import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "../types/runtime.js";
import type { PersistedToolResult } from "../types/messages.js";

const TOOL_RESULTS_DIR = ".opencat/tool-results";
const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;
const PREVIEW_CHARS = 2_000;
const PERSISTED_OUTPUT_TAG = "<persisted-output>";

export type PersistedToolResultContent = {
  content: string;
  persistedToolResult?: PersistedToolResult;
};

export async function maybePersistToolResultContent(options: {
  runtime: Runtime;
  toolCallId: string;
  toolName: string;
  content: string;
  maxResultSizeChars?: number;
}): Promise<PersistedToolResultContent> {
  const threshold = getPersistenceThreshold(options.maxResultSizeChars);
  if (!Number.isFinite(threshold) || options.content.length <= threshold) {
    return { content: options.content };
  }

  return persistToolResultContent({
    runtime: options.runtime,
    id: options.toolCallId,
    content: options.content,
  });
}

export async function persistToolResultContent(options: {
  runtime: Runtime;
  id: string;
  content: string;
}): Promise<PersistedToolResultContent> {
  const relativePath = join(
    TOOL_RESULTS_DIR,
    sanitizePathSegment(options.runtime.sessionId),
    `${sanitizePathSegment(options.id)}.txt`,
  );
  const absolutePath = join(options.runtime.cwd, relativePath);
  const sha256 = createHash("sha256").update(options.content).digest("hex");

  await mkdir(join(options.runtime.cwd, TOOL_RESULTS_DIR, sanitizePathSegment(options.runtime.sessionId)), {
    recursive: true,
  });
  try {
    await writeFile(absolutePath, options.content, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }
  }

  const preview = createPreview(options.content, PREVIEW_CHARS);
  const persistedToolResult: PersistedToolResult = {
    path: relativePath,
    absolutePath,
    size: options.content.length,
    sha256,
    previewChars: preview.length,
    originalContentType: "text",
  };

  return {
    content: buildPersistedToolResultMessage(persistedToolResult, preview),
    persistedToolResult,
  };
}

export function buildPersistedToolResultMessage(
  persistedToolResult: PersistedToolResult,
  preview: string,
): string {
  return [
    PERSISTED_OUTPUT_TAG,
    `Output too large (${persistedToolResult.size} characters). Full output saved to: ${persistedToolResult.path}`,
    `sha256: ${persistedToolResult.sha256}`,
    "",
    `Preview (first ${persistedToolResult.previewChars} characters):`,
    preview,
    persistedToolResult.previewChars < persistedToolResult.size ? "..." : "",
    "</persisted-output>",
  ].filter((line) => line.length > 0).join("\n");
}

function getPersistenceThreshold(maxResultSizeChars: number | undefined): number {
  if (maxResultSizeChars === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  if (!Number.isFinite(maxResultSizeChars)) {
    return maxResultSizeChars;
  }

  return Math.min(maxResultSizeChars, DEFAULT_MAX_RESULT_SIZE_CHARS);
}

function createPreview(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  const truncated = content.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;
  return content.slice(0, cutPoint);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "result";
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}
