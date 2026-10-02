import { execFileSync } from "node:child_process";
import path from "node:path";
import { getAppConfig, getEvaluationConfig } from "../src/config/load-config.js";

// The Python normalizer receives settings resolved by the same YAML entry point.
const config = getAppConfig();
const evaluation = getEvaluationConfig(config);
const active = config.evaluation.active;
const output = evaluation.datasetPath ?? path.join(
  config.evaluation.directory ?? evaluation.outputDir ?? `.opencat/evals/swe-${active === "serial" ? "serial" : "verified-cache"}`,
  "dataset.jsonl",
);
execFileSync(evaluation.python ?? (process.platform === "win32" ? "python" : "python3"), [
  path.resolve("scripts/load_swe_verified_dataset.py"),
  "--source", evaluation.datasetSource ?? (active === "serial" ? "SWE-bench/SWE-bench_Lite" : "princeton-nlp/SWE-bench_Verified"),
  "--split", evaluation.datasetSplit ?? "test",
  "--output", path.resolve(output),
  "--limit", String(evaluation.limit ?? (active === "serial" ? 100 : 5)),
], { stdio: "inherit" });
