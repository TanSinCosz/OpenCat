import { readFile, stat } from "node:fs/promises";
import { normalize } from "node:path";

import { formatContentWithLineNumbers } from "../Tools/FileRead/FileRead.js";
import {
  cacheToObject,
  type FileState,
  type FileStateCache,
} from "../Tools/types.js";
import { createRuntimeContextMessage } from "../query/runtime-context.js";
import type { AutoCompressSummaryId } from "../types/context.js";
import type { Message } from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";

const MAX_POST_COMPACT_FILE_ATTACHMENTS = 5;
const MAX_POST_COMPACT_FILE_CHARS = 24_000;
const MAX_POST_COMPACT_TOTAL_CHARS = 60_000;

export type PostCompactReadFileRestoreResult = {
  candidateCount: number;
  restoredCount: number;
  skippedCount: number;
};

/**
 * Mirrors the official post-compact read-state handoff:
 * snapshot the files the model had seen, clear the mutable cache, then restore
 * a small recent subset as model-visible attachments and cache entries.
 */
export async function restoreReadFileStateAfterAutoCompress(
  runtime: Runtime,
  state: State,
  summaryId: AutoCompressSummaryId,
  preservedMessages: readonly Message[],
): Promise<PostCompactReadFileRestoreResult> {
  if (state.autoCompress.readFileStateRestoredForSummaryId === summaryId) {
    return { candidateCount: 0, restoredCount: 0, skippedCount: 0 };
  }

  const readFileState = runtime.toolUseContext.readFileState;
  const snapshot = cacheToObject(readFileState);
  const candidates = selectPostCompactFileCandidates(
    snapshot,
    collectPreservedReadFilePaths(preservedMessages),
  );

  readFileState.clear();
  state.autoCompress.readFileStateRestoredForSummaryId = summaryId;

  const restored = await createPostCompactFileRestoreMessages(
    candidates,
    readFileState,
  );

  state.runtimeContextMessages.push(...restored.messages);

  return {
    candidateCount: candidates.length,
    restoredCount: restored.messages.length,
    skippedCount: candidates.length - restored.messages.length,
  };
}

type FileCandidate = {
  path: string;
  state: FileState;
};

type FileRestoreMessagesResult = {
  messages: Message[];
};

function selectPostCompactFileCandidates(
  snapshot: Record<string, FileState>,
  preservedReadFilePaths: ReadonlySet<string>,
): FileCandidate[] {
  return Object.entries(snapshot)
    .filter(([filePath, state]) =>
      !state.isPartialView && !preservedReadFilePaths.has(normalize(filePath))
    )
    .sort(([, left], [, right]) => right.timestamp - left.timestamp)
    .slice(0, MAX_POST_COMPACT_FILE_ATTACHMENTS)
    .map(([path, state]) => ({ path, state }));
}

async function createPostCompactFileRestoreMessages(
  candidates: readonly FileCandidate[],
  readFileState: FileStateCache,
): Promise<FileRestoreMessagesResult> {
  const messages: Message[] = [];
  let remainingChars = MAX_POST_COMPACT_TOTAL_CHARS;

  for (const candidate of candidates) {
    if (remainingChars <= 0) {
      break;
    }

    const restored = await restoreOneFile(candidate, remainingChars);
    if (!restored) {
      continue;
    }

    readFileState.set(candidate.path, {
      content: restored.rawContent,
      timestamp: restored.timestamp,
      offset: 1,
      limit: undefined,
      isPartialView: restored.truncated,
    });

    messages.push(createRuntimeContextMessage({
      source: "file_restore",
      content: renderPostCompactFileAttachment(restored),
    }));
    remainingChars -= restored.attachmentChars;
  }

  return { messages };
}

type RestoredFile = {
  path: string;
  rawContent: string;
  numberedContent: string;
  timestamp: number;
  truncated: boolean;
  attachmentChars: number;
};

async function restoreOneFile(
  candidate: FileCandidate,
  remainingChars: number,
): Promise<RestoredFile | null> {
  try {
    const stats = await stat(candidate.path);
    if (stats.isDirectory()) {
      return null;
    }

    const diskContent = await readFile(candidate.path, "utf8");
    const rawContent = stripBom(diskContent);
    const maxChars = Math.min(MAX_POST_COMPACT_FILE_CHARS, remainingChars);
    const truncated = rawContent.length > maxChars;
    const visibleContent = truncated
      ? `${rawContent.slice(0, Math.max(0, maxChars))}\n[File truncated during post-compact restore]`
      : rawContent;
    const numberedContent = formatContentWithLineNumbers(visibleContent, 1);
    const timestamp = Math.floor(stats.mtimeMs);

    return {
      path: candidate.path,
      rawContent,
      numberedContent,
      timestamp,
      truncated,
      attachmentChars: numberedContent.length,
    };
  } catch {
    return null;
  }
}

function renderPostCompactFileAttachment(file: RestoredFile): string {
  const lines = [
    "<post-compact-file-restore>",
    "The following file was read before auto-compress and has been restored into the current context.",
    `path: ${file.path}`,
    `partial: ${file.truncated ? "true" : "false"}`,
    "<content>",
    file.numberedContent,
    "</content>",
    "</post-compact-file-restore>",
  ];

  return lines.join("\n");
}

function collectPreservedReadFilePaths(messages: readonly Message[]): Set<string> {
  const paths = new Set<string>();

  for (const message of messages) {
    if (message.role !== "tool" || !message.content) {
      continue;
    }

    const filePath = parseToolMessageFilePath(message.content);
    if (filePath) {
      paths.add(normalize(filePath));
    }
  }

  return paths;
}

function parseToolMessageFilePath(content: string): string | undefined {
  try {
    const value = JSON.parse(content) as unknown;
    if (!isRecord(value)) {
      return undefined;
    }

    const file = value.file;
    if (!isRecord(file) || typeof file.filePath !== "string") {
      return undefined;
    }

    return file.filePath;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}
