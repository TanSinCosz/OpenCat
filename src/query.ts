import { executeToolCall } from "./Tools/executor.js";
import type { Runtime, State } from "./types/type.js";
import { streamAssistantMessage } from "./query/assistant-stream.js";
import { createMessagesForQueryBuilder } from "./query/messages.js";
import { createStreamRequest } from "./query/request.js";
import type { QueryEvent, QueryOptions } from "./query/types.js";

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
  const maxTurns = options.maxTurns ?? 10;
  const buildMessagesForQuery =
    options.messagesForQueryBuilder ??
    createMessagesForQueryBuilder(options.promptOptions);
  const client = runtime.deepSeekClient;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const messagesForQuery = await buildMessagesForQuery(runtime, state);
    yield {
      type: "context_ready",
      systemPrompt: messagesForQuery.systemPrompt,
      messages: messagesForQuery.messages,
    };

    const request = await createStreamRequest(runtime, messagesForQuery.messages);
    yield { type: "model_stream_start", turn };

    let assistantMessage;
    for await (const update of streamAssistantMessage(client, request)) {
      if (update.type === "assistant_message_ready") {
        assistantMessage = update.message;
        continue;
      }

      yield update;
    }

    if (!assistantMessage) {
      throw new Error("Model stream completed without an assistant message.");
    }

    state.Messages.push({ message: assistantMessage });
    runtime.toolUseContext.messages = state.Messages;
    yield { type: "assistant_message", message: assistantMessage };

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
      );
      state.Messages.push({ message: toolResultMessage });
      runtime.toolUseContext.messages = state.Messages;
      yield {
        type: "tool_result",
        toolCall,
        message: toolResultMessage,
      };
    }

    yield { type: "turn_end", turn, hasToolUse: true };
  }

  yield { type: "done", reason: "max_turns" };
}
