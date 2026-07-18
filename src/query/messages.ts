import { createHash, randomUUID } from "node:crypto";
import type { DeepSeekMessage } from "../deepseek/types.js";
import { applyAutoCompressSummary } from "../auto-compress/index.js";
import {
  buildSystemPrompt,
  appendSystemContext,
  getOrCreateSystemContext,
  getOrCreateUserContext,
  prependUserContextMessages,
} from "../system-prompt.js";
import type {
  HistorySnipBoundary,
  HistorySnipId,
  ToolResultBudgetState,
} from "../types/context.js";
import {
  estimateDeepSeekMessageSize,
  toDeepSeekMessage,
  type Message,
  type MessageId,
  withMessageSize,
} from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import type { MessageProjectionStats, MessagesForQuery } from "./types.js";

const BULKY_TOOL_RESULT_COMPACT_TAG = "<tool-result-compact>";
const BULKY_TOOL_NAMES = new Set([
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Glob",
  "WebFetch",
  "ReadSkill",
]);
const DEFAULT_HISTORY_SNIP_TARGET_TOKENS = 80_000;
const DEFAULT_HISTORY_SNIP_CANCEL_CONTEXT_TOKENS = 120_000;
const DEFAULT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS = 180_000;
const DEFAULT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS = 80_000;
const BULKY_TOOL_RESULT_COMPACT_PREVIEW_TOKENS = 1_000;
const DEFAULT_PROJECTION_RECENT_TAIL_TARGET_TOKENS = 30_000;
const DEFAULT_PROJECTION_RECENT_TAIL_MAX_TOKENS = 40_000;
const DEFAULT_PROJECTION_RECENT_TAIL_MIN_API_MESSAGES = 12;
const DEFAULT_PROJECTION_RECENT_TAIL_MIN_USER_CONTENT_MESSAGES = 3;
const TOOL_RESULT_BUDGET_TAG = "<tool-result-budget>";

export type SnippedContentOnlyStats = {
  tokens: number;
  messageCount: number;
  lastMessageId?: MessageId;
};

export async function buildMessagesForQuery(
  runtime: Runtime,
  state: State,
): Promise<MessagesForQuery> {
  const systemPrompt = await getOrCreateSystemPrompt(runtime);
  let historySnipCount = 0;

  let projection = await projectMessagesWithExistingCompressionState(
    runtime,
    state,
    systemPrompt,
  );
  let visibleMessages = projection.visibleMessages;
  let deepSeekMessages = projection.deepSeekMessages;
  let stats = projection.stats;
  let toolResultBudgetSnapshotBeforeNewBulky:
    | ToolResultBudgetStateSnapshot
    | null = null;

  // Create new bulky replacements only when the whole request crosses the
  // threshold. Existing replacements are applied above on every build.
  if (isContextOverBulkyCompactThreshold(deepSeekMessages)) {
    toolResultBudgetSnapshotBeforeNewBulky = snapshotToolResultBudgetState(
      runtime,
      state,
    );
    const compacted = createBulkyToolCompactionsWithStats(
      visibleMessages,
      runtime,
      state,
      estimateSystemPromptTokens(systemPrompt),
    );
    visibleMessages = compacted.messages;
    stats = {
      ...stats,
      bulkyToolCompactNeeded: compacted.stats.bulkyToolCompactNeeded,
      bulkyToolCompactCount:
        stats.bulkyToolCompactCount + compacted.stats.bulkyToolCompactCount,
      toolResultCharsAfterCompact: compacted.stats.toolResultCharsAfterCompact,
    };
    deepSeekMessages = await createDeepSeekMessages({
      runtime,
      systemPrompt,
      messages: visibleMessages,
    });
  }

  // If bulky compaction cannot reach the target, progressively create snip
  // boundaries. If that still leaves the request too large, roll back the new
  // snips and let auto-compress handle the older context later.
  const historySnips = ensureHistorySnips(state);
  const historySnipStartCount = historySnips.length;
  if (shouldCreateHistorySnipBoundary(
    state,
    visibleMessages,
    stats,
    deepSeekMessages,
  )) {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (!isContextOverBulkyCompactTarget(deepSeekMessages)) {
        break;
      }

      const historySnipBoundary = createHistorySnipBoundary(
        deepSeekMessages,
        visibleMessages,
      );
      if (!historySnipBoundary) {
        break;
      }

      historySnips.push(historySnipBoundary);
      historySnipCount++;

      projection = await projectMessagesWithExistingCompressionState(
        runtime,
        state,
        systemPrompt,
      );
      visibleMessages = projection.visibleMessages;
      deepSeekMessages = projection.deepSeekMessages;
      stats = projection.stats;
    }

    if (
      historySnipCount > 0 &&
      isContextOverHistorySnipCancelThreshold(deepSeekMessages)
    ) {
      historySnips.splice(historySnipStartCount);
      if (toolResultBudgetSnapshotBeforeNewBulky) {
        restoreToolResultBudgetState(
          runtime,
          state,
          toolResultBudgetSnapshotBeforeNewBulky,
        );
      }
      historySnipCount = 0;

      projection = await projectMessagesWithExistingCompressionState(
        runtime,
        state,
        systemPrompt,
      );
      visibleMessages = projection.visibleMessages;
      deepSeekMessages = projection.deepSeekMessages;
      stats = projection.stats;
    }
  }

  return {
    systemPrompt,
    messages: deepSeekMessages,
    forkContextMessages: cloneMessages(visibleMessages),
    stats: {
      ...stats,
      historySnipCount,
    },
  };
}

type ToolResultBudgetStateSnapshot = {
  seenIds: Set<string>;
  replacements: Map<string, string>;
};

function snapshotToolResultBudgetState(
  runtime: Runtime,
  state: State,
): ToolResultBudgetStateSnapshot {
  const budgetState = getOrCreateToolResultBudgetState(runtime, state);
  return {
    seenIds: new Set(budgetState.seenIds),
    replacements: new Map(budgetState.replacements),
  };
}

function restoreToolResultBudgetState(
  runtime: Runtime,
  state: State,
  snapshot: ToolResultBudgetStateSnapshot,
): void {
  state.toolResultBudgetState.seenIds = new Set(snapshot.seenIds);
  state.toolResultBudgetState.replacements = new Map(snapshot.replacements);
  runtime.toolResultBudgetState = state.toolResultBudgetState;
}

async function projectMessagesWithExistingCompressionState(
  runtime: Runtime,
  state: State,
  systemPrompt: string,
): Promise<{
  visibleMessages: Message[];
  deepSeekMessages: DeepSeekMessage[];
  stats: MessageProjectionStats;
}> {
  const projectedMessages = cloneMessages(applyAutoCompressSummary(state));
  const budgeted = applyExistingToolResultBudgetWithStats(
    projectedMessages,
    runtime,
    state,
  );
  const compacted = applyExistingBulkyToolCompactionsWithStats(
    budgeted.messages,
    runtime,
    state,
  );
  const visibleMessages = applyHistorySnipBoundaries(
    state,
    compacted.messages,
  );
  const deepSeekMessages = await createDeepSeekMessages({
    runtime,
    systemPrompt,
    messages: visibleMessages,
  });

  return {
    visibleMessages,
    deepSeekMessages,
    stats: {
      ...createProjectionStats(),
      toolResultBudgetReplacementCount:
        budgeted.stats.toolResultBudgetReplacementCount,
      bulkyToolCompactNeeded: compacted.stats.bulkyToolCompactNeeded,
      bulkyToolCompactCount: compacted.stats.bulkyToolCompactCount,
      toolResultCharsBeforeBudget:
        budgeted.stats.toolResultCharsBeforeBudget,
      toolResultCharsAfterBudget: budgeted.stats.toolResultCharsAfterBudget,
      toolResultCharsAfterCompact: compacted.stats.toolResultCharsAfterCompact,
    },
  };
}

function cloneMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({ ...message }) as Message);
}

function createProjectionStats(): MessageProjectionStats {
  return {
    toolResultBudgetReplacementCount: 0,
    bulkyToolCompactNeeded: false,
    bulkyToolCompactCount: 0,
    historySnipCount: 0,
    toolResultCharsBeforeBudget: 0,
    toolResultCharsAfterBudget: 0,
    toolResultCharsAfterCompact: 0,
  };
}

function totalToolResultContentChars(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => {
    if (message.role !== "tool") {
      return sum;
    }

    return sum + message.content.length;
  }, 0);
}

function totalProjectedMessageTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + getMessageTokenSize(message), 0);
}

function applyToolResultReplacements(
  messages: Message[],
  replacementByMessageIndex: ReadonlyMap<number, string>,
): Message[] {
  return messages.map((message, messageIndex) => {
    if (message.role !== "tool") {
      return message;
    }

    const replacement = replacementByMessageIndex.get(messageIndex);
    if (replacement === undefined) {
      return message;
    }

    return withMessageSize({
      ...message,
      content: replacement,
    });
  });
}

function estimateSystemPromptTokens(systemPrompt: string): number {
  if (systemPrompt.length === 0) {
    return 0;
  }

  return estimateDeepSeekMessageSize({
    role: "system",
    content: systemPrompt,
  }).estimatedTokens;
}

type BulkyToolResultCandidate = ToolResultCandidate & { toolName: string };

function collectBulkyToolResultCandidates(
  messages: readonly Message[],
  toolNameById: ReadonlyMap<string, string>,
): BulkyToolResultCandidate[] {
  const candidates: BulkyToolResultCandidate[] = [];

  for (const [messageIndex, message] of messages.entries()) {
    if (
      message.role !== "tool" ||
      !message.content ||
      isToolResultAlreadyCompressed(message.content)
    ) {
      continue;
    }

    const toolName = message.toolName ?? toolNameById.get(message.tool_call_id);
    if (!toolName || !BULKY_TOOL_NAMES.has(toolName)) {
      continue;
    }

    candidates.push({
      budgetKey: createBulkyToolResultBudgetKey(message.id),
      messageIndex,
      toolCallId: message.tool_call_id,
      toolName,
      content: message.content,
      sizeTokens: getMessageTokenSize(message),
    });
  }

  return candidates;
}

function selectProtectedBulkyToolResultBudgetKeys(
  candidates: readonly BulkyToolResultCandidate[],
  protectedStart: number,
): Set<string> {
  return new Set(
    candidates
      .filter((candidate) => candidate.messageIndex >= protectedStart)
      .map((candidate) => candidate.budgetKey),
  );
}

function selectRecentBulkyToolResultBudgetKeys(
  candidates: readonly BulkyToolResultCandidate[],
  keepRecent: number,
): Set<string> {
  if (keepRecent <= 0) {
    return new Set();
  }

  return new Set(
    candidates
      .slice(Math.max(0, candidates.length - keepRecent))
      .map((candidate) => candidate.budgetKey),
  );
}

export async function createDeepSeekMessages(options: {
  runtime?: Runtime;
  systemPrompt: string;
  messages: Message[];
}): Promise<DeepSeekMessage[]> {
  const systemContext = options.runtime
    ? await getOrCreateSystemContext(options.runtime)
    : {};
  const userContext = options.runtime
    ? await getOrCreateUserContext(options.runtime)
    : {};
  const systemPrompt = appendSystemContext(options.systemPrompt, systemContext);
  const messages = repairToolCallMessagePairs(
    prependUserContextMessages(options.messages, userContext),
  );

  return [
    {
      role: "system",
      content: systemPrompt,
    },
    ...messages.map(toDeepSeekMessage),
  ];
}

function repairToolCallMessagePairs(messages: Message[]): Message[] {
  const repaired: Message[] = [];
  let pendingToolCallIds = new Set<string>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;

    if (message.role === "assistant" && message.tool_calls?.length) {
      pendingToolCallIds = new Set();

      const immediateToolResultIds = new Set<string>();
      for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex++) {
        const nextMessage = messages[nextIndex]!;
        if (nextMessage.role !== "tool") {
          break;
        }

        immediateToolResultIds.add(nextMessage.tool_call_id);
      }

      const keptToolCalls = message.tool_calls.filter((toolCall) =>
        immediateToolResultIds.has(toolCall.id)
      );

      if (keptToolCalls.length > 0) {
        pendingToolCallIds = new Set(
          keptToolCalls.map((toolCall) => toolCall.id),
        );
        repaired.push(withMessageSize({
          ...message,
          tool_calls: keptToolCalls,
        }));
        continue;
      }

      if (typeof message.content === "string" && message.content.trim()) {
        const { tool_calls: _toolCalls, ...contentOnlyMessage } = message;
        repaired.push(withMessageSize(contentOnlyMessage));
      }
      continue;
    }

    if (message.role === "tool") {
      if (!pendingToolCallIds.has(message.tool_call_id)) {
        continue;
      }

      pendingToolCallIds.delete(message.tool_call_id);
      repaired.push(message);
      continue;
    }

    pendingToolCallIds = new Set();
    repaired.push(message);
  }

  return repaired;
}

export async function getOrCreateSystemPrompt(
  runtime: Runtime,
): Promise<string> {
  // Session scoped for prompt-cache friendliness: once prepared, query turns
  // reuse the exact same system string.
  if (!runtime.systemPrompt) {
    runtime.systemPrompt = await buildSystemPrompt(runtime, {
      model: runtime.deepSeekRuntimeConfig.model,
    });
  }

  return runtime.systemPrompt;
}

type ToolResultCandidate = {
  budgetKey: string;
  messageIndex: number;
  toolCallId: string;
  toolName?: string;
  content: string;
  sizeTokens: number;
};

function compactBulkyToolResultsWithStats(
  messages: Message[],
  runtime: Runtime,
  ownerState?: State,
  contextBaseTokens = 0,
): { messages: Message[]; stats: Pick<MessageProjectionStats,
  "bulkyToolCompactNeeded" | "bulkyToolCompactCount" | "toolResultCharsAfterCompact"
> } {
  const applied = applyExistingBulkyToolCompactionsWithStats(
    messages,
    runtime,
    ownerState,
  );

  if (
    !isProjectedContextOverBulkyCompactThreshold(
      applied.messages,
      contextBaseTokens,
    )
  ) {
    return applied;
  }

  const created = createBulkyToolCompactionsWithStats(
    applied.messages,
    runtime,
    ownerState,
    contextBaseTokens,
  );

  return {
    messages: created.messages,
    stats: {
      bulkyToolCompactNeeded: created.stats.bulkyToolCompactNeeded,
      bulkyToolCompactCount:
        applied.stats.bulkyToolCompactCount + created.stats.bulkyToolCompactCount,
      toolResultCharsAfterCompact: created.stats.toolResultCharsAfterCompact,
    },
  };
}

function applyExistingBulkyToolCompactionsWithStats(
  messages: Message[],
  runtime: Runtime,
  ownerState?: State,
): { messages: Message[]; stats: Pick<MessageProjectionStats,
  "bulkyToolCompactNeeded" | "bulkyToolCompactCount" | "toolResultCharsAfterCompact"
> } {
  const budgetState = getOrCreateToolResultBudgetState(runtime, ownerState);
  const toolNameById = buildToolNameById(messages);
  const candidates = collectBulkyToolResultCandidates(messages, toolNameById);
  const replacementByMessageIndex = new Map<number, string>();

  for (const candidate of candidates) {
    const existingReplacement = budgetState.replacements.get(candidate.budgetKey);
    if (existingReplacement !== undefined) {
      replacementByMessageIndex.set(candidate.messageIndex, existingReplacement);
      continue;
    }
  }

  if (replacementByMessageIndex.size === 0) {
    return {
      messages,
      stats: {
        bulkyToolCompactCount: 0,
        bulkyToolCompactNeeded: false,
        toolResultCharsAfterCompact: totalToolResultContentChars(messages),
      },
    };
  }

  const compactedMessages = messages.map((message, messageIndex) => {
    if (message.role !== "tool") {
      return message;
    }

    const replacement = replacementByMessageIndex.get(messageIndex);
    if (replacement === undefined) {
      return message;
    }

    return withMessageSize({
      ...message,
      content: replacement,
    });
  });

  return {
    messages: compactedMessages,
    stats: {
      bulkyToolCompactCount: replacementByMessageIndex.size,
      bulkyToolCompactNeeded: false,
      toolResultCharsAfterCompact: totalToolResultContentChars(compactedMessages),
    },
  };
}

function createBulkyToolCompactionsWithStats(
  messages: Message[],
  runtime: Runtime,
  ownerState?: State,
  contextBaseTokens = 0,
): { messages: Message[]; stats: Pick<MessageProjectionStats,
  "bulkyToolCompactNeeded" | "bulkyToolCompactCount" | "toolResultCharsAfterCompact"
> } {
  const budgetState = getOrCreateToolResultBudgetState(runtime, ownerState);
  const toolNameById = buildToolNameById(messages);
  const contextTarget = getBulkyToolResultCompactTargetContextTokens();
  const candidates = collectBulkyToolResultCandidates(messages, toolNameById);
  const legacyKeepRecent = getLegacyBulkyToolResultKeepRecentCount();
  const protectedBudgetKeys = legacyKeepRecent === null
    ? selectProtectedBulkyToolResultBudgetKeys(
      candidates,
      calculateProjectionRecentTailStart(messages),
    )
    : selectRecentBulkyToolResultBudgetKeys(candidates, legacyKeepRecent);
  const replacementByMessageIndex = new Map<number, string>();
  let projectedTotalTokens = contextBaseTokens + totalProjectedMessageTokens(messages);

  for (const candidate of candidates) {
    if (
      protectedBudgetKeys.has(candidate.budgetKey) ||
      projectedTotalTokens <= contextTarget ||
      candidate.sizeTokens <= BULKY_TOOL_RESULT_COMPACT_PREVIEW_TOKENS
    ) {
      continue;
    }

    const replacement = buildBulkyToolResultReplacement({
      budgetKey: candidate.budgetKey,
      toolCallId: candidate.toolCallId,
      toolName: candidate.toolName,
      content: candidate.content,
      sizeTokens: candidate.sizeTokens,
    });
    budgetState.seenIds.add(candidate.budgetKey);
    budgetState.replacements.set(candidate.budgetKey, replacement);
    replacementByMessageIndex.set(candidate.messageIndex, replacement);
    projectedTotalTokens -= Math.max(
      0,
      candidate.sizeTokens - estimateToolResultReplacementTokens(replacement),
    );
  }

  if (replacementByMessageIndex.size === 0) {
    return {
      messages,
      stats: {
        bulkyToolCompactCount: 0,
        bulkyToolCompactNeeded: true,
        toolResultCharsAfterCompact: totalToolResultContentChars(messages),
      },
    };
  }

  const compactedMessages = messages.map((message, messageIndex) => {
    if (message.role !== "tool") {
      return message;
    }

    const replacement = replacementByMessageIndex.get(messageIndex);
    if (replacement === undefined) {
      return message;
    }

    return withMessageSize({
      ...message,
      content: replacement,
    });
  });

  return {
    messages: compactedMessages,
    stats: {
      bulkyToolCompactCount: replacementByMessageIndex.size,
      bulkyToolCompactNeeded: true,
      toolResultCharsAfterCompact: totalToolResultContentChars(compactedMessages),
    },
  };
}

function applyExistingToolResultBudgetWithStats(
  messages: Message[],
  runtime: Runtime,
  ownerState?: State,
): { messages: Message[]; stats: Pick<MessageProjectionStats,
  | "toolResultBudgetReplacementCount"
  | "toolResultCharsBeforeBudget"
  | "toolResultCharsAfterBudget"
> } {
  const budgetState = getOrCreateToolResultBudgetState(runtime, ownerState);
  const toolNameById = buildToolNameById(messages);
  const replacementByMessageIndex = new Map<number, string>();

  for (const candidates of collectToolResultGroups(messages, toolNameById)) {
    for (const candidate of candidates) {
      const replacement = budgetState.replacements.get(candidate.budgetKey);
      if (replacement !== undefined) {
        replacementByMessageIndex.set(candidate.messageIndex, replacement);
      }
    }
  }

  if (replacementByMessageIndex.size === 0) {
    return {
      messages,
      stats: {
        toolResultBudgetReplacementCount: 0,
        toolResultCharsBeforeBudget: totalToolResultContentChars(messages),
        toolResultCharsAfterBudget: totalToolResultContentChars(messages),
      },
    };
  }

  const budgetedMessages = applyToolResultReplacements(
    messages,
    replacementByMessageIndex,
  );

  return {
    messages: budgetedMessages,
    stats: {
      toolResultBudgetReplacementCount: replacementByMessageIndex.size,
      toolResultCharsBeforeBudget: totalToolResultContentChars(messages),
      toolResultCharsAfterBudget: totalToolResultContentChars(budgetedMessages),
    },
  };
}

export function applyHistorySnipBoundaries(
  state: State,
  messages: Message[],
): Message[] {
  const historySnips = ensureHistorySnips(state);

  if (historySnips.length === 0) {
    return messages;
  }

  const removedMessageIds = new Set(
    historySnips.flatMap((boundary) => boundary.removedMessageIds),
  );
  const contentOnlyMessageIds = new Set(
    historySnips.flatMap((boundary) => boundary.contentOnlyMessageIds ?? []),
  );
  const compactedContentOnlyMessageIds =
    collectCompactedSnipContentOnlyMessageIds(state);

  return messages.flatMap((message) => {
    if (removedMessageIds.has(message.id)) {
      return [];
    }

    if (contentOnlyMessageIds.has(message.id)) {
      if (compactedContentOnlyMessageIds.has(message.id)) {
        return [];
      }

      const contentOnlyMessage = createHistorySnipContentOnlyMessage(message);
      return contentOnlyMessage ? [contentOnlyMessage] : [];
    }

    return [message];
  });
}

export function getVisibleSnippedContentOnlyStats(
  state: State,
): SnippedContentOnlyStats {
  const contentOnlyMessageIds = new Set(
    ensureHistorySnips(state).flatMap(
      (boundary) => boundary.contentOnlyMessageIds ?? [],
    ),
  );
  const compactedContentOnlyMessageIds =
    collectCompactedSnipContentOnlyMessageIds(state);
  const stats: SnippedContentOnlyStats = {
    tokens: 0,
    messageCount: 0,
  };

  if (contentOnlyMessageIds.size === 0) {
    return stats;
  }

  for (const message of state.Messages) {
    if (
      !contentOnlyMessageIds.has(message.id) ||
      compactedContentOnlyMessageIds.has(message.id)
    ) {
      continue;
    }

    const contentOnlyMessage = createHistorySnipContentOnlyMessage(message);
    if (!contentOnlyMessage) {
      continue;
    }

    stats.tokens += getMessageTokenSize(contentOnlyMessage);
    stats.messageCount++;
    stats.lastMessageId = message.id;
  }

  return stats;
}

function collectCompactedSnipContentOnlyMessageIds(state: State): Set<MessageId> {
  const throughMessageId =
    state.autoCompress.snippedContentCompactedThroughMessageId;
  const compactedIds = new Set<MessageId>();

  if (!throughMessageId) {
    return compactedIds;
  }

  const throughIndex = state.Messages.findIndex(
    (message) => message.id === throughMessageId,
  );
  if (throughIndex === -1) {
    return compactedIds;
  }

  const contentOnlyMessageIds = new Set(
    ensureHistorySnips(state).flatMap(
      (boundary) => boundary.contentOnlyMessageIds ?? [],
    ),
  );

  for (let index = 0; index <= throughIndex; index++) {
    const messageId = state.Messages[index]?.id;
    if (messageId && contentOnlyMessageIds.has(messageId)) {
      compactedIds.add(messageId);
    }
  }

  return compactedIds;
}

export function ensureHistorySnips(state: State): HistorySnipBoundary[] {
  state.historySnips ??= [];
  return state.historySnips;
}

function hasHistorySnipForLatestMessage(
  state: State,
  messages: readonly Message[],
): boolean {
  const latestMessageId = messages.at(-1)?.id;

  if (!latestMessageId) {
    return false;
  }

  return ensureHistorySnips(state).some((boundary) =>
    boundary.createdAtMessageId === latestMessageId
  );
}

export function createHistorySnipBoundary(
  messagesForQuery: DeepSeekMessage[],
  messages: Message[],
): HistorySnipBoundary | null {
  const desiredMessagesForQueryTokens = getDesiredHistorySnipTokens();
  const currentSize = totalMessageTokens(messagesForQuery);

  if (currentSize <= desiredMessagesForQueryTokens || messages.length === 0) {
    return null;
  }

  const targetRemovalTokens = currentSize - desiredMessagesForQueryTokens;
  const decision = selectHistorySnipDecision(
    messages,
    targetRemovalTokens,
  );

  if (
    decision.removedMessageIds.length === 0 &&
    decision.contentOnlyMessageIds.length === 0
  ) {
    return null;
  }

  return {
    id: createHistorySnipId(),
    removedMessageIds: decision.removedMessageIds,
    contentOnlyMessageIds: decision.contentOnlyMessageIds,
    createdAtMessageId: messages.at(-1)?.id,
    reason: "prompt_budget",
    createdAt: Date.now(),
  };
}

function shouldCreateHistorySnipBoundary(
  state: State,
  preparedMessages: readonly Message[],
  stats: MessageProjectionStats,
  deepSeekMessages: DeepSeekMessage[],
): boolean {
  if (hasHistorySnipForLatestMessage(state, preparedMessages)) {
    return false;
  }

  return stats.bulkyToolCompactNeeded &&
    totalMessageTokens(deepSeekMessages) >
    getBulkyToolResultCompactTargetContextTokens();
}

type HistorySnipDecision = {
  removedMessageIds: Message["id"][];
  contentOnlyMessageIds: Message["id"][];
};

function selectHistorySnipDecision(
  messages: Message[],
  targetRemovalTokens: number,
): HistorySnipDecision {
  const protectedStart = calculateProtectedRecentTailStart(messages);
  const decision: HistorySnipDecision = {
    removedMessageIds: [],
    contentOnlyMessageIds: [],
  };
  let removedTokens = 0;

  for (let index = 0; index < protectedStart; index++) {
    if (removedTokens >= targetRemovalTokens) {
      break;
    }

    const message = messages[index]!;
    const contentOnlyMessage = createHistorySnipContentOnlyMessage(message);

    if (contentOnlyMessage) {
      const savedTokens = Math.max(
        0,
        getMessageTokenSize(message) - getMessageTokenSize(contentOnlyMessage),
      );

      if (savedTokens > 0) {
        decision.contentOnlyMessageIds.push(message.id);
        removedTokens += savedTokens;
      }
      continue;
    }

    if (isHistorySnipRemovableMessage(message)) {
      decision.removedMessageIds.push(message.id);
      removedTokens += getMessageTokenSize(message);
    }
  }

  return decision;
}

function createHistorySnipContentOnlyMessage(message: Message): Message | null {
  if (message.role === "user" && message.source === "user") {
    return withMessageSize({
      ...message,
      content: message.content,
    });
  }

  if (
    message.role === "assistant" &&
    message.source === "assistant" &&
    typeof message.content === "string" &&
    message.content.trim().length > 0
  ) {
    const {
      tool_calls: _toolCalls,
      reasoning_content: _reasoningContent,
      prefix: _prefix,
      ...contentOnlyMessage
    } = message;

    return withMessageSize({
      ...contentOnlyMessage,
      content: message.content,
    });
  }

  return null;
}

function isHistorySnipRemovableMessage(message: Message): boolean {
  if (message.role === "tool") {
    return true;
  }

  if (message.role === "assistant" && message.tool_calls?.length) {
    return true;
  }

  return isRegenerableAttachmentMessage(message);
}

function isRegenerableAttachmentMessage(message: Message): boolean {
  return message.source === "runtime" ||
    message.source === "long_term_memory" ||
    message.source === "file_restore" ||
    message.source === "dynamic_skill" ||
    message.source === "todo_list" ||
    message.source === "plan_mode" ||
    message.source === "agent_notification" ||
    message.source === "agent_message";
}

type ProjectionRecentTailStats = {
  tokens: number;
  apiMessages: number;
  userContentMessages: number;
};

function calculateProtectedRecentTailStart(messages: Message[]): number {
  return moveToSafeBusinessTailBoundary(
    messages,
    calculateProjectionRecentTailStart(messages),
  );
}

function calculateProjectionRecentTailStart(messages: Message[]): number {
  const legacyMinRecentMessages = getLegacyHistorySnipMinRecentMessages();
  if (legacyMinRecentMessages !== null) {
    return Math.max(0, messages.length - legacyMinRecentMessages);
  }

  let start = messages.length;
  const stats: ProjectionRecentTailStats = {
    tokens: 0,
    apiMessages: 0,
    userContentMessages: 0,
  };

  while (start > 0) {
    if (isProjectionRecentTailLargeEnough(stats)) {
      break;
    }

    if (stats.tokens >= getProjectionRecentTailMaxTokens()) {
      break;
    }

    start--;
    addMessageToProjectionRecentTailStats(stats, messages[start]!);
  }

  return start;
}

function isProjectionRecentTailLargeEnough(
  stats: ProjectionRecentTailStats,
): boolean {
  return stats.tokens >= getProjectionRecentTailTargetTokens() &&
    stats.apiMessages >= getProjectionRecentTailMinApiMessages() &&
    stats.userContentMessages >=
      getProjectionRecentTailMinUserContentMessages();
}

function addMessageToProjectionRecentTailStats(
  stats: ProjectionRecentTailStats,
  message: Message,
): void {
  stats.tokens += getMessageTokenSize(message);
  stats.apiMessages++;

  if (hasProjectionUserContent(message)) {
    stats.userContentMessages++;
  }
}

function hasProjectionUserContent(message: Message): boolean {
  return message.role === "user" &&
    message.source === "user" &&
    typeof message.content === "string" &&
    message.content.trim().length > 0;
}

function moveToSafeBusinessTailBoundary(
  messages: Message[],
  start: number,
): number {
  let safeStart = start;

  while (safeStart > 0) {
    const missingToolCallIds = findMissingBusinessToolCallIds(
      messages,
      safeStart,
    );
    if (missingToolCallIds.size === 0) {
      break;
    }

    const toolCallIndex = findPreviousBusinessToolCallIndex(
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

function findMissingBusinessToolCallIds(
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

function findPreviousBusinessToolCallIndex(
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

function createHistorySnipId(): HistorySnipId {
  return `history_snip_${randomUUID()}`;
}

function getHistorySnipTargetTokens(): number {
  return getPositiveIntegerEnv(
    "OPENCAT_HISTORY_SNIP_TARGET_TOKENS",
    DEFAULT_HISTORY_SNIP_TARGET_TOKENS,
  );
}

function getDesiredHistorySnipTokens(): number {
  return getHistorySnipTargetTokens();
}

function getProjectionRecentTailTargetTokens(): number {
  return getPositiveIntegerEnv(
    "OPENCAT_PROJECTION_RECENT_TAIL_TARGET_TOKENS",
    DEFAULT_PROJECTION_RECENT_TAIL_TARGET_TOKENS,
  );
}

function getProjectionRecentTailMaxTokens(): number {
  return getPositiveIntegerEnv(
    "OPENCAT_PROJECTION_RECENT_TAIL_MAX_TOKENS",
    DEFAULT_PROJECTION_RECENT_TAIL_MAX_TOKENS,
  );
}

function getProjectionRecentTailMinApiMessages(): number {
  return getNonNegativeIntegerEnv(
    "OPENCAT_PROJECTION_RECENT_TAIL_MIN_API_MESSAGES",
    DEFAULT_PROJECTION_RECENT_TAIL_MIN_API_MESSAGES,
  );
}

function getProjectionRecentTailMinUserContentMessages(): number {
  const configured = getOptionalNonNegativeIntegerEnv(
    "OPENCAT_PROJECTION_RECENT_TAIL_MIN_USER_CONTENT_MESSAGES",
  );

  if (configured !== null) {
    return configured;
  }

  return getNonNegativeIntegerEnv(
    "OPENCAT_PROJECTION_RECENT_TAIL_MIN_TEXT_MESSAGES",
    DEFAULT_PROJECTION_RECENT_TAIL_MIN_USER_CONTENT_MESSAGES,
  );
}

function getLegacyHistorySnipMinRecentMessages(): number | null {
  return getOptionalNonNegativeIntegerEnv(
    "OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES",
  );
}

function getLegacyBulkyToolResultKeepRecentCount(): number | null {
  return getOptionalNonNegativeIntegerEnv(
    "OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT",
  );
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const configured = Number(process.env[name]);

  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  return fallback;
}

function getOptionalNonNegativeIntegerEnv(name: string): number | null {
  if (!(name in process.env)) {
    return null;
  }

  const configured = Number(process.env[name]);

  if (Number.isFinite(configured) && configured >= 0) {
    return Math.floor(configured);
  }

  return null;
}

function getNonNegativeIntegerEnv(name: string, fallback: number): number {
  const configured = Number(process.env[name]);

  if (Number.isFinite(configured) && configured >= 0) {
    return Math.floor(configured);
  }

  return fallback;
}

function getOrCreateToolResultBudgetState(
  runtime: Runtime,
  state?: State,
): ToolResultBudgetState {
  if (state) {
    runtime.toolResultBudgetState = state.toolResultBudgetState;
    return state.toolResultBudgetState;
  }

  runtime.toolResultBudgetState ??= {
    seenIds: new Set(),
    replacements: new Map(),
  };

  return runtime.toolResultBudgetState;
}

function buildToolNameById(messages: Message[]): Map<string, string> {
  const toolNameById = new Map<string, string>();

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    for (const toolCall of message.tool_calls ?? []) {
      toolNameById.set(toolCall.id, toolCall.function.name);
    }
  }

  return toolNameById;
}

function collectToolResultGroups(
  messages: Message[],
  toolNameById: ReadonlyMap<string, string>,
): ToolResultCandidate[][] {
  const groups: ToolResultCandidate[][] = [];
  let current: ToolResultCandidate[] = [];

  const flush = () => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  };

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "tool") {
      flush();
      continue;
    }

    if (!message.content || isToolResultAlreadyBudgeted(message.content)) {
      continue;
    }

    current.push({
      budgetKey: message.id,
      messageIndex,
      toolCallId: message.tool_call_id,
      toolName: toolNameById.get(message.tool_call_id),
      content: message.content,
      sizeTokens: getMessageTokenSize(message),
    });
  }

  flush();

  return groups;
}

function renderHeadTailToolResultPreview(content: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  const previewChars = Math.floor(maxChars / 2);
  const head = content.slice(0, previewChars);
  const tail = content.slice(-previewChars);
  const omittedChars = Math.max(
    0,
    content.length - head.length - tail.length,
  );

  return [
    "<preview_head>",
    head,
    "</preview_head>",
    `[${omittedChars} characters omitted from the middle]`,
    "<preview_tail>",
    tail,
    "</preview_tail>",
  ].join("\n");
}

function estimateToolResultReplacementTokens(content: string): number {
  return estimateDeepSeekMessageSize({
    role: "tool",
    tool_call_id: "compact_preview",
    content,
  }).estimatedTokens;
}

function isContextOverBulkyCompactThreshold(
  messagesForQuery: DeepSeekMessage[],
): boolean {
  return totalMessageTokens(messagesForQuery) >=
    getBulkyToolResultCompactContextTokens();
}

function isContextOverBulkyCompactTarget(
  messagesForQuery: DeepSeekMessage[],
): boolean {
  return totalMessageTokens(messagesForQuery) >
    getBulkyToolResultCompactTargetContextTokens();
}

function isContextOverHistorySnipCancelThreshold(
  messagesForQuery: DeepSeekMessage[],
): boolean {
  return totalMessageTokens(messagesForQuery) >
    getHistorySnipCancelContextTokens();
}

function isProjectedContextOverBulkyCompactThreshold(
  messages: readonly Message[],
  contextBaseTokens = 0,
): boolean {
  return contextBaseTokens + totalProjectedMessageTokens(messages) >=
    getBulkyToolResultCompactContextTokens();
}

function getBulkyToolResultCompactContextTokens(): number {
  return getPositiveIntegerEnv(
    "OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS",
    DEFAULT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS,
  );
}

function getBulkyToolResultCompactTargetContextTokens(): number {
  return getPositiveIntegerEnv(
    "OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS",
    DEFAULT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS,
  );
}

function getHistorySnipCancelContextTokens(): number {
  return getPositiveIntegerEnv(
    "OPENCAT_HISTORY_SNIP_CANCEL_CONTEXT_TOKENS",
    DEFAULT_HISTORY_SNIP_CANCEL_CONTEXT_TOKENS,
  );
}

function createBulkyToolResultBudgetKey(messageId: Message["id"]): string {
  return `bulky_tool_result:${messageId}`;
}

type BulkyToolResultReplacementCandidate = {
  budgetKey: string;
  toolCallId: string;
  toolName: string;
  content: string;
  sizeTokens: number;
};

function buildBulkyToolResultReplacement(
  candidate: BulkyToolResultReplacementCandidate,
): string {
  const contentHash = createHash("sha256")
    .update(candidate.content)
    .digest("hex");
  return [
    BULKY_TOOL_RESULT_COMPACT_TAG,
    `Tool result from ${candidate.toolName} was compacted in this request because this tool commonly produces large, regenerable outputs.`,
    `tool_call_id: ${candidate.toolCallId}`,
    `budget_key: ${candidate.budgetKey}`,
    `original_size: ${candidate.content.length} characters`,
    `estimated_tokens: ${candidate.sizeTokens}`,
    `sha256: ${contentHash}`,
    "The original result remains in the authoritative session messages/transcript and was not re-executed.",
    renderHeadTailToolResultPreview(
      candidate.content,
      BULKY_TOOL_RESULT_COMPACT_PREVIEW_TOKENS,
    ),
    "</tool-result-compact>",
  ].join("\n");
}

function isToolResultAlreadyBudgeted(content: string): boolean {
  return content.startsWith(TOOL_RESULT_BUDGET_TAG);
}

function isToolResultAlreadyCompressed(content: string): boolean {
  return content.startsWith(TOOL_RESULT_BUDGET_TAG) ||
    content.startsWith(BULKY_TOOL_RESULT_COMPACT_TAG);
}

function totalMessageTokens(messages: DeepSeekMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

function messageTokens(message: DeepSeekMessage): number {
  return estimateDeepSeekMessageSize(message).estimatedTokens;
}

function getMessageTokenSize(message: Message): number {
  return message.size?.estimatedTokens ??
    estimateDeepSeekMessageSize(toDeepSeekMessage(message)).estimatedTokens;
}
