import { mkdir } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import type { DeepSeekMessage } from "../deepseek/types.js";
import {
  formatFileMemoryManifest,
  getFileMemoryDir,
  getFileMemoryLogsDir,
  loadFileMemories,
  loadFileMemoryEntrypoint,
  scanFileMemoryHeaders,
  type FileMemoryHeader,
  type LoadedFileMemory,
} from "../Memory/file-memory.js";
import { emitRunEvent } from "../telemetry/observer.js";
import type { Message, MessageId } from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import type { AgentDefinition } from "../Tools/Agent/definitions.js";
import type { CanUseToolFn } from "../Tools/types.js";

const MEMORY_QUERY_RECENT_MESSAGES = 6;
const MEMORY_QUERY_MAX_CHARS = 4_000;
const MAX_RELEVANT_MEMORY_FILES = 5;
const MEMORY_SELECTOR_MAX_TOKENS = 512;
const FILE_MEMORY_EXTRACTION_MAX_TURNS = 5;
const RECENT_TOOL_NAMES_FOR_MEMORY_QUERY = 12;

/**
 * Builds a transient model-visible memory block.
 *
 * This deliberately returns a transient context message instead of mutating
 * State.Messages: long-term memory is external context, not part of the
 * authoritative conversation transcript.
 */
export async function createLongTermMemoryContextMessage(
  runtime: Runtime,
  messages: readonly Message[],
): Promise<DeepSeekMessage | null> {
  const config = runtime.longTermMemoryConfig;
  if (!config.enabled || !config.autoInject) {
    return null;
  }

  const query = buildLongTermMemoryQuery(messages);
  if (!query) {
    return null;
  }

  try {
    const entrypoint = await loadFileMemoryEntrypoint(runtime);
    if (!entrypoint) {
      return null;
    }

    const headers = await scanFileMemoryHeaders(runtime);
    const alreadySurfaced = collectSurfacedLongTermMemoryFiles(messages);
    const recentTools = collectRecentToolNames(messages);
    const selectedFiles = await selectRelevantFileMemories(
      runtime,
      query,
      headers,
      {
        alreadySurfaced,
        recentTools,
      },
    );
    const selectedMemories = await loadFileMemories(runtime, selectedFiles);
    const content = renderLongTermMemoryFileContext(
      entrypoint,
      selectedMemories,
      config.maxInjectedChars,
    );
    await emitRunEvent(runtime, {
      type: "long_term_memory_injected",
      queryChars: query.length,
      resultCount: selectedMemories.length,
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
    const response = await runtime.deepSeekClient.create({
      model: getDeepSeekModel(runtime),
      max_tokens: MEMORY_SELECTOR_MAX_TOKENS,
      temperature: 0,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You are selecting long-term memory files that will be useful to OpenCat as it processes the user's next request.",
            "You will be given the user's recent query context and a manifest of available memory files with their filenames, types, names, and descriptions.",
            `Return JSON only: {"selected_files":["relative/path.md"]}.`,
            `Return a list of filenames for memories that will clearly be useful to OpenCat as it processes the request, up to ${MAX_RELEVANT_MEMORY_FILES} files.`,
            "Only select filenames from the provided manifest.",
            "Select based on the manifest metadata. Do not invent filenames or rely on memories that are not listed.",
            "Only include memories you are certain will help. If you are unsure whether a memory is useful, do not include it.",
            "Be selective and discerning; keyword overlap alone is not enough.",
            "If recently used tools are provided, do not select ordinary usage reference memories for those tools because active tool output already provides usage context. Still select memories containing warnings, gotchas, or known issues about those tools.",
            "If no listed memory is clearly useful, return an empty list.",
          ].join("\n"),
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

function collectRecentToolNames(messages: readonly Message[]): string[] {
  const names: string[] = [];

  for (const message of messages.slice().reverse()) {
    if (message.role === "tool" && message.toolName) {
      names.push(message.toolName);
    } else if (message.role === "assistant") {
      for (const toolCall of (message.tool_calls ?? []).slice().reverse()) {
        names.push(toolCall.function.name);
      }
    }

    if (names.length >= RECENT_TOOL_NAMES_FOR_MEMORY_QUERY) {
      break;
    }
  }

  return [...new Set(names)].slice(0, RECENT_TOOL_NAMES_FOR_MEMORY_QUERY);
}

function parseSelectedMemoryFiles(content: string): string[] {
  try {
    const parsed = JSON.parse(extractJsonObject(content)) as {
      selected_files?: unknown;
    };
    return Array.isArray(parsed.selected_files)
      ? parsed.selected_files.filter((value): value is string =>
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

function getDeepSeekModel(runtime: Runtime): "deepseek-v4-flash" | "deepseek-v4-pro" {
  return runtime.deepSeekRuntimeConfig.model === "deepseek-v4-flash"
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

  const turn = selectTurnMessagesFromMessages(
    state.Messages,
    options.turnStartMessageId,
  );
  if (!turn || turn.newMessages.length === 0) {
    return { status: "skipped", reason: "no_extractable_messages" };
  }

  if (hasMemorySaveSince(state.Messages, options.turnStartMessageId)) {
    return { status: "skipped", reason: "memory_saved_by_main_agent" };
  }

  void runFileMemoryExtractionAgent(runtime, state, {
    newMessageCount: turn.newMessages.length,
  }).catch((error) => {
    void emitRunEvent(runtime, {
      type: "long_term_memory_extracted",
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
  });

  return { status: "skipped", reason: "file_memory_extract_launched" };
}

async function runFileMemoryExtractionAgent(
  runtime: Runtime,
  state: State,
  options: { newMessageCount: number },
): Promise<void> {
  const memoryDir = getFileMemoryDir(runtime);
  const logsDir = getFileMemoryLogsDir(runtime);
  const forkContextMessages = state.Messages.map((message) => ({ ...message }));
  await mkdir(logsDir, { recursive: true });
  const prompt = buildFileMemoryExtractionPrompt({
    memoryDir,
    logsDir,
    logPath: getDailyMemoryLogPath(logsDir),
    newMessageCount: options.newMessageCount,
  });
  const { runAgentTask } = await import("../Tools/Agent/runner.js");

  await runAgentTask({
    parentRuntime: runtime,
    parentState: state,
    agentDefinition: createFileMemoryExtractionAgentDefinition(),
    prompt,
    description: "Update file-based long-term memory",
    mode: "fork",
    isolation: "none",
    maxTurns: FILE_MEMORY_EXTRACTION_MAX_TURNS,
    recordTaskLifecycle: false,
    agentRole: "session",
    forkContextMessages,
    canUseTool: createFileMemoryExtractionCanUseTool(logsDir),
  });
}

function createFileMemoryExtractionAgentDefinition(): AgentDefinition {
  return {
    agentType: "long_term_memory",
    category: "worker",
    source: "built-in",
    whenToUse: "Internal agent used to update file-based long-term memory.",
    tools: ["Read", "Grep", "Glob", "Edit", "Write"],
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
        "Append durable memory signals to the daily memory log only.",
        "Do not answer the user and do not modify project files.",
        "Save only durable cross-session information that is not derivable from the current project state.",
        "Do not edit MEMORY.md or topic memory files; a separate dream pass consolidates logs later.",
      ].join("\n"),
  };
}

function buildFileMemoryExtractionPrompt(input: {
  memoryDir: string;
  logsDir: string;
  logPath: string;
  newMessageCount: number;
}): string {
  return [
    `Analyze the most recent ~${input.newMessageCount} model-visible messages in the inherited conversation and append durable memory signals if useful.`,
    "",
    `Memory directory: ${input.memoryDir}`,
    `Daily logs directory: ${input.logsDir}`,
    `Append-only log file for today: ${input.logPath}`,
    "",
    "Allowed tools: Read, Grep, Glob, Edit, Write.",
    "You may only Write/Edit files inside the daily logs directory. Other writes will be denied.",
    "Do not edit MEMORY.md or topic memory files. A manual/automatic dream pass will consolidate logs later.",
    "If the log file already exists, append new bullets to the end. Do not rewrite or reorganize existing log entries.",
    "If the log file does not exist, create it and parent directories as needed.",
    "",
    "Log format:",
    "```markdown",
    "- HH:MM [type] Concise durable memory signal. Include Why/How to apply when useful.",
    "```",
    "Use current local time when available; otherwise use an approximate timestamp.",
    "",
    "Log only information likely to be useful in future conversations:",
    "- user: durable user role, goals, preferences, knowledge background.",
    "- feedback: corrections or validated preferences about how to work. Include Why and How to apply when the conversation provides them.",
    "- project: non-obvious project context, motivation, constraints, deadlines, or decisions not derivable from code/git. Convert relative dates to absolute dates when possible.",
    "- reference: pointers to external systems and where to look for up-to-date information.",
    "",
    "What NOT to save:",
    "- Code patterns, conventions, architecture, file paths, or project structure; these can be derived by reading the current project state.",
    "- Git history, recent changes, or who changed what; git is the authority.",
    "- Debugging solutions or fix recipes; the fix belongs in code or commit context.",
    "- Anything already documented in project files unless the user explicitly made it a cross-session preference.",
    "- Ephemeral task details: in-progress work, temporary state, current conversation context.",
    "- Plans or task lists for the current conversation. Use Plan/Todo state for those, not long-term memory.",
    "",
    "These log entries are raw signal, not official memory. Be conservative: if nothing durable appears, do not write anything.",
    "If nothing should be saved, do not call any writing tools; finish with a short note saying no durable memory was needed.",
  ].join("\n");
}

function createFileMemoryExtractionCanUseTool(logsDir: string): CanUseToolFn {
  const root = normalize(resolve(logsDir));

  return (tool, input) => {
    if (tool.name === "Read" || tool.name === "Grep" || tool.name === "Glob") {
      return { behavior: "allow" };
    }

    if (
      (tool.name === "Write" || tool.name === "Edit") &&
      typeof input === "object" &&
      input !== null &&
      "file_path" in input &&
      typeof input.file_path === "string" &&
      isPathInside(input.file_path, root)
    ) {
      return { behavior: "allow" };
    }

    return {
      behavior: "deny",
      message: `Long-term memory extraction may only read files and append/write inside ${logsDir}.`,
    };
  };
}

function getDailyMemoryLogPath(logsDir: string, date = new Date()): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return resolve(logsDir, year, month, `${year}-${month}-${day}.md`);
}

function isPathInside(filePath: string, root: string): boolean {
  const candidate = normalize(resolve(filePath)).toLowerCase();
  const normalizedRoot = root.toLowerCase();
  return candidate === normalizedRoot ||
    candidate.startsWith(`${normalizedRoot}\\`) ||
    candidate.startsWith(`${normalizedRoot}/`);
}

function selectTurnMessagesFromMessages(
  messages: readonly Message[],
  turnStartMessageId: MessageId | undefined,
): { newMessages: Message[] } | null {
  const startIndex = turnStartMessageId
    ? messages.findIndex((message) => message.id === turnStartMessageId)
    : findLastUserMessageIndex(messages);
  if (startIndex < 0) {
    return null;
  }

  const newMessages = messages
    .slice(startIndex)
    .filter(isLongTermMemorySourceMessage);

  return { newMessages };
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

function hasMemorySaveSince(
  messages: readonly Message[],
  turnStartMessageId: MessageId | undefined,
): boolean {
  const startIndex = turnStartMessageId
    ? messages.findIndex((message) => message.id === turnStartMessageId)
    : 0;
  const scopedMessages = messages.slice(Math.max(0, startIndex));

  return scopedMessages.some((message) =>
    message.role === "assistant" &&
    (message.tool_calls ?? []).some((toolCall) =>
      toolCall.function.name === "MemorySave"
    )
  );
}

function isLongTermMemorySourceMessage(message: Message): boolean {
  return (
    (message.role === "user" || message.role === "assistant") &&
    (message.source === "user" || message.source === "assistant") &&
    getMessageText(message).trim().length > 0
  );
}

function buildLongTermMemoryQuery(messages: readonly Message[]): string {
  const parts: string[] = [];

  for (
    const message of messages
      .filter(isLongTermMemorySourceMessage)
      .slice(-MEMORY_QUERY_RECENT_MESSAGES)
  ) {
    const text = getMessageText(message);
    if (text) {
      parts.push(`${message.role}: ${text}`);
    }
  }

  return truncate(parts.join("\n"), MEMORY_QUERY_MAX_CHARS).trim();
}

function getMessageText(message: Message): string {
  if (message.role === "user") {
    return message.content;
  }

  if (message.role === "assistant") {
    return typeof message.content === "string" ? message.content : "";
  }

  return "";
}

function renderLongTermMemoryFileContext(
  entrypoint: { path: string; content: string },
  memories: readonly LoadedFileMemory[],
  maxChars: number,
): string {
  const lines = [
    "<long_term_memory>",
    "Relevant long-term memories for this request. Use them as context, but prefer newer user messages if there is a conflict.",
    "<memory_index>",
    `source=${entrypoint.path}`,
    entrypoint.content,
    "</memory_index>",
  ];

  if (memories.length > 0) {
    lines.push("<memory_files>");
    for (const memory of memories) {
      lines.push(
        `<memory_file path="${escapeAttribute(memory.filename)}"${
          memory.type ? ` type="${memory.type}"` : ""
        }>`,
        memory.content,
        "</memory_file>",
      );
    }
    lines.push("</memory_files>");
  }

  lines.push("</long_term_memory>");
  return truncate(lines.join("\n"), maxChars);
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
