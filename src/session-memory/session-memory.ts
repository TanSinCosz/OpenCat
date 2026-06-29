import type { DeepSeekCreateRequest } from "../deepseek/types.js";
import type { Message } from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import {
  createSessionMemoryState,
  type SessionMemoryState,
} from "../types/session-memory.js";
import type { State } from "../types/state.js";
import {
  buildSessionMemoryUpdatePrompt,
  DEFAULT_SESSION_MEMORY_TEMPLATE,
  SESSION_MEMORY_SYSTEM_PROMPT,
} from "./prompts.js";
import { savePersistedSessionMemory } from "./persistence.js";
import { recordTranscriptStateSnapshot } from "../transcript/persistence.js";

export type SessionMemoryUpdateResult =
  | { status: "updated"; content: string }
  | { status: "skipped"; reason: string };

/**
 * Refreshes the rolling session memory notes when autocompress explicitly asks
 * for them.
 *
 * The result is stored in state.sessionMemory.content as one complete markdown
 * document. A refresh updates the existing fixed sections; it does not create
 * a new section for each summary run and it does not mutate authoritative
 * state.Messages.
 */
export async function updateSessionMemoryForAutoCompress(
  runtime: Runtime,
  state: State,
): Promise<SessionMemoryUpdateResult> {
  const sessionMemory = ensureSessionMemoryState(state);

  if (state.Messages.length === 0) {
    return { status: "skipped", reason: "empty_messages" };
  }

  sessionMemory.initialized = true;
  sessionMemory.tokensAtLastUpdateAttempt = estimateMessageTokens(state.Messages);

  const transcript = formatMessagesForSessionMemory(
    state.Messages,
    sessionMemory.config.maxTranscriptChars,
  );
  const prompt = buildSessionMemoryUpdatePrompt({
    currentNotes: sessionMemory.content || DEFAULT_SESSION_MEMORY_TEMPLATE,
    transcript,
  });
  let content: string | undefined;

  try {
    const response = await runtime.deepSeekClient.create({
      model: runtime.deepSeekRuntimeConfig.model as DeepSeekCreateRequest["model"],
      messages: [
        {
          role: "system",
          content: SESSION_MEMORY_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: runtime.deepSeekRuntimeConfig.maxTokens,
      reasoning_effort:
        runtime.deepSeekRuntimeConfig.reasoningEffort === "high" ||
        runtime.deepSeekRuntimeConfig.reasoningEffort === "max"
          ? runtime.deepSeekRuntimeConfig.reasoningEffort
          : undefined,
      temperature: 0,
    });
    content = response.choices[0]?.message.content?.trim();
  } catch (error) {
    sessionMemory.status = "failed";
    sessionMemory.lastFailedAt = Date.now();
    sessionMemory.lastFailureReason = error instanceof Error
      ? error.message
      : String(error);
    return { status: "skipped", reason: "model_request_failed" };
  }

  if (!content) {
    sessionMemory.status = "failed";
    sessionMemory.lastFailedAt = Date.now();
    sessionMemory.lastFailureReason = "empty_model_response";
    return { status: "skipped", reason: "empty_model_response" };
  }

  sessionMemory.content = content;
  sessionMemory.tokensAtLastExtraction = estimateMessageTokens(state.Messages);
  sessionMemory.status = "ready";
  sessionMemory.lastUpdatedAt = Date.now();
  delete sessionMemory.lastFailedAt;
  delete sessionMemory.lastFailureReason;

  const lastMessage = state.Messages.at(-1);
  if (lastMessage) {
    sessionMemory.lastUpdateMessageId = lastMessage.id;

    if (!hasToolCallsInLastAssistantTurn(state.Messages)) {
      sessionMemory.lastSummarizedMessageId = lastMessage.id;
    }
  }

  await savePersistedSessionMemory(runtime, state);
  await recordTranscriptStateSnapshot(runtime, state, "session_memory");

  return { status: "updated", content };
}

/**
 * Refreshes session memory only when the background update thresholds are met.
 * Autocompress should call updateSessionMemoryForAutoCompress instead, because
 * reaching that stage is already the update signal.
 */
export async function updateSessionMemoryIfNeeded(
  runtime: Runtime,
  state: State,
): Promise<SessionMemoryUpdateResult> {
  const shouldUpdate = shouldUpdateSessionMemory(state);

  if (!shouldUpdate.update) {
    return { status: "skipped", reason: shouldUpdate.reason };
  }

  return updateSessionMemoryForAutoCompress(runtime, state);
}

/**
 * Decides whether the session memory should be refreshed on this turn.
 *
 * This mirrors the official shape: wait until the transcript is large enough,
 * require meaningful context growth since the last update, and prefer updating
 * at a safe boundary instead of in the middle of an assistant tool-call chain.
 */
export function shouldUpdateSessionMemory(
  state: State,
): { update: true } | { update: false; reason: string } {
  const sessionMemory = ensureSessionMemoryState(state);

  if (state.Messages.length === 0) {
    return { update: false, reason: "empty_messages" };
  }

  const currentTokenCount = estimateMessageTokens(state.Messages);
  if (!sessionMemory.initialized) {
    if (
      currentTokenCount <
      sessionMemory.config.minimumMessageTokensToInit
    ) {
      return { update: false, reason: "below_initialization_threshold" };
    }
  }

  const tokensAtLastMemoryWork = Math.max(
    sessionMemory.tokensAtLastExtraction,
    sessionMemory.tokensAtLastUpdateAttempt,
  );
  const tokensSinceLastMemoryWork =
    currentTokenCount - tokensAtLastMemoryWork;
  if (
    tokensSinceLastMemoryWork <
    sessionMemory.config.minimumTokensBetweenUpdate
  ) {
    return { update: false, reason: "below_update_threshold" };
  }

  const toolCallsSinceLastUpdate = countToolCallsSince(
    state.Messages,
    sessionMemory.lastUpdateMessageId,
  );
  const hasToolCallThreshold =
    toolCallsSinceLastUpdate >= sessionMemory.config.toolCallsBetweenUpdates;
  const isNaturalBreak = !hasToolCallsInLastAssistantTurn(state.Messages);

  if (!hasToolCallThreshold && !isNaturalBreak) {
    return { update: false, reason: "waiting_for_safe_break" };
  }

  return { update: true };
}

/**
 * Ensures older State objects have a sessionMemory bucket.
 * Keeping this separate from Message preserves the distinction between raw
 * conversation history and derived memory notes.
 */
export function ensureSessionMemoryState(state: State): SessionMemoryState {
  state.sessionMemory ??= createSessionMemoryState();
  state.sessionMemory.status ??= "idle";
  state.sessionMemory.tokensAtLastUpdateAttempt ??= 0;
  return state.sessionMemory;
}

/**
 * Renders business Message objects into a transcript for the memory updater.
 *
 * The transcript is not sent to the main model directly. It is only the input
 * used to update the rolling notes, so long tool results are allowed to be
 * shortened and very old transcript text can be omitted.
 */
export function formatMessagesForSessionMemory(
  messages: Message[],
  maxChars: number,
): string {
  const rendered = messages.map(formatMessageForSessionMemory).join("\n\n");

  if (rendered.length <= maxChars) {
    return rendered;
  }

  return [
    `[Earlier transcript omitted: keeping the latest ${maxChars} characters.]`,
    rendered.slice(-maxChars),
  ].join("\n");
}

/**
 * Roughly estimates transcript size for update thresholds.
 * This is deliberately lightweight; provider-specific exact token counting can
 * be added later without changing the session-memory state model.
 */
export function estimateMessageTokens(messages: Message[]): number {
  const chars = messages.reduce(
    (sum, message) => sum + JSON.stringify(message).length,
    0,
  );

  return Math.ceil(chars / 4);
}

/**
 * Converts one Message into a readable transcript block.
 * Assistant tool calls and tool results are made explicit so the notes can
 * capture what work happened without needing the original structured payload.
 */
function formatMessageForSessionMemory(message: Message): string {
  switch (message.role) {
    case "system":
      return `[system:${message.id}]\n${message.content}`;
    case "user":
      return `[user:${message.id}]\n${message.content}`;
    case "assistant": {
      const parts = [`[assistant:${message.id}]`];

      if (message.content) {
        parts.push(message.content);
      }

      for (const toolCall of message.tool_calls ?? []) {
        parts.push(
          [
            `tool_call: ${toolCall.function.name}`,
            `id: ${toolCall.id}`,
            `arguments: ${toolCall.function.arguments}`,
          ].join("\n"),
        );
      }

      return parts.join("\n");
    }
    case "tool":
      return [
        `[tool:${message.id}]`,
        `tool_call_id: ${message.tool_call_id}`,
        message.toolName ? `tool_name: ${message.toolName}` : undefined,
        truncateToolResult(message.content),
      ].filter(Boolean).join("\n");
  }
}

/**
 * Prevents large tool outputs from dominating the session-memory update prompt.
 */
function truncateToolResult(content: string): string {
  const limit = 8_000;
  if (content.length <= limit) {
    return content;
  }

  return `${content.slice(0, limit)}\n[... tool result truncated for session memory ...]`;
}

/**
 * Counts assistant tool calls after the last successful session-memory update.
 */
function countToolCallsSince(
  messages: Message[],
  sinceMessageId: string | undefined,
): number {
  let count = 0;
  let foundStart = sinceMessageId === undefined;

  for (const message of messages) {
    if (!foundStart) {
      foundStart = message.id === sinceMessageId;
      continue;
    }

    if (message.role === "assistant") {
      count += message.tool_calls?.length ?? 0;
    }
  }

  return count;
}

/**
 * Detects whether the latest assistant turn is still a tool-use boundary.
 * Updating notes at that point is less safe because the matching tool results
 * may not have been appended yet.
 */
function hasToolCallsInLastAssistantTurn(messages: Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;

    if (message.role === "assistant") {
      return (message.tool_calls?.length ?? 0) > 0;
    }
  }

  return false;
}
