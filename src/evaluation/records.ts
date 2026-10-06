/** JSON / JSONL 读取与非结构化字段解析；兼容旧评测产物，保留坏行诊断。 */
import { readFile } from "node:fs/promises";
import type { JsonRecord } from "./types.js";

export async function readJson(filePath: string): Promise<JsonRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function readJsonl(filePath: string): Promise<JsonRecord[]> {
  let raw = "";
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }

  return raw.split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        return isRecord(parsed) ? parsed : { type: "unknown_json", value: parsed };
      } catch {
        return { type: "parse_error", raw: line.slice(0, 1000) };
      }
    });
}

export async function readDatasetRecords(filePath: string): Promise<JsonRecord[]> {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed)
        ? parsed.filter(isRecord)
        : [];
    } catch {
      return [];
    }
  }

  return await readJsonl(filePath);
}

export function firstString(records: readonly JsonRecord[], key: string): string | undefined {
  for (const record of records) {
    const value = stringValue(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function messageContentToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map(messageContentToText).filter(Boolean).join("\n");
  }

  if (isRecord(value)) {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.content === "string") {
      return value.content;
    }
    return JSON.stringify(value);
  }

  return String(value);
}

export function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function sanitizeSegment(value: string): string {
  return value.replace(/[\\/]/g, "");
}

export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
