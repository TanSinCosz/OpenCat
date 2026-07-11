import { createHash, randomUUID } from "node:crypto";
import type { DeepSeekMessage } from "../deepseek/types.js";
import { applyAutoCompressSummary } from "../auto-compress/index.js";
import { persistToolResultForBudget } from "../tool-results/persistence.js";
import {
  buildSystemPrompt,
} from "../system-prompt.js";
import type {
  HistorySnipBoundary,
  HistorySnipId,
  ToolResultBudgetState,
} from "../types/context.js";
import {
  createMessage,
  estimateDeepSeekMessageSize,
  toDeepSeekMessage,
  type Message,
  withMessageSize,
} from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import type { MessageProjectionStats, MessagesForQuery } from "./types.js";

const MAX_TOOL_RESULTS_PER_MESSAGE_TOKENS = 50_000;
const DEFAULT_BULKY_TOOL_RESULT_TARGET_TOKENS = 30_000;
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
const DEFAULT_HISTORY_SNIP_HARD_TOKENS = 125_000;
const DEFAULT_HISTORY_SNIP_TARGET_TOKENS = 30_000;
const DEFAULT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS = 125_000;
const BULKY_TOOL_RESULT_COMPACT_PREVIEW_TOKENS = 1_000;
const DEFAULT_BULKY_TOOL_RESULT_KEEP_RECENT = 5;
const DEFAULT_MIN_RECENT_MESSAGES_AFTER_SNIP = 5;
const TOOL_RESULT_BUDGET_TAG = "<tool-result-budget>";

export async function buildMessagesForQuery(
  runtime: Runtime,
  state: State,
): Promise<MessagesForQuery> {
  const systemPrompt = await getOrCreateSystemPrompt(runtime);
  const stats = createProjectionStats();
  let prepared = await prepareMessagesWithStats(runtime, state);
  let preparedMessages = prepared.messages;
  let visibleMessages = removeHistorySnippedMessages(
    state,
    preparedMessages,
  );
  let deepSeekMessages = await createDeepSeekMessages({
    systemPrompt,
    messages: visibleMessages,
  });

  const historySnipBoundary = hasHistorySnipForLatestMessage(
    state,
    preparedMessages,
  )
    ? null
    : createHistorySnipBoundary(
      deepSeekMessages,
      visibleMessages,
    );

  if (historySnipBoundary) {
    ensureHistorySnips(state).push(historySnipBoundary);
    stats.historySnipCount++;
    prepared = await prepareMessagesWithStats(runtime, state);
    preparedMessages = prepared.messages;
    visibleMessages = removeHistorySnippedMessages(
      state,
      preparedMessages,
    );
  }

  const limitedMessages = enforceHistoryLimit(visibleMessages);
  if (limitedMessages !== visibleMessages) {
    const hardSnipBoundary = hasHistorySnipForLatestMessage(
      state,
      preparedMessages,
    )
      ? null
      : createHistorySnipBoundaryFromLimitedMessages(
        visibleMessages,
        limitedMessages,
      );
    if (hardSnipBoundary) {
      ensureHistorySnips(state).push(hardSnipBoundary);
      stats.historySnipCount++;
      visibleMessages = removeHistorySnippedMessages(
        state,
        preparedMessages,
      );
    } else {
      stats.hardHistorySnipApplied = true;
      visibleMessages = limitedMessages;
    }
  }

  mergeProjectionStats(stats, prepared.stats);
  deepSeekMessages = await createDeepSeekMessages({
    systemPrompt,
    messages: visibleMessages,
  });

  return {
    systemPrompt,
    messages: deepSeekMessages,
    forkContextMessages: cloneMessages(visibleMessages),
    stats,
  };
}

async function prepareMessages(
  runtime: Runtime,
  state: State,
): Promise<Message[]> {
  return (await prepareMessagesWithStats(runtime, state)).messages;
}

async function prepareMessagesWithStats(
  runtime: Runtime,
  state: State,
): Promise<{ messages: Message[]; stats: MessageProjectionStats }> {
  // Existing auto-compress summaries are applied here. New summaries are
  // created in the query loop only after the request still exceeds budget.
  const autoCompressedMessages = applyAutoCompressSummary(state);
  const clonedMessages = cloneMessages(autoCompressedMessages);
  const budgeted = await budgetToolResultsWithStats(clonedMessages, runtime, state);
  const compacted = compactBulkyToolResultsWithStats(budgeted.messages, runtime, state);

  // Fixed request-shaping order:
  // 1. group-level tool result budget
  // 2. per-result microcompact for bulky, regenerable tools
  // 3. history-snip boundaries
  return {
    messages: compacted.messages,
    stats: {
      ...createProjectionStats(),
      toolResultBudgetReplacementCount:
        budgeted.stats.toolResultBudgetReplacementCount,
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
    bulkyToolCompactCount: 0,
    historySnipCount: 0,
    hardHistorySnipApplied: false,
    toolResultCharsBeforeBudget: 0,
    toolResultCharsAfterBudget: 0,
    toolResultCharsAfterCompact: 0,
  };
}

function mergeProjectionStats(
  target: MessageProjectionStats,
  source: MessageProjectionStats,
): void {
  target.toolResultBudgetReplacementCount =
    source.toolResultBudgetReplacementCount;
  target.bulkyToolCompactCount = source.bulkyToolCompactCount;
  target.toolResultCharsBeforeBudget = source.toolResultCharsBeforeBudget;
  target.toolResultCharsAfterBudget = source.toolResultCharsAfterBudget;
  target.toolResultCharsAfterCompact = source.toolResultCharsAfterCompact;
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
  systemPrompt: string;
  messages: Message[];
}): Promise<DeepSeekMessage[]> {
  return [
    {
      role: "system",
      content: options.systemPrompt,
    },
    ...options.messages.map(toDeepSeekMessage),
  ];
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

type CandidatePartition = {
  mustReapply: Array<ToolResultCandidate & { replacement: string }>;
  frozen: ToolResultCandidate[];
  fresh: ToolResultCandidate[];
};

export function compactBulkyToolResults(
  messages: Message[],
  runtime: Runtime,
): Message[] {
  return compactBulkyToolResultsWithStats(messages, runtime).messages;
}

function compactBulkyToolResultsWithStats(
  messages: Message[],
  runtime: Runtime,
  ownerState?: State,
): { messages: Message[]; stats: Pick<MessageProjectionStats,
  "bulkyToolCompactCount" | "toolResultCharsAfterCompact"
> } {
  const budgetState = getOrCreateToolResultBudgetState(runtime, ownerState);
  const toolNameById = buildToolNameById(messages);
  const targetTokens = getBulkyToolResultTargetTokens();
  const contextThreshold = getBulkyToolResultCompactContextTokens();
  const keepRecent = getBulkyToolResultKeepRecentCount();
  const isContextOverThreshold =
    totalProjectedMessageTokens(messages) > contextThreshold;
  const candidates = collectBulkyToolResultCandidates(messages, toolNameById);
  const targetToolResultTokens = candidates.reduce(
    (sum, candidate) => sum + candidate.sizeTokens,
    0,
  );
  const shouldCompactPool =
    targetToolResultTokens > targetTokens || isContextOverThreshold;
  const protectedBudgetKeys = selectRecentBulkyToolResultBudgetKeys(
    candidates,
    keepRecent,
  );
  const replacementByMessageIndex = new Map<number, string>();
  let projectedToolResultTokens = targetToolResultTokens;
  let projectedTotalTokens = totalProjectedMessageTokens(messages);

  for (const candidate of candidates) {
    const existingReplacement = budgetState.replacements.get(candidate.budgetKey);
    if (existingReplacement !== undefined) {
      replacementByMessageIndex.set(candidate.messageIndex, existingReplacement);
      const savedTokens = Math.max(
        0,
        candidate.sizeTokens - estimateToolResultReplacementTokens(existingReplacement),
      );
      projectedToolResultTokens -= savedTokens;
      projectedTotalTokens -= savedTokens;
      continue;
    }

    if (
      !shouldCompactPool ||
      protectedBudgetKeys.has(candidate.budgetKey) ||
      (
        projectedToolResultTokens <= targetTokens &&
        projectedTotalTokens <= contextThreshold
      ) ||
      candidate.sizeTokens <= BULKY_TOOL_RESULT_COMPACT_PREVIEW_TOKENS
    ) {
      continue;
    }

    budgetState.seenIds.add(candidate.budgetKey);
    const replacement = buildBulkyToolResultReplacement({
      budgetKey: candidate.budgetKey,
      toolCallId: candidate.toolCallId,
      toolName: candidate.toolName,
      content: candidate.content,
      sizeTokens: candidate.sizeTokens,
    });
    budgetState.replacements.set(candidate.budgetKey, replacement);
    replacementByMessageIndex.set(candidate.messageIndex, replacement);
    const savedTokens = Math.max(
      0,
      candidate.sizeTokens - estimateToolResultReplacementTokens(replacement),
    );
    projectedToolResultTokens -= savedTokens;
    projectedTotalTokens -= savedTokens;
  }

  if (replacementByMessageIndex.size === 0) {
    return {
      messages,
      stats: {
        bulkyToolCompactCount: 0,
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
      toolResultCharsAfterCompact: totalToolResultContentChars(compactedMessages),
    },
  };
}

export async function budgetToolResults(
  messages: Message[],
  runtime: Runtime,
): Promise<Message[]> {
  return (await budgetToolResultsWithStats(messages, runtime)).messages;
}

async function budgetToolResultsWithStats(
  messages: Message[],
  runtime: Runtime,
  ownerState?: State,
): Promise<{ messages: Message[]; stats: Pick<MessageProjectionStats,
  | "toolResultBudgetReplacementCount"
  | "toolResultCharsBeforeBudget"
  | "toolResultCharsAfterBudget"
> }> {
  const budgetState = getOrCreateToolResultBudgetState(runtime, ownerState);

  // Tool messages only carry tool_call_id, so recover the tool name from the
  // preceding assistant tool call before applying budget decisions.
  const toolNameById = buildToolNameById(messages);
  const skipToolNames = new Set(
    runtime.tools
      .filter((tool) => tool.maxResultSizeChars === Infinity)
      .map((tool) => tool.name),
  );
  const shouldSkip = (candidate: ToolResultCandidate): boolean =>
    candidate.toolName !== undefined && skipToolNames.has(candidate.toolName);

  const replacementByMessageIndex = new Map<number, string>();

  for (
    const candidates of collectToolResultGroups(messages, toolNameById)
  ) {
    const { mustReapply, frozen, fresh } = partitionByPriorDecision(
      candidates,
      budgetState,
    );

    for (const candidate of mustReapply) {
      replacementByMessageIndex.set(candidate.messageIndex, candidate.replacement);
    }

    if (fresh.length === 0) {
      for (const candidate of candidates) {
        budgetState.seenIds.add(candidate.budgetKey);
      }
      continue;
    }

    const skipped = fresh.filter(shouldSkip);
    for (const candidate of skipped) {
      budgetState.seenIds.add(candidate.budgetKey);
    }
    const eligibleFresh = fresh.filter((candidate) => !shouldSkip(candidate));

    const frozenSize = frozen.reduce(
      (sum, candidate) => sum + candidate.sizeTokens,
      0,
    );
    const freshSize = eligibleFresh.reduce(
      (sum, candidate) => sum + candidate.sizeTokens,
      0,
    );
    const selected =
      frozenSize + freshSize > MAX_TOOL_RESULTS_PER_MESSAGE_TOKENS
        ? selectFreshToReplace(
          eligibleFresh,
          frozenSize,
          MAX_TOOL_RESULTS_PER_MESSAGE_TOKENS,
        )
        : [];
    const selectedIds = new Set(
      selected.map((candidate) => candidate.budgetKey),
    );

    for (const candidate of candidates) {
      if (!selectedIds.has(candidate.budgetKey)) {
        budgetState.seenIds.add(candidate.budgetKey);
      }
    }

    for (const candidate of selected) {
      try {
        const replacement = await persistToolResultForBudget({
          runtime,
          toolCallId: candidate.toolCallId,
          content: candidate.content,
          toolName: candidate.toolName,
        });
        budgetState.seenIds.add(candidate.budgetKey);
        budgetState.replacements.set(candidate.budgetKey, replacement);
        replacementByMessageIndex.set(candidate.messageIndex, replacement);
      } catch {
        const replacement = buildToolResultReplacement(candidate);
        budgetState.seenIds.add(candidate.budgetKey);
        budgetState.replacements.set(candidate.budgetKey, replacement);
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

  const budgetedMessages = messages.map((message, messageIndex) => {
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
    messages: budgetedMessages,
    stats: {
      toolResultBudgetReplacementCount: replacementByMessageIndex.size,
      toolResultCharsBeforeBudget: totalToolResultContentChars(messages),
      toolResultCharsAfterBudget: totalToolResultContentChars(budgetedMessages),
    },
  };
}

export function enforceHistoryLimit(messages: Message[]): Message[] {
  const maxMessagesForQueryTokens = getHistorySnipHardTokens();

  if (totalBusinessMessageTokens(messages) <= maxMessagesForQueryTokens) {
    return messages;
  }

  const minRecentMessages = getHistorySnipMinRecentMessages();
  const firstMessage = messages[0];
  const hasSystem = firstMessage?.role === "system";
  const head = hasSystem ? [firstMessage] : [];
  const body = hasSystem ? messages.slice(1) : messages;
  const marker = createSnipMarkerMessage(body.length);
  const markerSize = getMessageTokenSize(marker);
  let tailSize = head.reduce((sum, message) => sum + getMessageTokenSize(message), 0) +
    markerSize;
  let start = body.length;

  while (start > 0) {
    const next = body[start - 1]!;
    const nextSize = getMessageTokenSize(next);

    if (
      body.length - start >= minRecentMessages &&
      tailSize + nextSize > maxMessagesForQueryTokens
    ) {
      break;
    }

    start--;
    tailSize += nextSize;
  }

  start = moveToSafeTailBoundary(body, start);

  if (start <= 0) {
    return messages;
  }

  return [
    ...head,
    createSnipMarkerMessage(start),
    ...body.slice(start),
  ];
}

export function removeHistorySnippedMessages(
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

  return messages.flatMap((message) => {
    if (removedMessageIds.has(message.id)) {
      return [];
    }

    if (contentOnlyMessageIds.has(message.id)) {
      const contentOnlyMessage = createHistorySnipContentOnlyMessage(message);
      return contentOnlyMessage ? [contentOnlyMessage] : [];
    }

    return [message];
  });
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
  const maxMessagesForQueryTokens = getHistorySnipHardTokens();
  const targetMessagesForQueryTokens = getHistorySnipTargetTokens();
  const currentSize = totalMessageTokens(messagesForQuery);

  if (currentSize <= maxMessagesForQueryTokens || messages.length === 0) {
    return null;
  }

  const targetRemovalTokens = Math.max(
    currentSize - targetMessagesForQueryTokens,
    currentSize - maxMessagesForQueryTokens,
  );
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

export function createHistorySnipBoundaryFromLimitedMessages(
  messages: Message[],
  limitedMessages: Message[],
): HistorySnipBoundary | null {
  const keptMessageIds = new Set(limitedMessages.map((message) => message.id));
  const removedMessageIds = messages
    .filter((message) => !keptMessageIds.has(message.id))
    .map((message) => message.id);

  if (removedMessageIds.length === 0) {
    return null;
  }

  return {
    id: createHistorySnipId(),
    removedMessageIds,
    createdAtMessageId: messages.at(-1)?.id,
    reason: "prompt_budget",
    createdAt: Date.now(),
  };
}

type SnipCandidateGroup = {
  messageIds: string[];
  estimatedTokens: number;
  priority: number;
};

function selectHistorySnipMessageIds(
  messages: Message[],
  targetRemovalTokens: number,
): Message["id"][] {
  return selectHistorySnipDecision(messages, targetRemovalTokens)
    .removedMessageIds;
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

    decision.removedMessageIds.push(message.id);
    removedTokens += getMessageTokenSize(message);
  }

  if (removedTokens > 0) {
    return decision;
  }

  return {
    removedMessageIds: selectLegacyHistorySnipMessageIds(
      messages,
      targetRemovalTokens,
    ),
    contentOnlyMessageIds: [],
  };
}

function selectLegacyHistorySnipMessageIds(
  messages: Message[],
  targetRemovalTokens: number,
): Message["id"][] {
  const protectedStart = calculateProtectedRecentTailStart(messages);
  const candidates = collectHistorySnipCandidateGroups(messages, protectedStart);
  const selected = selectCandidateGroups(candidates, targetRemovalTokens);
  const selectedIds = new Set(selected.flatMap((group) => group.messageIds));

  // Only tool rounds and regenerable context messages are eligible for
  // removal.  If those candidates are not enough, don't create a boundary
  // let auto-compress handle the overflow instead.
  if (estimateSelectedTokens(messages, selectedIds) >= targetRemovalTokens) {
    return [...selectedIds] as Message["id"][];
  }

  return [];
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

function calculateProtectedRecentTailStart(messages: Message[]): number {
  const maxMessagesForQueryTokens = getHistorySnipHardTokens();
  const minRecentMessages = getHistorySnipMinRecentMessages();
  let start = messages.length;
  let tailSize = 0;

  while (start > 0) {
    const next = messages[start - 1]!;
    const nextSize = getMessageTokenSize(next);

    if (
      messages.length - start >= minRecentMessages &&
      tailSize + nextSize > maxMessagesForQueryTokens
    ) {
      break;
    }

    start--;
    tailSize += nextSize;
  }

  return moveToSafeBusinessTailBoundary(messages, start);
}

function collectHistorySnipCandidateGroups(
  messages: Message[],
  protectedStart: number,
): SnipCandidateGroup[] {
  const groups: SnipCandidateGroup[] = [];
  const groupedIds = new Set<string>();

  for (let index = 0; index < protectedStart; index++) {
    const message = messages[index]!;
    if (groupedIds.has(message.id)) {
      continue;
    }

    const toolRound = collectToolRoundGroup(messages, index, protectedStart);
    if (toolRound) {
      for (const messageId of toolRound.messageIds) {
        groupedIds.add(messageId);
      }
      groups.push(toolRound);
      continue;
    }

    if (isRegenerableAttachmentMessage(message)) {
      groupedIds.add(message.id);
      groups.push(createSnipCandidateGroup([message], 1));
    }
  }

  return groups.sort((left, right) =>
    left.priority - right.priority ||
    right.estimatedTokens - left.estimatedTokens
  );
}

function collectToolRoundGroup(
  messages: Message[],
  index: number,
  protectedStart: number,
): SnipCandidateGroup | null {
  const message = messages[index]!;
  if (message.role !== "assistant" || !message.tool_calls?.length) {
    return null;
  }

  const toolCallIds = new Set(message.tool_calls.map((toolCall) => toolCall.id));
  const group: Message[] = [message];

  for (let cursor = index + 1; cursor < protectedStart; cursor++) {
    const next = messages[cursor]!;
    if (next.role !== "tool") {
      break;
    }

    if (toolCallIds.has(next.tool_call_id)) {
      group.push(next);
    }
  }

  if (group.length === 1) {
    return null;
  }

  return createSnipCandidateGroup(group, 2);
}

function createSnipCandidateGroup(
  messages: Message[],
  priority: number,
): SnipCandidateGroup {
  return {
    messageIds: messages.map((message) => message.id),
    estimatedTokens: messages.reduce(
      (sum, message) => sum + getMessageTokenSize(message),
      0,
    ),
    priority,
  };
}

function selectCandidateGroups(
  candidates: SnipCandidateGroup[],
  targetRemovalTokens: number,
): SnipCandidateGroup[] {
  const selected: SnipCandidateGroup[] = [];
  let removedTokens = 0;

  for (const candidate of candidates) {
    if (removedTokens >= targetRemovalTokens) {
      break;
    }

    selected.push(candidate);
    removedTokens += candidate.estimatedTokens;
  }

  return selected;
}

function estimateSelectedTokens(
  messages: Message[],
  selectedIds: ReadonlySet<string>,
): number {
  return messages.reduce((sum, message) => {
    if (!selectedIds.has(message.id)) {
      return sum;
    }

    return sum + getMessageTokenSize(message);
  }, 0);
}

function isRegenerableAttachmentMessage(message: Message): boolean {
  // These messages are projected attachments/context rather than core user ↔
  // assistant conversation turns. They can be restored or regenerated from
  // runtime state, memory, file restore, skill discovery, or agent state, so old
  // copies are safe durable history-snip candidates.
  return message.source === "runtime" ||
    message.source === "long_term_memory" ||
    message.source === "file_restore" ||
    message.source === "dynamic_skill" ||
    message.source === "agent_notification" ||
    message.source === "agent_message";
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

function getHistorySnipHardTokens(): number {
  return getPositiveIntegerEnv(
    "OPENCAT_HISTORY_SNIP_HARD_TOKENS",
    DEFAULT_HISTORY_SNIP_HARD_TOKENS,
  );
}

function getHistorySnipTargetTokens(): number {
  return getPositiveIntegerEnv(
    "OPENCAT_HISTORY_SNIP_TARGET_TOKENS",
    DEFAULT_HISTORY_SNIP_TARGET_TOKENS,
  );
}

function getHistorySnipMinRecentMessages(): number {
  return getPositiveIntegerEnv(
    "OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES",
    DEFAULT_MIN_RECENT_MESSAGES_AFTER_SNIP,
  );
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const configured = Number(process.env[name]);

  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  return fallback;
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

function partitionByPriorDecision(
  candidates: ToolResultCandidate[],
  state: ToolResultBudgetState,
): CandidatePartition {
  return candidates.reduce<CandidatePartition>(
    (partition, candidate) => {
      const replacement = state.replacements.get(candidate.budgetKey);

      if (replacement !== undefined) {
        partition.mustReapply.push({ ...candidate, replacement });
      } else if (state.seenIds.has(candidate.budgetKey)) {
        partition.frozen.push(candidate);
      } else {
        partition.fresh.push(candidate);
      }

      return partition;
    },
    { mustReapply: [], frozen: [], fresh: [] },
  );
}

function selectFreshToReplace(
  fresh: ToolResultCandidate[],
  frozenSize: number,
  limit: number,
): ToolResultCandidate[] {
  const sorted = [...fresh].sort((a, b) => b.sizeTokens - a.sizeTokens);
  const selected: ToolResultCandidate[] = [];
  let remaining = frozenSize + fresh.reduce(
    (sum, candidate) => sum + candidate.sizeTokens,
    0,
  );

  for (const candidate of sorted) {
    if (remaining <= limit) {
      break;
    }

    selected.push(candidate);
    remaining -= candidate.sizeTokens;
  }

  return selected;
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

function getBulkyToolResultTargetTokens(): number {
  return getPositiveIntegerEnv(
    "OPENCAT_BULKY_TOOL_RESULT_TARGET_TOKENS",
    DEFAULT_BULKY_TOOL_RESULT_TARGET_TOKENS,
  );
}

function getBulkyToolResultCompactContextTokens(): number {
  return getPositiveIntegerEnv(
    "OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS",
    DEFAULT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS,
  );
}

function getBulkyToolResultKeepRecentCount(): number {
  return getNonNegativeIntegerEnv(
    "OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT",
    DEFAULT_BULKY_TOOL_RESULT_KEEP_RECENT,
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

function buildToolResultReplacement(candidate: ToolResultCandidate): string {
  const toolLabel = candidate.toolName ?? "unknown tool";
  const persistedReference = extractPersistedToolResultReference(
    candidate.content,
  );
  const originalSize = persistedReference?.size ?? candidate.content.length;
  const contentHash = persistedReference?.sha256 ??
    createHash("sha256").update(candidate.content).digest("hex");
  const storageLine = persistedReference
    ? `Full result path: ${persistedReference.path}`
    : "Full result location: authoritative session messages/transcript";

  return [
    TOOL_RESULT_BUDGET_TAG,
    `Tool result from ${toolLabel} was omitted from this request because the tool-result group exceeded the context budget.`,
    `tool_call_id: ${candidate.toolCallId}`,
    `original_size: ${originalSize} ${persistedReference ? "bytes" : "characters"}`,
    `estimated_tokens: ${candidate.sizeTokens}`,
    `sha256: ${contentHash}`,
    storageLine,
    "The original result was not re-executed and was not deleted. Use the persisted/session copy if the full output is needed.",
    "</tool-result-budget>",
  ].join("\n");
}

function extractPersistedToolResultReference(content: string): {
  path: string;
  sha256?: string;
  size?: number;
} | null {
  const path = content.match(/^Full output path:\s*(.+)$/m)?.[1]?.trim();

  if (!path) {
    return null;
  }

  const sha256 = content.match(/^SHA-256:\s*([a-fA-F0-9]{64})$/m)?.[1];
  const sizeText = content.match(/^Tool result.* was (\d+) bytes /m)?.[1];
  const size = sizeText ? Number(sizeText) : undefined;

  return {
    path,
    ...(sha256 ? { sha256 } : {}),
    ...(Number.isFinite(size) ? { size } : {}),
  };
}

function isToolResultAlreadyBudgeted(content: string): boolean {
  return content.startsWith(TOOL_RESULT_BUDGET_TAG);
}

function isToolResultAlreadyCompressed(content: string): boolean {
  return content.startsWith(TOOL_RESULT_BUDGET_TAG) ||
    content.startsWith(BULKY_TOOL_RESULT_COMPACT_TAG);
}

function createSnipMarkerMessage(removedMessages: number): Message {
  return createMessage(
    {
      role: "user",
      content:
        `[History snipped: ${removedMessages} earlier messages were removed from this request to stay within the context budget. The authoritative conversation state was not modified.]`,
    },
    { source: "runtime" },
  );
}

function moveToSafeTailBoundary(
  messages: DeepSeekMessage[],
  start: number,
): number {
  let safeStart = start;

  while (safeStart > 0 && messages[safeStart]?.role === "tool") {
    safeStart--;
  }

  return safeStart;
}

function totalMessageTokens(messages: DeepSeekMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

function totalBusinessMessageTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + getMessageTokenSize(message), 0);
}

function messageTokens(message: DeepSeekMessage): number {
  return estimateDeepSeekMessageSize(message).estimatedTokens;
}

function getMessageTokenSize(message: Message): number {
  return message.size?.estimatedTokens ??
    estimateDeepSeekMessageSize(toDeepSeekMessage(message)).estimatedTokens;
}
