import { randomUUID } from "node:crypto";
import {
  isSessionMemoryEmpty,
  truncateSessionMemoryForCompact,
} from "../session-memory/prompts.js";
import {
  loadPersistedSessionMemory,
} from "../session-memory/persistence.js";
import { updateSessionMemoryForAutoCompress } from "../session-memory/session-memory.js";
import { restoreReadFileStateAfterAutoCompress } from "./read-file-restore.js";
import type {
  AutoCompressState,
  AutoCompressSummary,
  AutoCompressSummaryId,
} from "../types/context.js";
import {
  toDeepSeekMessage,
  type Message,
  type MessageId,
  type UserMessage,
} from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";

const TARGET_RECENT_TAIL_TOKENS = 30_000;
const MAX_RECENT_TAIL_TOKENS = 40_000;
const MIN_RECENT_TEXT_MESSAGES = 5;
const MIN_RECENT_API_MESSAGES = 12;

export type AutoCompressResult =
  | AutoCompressCompressedResult
  | { status: "skipped"; reason: string };

type AutoCompressCompressedResult = {
  status: "compressed";
  summary: AutoCompressSummary;
};

/**
 * Runs the durable auto-compress step against State.
 *
 * The caller is responsible for deciding that the current projection is too
 * large. This function only prepares session memory and records an
 * AutoCompressSummary that a later projection pass can render into the request.
 */
export async function applyAutoCompression(
  runtime: Runtime,
  state: State,
): Promise<AutoCompressResult> {
  const autoCompress = ensureAutoCompressState(state);
  await loadPersistedSessionMemory(runtime, state);
  resetSessionMemoryUpdateFlagIfSummaryHasTail(autoCompress, state);

  const existingSummary = createSessionMemoryAutoCompressSummary(state);
  if (existingSummary && isSummaryCurrentForLatestMessage(existingSummary, state)) {
    const result = activateAutoCompressSummary(autoCompress, existingSummary);
    await restoreReadFileStateAfterAutoCompress(
      runtime,
      state,
      result.summary.id,
      projectMessagesWithAutoCompress(state),
    );
    return result;
  }

  if (!autoCompress.sessionMemoryUpdated) {
    const updateResult = await updateSessionMemoryForAutoCompress(runtime, state);
    if (updateResult.status === "updated") {
      autoCompress.sessionMemoryUpdated = true;
    } else {
      return updateResult;
    }
  }

  const summary = createSessionMemoryAutoCompressSummary(state);
  if (!summary) {
    if (existingSummary) {
      const result = activateAutoCompressSummary(autoCompress, existingSummary);
      await restoreReadFileStateAfterAutoCompress(
        runtime,
        state,
        result.summary.id,
        projectMessagesWithAutoCompress(state),
      );
      return result;
    }
    return { status: "skipped", reason: "session_memory_not_usable" };
  }

  const result = activateAutoCompressSummary(autoCompress, summary);
  await restoreReadFileStateAfterAutoCompress(
    runtime,
    state,
    result.summary.id,
    projectMessagesWithAutoCompress(state),
  );
  return result;
}

export function ensureAutoCompressState(state: State): AutoCompressState {
  state.autoCompress ??= { summaries: [], sessionMemoryUpdated: false };
  state.autoCompress.sessionMemoryUpdated ??= false;
  state.autoCompress.summaries ??= [];
  return state.autoCompress;
}

/**
 * Projects durable State messages into the post-compress request view.
 *
 * Older messages covered by the active summary are represented by one compact
 * summary message. The recent tail is kept verbatim using token budget as the
 * primary control, with message counts only acting as thin-context guards.
 */
export function projectMessagesWithAutoCompress(state: State): Message[] {
  const summary = getActiveAutoCompressSummary(state);
  if (!summary?.throughMessageId) {
    return state.Messages;
  }

  const throughIndex = state.Messages.findIndex(
    (message) => message.id === summary.throughMessageId,
  );
  if (throughIndex === -1) {
    const summaryMessageId = `msg_${summary.id}`;
    if (state.Messages[0]?.id === summaryMessageId) {
      return state.Messages;
    }

    return [
      createAutoCompressSummaryMessage(summary),
      ...state.Messages,
    ];
  }

  const tailStart = calculateRecentTailStart(state.Messages, throughIndex);
  const summaryMessage = createAutoCompressSummaryMessage(summary);

  return [
    summaryMessage,
    ...state.Messages.slice(tailStart),
  ];
}

function createSessionMemoryAutoCompressSummary(
  state: State,
): AutoCompressSummary | null {
  const sessionMemory = state.sessionMemory;
  const throughMessageId = sessionMemory.lastSummarizedMessageId;

  if (
    sessionMemory.status !== "ready" ||
    !throughMessageId ||
    isSessionMemoryEmpty(sessionMemory.content)
  ) {
    return null;
  }

  const throughIndex = state.Messages.findIndex(
    (message) => message.id === throughMessageId,
  );
  if (throughIndex === -1) {
    return null;
  }

  return {
    id: createAutoCompressSummaryId(),
    content: renderSessionMemorySummary(sessionMemory.content),
    fromMessageId: state.Messages[0]?.id,
    throughMessageId,
    messageCount: throughIndex + 1,
    createdAt: Date.now(),
  };
}

function resetSessionMemoryUpdateFlagIfSummaryHasTail(
  autoCompress: AutoCompressState,
  state: State,
): void {
  const activeSummary = getActiveAutoCompressSummary(state);
  if (
    activeSummary?.throughMessageId &&
    !isSummaryCurrentForLatestMessage(activeSummary, state)
  ) {
    autoCompress.sessionMemoryUpdated = false;
  }
}

function isSummaryCurrentForLatestMessage(
  summary: AutoCompressSummary,
  state: State,
): boolean {
  return summary.throughMessageId === state.Messages.at(-1)?.id;
}

function renderSessionMemorySummary(sessionMemory: string): string {
  const { truncatedContent, wasTruncated } =
    truncateSessionMemoryForCompact(sessionMemory);
  const lines = [
    "This session is being continued from a previous conversation that ran out of context. The session memory below covers the earlier portion of the conversation.",
    "",
    "<session_memory>",
    truncatedContent.trim(),
    "</session_memory>",
    "",
    "Recent messages after this summary are preserved verbatim.",
  ];

  if (wasTruncated) {
    lines.push(
      "",
      "Some session memory sections were truncated for length. Use the full session memory source if exact older details are needed.",
    );
  }

  return lines.join("\n");
}

function findSummaryIndexByThroughMessageId(
  autoCompress: AutoCompressState,
  throughMessageId: MessageId | undefined,
): number {
  if (!throughMessageId) {
    return -1;
  }

  return autoCompress.summaries.findIndex(
    (summary) => summary.throughMessageId === throughMessageId,
  );
}

function activateAutoCompressSummary(
  autoCompress: AutoCompressState,
  summary: AutoCompressSummary,
): AutoCompressCompressedResult {
  const existingIndex = findSummaryIndexByThroughMessageId(
    autoCompress,
    summary.throughMessageId,
  );
  if (existingIndex !== -1) {
    const [existing] = autoCompress.summaries.splice(existingIndex, 1);
    if (!existing) {
      throw new Error("Auto-compress summary index disappeared during activation.");
    }

    autoCompress.summaries.push(existing);
    return { status: "compressed", summary: existing };
  }

  autoCompress.summaries.push(summary);
  return { status: "compressed", summary };
}

function createAutoCompressSummaryId(): AutoCompressSummaryId {
  return `autocompress_${randomUUID()}`;
}

function getActiveAutoCompressSummary(
  state: State,
): AutoCompressSummary | undefined {
  return state.autoCompress?.summaries.at(-1);
}

function createAutoCompressSummaryMessage(
  summary: AutoCompressSummary,
): UserMessage {
  return {
    role: "user",
    content: summary.content,
    id: `msg_${summary.id}`,
    createdAt: summary.createdAt,
    source: "auto_compress",
  };
}

type RecentTailStats = {
  tokens: number;
  apiMessages: number;
  textMessages: number;
};

function calculateRecentTailStart(
  messages: Message[],
  throughIndex: number,
): number {
  let start = Math.min(throughIndex + 1, messages.length);
  const stats = calculateRecentTailStats(messages, start);

  while (start > 0) {
    if (isRecentTailLargeEnough(stats)) {
      break;
    }

    if (stats.tokens >= MAX_RECENT_TAIL_TOKENS) {
      break;
    }

    start--;
    addMessageToRecentTailStats(stats, messages[start]!);
  }

  return moveToSafeRecentTailBoundary(messages, start);
}

function isRecentTailLargeEnough(stats: RecentTailStats): boolean {
  return (
    stats.tokens >= TARGET_RECENT_TAIL_TOKENS &&
    stats.apiMessages >= MIN_RECENT_API_MESSAGES &&
    stats.textMessages >= MIN_RECENT_TEXT_MESSAGES
  );
}

function calculateRecentTailStats(
  messages: Message[],
  start: number,
): RecentTailStats {
  const stats: RecentTailStats = {
    tokens: 0,
    apiMessages: 0,
    textMessages: 0,
  };

  for (let index = start; index < messages.length; index++) {
    addMessageToRecentTailStats(stats, messages[index]!);
  }

  return stats;
}

function addMessageToRecentTailStats(
  stats: RecentTailStats,
  message: Message,
): void {
  stats.tokens += estimateMessageTokens(message);
  stats.apiMessages++;
  if (hasTextContent(message)) {
    stats.textMessages++;
  }
}

function estimateMessageTokens(message: Message): number {
  return Math.ceil(JSON.stringify(toDeepSeekMessage(message)).length / 4);
}

function hasTextContent(message: Message): boolean {
  if (message.role === "user") {
    return message.content.trim().length > 0;
  }

  if (message.role === "assistant") {
    return typeof message.content === "string" && message.content.trim().length > 0;
  }

  return false;
}

function moveToSafeRecentTailBoundary(
  messages: Message[],
  start: number,
): number {
  let safeStart = start;

  while (safeStart > 0) {
    const missingToolCallIds = findMissingToolCallIds(messages, safeStart);
    if (missingToolCallIds.size === 0) {
      break;
    }

    const toolCallIndex = findPreviousToolCallIndex(
      messages,
      safeStart - 1,
      missingToolCallIds,
    );
    if (toolCallIndex === -1) {
      break;
    }

    safeStart = toolCallIndex;
  }

  while (safeStart > 0 && messages[safeStart]?.role === "tool") {
    safeStart--;
  }

  return safeStart;
}

function findMissingToolCallIds(
  messages: Message[],
  start: number,
): Set<string> {
  const toolResultIds = new Set<string>();
  const keptToolCallIds = new Set<string>();

  for (let index = start; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "tool") {
      toolResultIds.add(message.tool_call_id);
      continue;
    }

    if (message.role === "assistant") {
      for (const toolCall of message.tool_calls ?? []) {
        keptToolCallIds.add(toolCall.id);
      }
    }
  }

  for (const toolCallId of keptToolCallIds) {
    toolResultIds.delete(toolCallId);
  }

  return toolResultIds;
}

function findPreviousToolCallIndex(
  messages: Message[],
  fromIndex: number,
  toolCallIds: ReadonlySet<string>,
): number {
  for (let index = fromIndex; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant") {
      continue;
    }

    if (message.tool_calls?.some((toolCall) => toolCallIds.has(toolCall.id))) {
      return index;
    }
  }

  return -1;
}
