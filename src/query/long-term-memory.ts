import { mkdir, readFile } from "node:fs/promises";
import { dirname, normalize, resolve } from "node:path";
import { getModelUserContentText } from "../openai-compatible/content.js";
import type { ModelMessage } from "../openai-compatible/types.js";
import {
  formatFileMemoryManifest,
  getFileMemoryDailyLogPath,
  getFileMemoryDir,
  loadFileMemories,
  scanFileMemoryHeaders,
  type FileMemoryHeader,
  type LoadedFileMemory,
} from "../Memory/file-memory.js";
import { recordTranscriptStateSnapshot } from "../transcript/persistence.js";
import { emitRunEvent } from "../telemetry/observer.js";
import type { Message, MessageId } from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { LongTermMemoryState, State } from "../types/state.js";
import type { AgentDefinition } from "../Tools/Agent/definitions.js";
import type { CanUseToolFn } from "../Tools/types.js";

const MEMORY_QUERY_MAX_CHARS = 4_000;
const MAX_RELEVANT_MEMORY_FILES = 5;
const MEMORY_SELECTOR_MAX_TOKENS = 256;
const FILE_MEMORY_EXTRACTION_MAX_TURNS = 5;
const RECENT_TOOL_NAMES_FOR_MEMORY_QUERY = 12;
const MAX_MEMORY_INJECTION_SESSION_BYTES = 60 * 1_024;
const STALE_MEMORY_AGE_MS = 24 * 60 * 60 * 1_000;

const MEMORY_SELECTOR_SYSTEM_PROMPT = [
  "You are selecting memories that will be useful to OpenCat as it processes a user's query.",
  "You will be given the user's query and a list of available memory files with their filenames and descriptions.",
  "Return JSON only: {\"selected_memories\":[\"relative/path.md\"]}.",
  `Return up to ${MAX_RELEVANT_MEMORY_FILES} filenames for memories that will clearly be useful while processing the query.`,
  "Only include filenames from the provided manifest.",
  "Only include memories that you are certain will be helpful based on their name and description.",
  "If you are unsure whether a memory will be useful, do not select it. Be selective and discerning.",
  "If no listed memory is clearly useful, return an empty list.",
  "If recently used tools are provided, do not select ordinary usage reference or API documentation for those tools because the active conversation already contains their working context.",
  "Still select memories containing warnings, gotchas, or known issues about those tools.",
].join("\n");

type PendingMemoryExtraction = {
  parentState: State;
  messages: Message[];
  fallbackStartMessageId?: MessageId;
  originSessionId: string;
};

type MemoryExtractionCoordinator = {
  inFlight: Promise<void> | null;
  pending: PendingMemoryExtraction | null;
  lastProcessedMessageId?: MessageId;
  retryFromMessageId?: MessageId;
};

const memoryExtractionCoordinators = new WeakMap<
  Runtime,
  MemoryExtractionCoordinator
>();

/**
 * Returns the memory block selected for this request without mutating Messages.
 * request-context.ts merges this body into a persisted opencat_context attachment;
 * subsequent requests still apply the existing volatile-block cleanup rules.
 */
export async function createLongTermMemoryContextMessage(
  runtime: Runtime,
  messages: readonly Message[],
  memoryState?: LongTermMemoryState,
): Promise<ModelMessage | null> {
  const config = runtime.longTermMemoryConfig;
  if (!config.enabled || !config.autoInject) {
    return null;
  }

  try {
    const query = buildLongTermMemoryQuery(messages);
    if (!query) {
      return null;
    }

    const headers = await scanFileMemoryHeaders(runtime);
    const alreadySurfaced = memoryState
      ? collectCurrentSurfacedMemoryFiles(memoryState, headers)
      : collectSurfacedLongTermMemoryFiles(messages);
    const selectedFiles = await selectRelevantFileMemories(
      runtime,
      query,
      headers,
      {
        alreadySurfaced,
        recentTools: collectRecentSuccessfulToolNames(messages),
      },
    );
    const selectedMemories = await loadFileMemories(runtime, selectedFiles);
    const acceptedMemories = selectMemoriesWithinInjectionBudgets(
      selectedMemories,
      config.maxInjectedChars,
      memoryState,
    );
    if (acceptedMemories.length === 0) {
      return null;
    }

    const content = renderLongTermMemoryFileContext(acceptedMemories);
    recordSurfacedMemories(memoryState, acceptedMemories);
    await emitRunEvent(runtime, {
      type: "long_term_memory_injected",
      queryChars: query.length,
      resultCount: acceptedMemories.length,
      injectedChars: content.length,
    });

    return {
      role: "user",
      content,
    };
  } catch {
    // Memory search is helpful context, not a hard dependency for answering.
    // Tool calls can still explicitly surface memory errors when debugging.
    return null;
  }
}

function collectCurrentSurfacedMemoryFiles(
  memoryState: LongTermMemoryState,
  headers: readonly FileMemoryHeader[],
): Set<string> {
  return new Set(headers
    .filter((header) =>
      memoryState.surfacedFiles[header.filename]?.modifiedAtMs ===
        header.modifiedAtMs
    )
    .map((header) => header.filename));
}

async function selectRelevantFileMemories(
  runtime: Runtime,
  query: string,
  headers: readonly FileMemoryHeader[],
  options: {
    alreadySurfaced?: ReadonlySet<string>;
    recentTools?: readonly string[];
  } = {},
): Promise<string[]> {
  const availableHeaders = headers.filter((header) =>
    !options.alreadySurfaced?.has(header.filename)
  );
  if (availableHeaders.length === 0) {
    return [];
  }

  const filenames = new Set(availableHeaders.map((header) => header.filename));
  const manifest = formatFileMemoryManifest(availableHeaders);
  const toolsSection = options.recentTools?.length
    ? `\n\nRecently used tools: ${options.recentTools.join(", ")}`
    : "";

  try {
    const response = await runtime.modelClient.create({
      model: getMemorySelectorModel(runtime),
      user_id: runtime.modelRuntimeConfig.userId,
      max_tokens: MEMORY_SELECTOR_MAX_TOKENS,
      temperature: 0,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: MEMORY_SELECTOR_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: [
            `Query:\n${query}`,
            "",
            `Available memory files:\n${manifest}${toolsSection}`,
          ].join("\n"),
        },
      ],
    });
    const content = response.choices[0]?.message.content ?? "";
    const parsed = parseSelectedMemoryFiles(content);
    return parsed
      .filter((filename) => filenames.has(filename))
      .slice(0, MAX_RELEVANT_MEMORY_FILES);
  } catch {
    return [];
  }
}

export function collectSurfacedLongTermMemoryFiles(
  messages: readonly Message[],
): Set<string> {
  const files = new Set<string>();

  for (const message of messages) {
    if (typeof message.content !== "string") {
      continue;
    }

    for (const match of message.content.matchAll(/<memory_file\s+path="([^"]+)"/g)) {
      files.add(unescapeAttribute(match[1]));
    }
  }

  return files;
}

function collectRecentSuccessfulToolNames(
  messages: readonly Message[],
): string[] {
  const userIndexes = messages
    .map((message, index) =>
      message.role === "user" && message.source === "user" ? index : -1
    )
    .filter((index) => index >= 0);
  const currentUserIndex = userIndexes.at(-1) ?? messages.length;
  const previousUserIndex = userIndexes.at(-2) ?? -1;
  const scopedMessages = messages.slice(previousUserIndex + 1, currentUserIndex);
  const callNames = new Map<string, string>();
  const successful = new Set<string>();
  const failed = new Set<string>();

  for (const message of scopedMessages) {
    if (message.role === "assistant") {
      for (const toolCall of message.tool_calls ?? []) {
        callNames.set(toolCall.id, toolCall.function.name);
      }
      continue;
    }
    if (message.role !== "tool") {
      continue;
    }

    const name = message.toolName ?? callNames.get(message.tool_call_id);
    if (!name) {
      continue;
    }
    if (looksLikeFailedToolResult(message.content)) {
      failed.add(name);
      successful.delete(name);
    } else if (!failed.has(name)) {
      successful.add(name);
    }
  }

  return [...successful].slice(-RECENT_TOOL_NAMES_FOR_MEMORY_QUERY);
}

function looksLikeFailedToolResult(content: string): boolean {
  return /^(?:error\b|permission denied\b|tool unavailable\b)|\bENOENT\b|\bfailed\b/i
    .test(content.trim());
}

function parseSelectedMemoryFiles(content: string): string[] {
  try {
    const parsed = JSON.parse(extractJsonObject(content)) as {
      selected_memories?: unknown;
      selected_files?: unknown;
    };
    const selected = parsed.selected_memories ?? parsed.selected_files;
    return Array.isArray(selected)
      ? selected.filter((value): value is string =>
        typeof value === "string"
      )
      : [];
  } catch {
    return [];
  }
}

function extractJsonObject(content: string): string {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  return start >= 0 && end >= start ? content.slice(start, end + 1) : content;
}

function getMemorySelectorModel(runtime: Runtime): string {
  if (runtime.modelRuntimeConfig.provider !== "deepseek") {
    return runtime.modelRuntimeConfig.model;
  }

  return runtime.modelRuntimeConfig.model === "deepseek-v4-flash"
    ? "deepseek-v4-flash"
    : "deepseek-v4-pro";
}

export type LongTermMemoryExtractionResult =
  | { status: "extracted"; count: number; source: "state" | "transcript" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export async function extractLongTermMemoryForCompletedQuery(
  runtime: Runtime,
  state: State,
  options: {
    turnStartMessageId?: MessageId;
    turnStartedAt?: number;
  } = {},
): Promise<LongTermMemoryExtractionResult> {
  const config = runtime.longTermMemoryConfig;
  if (
    runtime.agentRole !== "main" ||
    !config.enabled ||
    !config.autoExtract
  ) {
    return { status: "skipped", reason: "disabled" };
  }

  const coordinator = getMemoryExtractionCoordinator(runtime, state);
  const messages = state.Messages.map((message) => ({ ...message }));
  const startMessageId = coordinator.retryFromMessageId ??
    coordinator.lastProcessedMessageId ??
    options.turnStartMessageId;
  const turn = selectMessagesAfterCursor(messages, startMessageId, {
    includeCursor: coordinator.lastProcessedMessageId === undefined,
  });
  if (!turn || turn.newMessageCount === 0) {
    return { status: "skipped", reason: "no_extractable_messages" };
  }

  if (
    hasMemoryWriteSince(
      messages,
      startMessageId,
      getFileMemoryDir(runtime),
    )
  ) {
    coordinator.lastProcessedMessageId = messages.at(-1)?.id;
    coordinator.retryFromMessageId = undefined;
    state.longTermMemory.lastExtractedMessageId =
      coordinator.lastProcessedMessageId;
    state.longTermMemory.retryFromMessageId = undefined;
    await recordTranscriptStateSnapshot(runtime, state, "long_term_memory");
    return { status: "skipped", reason: "memory_saved_by_main_agent" };
  }

  const request: PendingMemoryExtraction = {
    parentState: state,
    messages,
    fallbackStartMessageId: startMessageId,
    originSessionId: runtime.sessionId,
  };
  if (coordinator.inFlight) {
    coordinator.pending = request;
  } else {
    startFileMemoryExtraction(runtime, coordinator, request);
  }

  return { status: "skipped", reason: "file_memory_extract_launched" };
}

/**
 * Wait for background extraction during graceful shutdown or deterministic
 * tests. Normal requests do not block on memory maintenance.
 */
export async function drainPendingLongTermMemoryExtractions(
  runtime: Runtime,
): Promise<void> {
  const coordinator = memoryExtractionCoordinators.get(runtime);
  while (coordinator?.inFlight) {
    await coordinator.inFlight;
  }
}

function getMemoryExtractionCoordinator(
  runtime: Runtime,
  state: State,
): MemoryExtractionCoordinator {
  let coordinator = memoryExtractionCoordinators.get(runtime);
  if (!coordinator) {
    coordinator = {
      inFlight: null,
      pending: null,
      lastProcessedMessageId: state.longTermMemory.lastExtractedMessageId,
      retryFromMessageId: state.longTermMemory.retryFromMessageId,
    };
    memoryExtractionCoordinators.set(runtime, coordinator);
  }
  return coordinator;
}

function startFileMemoryExtraction(
  runtime: Runtime,
  coordinator: MemoryExtractionCoordinator,
  request: PendingMemoryExtraction,
): void {
  const startMessageId = coordinator.retryFromMessageId ??
    coordinator.lastProcessedMessageId ??
    request.fallbackStartMessageId;
  const turn = selectMessagesAfterCursor(request.messages, startMessageId, {
    includeCursor: coordinator.lastProcessedMessageId === undefined,
  });
  if (!turn || turn.newMessageCount === 0) {
    coordinator.lastProcessedMessageId = request.messages.at(-1)?.id;
    coordinator.retryFromMessageId = undefined;
    request.parentState.longTermMemory.lastExtractedMessageId =
      coordinator.lastProcessedMessageId;
    request.parentState.longTermMemory.retryFromMessageId = undefined;
    void recordTranscriptStateSnapshot(
      runtime,
      request.parentState,
      "long_term_memory",
    );
    return;
  }

  coordinator.inFlight = (async () => {
    try {
      await runFileMemoryExtractionAgent(
        runtime,
        request.parentState,
        {
          newMessageCount: turn.newMessageCount,
          forkContextMessages: request.messages,
          originSessionId: request.originSessionId,
        },
      );
      coordinator.lastProcessedMessageId = request.messages.at(-1)?.id;
      coordinator.retryFromMessageId = undefined;
      request.parentState.longTermMemory.lastExtractedMessageId =
        coordinator.lastProcessedMessageId;
      request.parentState.longTermMemory.retryFromMessageId = undefined;
    } catch (error) {
      coordinator.retryFromMessageId = startMessageId;
      request.parentState.longTermMemory.retryFromMessageId = startMessageId;
      await emitRunEvent(runtime, {
        type: "long_term_memory_extracted",
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    await recordTranscriptStateSnapshot(
      runtime,
      request.parentState,
      "long_term_memory",
    );
  })().finally(() => {
    coordinator.inFlight = null;
    const pending = coordinator.pending;
    coordinator.pending = null;
    if (pending) {
      startFileMemoryExtraction(runtime, coordinator, pending);
    }
  });
}

async function runFileMemoryExtractionAgent(
  runtime: Runtime,
  state: State,
  options: {
    newMessageCount: number;
    forkContextMessages: Message[];
    originSessionId: string;
  },
): Promise<void> {
  const memoryDir = getFileMemoryDir(runtime);
  const now = new Date();
  const dailyLogPath = getFileMemoryDailyLogPath(runtime, now);
  await mkdir(dirname(dailyLogPath), { recursive: true });
  const existingMemories = formatFileMemoryManifest(
    await scanFileMemoryHeaders(runtime),
  );
  const prompt = buildFileMemoryExtractionPrompt({
    memoryDir,
    dailyLogPath,
    currentTimestamp: formatLocalTimestamp(now),
    newMessageCount: options.newMessageCount,
    existingMemories,
    originSessionId: options.originSessionId,
  });
  const { runAgentTask } = await import("../Tools/Agent/runner.js");

  await runAgentTask({
    parentRuntime: runtime,
    parentState: state,
    agentDefinition: createFileMemoryExtractionAgentDefinition(),
    prompt,
    description: "Append durable signals to the memory daily log",
    mode: "fork",
    isolation: "none",
    maxTurns: FILE_MEMORY_EXTRACTION_MAX_TURNS,
    recordTaskLifecycle: false,
    agentRole: "session",
    forkContextMessages: options.forkContextMessages,
    canUseTool: createFileMemoryExtractionCanUseTool(
      dailyLogPath,
      options.originSessionId,
    ),
    stopAfterSuccessfulToolNames: ["Edit", "Write"],
  });
}

function createFileMemoryExtractionAgentDefinition(): AgentDefinition {
  return {
    agentType: "long_term_memory",
    category: "worker",
    source: "built-in",
    whenToUse: "Internal agent used to stage durable signals in a daily log.",
    tools: ["Read", "Edit", "Write"],
    disallowedTools: [
      "Agent",
      "Bash",
      "MemorySave",
      "SendMessage",
      "Plan",
      "TodoWrite",
      "WebSearch",
      "WebFetch",
      "ReadSkill",
    ],
    model: "inherit",
    permissionMode: "default",
    maxTurns: FILE_MEMORY_EXTRACTION_MAX_TURNS,
    getSystemPrompt: () =>
      [
        "You are a forked long-term memory extraction agent.",
        "Stage durable cross-session signals in today's append-only memory log.",
        "Use the inherited conversation and the task prompt as your only conversation evidence.",
        "Do not answer the user, investigate the repository, or modify project files.",
        "Save only durable cross-session information that is not derivable from the current project state.",
        "Never edit MEMORY.md or formal topic memory files; AutoDream owns consolidation.",
      ].join("\n"),
  };
}

export function buildFileMemoryExtractionPrompt(input: {
  memoryDir: string;
  dailyLogPath: string;
  currentTimestamp: string;
  newMessageCount: number;
  existingMemories: string;
  originSessionId: string;
}): string {
  const manifest = input.existingMemories
    ? [
      "",
      "## Existing memory files",
      "",
      input.existingMemories,
      "",
      "Use this manifest only for orientation. Do not edit these formal files. Avoid logging an already-settled fact unless the recent messages correct, contradict, or materially extend it.",
    ]
    : [];

  return [
    `You are now acting as the memory extraction subagent. Analyze only the most recent ~${input.newMessageCount} model-visible messages above and append durable signals to today's staging log when useful.`,
    "",
    `Memory directory: ${input.memoryDir}`,
    `Today's append-only log: ${input.dailyLogPath}`,
    `Current local timestamp: ${input.currentTimestamp}`,
    `Origin session ID: ${input.originSessionId}`,
    "",
    "This log is an intermediate append-only stream. AutoDream later distills it into formal topic files and MEMORY.md.",
    "You may Read, Edit, or Write only the exact daily-log path above. MEMORY.md, topic files, project files, and every other path are write-protected.",
    "If the log exists, Read it once and append with Edit or Write while preserving every existing byte as a prefix. Never rewrite, reorganize, deduplicate, or delete an older log entry.",
    "If the log does not exist, create it. Use the date as the heading and then append entries.",
    `You MUST only use content from the last ~${input.newMessageCount} messages. Do not investigate or verify it further: do not inspect project source, git history, or transcripts.`,
    ...manifest,
    "",
    "If the user explicitly asks you to remember something, log it when it fits the durable-memory criteria. If the user asks you to forget or correct something, append a correction/tombstone entry; do not edit prior log entries. AutoDream will update the formal memory.",
    "",
    "## Types of memory",
    "",
    "- user: the user's role, goals, responsibilities, preferences, or knowledge that should shape future collaboration. Avoid negative judgments or irrelevant profile details.",
    "- feedback: corrections or confirmed non-obvious approaches about how work should be done. Lead with the rule, then add **Why:** and **How to apply:** lines.",
    "- project: non-obvious goals, motivations, constraints, deadlines, ownership, or decisions not derivable from code or git. Convert relative dates to absolute dates. Lead with the fact, then add **Why:** and **How to apply:** lines.",
    "- reference: pointers to external systems and where current information can be found.",
    "",
    "## What NOT to save",
    "",
    "- Code patterns, conventions, architecture, file paths, or project structure; these can be derived by reading the current project state.",
    "- Git history, recent changes, or who changed what; git is the authority.",
    "- Debugging solutions or fix recipes; the fix belongs in code or commit context.",
    "- Anything already documented in CLAUDE.md, OPENCAT.md, or other project instruction files.",
    "- Ephemeral task details: in-progress work, temporary state, current conversation context.",
    "- Plans or task lists for the current conversation. Use Plan/Todo state for those, not long-term memory.",
    "",
    "These exclusions still apply when the user explicitly asks to save a noisy activity summary. Preserve only the surprising or non-obvious durable part.",
    "",
    "## How to append",
    "",
    "Append one short block per durable signal using this format:",
    "```markdown",
    `- HH:mm | type: {{user | feedback | project | reference}} | originSessionId: ${input.originSessionId}`,
    "  {{concise durable fact, correction, or tombstone}}",
    "  **Why:** {{why it matters, when known}}",
    "  **How to apply:** {{future behavior, when actionable}}",
    "```",
    "",
    `- Every new entry must contain exactly this provenance field: originSessionId: ${input.originSessionId}.`,
    "- Use the local HH:mm represented by the current timestamp above.",
    "- Omit Why or How to apply when the source does not support them.",
    "- Keep entries concise. The daily log is evidence for AutoDream, not a transcript summary.",
    "- Do not edit MEMORY.md or create/update any topic memory file.",
    "",
    "Be conservative. If nothing durable appears, do not call a writing tool.",
  ].join("\n");
}

function createFileMemoryExtractionCanUseTool(
  dailyLogPath: string,
  originSessionId: string,
): CanUseToolFn {
  const allowedPath = normalize(resolve(dailyLogPath)).toLowerCase();

  return async (tool, input) => {
    const record = asToolInputRecord(input);
    const requestedPath = typeof record?.file_path === "string"
      ? normalize(resolve(record.file_path)).toLowerCase()
      : "";
    if (requestedPath !== allowedPath) {
      return denyDailyLogTool(dailyLogPath);
    }

    if (tool.name === "Read") {
      return { behavior: "allow" };
    }

    if (tool.name === "Write" && typeof record?.content === "string") {
      return await validateDailyLogWrite(
        dailyLogPath,
        record.content,
        originSessionId,
      );
    }

    if (
      tool.name === "Edit" &&
      typeof record?.old_string === "string" &&
      typeof record.new_string === "string" &&
      record.replace_all !== true
    ) {
      return await validateDailyLogEdit(
        dailyLogPath,
        record.old_string,
        record.new_string,
        originSessionId,
      );
    }

    return denyDailyLogTool(dailyLogPath);
  };
}

function asToolInputRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null
    ? input as Record<string, unknown>
    : null;
}

async function validateDailyLogWrite(
  dailyLogPath: string,
  nextContent: string,
  originSessionId: string,
) {
  const previousContent = await readUtf8OrNull(dailyLogPath);
  const appendedContent = previousContent === null
    ? nextContent
    : nextContent.slice(previousContent.length);
  if (
    (previousContent !== null && !nextContent.startsWith(previousContent)) ||
    !containsOriginSessionId(appendedContent, originSessionId)
  ) {
    return {
      behavior: "deny" as const,
      message:
        "Daily logs are append-only. Preserve the existing content exactly and append entries with the required originSessionId.",
    };
  }
  return { behavior: "allow" as const };
}

async function validateDailyLogEdit(
  dailyLogPath: string,
  oldString: string,
  newString: string,
  originSessionId: string,
) {
  const previousContent = await readUtf8OrNull(dailyLogPath);
  const appendedContent = newString.slice(oldString.length);
  if (
    previousContent === null ||
    !previousContent.endsWith(oldString) ||
    !newString.startsWith(oldString) ||
    !containsOriginSessionId(appendedContent, originSessionId)
  ) {
    return {
      behavior: "deny" as const,
      message:
        "Daily-log Edit must replace the current file tail with that same tail plus new entries carrying the required originSessionId.",
    };
  }
  return { behavior: "allow" as const };
}

function containsOriginSessionId(
  content: string,
  originSessionId: string,
): boolean {
  return content.includes(`originSessionId: ${originSessionId}`);
}

async function readUtf8OrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function denyDailyLogTool(dailyLogPath: string) {
  return {
    behavior: "deny" as const,
    message:
      `Long-term memory extraction may only append to today's daily log: ${dailyLogPath}`,
  };
}

function formatLocalTimestamp(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHour = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(
    2,
    "0",
  );
  const offsetMinute = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offsetSign}${offsetHour}:${offsetMinute}`;
}

function isPathInside(filePath: string, root: string): boolean {
  const candidate = normalize(resolve(filePath)).toLowerCase();
  const normalizedRoot = root.toLowerCase();
  return candidate === normalizedRoot ||
    candidate.startsWith(`${normalizedRoot}\\`) ||
    candidate.startsWith(`${normalizedRoot}/`);
}

function selectMessagesAfterCursor(
  messages: readonly Message[],
  cursorMessageId: MessageId | undefined,
  options: { includeCursor: boolean },
): { newMessageCount: number } | null {
  let cursorIndex = cursorMessageId
    ? messages.findIndex((message) => message.id === cursorMessageId)
    : findLastUserMessageIndex(messages);

  // Auto-compression can remove the message that held the extraction cursor.
  // Falling back to the current visible history keeps background extraction
  // alive instead of permanently returning zero for the rest of the session.
  if (cursorMessageId && cursorIndex < 0) {
    cursorIndex = 0;
    options = { includeCursor: true };
  }
  if (cursorIndex < 0) {
    return null;
  }

  const newMessageCount = messages
    .slice(cursorIndex + (options.includeCursor ? 0 : 1))
    .filter(isModelVisibleMemoryExtractionMessage)
    .length;

  return { newMessageCount };
}

function isModelVisibleMemoryExtractionMessage(message: Message): boolean {
  return (message.role === "user" && message.source === "user") ||
    (message.role === "assistant" && message.source === "assistant") ||
    (message.role === "tool" && message.source === "tool");
}

function findLastUserMessageIndex(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && message.source === "user") {
      return index;
    }
  }

  return -1;
}

function hasMemoryWriteSince(
  messages: readonly Message[],
  turnStartMessageId: MessageId | undefined,
  memoryDir: string,
): boolean {
  const startIndex = turnStartMessageId
    ? messages.findIndex((message) => message.id === turnStartMessageId)
    : 0;
  const scopedMessages = messages.slice(Math.max(0, startIndex));

  return scopedMessages.some((message) => {
    if (message.role !== "assistant") {
      return false;
    }

    return (message.tool_calls ?? []).some((toolCall) => {
      if (toolCall.function.name === "MemorySave") {
        return true;
      }
      if (
        toolCall.function.name !== "Write" &&
        toolCall.function.name !== "Edit"
      ) {
        return false;
      }

      try {
        const input = JSON.parse(toolCall.function.arguments) as {
          file_path?: unknown;
        };
        return typeof input.file_path === "string" &&
          isPathInside(input.file_path, normalize(resolve(memoryDir)));
      } catch {
        return false;
      }
    });
  });
}

function buildLongTermMemoryQuery(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && message.source === "user") {
      return truncate(
        getModelUserContentText(message.content),
        MEMORY_QUERY_MAX_CHARS,
      ).trim();
    }
  }

  return "";
}

function renderLongTermMemoryFileContext(
  memories: readonly LoadedFileMemory[],
): string {
  const lines = [
    "<long_term_memory>",
    "Relevant long-term memory files selected for the current user request.",
    "Treat them as potentially stale background context: verify repository facts against the current project, and prefer newer user instructions or current observations when they conflict.",
    "<memory_files>",
  ];

  for (const memory of memories) {
    lines.push(...renderMemoryFileBlock(memory));
  }

  lines.push("</memory_files>", "</long_term_memory>");
  return lines.join("\n");
}

function selectMemoriesWithinInjectionBudgets(
  memories: readonly LoadedFileMemory[],
  maxRequestChars: number,
  memoryState: LongTermMemoryState | undefined,
): LoadedFileMemory[] {
  const accepted: LoadedFileMemory[] = [];
  let requestChars = renderLongTermMemoryFileContext([]).length;
  let remainingSessionBytes = memoryState
    ? Math.max(
      0,
      MAX_MEMORY_INJECTION_SESSION_BYTES - memoryState.surfacedBytes,
    )
    : MAX_MEMORY_INJECTION_SESSION_BYTES;

  for (const memory of memories) {
    const block = renderMemoryFileBlock(memory).join("\n");
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (
      requestChars + block.length > maxRequestChars ||
      blockBytes > remainingSessionBytes
    ) {
      continue;
    }
    accepted.push(memory);
    requestChars += block.length;
    remainingSessionBytes -= blockBytes;
  }

  return accepted;
}

function recordSurfacedMemories(
  memoryState: LongTermMemoryState | undefined,
  memories: readonly LoadedFileMemory[],
): void {
  if (!memoryState) {
    return;
  }

  for (const memory of memories) {
    const injectedBytes = Buffer.byteLength(
      renderMemoryFileBlock(memory).join("\n"),
      "utf8",
    );
    memoryState.surfacedFiles[memory.filename] = {
      modifiedAtMs: memory.modifiedAtMs,
      injectedBytes,
    };
    memoryState.surfacedBytes += injectedBytes;
  }
}

function renderMemoryFileBlock(memory: LoadedFileMemory): string[] {
  const modifiedAt = new Date(memory.modifiedAtMs).toISOString();
  const lines = [
    `<memory_file path="${escapeAttribute(memory.filename)}" source_path="${
      escapeAttribute(memory.path)
    }"${memory.type ? ` type="${memory.type}"` : ""} modified_at="${
      escapeAttribute(modifiedAt)
    }">`,
  ];
  if (Date.now() - memory.modifiedAtMs > STALE_MEMORY_AGE_MS) {
    lines.push(
      `[Freshness warning: this memory was last modified on ${modifiedAt}. Point-in-time observations may be stale; verify them before use.]`,
    );
  }
  lines.push(memory.content, "</memory_file>");
  return lines;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars))}\n[Long-term memory truncated]`;
}
