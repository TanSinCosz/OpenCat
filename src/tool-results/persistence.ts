import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import type { Runtime } from "../types/runtime.js";

const TOOL_RESULTS_DIR = ".opencat/tool-results";
const TOOL_RESULT_PREVIEW_CHARS = 2_000;

export interface PersistToolResultForBudgetOptions {
  runtime: Runtime;
  toolCallId: string;
  content: string;
  toolName?: string;
}

export async function persistToolResultForBudget(
  options: PersistToolResultForBudgetOptions,
): Promise<string> {
  const sha256 = createHash("sha256").update(options.content).digest("hex");
  const directory = join(
    options.runtime.cwd,
    TOOL_RESULTS_DIR,
    sanitizePathSegment(options.runtime.sessionId),
  );
  const fileName = [
    Date.now(),
    sanitizePathSegment(options.toolName ?? "tool"),
    sanitizePathSegment(options.toolCallId),
    randomUUID(),
  ].join("-");
  const absolutePath = join(directory, `${fileName}.txt`);

  await mkdir(directory, { recursive: true });
  await writeFile(absolutePath, options.content, "utf8");

  const relativePath = normalizeRelativePath(
    relative(options.runtime.cwd, absolutePath),
  );

  return buildPersistedToolResultPreview({
    toolName: options.toolName,
    originalContent: options.content,
    relativePath,
    size: Buffer.byteLength(options.content, "utf8"),
    sha256,
  });
}

function buildPersistedToolResultPreview(options: {
  toolName?: string;
  originalContent: string;
  relativePath: string;
  size: number;
  sha256: string;
}): string {
  const preview = options.originalContent.slice(0, TOOL_RESULT_PREVIEW_CHARS);
  const omittedChars = Math.max(
    0,
    options.originalContent.length - TOOL_RESULT_PREVIEW_CHARS,
  );
  const toolLabel = options.toolName ? ` from ${options.toolName}` : "";

  return [
    `Tool result${toolLabel} was ${options.size} bytes and was persisted to disk because it is too large to inline in the conversation transcript.`,
    `Full output path: ${options.relativePath}`,
    `SHA-256: ${options.sha256}`,
    "",
    "<tool_result_preview>",
    omittedChars > 0
      ? `${preview}\n[${omittedChars} additional characters omitted from this message. Read the persisted file if the full output is needed.]`
      : preview,
    "</tool_result_preview>",
  ].join("\n");
}

function sanitizePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 96);
  return safe || "unknown";
}

function normalizeRelativePath(value: string): string {
  return value.split(/[\\/]+/).map((part) => basename(part)).join("/");
}
