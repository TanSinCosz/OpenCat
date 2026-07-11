#!/usr/bin/env python3
"""Load SWE-bench Verified instances into the JSONL shape used by OpenCat evals."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any, Iterable


DEFAULT_SOURCE = "princeton-nlp/SWE-bench_Verified"
DEFAULT_SPLIT = "test"
REQUIRED_FIELDS = ("instance_id", "repo", "base_commit", "problem_statement")
OPTIONAL_FIELDS = ("hints_text", "test_patch")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Normalize SWE-bench Verified data to JSONL for OpenCat evals.",
    )
    parser.add_argument(
        "--source",
        default=os.getenv("SWE_VERIFIED_DATASET_SOURCE", DEFAULT_SOURCE),
        help=(
            "Local JSON/JSONL file or HuggingFace dataset name. "
            f"Defaults to {DEFAULT_SOURCE}."
        ),
    )
    parser.add_argument(
        "--split",
        default=os.getenv("SWE_VERIFIED_DATASET_SPLIT", DEFAULT_SPLIT),
        help=f"HuggingFace dataset split. Defaults to {DEFAULT_SPLIT}.",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output JSONL path.",
    )
    parser.add_argument(
        "--limit",
        type=positive_int,
        default=int(os.getenv("SWE_VERIFIED_LIMIT", "5")),
        help="Maximum number of instances to write.",
    )
    parser.add_argument(
        "--instance-id",
        action="append",
        dest="instance_ids",
        help="Optional instance id filter. Can be passed multiple times.",
    )
    args = parser.parse_args()

    selected_ids = set(args.instance_ids or [])
    instances = []
    for item in load_source(args.source, args.split):
        normalized = normalize_instance(item)
        if selected_ids and normalized["instance_id"] not in selected_ids:
            continue
        instances.append(normalized)
        if len(instances) >= args.limit:
            break

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as handle:
        for instance in instances:
            handle.write(json.dumps(instance, ensure_ascii=False) + "\n")

    print(
        json.dumps(
            {
                "source": args.source,
                "split": args.split,
                "output": str(output_path),
                "count": len(instances),
            },
            ensure_ascii=False,
        )
    )


def load_source(source: str, split: str) -> Iterable[dict[str, Any]]:
    path = Path(source)
    if path.exists():
        return load_local_path(path, split)
    return load_huggingface_snapshot(source, split)


def load_local_path(path: Path, split: str) -> list[dict[str, Any]]:
    if path.is_dir():
        parquet_files = find_split_parquet_files(path, split)
        if parquet_files:
            return load_parquet_files(parquet_files)
        jsonl = path / f"{split}.jsonl"
        if jsonl.exists():
            return load_json_file(jsonl)
        json_file = path / f"{split}.json"
        if json_file.exists():
            return load_json_file(json_file)
        raise ValueError(f"No {split} JSON/JSONL/parquet files found in {path}")

    if path.suffix.lower() == ".parquet":
        return load_parquet_files([path])

    return load_json_file(path)


def load_json_file(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return []

    if text.startswith("["):
        data = json.loads(text)
        if not isinstance(data, list):
            raise ValueError(f"{path} must contain a JSON array or JSONL rows.")
        return data

    rows = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{line_no} must be a JSON object.")
        rows.append(value)
    return rows


def load_huggingface_snapshot(source: str, split: str) -> Iterable[dict[str, Any]]:
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise RuntimeError(
            "Python package 'huggingface_hub' is required for HuggingFace loading. "
            "Install it with: python -m pip install huggingface_hub"
        ) from exc

    snapshot_path = Path(
        snapshot_download(
            repo_id=source,
            repo_type="dataset",
            allow_patterns=[
                f"data/{split}-*.parquet",
                f"{split}-*.parquet",
                f"{split}.jsonl",
                f"{split}.json",
            ],
        )
    )
    parquet_files = find_split_parquet_files(snapshot_path, split)
    if parquet_files:
        return load_parquet_files(parquet_files)

    return load_huggingface_dataset(source, split)


def load_huggingface_dataset(source: str, split: str) -> Iterable[dict[str, Any]]:
    try:
        from datasets import load_dataset
    except ImportError as exc:
        raise RuntimeError(
            "Python package 'datasets' is required for HuggingFace loading. "
            "Install it with: python -m pip install datasets"
        ) from exc

    dataset = load_dataset(source, split=split)
    return (dict(row) for row in dataset)


def find_split_parquet_files(path: Path, split: str) -> list[Path]:
    return sorted(
        file
        for file in path.rglob("*.parquet")
        if file.name == f"{split}.parquet" or file.name.startswith(f"{split}-")
    )


def load_parquet_files(paths: list[Path]) -> list[dict[str, Any]]:
    try:
        import pandas as pd
    except ImportError as exc:
        raise RuntimeError(
            "Python package 'pandas' is required for parquet loading. "
            "Install it with: python -m pip install pandas pyarrow"
        ) from exc

    rows: list[dict[str, Any]] = []
    for path in paths:
        frame = pd.read_parquet(path)
        rows.extend(frame.to_dict(orient="records"))
    return rows


def normalize_instance(value: dict[str, Any]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for field in REQUIRED_FIELDS:
        raw = value.get(field)
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError(f"Invalid SWE-bench instance: missing {field}")
        normalized[field] = raw

    for field in OPTIONAL_FIELDS:
        raw = value.get(field)
        if isinstance(raw, str) and raw.strip():
            normalized[field] = raw

    return normalized


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


if __name__ == "__main__":
    main()
