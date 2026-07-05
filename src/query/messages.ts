import { createHash, randomUUID } from "node:crypto";
import type { DeepSeekMessage } from "../deepseek/types.js";
import { projectMessagesWithAutoCompress } from "../auto-compress/index.js";
import {
  buildSystemPrompt,
} from "../system-prompt.js";
import type {
  HistorySnipBoundary,
  HistorySnipId,
  ToolResultBudgetState,
} from "../types/context.js";
import { createMessage, toDeepSeekMessage, type Message } from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import type { MessagesForQuery } from "./types.js";

const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;
const DEFAULT_HISTORY_SNIP_HARD_CHARS = 800_000;
const DEFAULT_MIN_RECENT_MESSAGES_AFTER_SNIP = 12;
const TOOL_RESULT_BUDGET_TAG = "<tool-result-budget>";

export async function buildMessagesForQuery(
  runtime: Runtime,
  state: State,
): Promise<MessagesForQuery> {
  const systemPrompt = await getOrCreateSystemPrompt(runtime);
  const autoCompressedMessages = projectMessagesWithAutoCompress(state);
  let projectedMessages = projectMessagesWithHistorySnips(
    state,
    autoCompressedMessages,
  );
  // Progressive compression pipeline: tool result budget →
  // micro-compress → history snip boundary.
  projectedMessages = applyToolResultBudget(projectedMessages, runtime);
  let snipedMessages = applyHistorySnip(projectedMessages);
  let messages = await createDeepSeekMessagesForProjection({
    systemPrompt,
    projectedMessages: snipedMessages,
  });

  const historySnipBoundary = createHistorySnipBoundaryIfNeeded(
    messages,
    projectedMessages,
  );

  if (historySnipBoundary) {
    getHistorySnipBoundaries(state).push(historySnipBoundary);
    projectedMessages = projectMessagesWithHistorySnips(
      state,
      autoCompressedMessages,
    );
    projectedMessages = applyToolResultBudget(projectedMessages, runtime);
    snipedMessages = applyHistorySnip(projectedMessages);
    messages = await createDeepSeekMessagesForProjection({
      systemPrompt,
      projectedMessages: snipedMessages,
    });
  }

  return { systemPrompt, messages };
}

export async function createDeepSeekMessagesForProjection(options: {
  systemPrompt: string;
  projectedMessages: Message[];
}): Promise<DeepSeekMessage[]> {
  return [
    {
      role: "system",
      content: options.systemPrompt,
    },
    ...options.projectedMessages.map(toDeepSeekMessage),
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
  size: number;
};

type CandidatePartition = {
  mustReapply: Array<ToolResultCandidate & { replacement: string }>;
  frozen: ToolResultCandidate[];
  fresh: ToolResultCandidate[];
};

export function applyToolResultBudget(
  messages: Message[],
  runtime: Runtime,
): Message[] {
  const state = getOrCreateToolResultBudgetState(runtime);

  // 因为tool message 本身不知道自己来自哪个工具，只知道 tool_call_id
  // {
  //   role: "tool",
  //   tool_call_id: "call_xxx",
  //   content: "..."
  // }
  const toolNameById = buildToolNameById(messages);

  const replacementByMessageIndex = new Map<number, string>();

  for (
    const candidates of collectToolResultGroups(messages, toolNameById)
  ) {
    const { mustReapply, frozen, fresh } = partitionByPriorDecision(
      candidates,
      state,
    );

    for (const candidate of mustReapply) {
      replacementByMessageIndex.set(candidate.messageIndex, candidate.replacement);
    }

    if (fresh.length === 0) {
      for (const candidate of candidates) {
        state.seenIds.add(candidate.budgetKey);
      }
      continue;
    }

    const frozenSize = frozen.reduce(
      (sum, candidate) => sum + candidate.size,
      0,
    );
    const freshSize = fresh.reduce(
      (sum, candidate) => sum + candidate.size,
      0,
    );
    const selected =
      frozenSize + freshSize > MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
        ? selectFreshToReplace(
          fresh,
          frozenSize,
          MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
        )
        : [];
    const selectedIds = new Set(
      selected.map((candidate) => candidate.budgetKey),
    );

    for (const candidate of candidates) {
      if (!selectedIds.has(candidate.budgetKey)) {
        state.seenIds.add(candidate.budgetKey);
      }
    }

    for (const candidate of selected) {
      const replacement = buildToolResultReplacement(candidate);
      state.seenIds.add(candidate.budgetKey);
      state.replacements.set(candidate.budgetKey, replacement);
      replacementByMessageIndex.set(candidate.messageIndex, replacement);
    }
  }

  if (replacementByMessageIndex.size === 0) {
    return messages;
  }

  return messages.map((message, messageIndex) => {
    if (message.role !== "tool") {
      return message;
    }

    const replacement = replacementByMessageIndex.get(messageIndex);
    if (replacement === undefined) {
      return message;
    }

    return {
      ...message,
      content: replacement,
    };
  });
}

export function applyHistorySnip(messages: Message[]): Message[] {
  const maxMessagesForQueryChars = getHistorySnipHardChars();

  if (totalMessageSize(messages) <= maxMessagesForQueryChars) {
    return messages;
  }

  const minRecentMessages = getHistorySnipMinRecentMessages();
  const firstMessage = messages[0];
  const hasSystem = firstMessage?.role === "system";
  const head = hasSystem ? [firstMessage] : [];
  const body = hasSystem ? messages.slice(1) : messages;
  const marker = createSnipMarkerMessage(body.length);
  const markerSize = messageSize(marker);
  let tailSize = head.reduce((sum, message) => sum + messageSize(message), 0) +
    markerSize;
  let start = body.length;

  while (start > 0) {
    const next = body[start - 1]!;
    const nextSize = messageSize(next);

    if (
      body.length - start >= minRecentMessages &&
      tailSize + nextSize > maxMessagesForQueryChars
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

export function projectMessagesWithHistorySnips(
  state: State,
  messages: Message[],
): Message[] {
  const historySnips = getHistorySnipBoundaries(state);

  if (historySnips.length === 0) {
    return messages;
  }

  const removedMessageIds = new Set(
    historySnips.flatMap((boundary) => boundary.removedMessageIds),
  );

  return messages.filter((message) => !removedMessageIds.has(message.id));
}

export function getHistorySnipBoundaries(state: State): HistorySnipBoundary[] {
  state.historySnips ??= [];
  return state.historySnips;
}

export function createHistorySnipBoundaryIfNeeded(
  messagesForQuery: DeepSeekMessage[],
  projectedMessages: Message[],
): HistorySnipBoundary | null {
  const maxMessagesForQueryChars = getHistorySnipHardChars();
  const currentSize = totalMessageSize(messagesForQuery);

  if (currentSize <= maxMessagesForQueryChars || projectedMessages.length === 0) {
    return null;
  }

  const targetRemovalChars = currentSize - maxMessagesForQueryChars;
  const removedMessageIds = selectHistorySnipMessageIds(
    projectedMessages,
    targetRemovalChars,
  );

  if (removedMessageIds.length === 0) {
    return null;
  }

  return {
    id: createHistorySnipId(),
    removedMessageIds,
    createdAtMessageId: projectedMessages.at(-1)?.id,
    reason: "prompt_budget",
    createdAt: Date.now(),
  };
}

type SnipCandidateGroup = {
  messageIds: string[];
  estimatedChars: number;
  priority: number;
};

function selectHistorySnipMessageIds(
  messages: Message[],
  targetRemovalChars: number,
): Message["id"][] {
  const protectedStart = calculateProtectedRecentTailStart(messages);
  const candidates = collectHistorySnipCandidateGroups(messages, protectedStart);
  const selected = selectCandidateGroups(candidates, targetRemovalChars);
  const selectedIds = new Set(selected.flatMap((group) => group.messageIds));

  // Only tool rounds and regenerable context messages are eligible for
  // removal.  If those candidates are not enough, don't create a boundary
  // — let auto-compress handle the overflow instead.
  if (estimateSelectedChars(messages, selectedIds) >= targetRemovalChars) {
    return [...selectedIds] as Message["id"][];
  }

  return [];
}

function calculateProtectedRecentTailStart(messages: Message[]): number {
  const maxMessagesForQueryChars = getHistorySnipHardChars();
  const minRecentMessages = getHistorySnipMinRecentMessages();
  let start = messages.length;
  let tailSize = 0;

  while (start > 0) {
    const next = messages[start - 1]!;
    const nextSize = messageSize(toDeepSeekMessage(next));

    if (
      messages.length - start >= minRecentMessages &&
      tailSize + nextSize > maxMessagesForQueryChars
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

    if (isRegenerableRuntimeContextMessage(message)) {
      groupedIds.add(message.id);
      groups.push(createSnipCandidateGroup([message], 1));
    }
  }

  return groups.sort((left, right) =>
    left.priority - right.priority ||
    right.estimatedChars - left.estimatedChars
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
    estimatedChars: messages.reduce(
      (sum, message) => sum + messageSize(toDeepSeekMessage(message)),
      0,
    ),
    priority,
  };
}

function selectCandidateGroups(
  candidates: SnipCandidateGroup[],
  targetRemovalChars: number,
): SnipCandidateGroup[] {
  const selected: SnipCandidateGroup[] = [];
  let removedChars = 0;

  for (const candidate of candidates) {
    if (removedChars >= targetRemovalChars) {
      break;
    }

    selected.push(candidate);
    removedChars += candidate.estimatedChars;
  }

  return selected;
}

function estimateSelectedChars(
  messages: Message[],
  selectedIds: ReadonlySet<string>,
): number {
  return messages.reduce((sum, message) => {
    if (!selectedIds.has(message.id)) {
      return sum;
    }

    return sum + messageSize(toDeepSeekMessage(message));
  }, 0);
}

function isRegenerableRuntimeContextMessage(message: Message): boolean {
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

function getHistorySnipHardChars(): number {
  return getPositiveIntegerEnv(
    "OPENCAT_HISTORY_SNIP_HARD_CHARS",
    DEFAULT_HISTORY_SNIP_HARD_CHARS,
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

function getOrCreateToolResultBudgetState(
  runtime: Runtime,
): ToolResultBudgetState {
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
      size: message.content.length,
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
  const sorted = [...fresh].sort((a, b) => b.size - a.size);
  const selected: ToolResultCandidate[] = [];
  let remaining = frozenSize + fresh.reduce(
    (sum, candidate) => sum + candidate.size,
    0,
  );

  for (const candidate of sorted) {
    if (remaining <= limit) {
      break;
    }

    selected.push(candidate);
    remaining -= candidate.size;
  }

  return selected;
}

function buildToolResultReplacement(candidate: ToolResultCandidate): string {
  const toolLabel = candidate.toolName ?? "unknown tool";
  const persistedReference = extractPersistedToolResultReference(
    candidate.content,
  );
  const originalSize = persistedReference?.size ?? candidate.size;
  const contentHash = persistedReference?.sha256 ??
    createHash("sha256").update(candidate.content).digest("hex");
  const storageLine = persistedReference
    ? `Full result path: ${persistedReference.path}`
    : "Full result location: authoritative session messages/transcript";

  return [
    TOOL_RESULT_BUDGET_TAG,
    `Tool result from ${toolLabel} was omitted from this prompt projection because the tool-result group exceeded the context budget.`,
    `tool_call_id: ${candidate.toolCallId}`,
    `original_size: ${originalSize} ${persistedReference ? "bytes" : "characters"}`,
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

function createSnipMarkerMessage(removedMessages: number): Message {
  return createMessage(
    {
      role: "user",
      content:
        `[History snipped: ${removedMessages} earlier messages were removed from this prompt projection to stay within the context budget. The authoritative conversation state was not modified.]`,
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

function totalMessageSize(messages: DeepSeekMessage[]): number {
  return messages.reduce((sum, message) => sum + messageSize(message), 0);
}

function messageSize(message: DeepSeekMessage): number {
  return JSON.stringify(message).length;
}
