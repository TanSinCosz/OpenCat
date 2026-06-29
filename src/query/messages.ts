import type { DeepSeekMessage } from "../deepseek/types.js";
import { projectMessagesWithAutoCompress } from "../auto-compress/index.js";
import {
  buildSystemPrompt,
  type SystemPromptOptions,
} from "../system-prompt.js";
import { createLongTermMemoryContextMessage } from "./long-term-memory.js";
import type { ToolResultBudgetState } from "../types/context.js";
import { toDeepSeekMessage } from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import type {
  MessageCompressionStep,
  MessagesForQuery,
  MessagesForQueryBuilder,
} from "./types.js";

const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;
const TOOL_RESULT_PREVIEW_CHARS = 2_000;
const MAX_MESSAGES_FOR_QUERY_CHARS = 260_000;
const MIN_RECENT_MESSAGES_AFTER_SNIP = 12;
const TOOL_RESULT_BUDGET_TAG = "<tool-result-budget>";

export function createMessagesForQueryBuilder(
  promptOptions: SystemPromptOptions = {},
  steps: readonly MessageCompressionStep[] = [],
): MessagesForQueryBuilder {
  return (runtime, state) =>
    buildMessagesForQuery(runtime, state, {
      promptOptions,
      steps,
    });
}

export async function buildMessagesForQuery(
  runtime: Runtime,
  state: State,
  options: {
    promptOptions?: SystemPromptOptions;
    steps?: readonly MessageCompressionStep[];
    applyRequestLimits?: boolean;
    includeRuntimeContext?: boolean;
  } = {},
): Promise<MessagesForQuery> {
  const promptOptions = options.promptOptions ?? {};
  const applyRequestLimits = options.applyRequestLimits ?? true;
  const includeRuntimeContext = options.includeRuntimeContext ?? true;
  const systemPrompt = await getOrCreateSystemPrompt(runtime, promptOptions);
  const projectedMessages = projectMessagesWithAutoCompress(state);
  const runtimeContextMessages = includeRuntimeContext
    ? state.runtimeContextMessages
    : [];
  const longTermMemoryMessage = await createLongTermMemoryContextMessage(
    runtime,
    projectedMessages,
  );

  let messages: DeepSeekMessage[] = [
    {
      role: "system",
      content: systemPrompt,
    },
    ...(longTermMemoryMessage ? [longTermMemoryMessage] : []),
    ...projectedMessages.map(toDeepSeekMessage),
    ...runtimeContextMessages.map(toDeepSeekMessage),
  ];

  if (applyRequestLimits) {
    messages = applyToolResultBudget(messages, runtime);
    messages = applyHistorySnip(messages);
  }

  for (const step of options.steps ?? []) {
    messages = await step.apply(messages, { runtime, state, systemPrompt });
  }

  return { systemPrompt, messages };
}

async function getOrCreateSystemPrompt(
  runtime: Runtime,
  promptOptions: SystemPromptOptions,
): Promise<string> {
  // Session scoped for prompt-cache friendliness: once prepared, query turns
  // reuse the exact same system string.
  if (!runtime.systemPrompt) {
    runtime.systemPrompt = await buildSystemPrompt(runtime, {
      ...promptOptions,
      model: promptOptions.model ?? runtime.deepSeekRuntimeConfig.model,
    });
  }

  return runtime.systemPrompt;
}

type ToolResultCandidate = {
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
  messages: DeepSeekMessage[],
  runtime: Runtime,
): DeepSeekMessage[] {
  const state = getOrCreateToolResultBudgetState(runtime);

  // 因为tool message 本身不知道自己来自哪个工具，只知道 tool_call_id
  // {
  //   role: "tool",
  //   tool_call_id: "call_xxx",
  //   content: "..."
  // }
  const toolNameById = buildToolNameById(messages);
  const skipToolNames = new Set(
    runtime.tools
      .filter((tool) => !Number.isFinite(tool.maxResultSizeChars))
      .map((tool) => tool.name),
  );

  const replacementMap = new Map<string, string>();

  for (const candidates of collectToolResultGroups(messages, toolNameById)) {
    const { mustReapply, frozen, fresh } = partitionByPriorDecision(
      candidates,
      state,
    );

    for (const candidate of mustReapply) {
      replacementMap.set(candidate.toolCallId, candidate.replacement);
    }

    if (fresh.length === 0) {
      for (const candidate of candidates) {
        state.seenIds.add(candidate.toolCallId);
      }
      continue;
    }

    const skipped = fresh.filter((candidate) =>
      candidate.toolName ? skipToolNames.has(candidate.toolName) : false,
    );
    for (const candidate of skipped) {
      state.seenIds.add(candidate.toolCallId);
    }

    const eligible = fresh.filter(
      (candidate) => !skipped.includes(candidate),
    );
    const frozenSize = frozen.reduce(
      (sum, candidate) => sum + candidate.size,
      0,
    );
    const freshSize = eligible.reduce(
      (sum, candidate) => sum + candidate.size,
      0,
    );
    const selected =
      frozenSize + freshSize > MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
        ? selectFreshToReplace(
          eligible,
          frozenSize,
          MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
        )
        : [];
    const selectedIds = new Set(
      selected.map((candidate) => candidate.toolCallId),
    );

    for (const candidate of candidates) {
      if (!selectedIds.has(candidate.toolCallId)) {
        state.seenIds.add(candidate.toolCallId);
      }
    }

    for (const candidate of selected) {
      const replacement = buildToolResultReplacement(candidate);
      state.seenIds.add(candidate.toolCallId);
      state.replacements.set(candidate.toolCallId, replacement);
      replacementMap.set(candidate.toolCallId, replacement);
    }
  }

  if (replacementMap.size === 0) {
    return messages;
  }

  return messages.map((message) => {
    if (message.role !== "tool") {
      return message;
    }

    const replacement = replacementMap.get(message.tool_call_id);
    if (replacement === undefined) {
      return message;
    }

    return {
      ...message,
      content: replacement,
    };
  });
}

export function applyHistorySnip(messages: DeepSeekMessage[]): DeepSeekMessage[] {
  if (totalMessageSize(messages) <= MAX_MESSAGES_FOR_QUERY_CHARS) {
    return messages;
  }

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
      body.length - start >= MIN_RECENT_MESSAGES_AFTER_SNIP &&
      tailSize + nextSize > MAX_MESSAGES_FOR_QUERY_CHARS
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

function getOrCreateToolResultBudgetState(
  runtime: Runtime,
): ToolResultBudgetState {
  runtime.toolResultBudgetState ??= {
    seenIds: new Set(),
    replacements: new Map(),
  };

  return runtime.toolResultBudgetState;
}

function buildToolNameById(messages: DeepSeekMessage[]): Map<string, string> {
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
  messages: DeepSeekMessage[],
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

  for (const message of messages) {
    if (message.role !== "tool") {
      flush();
      continue;
    }

    if (!message.content || isToolResultAlreadyBudgeted(message.content)) {
      continue;
    }

    current.push({
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
      const replacement = state.replacements.get(candidate.toolCallId);

      if (replacement !== undefined) {
        partition.mustReapply.push({ ...candidate, replacement });
      } else if (state.seenIds.has(candidate.toolCallId)) {
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
  const preview = truncateAtLineBoundary(
    candidate.content,
    TOOL_RESULT_PREVIEW_CHARS,
  );
  const toolLabel = candidate.toolName ?? "unknown tool";

  return [
    TOOL_RESULT_BUDGET_TAG,
    `Tool result from ${toolLabel} was ${candidate.size} characters and was clipped for the prompt budget.`,
    `Preview (first ${preview.length} characters):`,
    preview,
  ].join("\n");
}

function truncateAtLineBoundary(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  const truncated = value.slice(0, limit);
  const newline = truncated.lastIndexOf("\n");

  if (newline > Math.floor(limit * 0.6)) {
    return truncated.slice(0, newline);
  }

  return truncated;
}

function isToolResultAlreadyBudgeted(content: string): boolean {
  return content.startsWith(TOOL_RESULT_BUDGET_TAG);
}

function createSnipMarkerMessage(removedMessages: number): DeepSeekMessage {
  return {
    role: "user",
    content:
      `[History snipped: ${removedMessages} earlier messages were removed from this prompt projection to stay within the context budget. The authoritative conversation state was not modified.]`,
  };
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
