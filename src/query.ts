import { executeToolCall } from "./Tools/executor.js";
import { createMessage, toDeepSeekMessage, type ToolMessage } from "./types/messages.js";
import { persistLargeToolResultIfNeeded } from "./tool-results/persistence.js";
import type { Runtime } from "./types/runtime.js";
import type { State } from "./types/state.js";
import { streamAssistantWithReasoningContinuation } from "./query/reasoning-continuation.js";
import { buildMessagesForQuery } from "./query/messages.js";
import { createStreamRequest } from "./query/request.js";
import type { MessagesForQuery, QueryEvent, QueryOptions } from "./query/types.js";
import {
  clearRuntimeContextAfterModelRequest,
  loadRuntimeContextForQuery,
} from "./query/runtime-context.js";
import { applyAutoCompression } from "./auto-compress/index.js";
import {
  recordTranscriptMessage,
  recordTranscriptStateSnapshot,
} from "./transcript/persistence.js";

export type {
  MessageCompressionContext,
  MessageCompressionStep,
  MessagesForQuery,
  MessagesForQueryBuilder,
  QueryEvent,
  QueryOptions,
} from "./query/types.js";
export { buildMessagesForQuery, createMessagesForQueryBuilder } from "./query/messages.js";
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

  for (let turn = 1; turn <= maxTurns; turn++) {
    const messagesForQuery = await prepareMessagesForQuery(
      runtime,
      state,
      options,
    );
    yield {
      type: "context_ready",
      systemPrompt: messagesForQuery.systemPrompt,
      messages: messagesForQuery.messages,
    };

    const request = await createStreamRequest(runtime, messagesForQuery.messages);
    yield { type: "model_stream_start", turn };

    const assistantMessage = yield* streamAssistantWithReasoningContinuation(
      runtime,
      request,
    );

    const persistedAssistantMessage = createMessage(assistantMessage);
    state.Messages.push(persistedAssistantMessage);
    await recordTranscriptMessage(runtime, persistedAssistantMessage);
    runtime.toolUseContext.messages = state.Messages;
    yield { type: "assistant_message", message: assistantMessage };
    await clearRuntimeContextAfterModelRequest(runtime, state);

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      yield { type: "turn_end", turn, hasToolUse: false };
      yield { type: "done", reason: "completed" };
      return;
    }

    for (const toolCall of toolCalls) {
      yield { type: "tool_use", toolCall };
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
      state.Messages.push(persistedToolResultMessage);
      await recordTranscriptMessage(runtime, persistedToolResultMessage);
      runtime.toolUseContext.messages = state.Messages;
      yield {
        type: "tool_result",
        toolCall,
        message: toDeepSeekMessage(persistedToolResultMessage),
      };
    }

    yield { type: "turn_end", turn, hasToolUse: true };
  }

  yield { type: "done", reason: "max_turns" };
}

async function prepareMessagesForQuery(
  runtime: Runtime,
  state: State,
  options: QueryOptions,
): Promise<MessagesForQuery> {
  if (options.messagesForQueryBuilder) {
    let messagesForQuery = await options.messagesForQueryBuilder(runtime, state);
    if (shouldApplyAutoCompression(messagesForQuery)) {
      const result = await applyAutoCompression(runtime, state);
      if (result.status === "compressed") {
        await recordTranscriptStateSnapshot(runtime, state, "auto_compress");
        messagesForQuery = await options.messagesForQueryBuilder(runtime, state);
      }
    }
    if (await loadRuntimeContextForQuery(runtime, state) > 0) {
      runtime.toolUseContext.messages = state.Messages;
      messagesForQuery = await options.messagesForQueryBuilder(runtime, state);
    }
    return messagesForQuery;
  }

  const projectedMessages = await buildMessagesForQuery(runtime, state, {
    promptOptions: options.promptOptions,
    applyRequestLimits: false,
    includeRuntimeContext: false,
  });

  if (shouldApplyAutoCompression(projectedMessages)) {
    const result = await applyAutoCompression(runtime, state);
    if (result.status === "compressed") {
      await recordTranscriptStateSnapshot(runtime, state, "auto_compress");
    }
  }

  if (await loadRuntimeContextForQuery(runtime, state) > 0) {
    runtime.toolUseContext.messages = state.Messages;
  }

  return buildMessagesForQuery(runtime, state, {
    promptOptions: options.promptOptions,
  });
}

function shouldApplyAutoCompression(messagesForQuery: MessagesForQuery): boolean {
  return estimateMessagesForQueryTokens(messagesForQuery) >=
    getAutoCompressTriggerTokens();
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
