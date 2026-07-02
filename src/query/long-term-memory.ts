import type { DeepSeekMessage } from "../deepseek/types.js";
import type { Message as MemoryInputMessage } from "../Memory/type.js";
import { getOrCreateLongTermMemory } from "../Memory/runtime.js";
import { searchLongTermMemory } from "../Memory/runtime.js";
import { loadStateFromTranscript } from "../transcript/persistence.js";
import { emitRunEvent } from "../telemetry/observer.js";
import type { Message, MessageId } from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";

const MEMORY_QUERY_RECENT_MESSAGES = 6;
const MEMORY_QUERY_MAX_CHARS = 4_000;
const LONG_TERM_MEMORY_CONTEXT_MESSAGES = 20;

/**
 * Builds a transient model-visible memory block.
 *
 * This deliberately returns a projection message instead of mutating
 * State.Messages: long-term memory is external context, not part of the
 * authoritative conversation transcript.
 */
export async function createLongTermMemoryContextMessage(
  runtime: Runtime,
  projectedMessages: readonly Message[],
): Promise<DeepSeekMessage | null> {
  const config = runtime.longTermMemoryConfig;
  if (!config.enabled || !config.autoInject) {
    return null;
  }

  const query = buildLongTermMemoryQuery(projectedMessages);
  if (!query) {
    return null;
  }

  try {
    const result = await searchLongTermMemory(runtime, query, {
      topK: config.autoInjectTopK,
      threshold: config.searchThreshold,
      scope: "user",
    });

    if (result.results.length === 0) {
      return null;
    }

    const content = renderLongTermMemoryContext(
      result.results,
      config.maxInjectedChars,
    );
    await emitRunEvent(runtime, {
      type: "long_term_memory_injected",
      queryChars: query.length,
      resultCount: result.results.length,
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

  const turn = await resolveLongTermMemoryTurnMessages(runtime, state, options);
  if (!turn) {
    return { status: "skipped", reason: "turn_messages_missing" };
  }

  const newMessages = toMemoryInputMessages(turn.newMessages);
  if (newMessages.length === 0) {
    return { status: "skipped", reason: "no_extractable_messages" };
  }

  const memory = getOrCreateLongTermMemory(runtime);
  if (!memory) {
    return { status: "skipped", reason: "memory_disabled" };
  }

  try {
    const result = await memory.add(newMessages, {
      infer: true,
      userId: config.userId,
      agentId: config.agentId,
      runId: config.runId,
      contextMessages: toMemoryInputMessages(turn.contextMessages),
      observationDate: formatDate(options.turnStartedAt ?? Date.now()),
      currentDate: formatDate(Date.now()),
      metadata: {
        source: "auto_long_term_memory",
        sessionId: runtime.sessionId,
        turnStartMessageId: turn.newMessages[0]?.id,
        turnEndMessageId: turn.newMessages.at(-1)?.id,
      },
    });

    return {
      status: "extracted",
      count: result.results.length,
      source: turn.source,
    };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveLongTermMemoryTurnMessages(
  runtime: Runtime,
  state: State,
  options: { turnStartMessageId?: MessageId },
): Promise<
  | {
    source: "state" | "transcript";
    newMessages: Message[];
    contextMessages: Message[];
  }
  | null
> {
  const fromState = selectTurnMessagesFromMessages(
    state.Messages,
    options.turnStartMessageId,
  );
  if (fromState) {
    return { source: "state", ...fromState };
  }

  if (!runtime.transcriptStore) {
    return null;
  }

  const fullState = await loadStateFromTranscript(runtime.transcriptStore, {
    hydrate: "full",
  });
  if (!fullState) {
    return null;
  }

  const fromTranscript = selectTurnMessagesFromMessages(
    fullState.Messages,
    options.turnStartMessageId,
  );
  return fromTranscript
    ? { source: "transcript", ...fromTranscript }
    : null;
}

function selectTurnMessagesFromMessages(
  messages: readonly Message[],
  turnStartMessageId: MessageId | undefined,
): { newMessages: Message[]; contextMessages: Message[] } | null {
  const startIndex = turnStartMessageId
    ? messages.findIndex((message) => message.id === turnStartMessageId)
    : findLastUserMessageIndex(messages);
  if (startIndex < 0) {
    return null;
  }

  const newMessages = messages
    .slice(startIndex)
    .filter(isLongTermMemorySourceMessage);
  const contextMessages = messages
    .slice(0, startIndex)
    .filter(isLongTermMemorySourceMessage)
    .slice(-LONG_TERM_MEMORY_CONTEXT_MESSAGES);

  return { newMessages, contextMessages };
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

function isLongTermMemorySourceMessage(message: Message): boolean {
  return (
    (message.role === "user" || message.role === "assistant") &&
    (message.source === "user" || message.source === "assistant") &&
    getMessageText(message).trim().length > 0
  );
}

function toMemoryInputMessages(
  messages: readonly Message[],
): MemoryInputMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: getMessageText(message),
  })).filter((message) => message.content.trim().length > 0);
}

function formatDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
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

type RenderableMemory = {
  id: string;
  memory: string;
  score?: number;
};

function renderLongTermMemoryContext(
  memories: readonly RenderableMemory[],
  maxChars: number,
): string {
  const lines = [
    "<long_term_memory>",
    "Relevant long-term memories retrieved for this request. Use them as context, but prefer newer user messages if there is a conflict.",
  ];

  for (const memory of memories) {
    const score = typeof memory.score === "number"
      ? ` score=${memory.score.toFixed(3)}`
      : "";
    lines.push(`- id=${memory.id}${score}: ${memory.memory}`);
  }

  lines.push("</long_term_memory>");
  return truncate(lines.join("\n"), maxChars);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars))}\n[Long-term memory truncated]`;
}
