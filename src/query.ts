import { executeToolCall } from "./Tools/executor.js";
import { drainAgentMessages } from "./Tools/Agent/state.js";
import type { DeepSeekAssistantMessage } from "./deepseek/types.js";
import { createMessage, toDeepSeekMessage, type ToolMessage } from "./types/messages.js";
import type { Runtime } from "./types/runtime.js";
import type { State } from "./types/state.js";
import { streamAssistantWithReasoningContinuation } from "./query/reasoning-continuation.js";
import {
  buildMessagesForQuery,
  getVisibleSnippedContentOnlyStats,
  type SnippedContentOnlyStats,
} from "./query/messages.js";
import { createStreamRequest } from "./query/request.js";
import type { MessagesForQuery, QueryEvent, QueryOptions } from "./query/types.js";
import { snapshotRuntimeUsage } from "./query/usage.js";
import {
  createLongTermMemoryContextMessage,
  extractLongTermMemoryForCompletedQuery,
  type LongTermMemoryExtractionResult,
} from "./query/long-term-memory.js";
import {
  clearRuntimeContextAfterModelRequest,
  createProjectionContextStateMessage,
  loadDynamicSkillContextForQuery,
  loadRuntimeContextForQuery,
} from "./query/runtime-context.js";
import {
  applyAutoCompression,
  applyAutoCompressSummary,
} from "./auto-compress/index.js";
import {
  recordTranscriptMessage,
  recordTranscriptStateSnapshot,
} from "./transcript/persistence.js";
import {
  emitRunEvent,
  stringifyTelemetryError,
} from "./telemetry/observer.js";

export type {
  MessagesForQuery,
  QueryEvent,
  QueryOptions,
} from "./query/types.js";
export { buildMessagesForQuery } from "./query/messages.js";
export { createStreamRequest } from "./query/request.js";
export { applyAutoCompression } from "./auto-compress/index.js";
export {
  appendRuntimeContextMessages,
  clearRuntimeContextAfterModelRequest,
  createRuntimeContextMessage,
  loadRuntimeContextForQuery,
} from "./query/runtime-context.js";

const DEFAULT_SNIPPED_CONTENT_AUTO_COMPRESS_TRIGGER_TOKENS = 40_000;

export async function* query(
  runtime: Runtime,
  state: State,
  options: QueryOptions = {},
): AsyncGenerator<QueryEvent, void, void> {
  yield* _query(runtime, state, options);
}

export async function* _query(
  runtime: Runtime,
  state: State,
  options: QueryOptions = {},
): AsyncGenerator<QueryEvent, void, void> {
  const maxTurns = options.maxTurns ?? 100;
  const turnStartMessageId = state.Messages.at(-1)?.id;
  const turnStartedAt = Date.now();
  await emitRunEvent(runtime, {
    type: "query_started",
    maxTurns,
    stateMessageCount: state.Messages.length,
  });

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      throwIfQueryAborted(runtime);

      // Phase A: drain durable parent-to-child messages before building.
      await drainPendingAgentMessagesForRuntime(runtime, state);

      // Phase B: project first, then compact State only if the request is still too large.
      const historySnipCountBeforeBuild = state.historySnips.length;
      let messagesForQuery = await buildMessagesForQuery(runtime, state);
      await recordHistorySnipSnapshotIfNeeded(
        runtime,
        state,
        historySnipCountBeforeBuild,
      );

      const autoCompressRequest = getAutoCompressionRequest(
        runtime,
        state,
      );
      if (autoCompressRequest) {
        const autoCompressResult = await applyAutoCompressionWithTelemetry(
          runtime,
          state,
          autoCompressRequest,
        );

        if (autoCompressResult.status === "compressed") {
          await recordTranscriptStateSnapshot(runtime, state, "auto_compress");
        }
      }

      // Phase C: append volatile/generated context after auto-compress so it is
      // visible to the model but not swallowed by the compaction prompt.
      await materializeRequestContext(runtime, state);
      const historySnipCountBeforeFinalBuild = state.historySnips.length;
      messagesForQuery = await buildMessagesForQuery(runtime, state);
      await recordHistorySnipSnapshotIfNeeded(
        runtime,
        state,
        historySnipCountBeforeFinalBuild,
      );
      await recordProjectionSnapshotIfNeeded(runtime, state, messagesForQuery);

      await emitRunEvent(runtime, {
        type: "context_ready",
        turn,
        messageCount: messagesForQuery.messages.length,
        estimatedTokens: estimateMessagesForQueryTokens(messagesForQuery),
        hasLongTermMemory: hasTaggedMessage(messagesForQuery, "<long_term_memory>"),
        hasSessionMemory: hasTaggedMessage(messagesForQuery, "<session_memory>"),
        hasAutoCompressSummary: hasTaggedMessage(
          messagesForQuery,
          "<local_compact_summary>",
        ) || hasTaggedMessage(messagesForQuery, "<session_memory>"),
        runtimeContextMessageCount: state.runtimeContextMessages.length,
        toolResultBudgetReplacementCount:
          messagesForQuery.stats.toolResultBudgetReplacementCount,
        bulkyToolCompactCount: messagesForQuery.stats.bulkyToolCompactCount,
        historySnipCount: messagesForQuery.stats.historySnipCount,
        toolResultCharsBeforeBudget:
          messagesForQuery.stats.toolResultCharsBeforeBudget,
        toolResultCharsAfterBudget:
          messagesForQuery.stats.toolResultCharsAfterBudget,
        toolResultCharsAfterCompact:
          messagesForQuery.stats.toolResultCharsAfterCompact,
      });
      yield {
        type: "context_ready",
        systemPrompt: messagesForQuery.systemPrompt,
        messages: messagesForQuery.messages,
        stats: messagesForQuery.stats,
      };

      const request = await createStreamRequest(runtime, messagesForQuery.messages);
      throwIfQueryAborted(runtime);
      await emitRunEvent(runtime, { type: "model_stream_started", turn });
      yield { type: "model_stream_start", turn };

      const assistantResult = yield* streamAssistantWithReasoningContinuation(
        runtime,
        request,
      );
      const assistantMessage = assistantResult.message;

      const persistedAssistantMessage = createMessage(assistantMessage, {
        usage: assistantResult.usage,
        contextTokenCount: assistantResult.contextTokenCount,
      });
      state.Messages.push(persistedAssistantMessage);
      await recordTranscriptMessage(runtime, persistedAssistantMessage);
      await emitRunEvent(runtime, {
        type: "assistant_message",
        turn,
        assistantTextChars: getAssistantTextChars(assistantMessage),
        reasoningChars: assistantMessage.reasoning_content?.length ?? 0,
        toolCallCount: assistantMessage.tool_calls?.length ?? 0,
      });
      yield {
        type: "assistant_message",
        message: assistantMessage,
        usage: assistantResult.usage,
      };
      await clearRuntimeContextAfterModelRequest(runtime, state);

      const toolCalls = assistantMessage.tool_calls ?? [];
      if (toolCalls.length === 0) {
        await emitRunEvent(runtime, {
          type: "turn_finished",
          turn,
          hasToolUse: false,
        });
        yield { type: "turn_end", turn, hasToolUse: false };
        const extraction = await extractLongTermMemoryForCompletedQuery(runtime, state, {
          turnStartMessageId,
          turnStartedAt,
        });
        await emitLongTermMemoryExtractionEvent(runtime, extraction);
        await emitRunEvent(runtime, {
          type: "query_finished",
          reason: "completed",
          durationMs: Date.now() - turnStartedAt,
        });
        yield {
          type: "done",
          reason: "completed",
          sessionUsage: snapshotRuntimeUsage(runtime),
        };
        return;
      }

      for (const toolCall of toolCalls) {
        throwIfQueryAborted(runtime);
        yield { type: "tool_use", toolCall };
        const toolStartedAt = Date.now();
        await emitRunEvent(runtime, {
          type: "tool_call_started",
          turn,
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          argsChars: toolCall.function.arguments.length,
          argsPreview: preview(toolCall.function.arguments, 500),
        });
        const toolResultMessage = await executeToolCall(
          toolCall,
          runtime.tools,
          runtime,
          state,
        );
        const stateToolResultMessage = {
          ...(createMessage(toolResultMessage) as ToolMessage),
          toolName: toolCall.function.name,
        };
        await emitRunEvent(runtime, {
          type: "tool_call_finished",
          turn,
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          resultChars: stateToolResultMessage.content.length,
          durationMs: Date.now() - toolStartedAt,
          persistedToolResult: false,
          persistedToolResultPath: undefined,
        });
        throwIfQueryAborted(runtime);
        state.Messages.push(stateToolResultMessage);
        await recordTranscriptMessage(runtime, stateToolResultMessage);
        yield {
          type: "tool_result",
          toolCall,
          message: toDeepSeekMessage(stateToolResultMessage),
        };
      }

      await emitRunEvent(runtime, {
        type: "turn_finished",
        turn,
        hasToolUse: true,
      });
      yield { type: "turn_end", turn, hasToolUse: true };
    }

    await emitRunEvent(runtime, {
      type: "query_finished",
      reason: "max_turns",
      durationMs: Date.now() - turnStartedAt,
    });
    yield {
      type: "done",
      reason: "max_turns",
      sessionUsage: snapshotRuntimeUsage(runtime),
    };
  } catch (error) {
    await emitRunEvent(runtime, {
      type: "query_failed",
      durationMs: Date.now() - turnStartedAt,
      error: stringifyTelemetryError(error),
    });
    throw error;
  }
}

async function materializeRequestContext(
  runtime: Runtime,
  state: State,
): Promise<void> {
  await loadRuntimeContextForQuery(runtime, state);
  await loadDynamicSkillContextForQuery(runtime, state);
  await materializeContextForQuery(runtime, state);
}

async function recordHistorySnipSnapshotIfNeeded(
  runtime: Runtime,
  state: State,
  historySnipCountBefore: number,
): Promise<void> {
  if (state.historySnips.length <= historySnipCountBefore) {
    return;
  }

  await recordTranscriptStateSnapshot(runtime, state, "history_snip");
}

async function recordProjectionSnapshotIfNeeded(
  runtime: Runtime,
  state: State,
  messagesForQuery: MessagesForQuery,
): Promise<void> {
  const stats = messagesForQuery.stats;
  if (
    stats.toolResultBudgetReplacementCount === 0 &&
    stats.bulkyToolCompactCount === 0
  ) {
    return;
  }

  await recordTranscriptStateSnapshot(runtime, state, "projection");
}

async function drainPendingAgentMessagesForRuntime(
  runtime: Runtime,
  state: State,
): Promise<number> {

  if (runtime.agentRole !== "subagent") {
    return 0;
  }

  const messages = drainAgentMessages(state.agentTasks, runtime.agentId);
  if (messages.length === 0) {
    return 0;
  }

  const message = createMessage({
    role: "user",
    content: renderPendingAgentMessages(messages),
  }, { source: "agent_message" });
  state.Messages.push(message);
  await recordTranscriptMessage(runtime, message);
  await emitRunEvent(runtime, {
    type: "agent_message_drained",
    childAgentId: runtime.agentId,
    messageCount: messages.length,
  });

  return messages.length;
}

function renderPendingAgentMessages(messages: readonly string[]): string {
  const renderedMessages = messages
    .map((message, index) => [
      `<message index="${index + 1}">`,
      message,
      `</message>`,
    ].join("\n"))
    .join("\n\n");

  return [
    `<agent-messages>`,
    `The parent agent sent the following queued message${messages.length === 1 ? "" : "s"}.`,
    `Use the newest instructions together with your original task.`,
    "",
    renderedMessages,
    `</agent-messages>`,
  ].join("\n");
}

async function materializeContextForQuery(
  runtime: Runtime,
  state: State,
): Promise<number> {
  // TODO: this couples attachment logic to the auto-compress summary view.
  // Should use raw state.Messages (or a non-auto-compress request view)
  // for the long-term-memory recall query instead.
  const visibleMessages = applyAutoCompressSummary(state);
  const longTermMemoryMessage = shouldAttachLongTermMemory(state)
    ? await createLongTermMemoryContextMessage(runtime, visibleMessages)
    : null;
  const contextMessage = createProjectionContextStateMessage([
    ...(longTermMemoryMessage
      ? [{
        source: "long_term_memory" as const,
        content: typeof longTermMemoryMessage.content === "string"
          ? longTermMemoryMessage.content
          : "",
      }]
      : []),
    ...state.runtimeContextMessages.map((message) => ({
      source: message.source,
      content: typeof message.content === "string" ? message.content : "",
    })),
  ]);

  if (!contextMessage) {
    return 0;
  }

  removePreviousDynamicSkillContext(state);
  state.Messages.push(contextMessage);
  state.runtimeContextMessages = [];
  await recordTranscriptMessage(runtime, contextMessage);
  await recordTranscriptStateSnapshot(runtime, state, "runtime_context");
  return 1;
}

function removePreviousDynamicSkillContext(state: State): number {
  let changed = 0;
  state.Messages = state.Messages.flatMap((message) => {
    if (
      message.role !== "user" ||
      message.name !== "opencat_context" ||
      typeof message.content !== "string"
    ) {
      return [message];
    }

    const content = stripDynamicSkillContextBlocks(message.content);
    if (content === message.content) {
      return [message];
    }

    changed++;
    if (!content.includes("<context_block source=")) {
      return [];
    }

    return [{ ...message, content }];
  });
  return changed;
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

function shouldAttachLongTermMemory(state: State): boolean {
  const lastMessage = state.Messages.at(-1);
  return lastMessage?.role === "user" && lastMessage.source === "user";
}

type AutoCompressionRequest = {
  reason: "snipped_content";
  snippedContentThroughMessageId?: SnippedContentOnlyStats["lastMessageId"];
};

async function applyAutoCompressionWithTelemetry(
  runtime: Runtime,
  state: State,
  request: AutoCompressionRequest,
) {
  const beforeMessageCount = state.Messages.length;
  await emitRunEvent(runtime, {
    type: "auto_compress_started",
    messageCount: beforeMessageCount,
    reason: request.reason,
  });
  const result = await applyAutoCompression(runtime, state, {
    snippedContentThroughMessageId: request.snippedContentThroughMessageId,
  });
  await emitRunEvent(runtime, {
    type: "auto_compress_finished",
    status: result.status,
    reason: result.status === "skipped" ? result.reason : undefined,
    beforeMessageCount,
    afterMessageCount: state.Messages.length,
    summaryId: result.status === "compressed" ? result.summary.id : undefined,
    summaryChars: result.status === "compressed"
      ? result.summary.content.length
      : undefined,
    summaryMessageCount: result.status === "compressed"
      ? result.summary.messageCount
      : undefined,
  });

  return result;
}

function getAutoCompressionRequest(
  runtime: Runtime,
  state: State,
): AutoCompressionRequest | null {
  if (!canRuntimeAutoCompress(runtime)) {
    return null;
  }

  const snippedContent = getVisibleSnippedContentOnlyStats(state);
  if (
    snippedContent.lastMessageId &&
    snippedContent.tokens >= getSnippedContentAutoCompressTriggerTokens()
  ) {
    return {
      reason: "snipped_content",
      snippedContentThroughMessageId: snippedContent.lastMessageId,
    };
  }

  return null;
}

function canRuntimeAutoCompress(runtime: Runtime): boolean {
  return runtime.agentRole !== "session" && runtime.agentType !== "session_memory";
}

function estimateMessagesForQueryTokens(messagesForQuery: MessagesForQuery): number {
  return Math.ceil(JSON.stringify(messagesForQuery.messages).length / 4);
}

function getSnippedContentAutoCompressTriggerTokens(): number {
  const configured = Number(
    process.env.OPENCAT_SNIPPED_CONTENT_AUTO_COMPRESS_TRIGGER_TOKENS,
  );

  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return DEFAULT_SNIPPED_CONTENT_AUTO_COMPRESS_TRIGGER_TOKENS;
}

function throwIfQueryAborted(runtime: Runtime): void {
  runtime.toolUseContext.abortController.signal.throwIfAborted();
}

async function emitLongTermMemoryExtractionEvent(
  runtime: Runtime,
  result: LongTermMemoryExtractionResult,
): Promise<void> {
  await emitRunEvent(runtime, {
    type: "long_term_memory_extracted",
    status: result.status,
    count: result.status === "extracted" ? result.count : undefined,
    source: result.status === "extracted" ? result.source : undefined,
    reason: result.status === "skipped" || result.status === "failed"
      ? result.reason
      : undefined,
  });
}

function getAssistantTextChars(message: DeepSeekAssistantMessage): number {
  return typeof message.content === "string" ? message.content.length : 0;
}

function hasTaggedMessage(
  messagesForQuery: MessagesForQuery,
  tag: string,
): boolean {
  return messagesForQuery.messages.some((message) =>
    getDeepSeekMessageText(message).includes(tag)
  );
}

function getDeepSeekMessageText(
  message: MessagesForQuery["messages"][number],
): string {
  if (message.role === "assistant") {
    return typeof message.content === "string" ? message.content : "";
  }

  return message.content;
}

function preview(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...`;
}
