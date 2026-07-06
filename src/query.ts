import { executeToolCall } from "./Tools/executor.js";
import { drainAgentMessages } from "./Tools/Agent/state.js";
import type { DeepSeekAssistantMessage } from "./deepseek/types.js";
import { createMessage, toDeepSeekMessage, type Message, type ToolMessage } from "./types/messages.js";
import { persistLargeToolResultIfNeeded } from "./tool-results/persistence.js";
import type { Runtime } from "./types/runtime.js";
import type { State } from "./types/state.js";
import { streamAssistantWithReasoningContinuation } from "./query/reasoning-continuation.js";
import {
  applyBulkyToolResultCompression,
  applyHistorySnip,
  applyToolResultBudget,
  createHistorySnipBoundaryIfNeeded,
  getHistorySnipBoundaries,
  getOrCreateSystemPrompt,
  projectMessagesWithHistorySnips,
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
  projectMessagesWithAutoCompress,
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

const DEFAULT_AUTO_COMPRESS_TRIGGER_TOKENS = 160_000;

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

      // Phase A: attach per-turn context into state.Messages before projection.
      // Subagent: drain queued parent-agent messages into state.Messages.
      await drainPendingAgentMessagesForRuntime(runtime, state);
      // Notifications from completed async subagents → runtimeContextMessages.
      await loadRuntimeContextForQuery(runtime, state);
      // Newly discovered project skills → runtimeContextMessages.
      await loadDynamicSkillContextForQuery(runtime, state);
      // Long-term memory recall + pack runtimeContextMessages → state.Messages.
      await materializeProjectionContextForQuery(runtime, state);

      // Phase B: project + compress (tool result budget → history snip).
      const messagesForQuery = await projectMessages(runtime, state);
      
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
      });
      yield {
        type: "context_ready",
        systemPrompt: messagesForQuery.systemPrompt,
        messages: messagesForQuery.messages,
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
        const persistedToolResultMessage = await persistLargeToolResultIfNeeded({
          runtime,
          message: createMessage(toolResultMessage) as ToolMessage,
          toolName: toolCall.function.name,
          maxResultSizeChars: runtime.tools.find((tool) =>
            tool.name === toolCall.function.name
          )?.maxResultSizeChars,
        });
        await emitRunEvent(runtime, {
          type: "tool_call_finished",
          turn,
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          resultChars: persistedToolResultMessage.content.length,
          durationMs: Date.now() - toolStartedAt,
          persistedToolResult: Boolean(
            persistedToolResultMessage.persistedToolResult,
          ),
          persistedToolResultPath:
            persistedToolResultMessage.persistedToolResult?.path,
        });
        throwIfQueryAborted(runtime);
        state.Messages.push(persistedToolResultMessage);
        await recordTranscriptMessage(runtime, persistedToolResultMessage);
        yield {
          type: "tool_result",
          toolCall,
          message: toDeepSeekMessage(persistedToolResultMessage),
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

/**
 * Project messages for a model request.  Tool result budget → history snip.
 * Read-only on state.Messages.  State.historySnips may grow when hard
 * truncation alone cannot bring the projection under the context limit.
 */
async function projectMessages(
  runtime: Runtime,
  state: State,
): Promise<MessagesForQuery> {
  const systemPrompt = await getOrCreateSystemPrompt(runtime);

  // Work on a copy so prompt projection never mutates state.Messages.
  const budgetedMessages = applyBulkyToolResultCompression(
    applyToolResultBudget(
      cloneMessages(state.Messages),
      runtime,
    ),
    runtime,
  );

  // Apply existing history snip boundaries (business messages).
  let projectedMessages = projectMessagesWithHistorySnips(
    state,
    budgetedMessages,
  );

  const boundaryCandidateMessages = [
    { role: "system" as const, content: systemPrompt },
    ...projectedMessages.map(toDeepSeekMessage),
  ];
  const historySnipBoundary = createHistorySnipBoundaryIfNeeded(
    boundaryCandidateMessages,
    projectedMessages,
  );

  if (historySnipBoundary) {
    getHistorySnipBoundaries(state).push(historySnipBoundary);
    const reprojectedBudgetedMessages = applyBulkyToolResultCompression(
      applyToolResultBudget(
        cloneMessages(state.Messages),
        runtime,
      ),
      runtime,
    );
    projectedMessages = projectMessagesWithHistorySnips(
      state,
      reprojectedBudgetedMessages,
    );
  }

  // History snip — hard truncation from the head.
  const sniped = applyHistorySnip(projectedMessages);

  // Convert to DeepSeek wire format at the end.
  return {
    systemPrompt,
    messages: [
      { role: "system" as const, content: systemPrompt },
      ...sniped.map(toDeepSeekMessage),
    ],
  };
}

function cloneMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({ ...message }) as Message);
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

async function materializeProjectionContextForQuery(
  runtime: Runtime,
  state: State,
): Promise<number> {
  // TODO: this couples attachment logic to auto-compress projection.
  // Should use raw state.Messages (or a non-auto-compress projection)
  // for the long-term-memory recall query instead.
  const projectedMessages = projectMessagesWithAutoCompress(state);
  const longTermMemoryMessage = shouldAttachLongTermMemory(state)
    ? await createLongTermMemoryContextMessage(runtime, projectedMessages)
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

  state.Messages.push(contextMessage);
  state.runtimeContextMessages = [];
  await recordTranscriptMessage(runtime, contextMessage);
  await recordTranscriptStateSnapshot(runtime, state, "runtime_context");
  return 1;
}

function shouldAttachLongTermMemory(state: State): boolean {
  const lastMessage = state.Messages.at(-1);
  return lastMessage?.role === "user" && lastMessage.source === "user";
}

async function applyAutoCompressionWithTelemetry(
  runtime: Runtime,
  state: State,
) {
  const beforeMessageCount = state.Messages.length;
  await emitRunEvent(runtime, {
    type: "auto_compress_started",
    messageCount: beforeMessageCount,
  });
  const result = await applyAutoCompression(runtime, state);
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

function shouldApplyAutoCompression(
  runtime: Runtime,
  messagesForQuery: MessagesForQuery,
): boolean {
  return canRuntimeAutoCompress(runtime) &&
    estimateMessagesForQueryTokens(messagesForQuery) >=
    getAutoCompressTriggerTokens();
}

function canRuntimeAutoCompress(runtime: Runtime): boolean {
  return runtime.agentRole !== "session" && runtime.agentType !== "session_memory";
}

function estimateMessagesForQueryTokens(messagesForQuery: MessagesForQuery): number {
  return Math.ceil(JSON.stringify(messagesForQuery.messages).length / 4);
}

function getAutoCompressTriggerTokens(): number {
  const configured = Number(process.env.OPENCAT_AUTO_COMPRESS_TRIGGER_TOKENS);

  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return DEFAULT_AUTO_COMPRESS_TRIGGER_TOKENS;
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
