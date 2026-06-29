import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AutoCompressState } from "../types/context.js";
import type { Message, MessageId, MessageSource } from "../types/messages.js";
import { createState, type State } from "../types/state.js";
import type { Runtime } from "../types/runtime.js";
import type { SessionMemoryState } from "../types/session-memory.js";
import type {
  AgentNotification,
  AgentTasksState,
} from "../Tools/Agent/state.js";

const TRANSCRIPT_STORE_VERSION = 1;
const TRANSCRIPT_DIR = ".opencat/transcripts";

export type TranscriptSnapshotReason =
  | "agent_notification"
  | "auto_compress"
  | "manual"
  | "query"
  | "runtime_context"
  | "session_memory";

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
  autoCompress: AutoCompressState;
  sessionMemory: SessionMemoryState;
  mode: State["mode"];
  agentTasks: AgentTasksState;
  agentNotifications: AgentNotification[];
  runtimeContextMessages: Message[];
  messageCount: number;
  latestMessageId?: MessageId;
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
        state: createPersistedStateSnapshot(state),
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

  const latestSnapshot = entries
    .filter((entry): entry is TranscriptStateSnapshotEntry =>
      entry.type === "state_snapshot"
    )
    .at(-1)?.state;
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
    sessionMemory: latestSnapshot?.sessionMemory,
    mode: latestSnapshot?.mode,
    agentTasks: latestSnapshot?.agentTasks,
    agentNotifications: latestSnapshot?.agentNotifications,
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

function createPersistedStateSnapshot(state: State): PersistedStateSnapshot {
  return {
    autoCompress: state.autoCompress,
    sessionMemory: state.sessionMemory,
    mode: state.mode,
    agentTasks: state.agentTasks,
    agentNotifications: state.agentNotifications,
    runtimeContextMessages: state.runtimeContextMessages,
    messageCount: state.Messages.length,
    latestMessageId: state.Messages.at(-1)?.id,
  };
}

function hydrateMessagesFromTranscript(
  messageEntries: TranscriptMessageEntry[],
  latestSnapshot: PersistedStateSnapshot | undefined,
  hydrate: LoadStateFromTranscriptOptions["hydrate"],
): Message[] {
  if (hydrate === "full") {
    return messageEntries.map((entry) =>
      normalizeHydratedTranscriptMessage(entry.message)
    );
  }

  const throughMessageId = getActiveAutoCompressThroughMessageId(
    latestSnapshot,
  );
  if (!throughMessageId) {
    return messageEntries.map((entry) =>
      normalizeHydratedTranscriptMessage(entry.message)
    );
  }

  const throughIndex = messageEntries.findIndex(
    (entry) => entry.message.id === throughMessageId,
  );
  if (throughIndex === -1) {
    return messageEntries.map((entry) =>
      normalizeHydratedTranscriptMessage(entry.message)
    );
  }

  return messageEntries
    .slice(throughIndex + 1)
    .map((entry) => normalizeHydratedTranscriptMessage(entry.message));
}

function normalizeHydratedTranscriptMessage(message: Message): Message {
  const normalized = ensureHydratedMessageSource(message);

  if (
    normalized.role !== "assistant" ||
    normalized.content ||
    (normalized.tool_calls?.length ?? 0) > 0 ||
    !normalized.reasoning_content
  ) {
    return normalized;
  }

  return {
    ...normalized,
    content: [
      "The model returned internal reasoning but did not produce a final answer.",
      "This older transcript entry was recovered so the session can continue.",
    ].join(" "),
  };
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
  const autoCompress = snapshot?.autoCompress;
  const activeSummaryId = autoCompress?.activeSummaryId;
  if (!activeSummaryId) {
    return undefined;
  }

  return autoCompress.summaries.find((summary) => summary.id === activeSummaryId)
    ?.throughMessageId;
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
