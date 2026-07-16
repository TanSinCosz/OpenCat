import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AutoCompressState, ToolResultBudgetState } from "../types/context.js";
import { withMessageSize, type Message, type MessageId, type MessageSource } from "../types/messages.js";
import { createState, type State } from "../types/state.js";
import type { Runtime } from "../types/runtime.js";
import type { SessionMemoryState } from "../types/session-memory.js";
import type {
  AgentNotification,
  AgentTask,
  AgentTasksState,
} from "../Tools/Agent/state.js";

const TRANSCRIPT_STORE_VERSION = 1;
const TRANSCRIPT_DIR = ".opencat/transcripts";
const MAX_PERSISTED_AGENT_PROMPT_CHARS = 2_000;
const MAX_PERSISTED_AGENT_RESULT_CHARS = 4_000;
const MAX_PERSISTED_NOTIFICATION_MESSAGE_CHARS = 8_000;
const MAX_PERSISTED_INVOKED_SKILLS = 5;
const MAX_PERSISTED_INVOKED_SKILL_CHARS = 16_000;
const MAX_PERSISTED_INVOKED_SKILLS_TOTAL_CHARS = 48_000;

export type TranscriptSnapshotReason =
  | "agent_notification"
  | "auto_compress"
  | "history_snip"
  | "manual"
  | "mode"
  | "projection"
  | "query"
  | "runtime_context"
  | "session_memory"
  | "todo";

export type TranscriptEntry =
  | TranscriptMessageEntry
  | TranscriptStateSnapshotEntry;

export type TranscriptMessageEntry = TranscriptBaseEntry & {
  type: "message";
  message: Message;
  parentMessageId?: MessageId;
};

export type TranscriptStateSnapshotEntry = TranscriptBaseEntry & {
  type: "state_snapshot";
  reason: TranscriptSnapshotReason;
  state: PersistedStateSnapshot;
};

export type PersistedStateSnapshot = {
  autoCompress?: AutoCompressState;
  historySnips?: State["historySnips"];
  toolResultBudgetState?: PersistedToolResultBudgetState;
  sessionMemory?: SessionMemoryState;
  mode?: State["mode"];
  agentTasks?: AgentTasksState;
  agentNotifications?: AgentNotification[];
  /**
   * Deprecated. Runtime context is per-request projection data and should not
   * be written into new snapshots. Kept optional so older transcripts hydrate.
   */
  runtimeContextMessages?: Message[];
  invokedSkills?: State["invokedSkills"];
  todos?: State["todos"];
  messageCount: number;
  latestMessageId?: MessageId;
};

export type PersistedToolResultBudgetState = {
  seenIds: string[];
  replacements: Array<[string, string]>;
};

type TranscriptBaseEntry = {
  version: typeof TRANSCRIPT_STORE_VERSION;
  sessionId: string;
  agentId: Runtime["agentId"];
  agentRole: Runtime["agentRole"];
  parentAgentId?: Runtime["parentAgentId"];
  agentType?: Runtime["agentType"];
  cwd: string;
  savedAt: number;
};

export interface TranscriptStore {
  readonly path: string;
  appendMessage(
    message: Message,
    options?: { parentMessageId?: MessageId },
  ): Promise<void>;
  appendStateSnapshot(
    state: State,
    reason: TranscriptSnapshotReason,
  ): Promise<void>;
  load(): Promise<TranscriptEntry[]>;
}

export type LoadStateFromTranscriptOptions = {
  hydrate?: "auto" | "full";
};

export type CreateTranscriptStoreOptions = {
  cwd: string;
  sessionId: string;
  agentId: Runtime["agentId"];
  agentRole: Runtime["agentRole"];
  parentAgentId?: Runtime["parentAgentId"];
  agentType?: Runtime["agentType"];
  directory?: string;
};

export function createTranscriptStore(
  options: CreateTranscriptStoreOptions,
): TranscriptStore {
  const directory = options.directory ?? join(options.cwd, TRANSCRIPT_DIR);
  const path = getTranscriptPath(directory, options);

  async function appendEntry(entry: TranscriptEntry): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  function createBaseEntry(): TranscriptBaseEntry {
    return {
      version: TRANSCRIPT_STORE_VERSION,
      sessionId: options.sessionId,
      agentId: options.agentId,
      agentRole: options.agentRole,
      parentAgentId: options.parentAgentId,
      agentType: options.agentType,
      cwd: options.cwd,
      savedAt: Date.now(),
    };
  }

  return {
    path,
    async appendMessage(message, appendOptions = {}) {
      await appendEntry({
        ...createBaseEntry(),
        type: "message",
        message,
        ...appendOptions,
      });
    },
    async appendStateSnapshot(state, reason) {
      await appendEntry({
        ...createBaseEntry(),
        type: "state_snapshot",
        reason,
        state: createPersistedStateSnapshot(state, reason),
      });
    },
    async load() {
      return loadTranscriptEntries(path, options.sessionId);
    },
  };
}

export async function loadTranscriptEntries(
  path: string,
  sessionId?: string,
): Promise<TranscriptEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  const entries: TranscriptEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const entry = parseTranscriptEntry(line);
    if (!entry) {
      continue;
    }

    if (sessionId && entry.sessionId !== sessionId) {
      continue;
    }

    entries.push(entry);
  }

  return entries;
}

/**
 * Rebuilds durable State from transcript facts.
 *
 * Message entries are the source of truth. The latest state snapshot restores
 * compact/session-memory/agent metadata without duplicating the message log.
 */
export async function loadStateFromTranscript(
  store: TranscriptStore,
  options: LoadStateFromTranscriptOptions = {},
): Promise<State | null> {
  const entries = await store.load();
  if (entries.length === 0) {
    return null;
  }

  const latestSnapshot = mergePersistedStateSnapshots(entries);
  const messageEntries = entries.filter(
    (entry): entry is TranscriptMessageEntry => entry.type === "message",
  );
  const messages = hydrateMessagesFromTranscript(
    messageEntries,
    latestSnapshot,
    options.hydrate ?? "auto",
  );

  return createState({
    messages,
    runtimeContextMessages: latestSnapshot?.runtimeContextMessages?.map(
      normalizeHydratedTranscriptMessage,
    ),
    autoCompress: latestSnapshot?.autoCompress,
    historySnips: latestSnapshot?.historySnips,
    toolResultBudgetState: hydrateToolResultBudgetState(
      latestSnapshot?.toolResultBudgetState,
    ),
    sessionMemory: latestSnapshot?.sessionMemory,
    mode: latestSnapshot?.mode,
    agentTasks: latestSnapshot?.agentTasks,
    agentNotifications: latestSnapshot?.agentNotifications,
    invokedSkills: latestSnapshot?.invokedSkills,
    todos: latestSnapshot?.todos,
  });
}

export async function recordTranscriptMessage(
  runtime: Runtime,
  message: Message,
  options?: { parentMessageId?: MessageId },
): Promise<void> {
  await runtime.transcriptStore?.appendMessage(message, options);
}

export async function recordTranscriptStateSnapshot(
  runtime: Runtime,
  state: State,
  reason: TranscriptSnapshotReason,
): Promise<void> {
  await runtime.transcriptStore?.appendStateSnapshot(state, reason);
}

function createPersistedStateSnapshot(
  state: State,
  reason: TranscriptSnapshotReason,
): PersistedStateSnapshot {
  const snapshot: PersistedStateSnapshot = {
    messageCount: state.Messages.length,
    latestMessageId: state.Messages.at(-1)?.id,
  };

  switch (reason) {
    case "auto_compress":
      snapshot.autoCompress = state.autoCompress;
      snapshot.historySnips = state.historySnips;
      snapshot.toolResultBudgetState = persistToolResultBudgetState(
        state.toolResultBudgetState,
      );
      snapshot.sessionMemory = state.sessionMemory;
      snapshot.invokedSkills = persistInvokedSkills(state.invokedSkills);
      return snapshot;
    case "history_snip":
      snapshot.historySnips = state.historySnips;
      return snapshot;
    case "projection":
      snapshot.toolResultBudgetState = persistToolResultBudgetState(
        state.toolResultBudgetState,
      );
      return snapshot;
    case "runtime_context":
    case "agent_notification":
      snapshot.agentNotifications = persistAgentNotifications(
        state.agentNotifications,
      );
      return snapshot;
    case "session_memory":
      snapshot.sessionMemory = state.sessionMemory;
      return snapshot;
    case "mode":
      snapshot.mode = state.mode;
      return snapshot;
    case "todo":
      snapshot.todos = state.todos;
      return snapshot;
    case "manual":
    case "query":
      snapshot.autoCompress = state.autoCompress;
      snapshot.historySnips = state.historySnips;
      snapshot.toolResultBudgetState = persistToolResultBudgetState(
        state.toolResultBudgetState,
      );
      snapshot.sessionMemory = state.sessionMemory;
      snapshot.mode = state.mode;
      snapshot.agentTasks = persistAgentTasks(state.agentTasks);
      snapshot.agentNotifications = persistAgentNotifications(
        state.agentNotifications,
      );
      snapshot.invokedSkills = persistInvokedSkills(state.invokedSkills);
      snapshot.todos = state.todos;
      return snapshot;
  }
}

function persistAgentTasks(tasks: AgentTasksState): AgentTasksState {
  const persisted: AgentTasksState = {};

  for (const [id, task] of Object.entries(tasks)) {
    persisted[id] = persistAgentTask(task);
  }

  return persisted;
}

function persistAgentTask(task: AgentTask): AgentTask {
  return {
    ...task,
    description: limitString(task.description, MAX_PERSISTED_AGENT_PROMPT_CHARS),
    prompt: limitString(task.prompt, MAX_PERSISTED_AGENT_PROMPT_CHARS),
    result: task.result === undefined
      ? undefined
      : limitString(task.result, MAX_PERSISTED_AGENT_RESULT_CHARS),
    error: task.error === undefined
      ? undefined
      : limitString(task.error, MAX_PERSISTED_AGENT_RESULT_CHARS),
    pendingMessages: task.pendingMessages.map((message) =>
      limitString(message, MAX_PERSISTED_NOTIFICATION_MESSAGE_CHARS)
    ),
  };
}

function persistAgentNotifications(
  notifications: readonly AgentNotification[],
): AgentNotification[] {
  return notifications.map((notification) => ({
    ...notification,
    description: limitString(
      notification.description,
      MAX_PERSISTED_AGENT_PROMPT_CHARS,
    ),
    message: limitString(
      notification.message,
      MAX_PERSISTED_NOTIFICATION_MESSAGE_CHARS,
    ),
  }));
}

function persistInvokedSkills(
  skills: readonly State["invokedSkills"][number][],
): State["invokedSkills"] {
  const persisted: State["invokedSkills"] = [];
  let remaining = MAX_PERSISTED_INVOKED_SKILLS_TOTAL_CHARS;

  for (const skill of [...skills].sort((left, right) =>
    right.invokedAt - left.invokedAt
  )) {
    if (persisted.length >= MAX_PERSISTED_INVOKED_SKILLS || remaining <= 0) {
      break;
    }

    const content = limitString(
      skill.content,
      Math.min(MAX_PERSISTED_INVOKED_SKILL_CHARS, remaining),
    );
    persisted.push({ ...skill, content });
    remaining -= content.length;
  }

  return persisted;
}

function limitString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const suffix = "\n[Persisted state truncated]";
  const contentLength = Math.max(0, maxChars - suffix.length);
  return `${value.slice(0, contentLength)}${suffix}`;
}

function persistToolResultBudgetState(
  state: ToolResultBudgetState,
): PersistedToolResultBudgetState {
  return {
    seenIds: [...state.seenIds],
    replacements: [...state.replacements.entries()],
  };
}

function hydrateToolResultBudgetState(
  state: PersistedToolResultBudgetState | undefined,
): ToolResultBudgetState | undefined {
  if (!state) {
    return undefined;
  }

  return {
    seenIds: new Set(state.seenIds),
    replacements: new Map(state.replacements),
  };
}

function mergePersistedStateSnapshots(
  entries: readonly TranscriptEntry[],
): PersistedStateSnapshot | undefined {
  let merged: PersistedStateSnapshot | undefined;

  for (const entry of entries) {
    if (entry.type !== "state_snapshot") {
      continue;
    }

    const snapshot = entry.state;
    merged ??= {
      messageCount: snapshot.messageCount,
      latestMessageId: snapshot.latestMessageId,
    };

    // State snapshots are now reason-scoped patches. Keep the newest value for
    // every durable field while allowing old full snapshots to hydrate normally.
    merged.messageCount = snapshot.messageCount;
    merged.latestMessageId = snapshot.latestMessageId;
    if (snapshot.autoCompress !== undefined) {
      merged.autoCompress = snapshot.autoCompress;
    }
    if (snapshot.historySnips !== undefined) {
      merged.historySnips = snapshot.historySnips;
    }
    if (snapshot.toolResultBudgetState !== undefined) {
      merged.toolResultBudgetState = snapshot.toolResultBudgetState;
    }
    if (snapshot.sessionMemory !== undefined) {
      merged.sessionMemory = snapshot.sessionMemory;
    }
    if (snapshot.mode !== undefined) {
      merged.mode = snapshot.mode;
    }
    if (snapshot.agentTasks !== undefined) {
      merged.agentTasks = snapshot.agentTasks;
    }
    if (snapshot.agentNotifications !== undefined) {
      merged.agentNotifications = snapshot.agentNotifications;
    }
    if (snapshot.runtimeContextMessages !== undefined) {
      merged.runtimeContextMessages = snapshot.runtimeContextMessages;
    }
    if (snapshot.invokedSkills !== undefined) {
      merged.invokedSkills = snapshot.invokedSkills;
    }
    if (snapshot.todos !== undefined) {
      merged.todos = snapshot.todos;
    }
  }

  return merged;
}

function hydrateMessagesFromTranscript(
  messageEntries: TranscriptMessageEntry[],
  latestSnapshot: PersistedStateSnapshot | undefined,
  hydrate: LoadStateFromTranscriptOptions["hydrate"],
): Message[] {
  const hydratedMessages = hydrateTranscriptMessages(messageEntries);

  if (hydrate === "full") {
    return hydratedMessages;
  }

  const throughMessageId = getActiveAutoCompressThroughMessageId(
    latestSnapshot,
  );
  if (!throughMessageId) {
    return hydratedMessages;
  }

  const throughIndex = hydratedMessages.findIndex(
    (message) => message.id === throughMessageId,
  );
  if (throughIndex === -1) {
    return hydratedMessages;
  }

  return hydratedMessages.slice(throughIndex + 1);
}

function hydrateTranscriptMessages(
  messageEntries: TranscriptMessageEntry[],
): Message[] {
  return messageEntries
    .map((entry) => normalizeHydratedTranscriptMessage(entry.message))
    .filter((message) => !isEmptyProjectionContextMessage(message));
}

function normalizeHydratedTranscriptMessage(message: Message): Message {
  const normalized = stripDynamicSkillContextBlocksFromMessage(
    ensureHydratedMessageSource(message),
  );

  if (
    normalized.role !== "assistant" ||
    normalized.content ||
    (normalized.tool_calls?.length ?? 0) > 0 ||
    !normalized.reasoning_content
  ) {
    return withMessageSize(normalized);
  }

  return withMessageSize({
    ...normalized,
    content: [
      "The model returned internal reasoning but did not produce a final answer.",
      "This older transcript entry was recovered so the session can continue.",
    ].join(" "),
  });
}

function stripDynamicSkillContextBlocksFromMessage(message: Message): Message {
  if (
    message.role !== "user" ||
    message.name !== "opencat_context" ||
    typeof message.content !== "string"
  ) {
    return message;
  }

  const content = stripDynamicSkillContextBlocks(message.content);
  if (content === message.content) {
    return message;
  }

  return withMessageSize({ ...message, content });
}

function stripDynamicSkillContextBlocks(content: string): string {
  return content
    .replace(
      /(?:\r?\n)?<context_block source="dynamic_skill">[\s\S]*?<\/context_block>(?:\r?\n)?/g,
      "\n",
    )
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n<\/opencat_context>/, "\n</opencat_context>");
}

function isEmptyProjectionContextMessage(message: Message): boolean {
  return (
    message.role === "user" &&
    message.name === "opencat_context" &&
    typeof message.content === "string" &&
    !message.content.includes("<context_block source=")
  );
}

function ensureHydratedMessageSource(message: Message): Message {
  if (message.source) {
    return message;
  }

  return {
    ...message,
    source: getDefaultHydratedMessageSource(message),
  };
}

function getDefaultHydratedMessageSource(message: Message): MessageSource {
  switch (message.role) {
    case "system":
      return "system";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
  }
}

function getActiveAutoCompressThroughMessageId(
  snapshot: PersistedStateSnapshot | undefined,
): MessageId | undefined {
  return snapshot?.autoCompress?.summaries.at(-1)?.throughMessageId;
}

function parseTranscriptEntry(line: string): TranscriptEntry | null {
  try {
    const value = JSON.parse(line) as Partial<TranscriptEntry>;
    if (
      value.version !== TRANSCRIPT_STORE_VERSION ||
      typeof value.sessionId !== "string" ||
      typeof value.agentId !== "string" ||
      typeof value.agentRole !== "string" ||
      typeof value.cwd !== "string" ||
      typeof value.savedAt !== "number"
    ) {
      return null;
    }

    if (value.type === "message" && value.message) {
      return value as TranscriptMessageEntry;
    }

    if (value.type === "state_snapshot" && value.state) {
      return value as TranscriptStateSnapshotEntry;
    }

    return null;
  } catch {
    return null;
  }
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getTranscriptPath(
  directory: string,
  options: CreateTranscriptStoreOptions,
): string {
  const safeSessionId = sanitizeSessionId(options.sessionId);
  if (options.agentRole === "main") {
    return join(directory, `${safeSessionId}.jsonl`);
  }

  if (options.agentRole === "session") {
    return join(
      directory,
      safeSessionId,
      "session-agents",
      `agent-${sanitizeSessionId(options.agentId)}.jsonl`,
    );
  }

  return join(
    directory,
    safeSessionId,
    "subagents",
    `agent-${sanitizeSessionId(options.agentId)}.jsonl`,
  );
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === code;
}
