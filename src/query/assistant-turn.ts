/** 模型回合：保存 fork 输入快照、请求模型、持久化 assistant 消息，并在响应后清理一次性上下文。 */
import type { ModelAssistantMessage } from "../openai-compatible/types.js";
import { createMessage, type Message } from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import { recordTranscriptMessage } from "../transcript/persistence.js";
import { emitRunEvent } from "../telemetry/observer.js";
import type { MessagesForQuery, QueryEvent } from "./types.js";
import { createStreamRequest } from "./request.js";
import { streamAssistantWithReasoningContinuation } from "./reasoning-continuation.js";
import { clearRuntimeContextAfterModelRequest } from "./runtime-context.js";

export interface SampledAssistantTurn {
  /** 模型原始响应，用于对外事件与工具调用。 */
  message: ModelAssistantMessage;
  /** 带本地消息 ID、用量等元数据的记录，用于 State、持久化和摘要。 */
  persistedMessage: Message;
}

export async function* sampleAssistantTurn(
  runtime: Runtime,
  state: State,
  messagesForQuery: MessagesForQuery,
  turn: number,
): AsyncGenerator<QueryEvent, SampledAssistantTurn, void> {
  // fork 继承本次请求的业务前缀；必须在后续工具调用改变 State 前保存。
  runtime.lastModelRequestContextMessages = cloneMessagesForFork(
    messagesForQuery.forkContextMessages,
  );
  const request = await createStreamRequest(runtime, messagesForQuery.messages);
  runtime.toolUseContext.abortController.signal.throwIfAborted();
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
  return { message: assistantMessage, persistedMessage: persistedAssistantMessage };
}

function cloneMessagesForFork(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({ ...message }) as Message);
}

function getAssistantTextChars(message: ModelAssistantMessage): number {
  return typeof message.content === "string" ? message.content.length : 0;
}
