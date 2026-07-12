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
  estimateDeepSeekMessageSize,
  toDeepSeekMessage,
  type Message,
  withMessageSize,
} from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import type { MessageProjectionStats, MessagesForQuery } from "./types.js";

const MAX_TOOL_RESULTS_PER_MESSAGE_TOKENS = 50_000;
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
const DEFAULT_HISTORY_SNIP_TARGET_TOKENS = 30_000;
const DEFAULT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS = 160_000;
const DEFAULT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS = 70_000;
const BULKY_TOOL_RESULT_COMPACT_PREVIEW_TOKENS = 1_000;
const DEFAULT_BULKY_TOOL_RESULT_KEEP_RECENT = 5;
const DEFAULT_MIN_RECENT_MESSAGES_AFTER_SNIP = 8;
const TOOL_RESULT_BUDGET_TAG = "<tool-result-budget>";

export async function buildMessagesForQuery(
  runtime: Runtime,
  state: State,
): Promise<MessagesForQuery> {
  const systemPrompt = await getOrCreateSystemPrompt(runtime);
  let historySnipCount = 0;

  // 1-2. Start from state.Messages, then apply existing reusable projection
  // state: auto-compress summary, tool-result budget replacements, bulky
  // replacements, and persisted snip boundaries.
  let projectedMessages = cloneMessages(applyAutoCompressSummary(state));
  let budgeted = applyExistingToolResultBudgetWithStats(
    projectedMessages,
    runtime,
    state,
  );
  let compacted = applyExistingBulkyToolCompactionsWithStats(
    budgeted.messages,
    runtime,
    state,
  );
  let stats: MessageProjectionStats = {
    ...createProjectionStats(),
    toolResultBudgetReplacementCount:
      budgeted.stats.toolResultBudgetReplacementCount,
    bulkyToolCompactNeeded: compacted.stats.bulkyToolCompactNeeded,
    bulkyToolCompactCount: compacted.stats.bulkyToolCompactCount,
    toolResultCharsBeforeBudget:
      budgeted.stats.toolResultCharsBeforeBudget,
    toolResultCharsAfterBudget: budgeted.stats.toolResultCharsAfterBudget,
    toolResultCharsAfterCompact: compacted.stats.toolResultCharsAfterCompact,
  };
  let visibleMessages = applyHistorySnipBoundaries(
    state,
    compacted.messages,
  );

  // 3. Measure the whole visible request after all existing projection state.
  let deepSeekMessages = await createDeepSeekMessages({
    systemPrompt,
    messages: visibleMessages,
  });

  // 4. If the visible request is over the bulky threshold, create new bulky
  // replacements, then measure the request again.
  if (isContextOverBulkyCompactThreshold(deepSeekMessages)) {
    compacted = createBulkyToolCompactionsWithStats(
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
      systemPrompt,
      messages: visibleMessages,
    });
  }

  // 5. If bulky compaction still cannot hit the target, create a durable
  // history-snip boundary and rerun the same projection once.
  const historySnipBoundary = shouldCreateHistorySnipBoundary(
    state,
    visibleMessages,
    stats,
    deepSeekMessages,
  )
    ? createHistorySnipBoundary(
      deepSeekMessages,
      visibleMessages,
    )
    : null;

  if (historySnipBoundary) {
    ensureHistorySnips(state).push(historySnipBoundary);
    historySnipCount = 1;

    // Re-run the same projection once so the newly persisted snip boundary
    // affects the current request, not just the next turn.
    projectedMessages = cloneMessages(applyAutoCompressSummary(state));
    budgeted = applyExistingToolResultBudgetWithStats(
      projectedMessages,
      runtime,
      state,
    );
    compacted = applyExistingBulkyToolCompactionsWithStats(
      budgeted.messages,
      runtime,
      state,
    );
    stats = {
      ...createProjectionStats(),
      toolResultBudgetReplacementCount:
        budgeted.stats.toolResultBudgetReplacementCount,
      bulkyToolCompactNeeded: compacted.stats.bulkyToolCompactNeeded,
      bulkyToolCompactCount: compacted.stats.bulkyToolCompactCount,
      toolResultCharsBeforeBudget:
        budgeted.stats.toolResultCharsBeforeBudget,
      toolResultCharsAfterBudget: budgeted.stats.toolResultCharsAfterBudget,
      toolResultCharsAfterCompact: compacted.stats.toolResultCharsAfterCompact,
    };
    visibleMessages = applyHistorySnipBoundaries(
      state,
      compacted.messages,
    );
    deepSeekMessages = await createDeepSeekMessages({
      systemPrompt,
      messages: visibleMessages,
    });
    if (isContextOverBulkyCompactThreshold(deepSeekMessages)) {
      compacted = createBulkyToolCompactionsWithStats(
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
        systemPrompt,
        messages: visibleMessages,
      });
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
  const keepRecent = getBulkyToolResultKeepRecentCount();
  const candidates = collectBulkyToolResultCandidates(messages, toolNameById);
  const protectedBudgetKeys = selectRecentBulkyToolResultBudgetKeys(
    candidates,
    keepRecent,
  );
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

export async function budgetToolResults(
  messages: Message[],
  runtime: Runtime,
): Promise<Message[]> {
  return (await budgetToolResultsWithStats(messages, runtime)).messages;
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
    message.source === "agent_notification" ||
    message.source === "agent_message";
}

function calculateProtectedRecentTailStart(messages: Message[]): number {
  const minRecentMessages = getHistorySnipMinRecentMessages();
  const start = Math.max(0, messages.length - minRecentMessages);

  return moveToSafeBusinessTailBoundary(messages, start);
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

function isContextOverBulkyCompactThreshold(
  messagesForQuery: DeepSeekMessage[],
): boolean {
  return totalMessageTokens(messagesForQuery) >=
    getBulkyToolResultCompactContextTokens();
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
