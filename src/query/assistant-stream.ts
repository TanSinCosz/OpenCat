import type { OpenAICompatibleClient } from "../openai-compatible/model-client.js";
import type {
  ModelAssistantMessage,
  ModelChatCompletionResponse,
  ModelCreateRequest,
  ModelDeltaToolCall,
  ModelStreamEnvelope,
  ModelToolCall,
} from "../openai-compatible/types.js";

export type AssistantStreamUpdate =
  | { type: "model_stream_event"; event: ModelStreamEnvelope }
  | { type: "assistant_reasoning_delta"; text: string }
  | { type: "assistant_text_delta"; text: string }
  | {
    type: "assistant_message_ready";
    message: ModelAssistantMessage;
    hadContent: boolean;
    finishReason: ModelChatCompletionResponse["choices"][number]["finish_reason"];
  };

export async function* streamAssistantMessage(
  client: OpenAICompatibleClient,
  request: ModelCreateRequest & { stream: true },
): AsyncGenerator<AssistantStreamUpdate, void, void> {
  const assistantMessage = createEmptyAssistantMessage();
  let finishReason: ModelChatCompletionResponse["choices"][number]["finish_reason"] =
    "stop";

  for await (const event of client.stream(request)) {
    yield { type: "model_stream_event", event };

    if (!event.chunk) {
      continue;
    }

    for (const choice of event.chunk.choices) {
      const delta = choice.delta;

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      if (typeof delta.content === "string") {
        assistantMessage.content =
          (assistantMessage.content ?? "") + delta.content;
        yield { type: "assistant_text_delta", text: delta.content };
      }

      if (typeof delta.reasoning_content === "string") {
        assistantMessage.reasoning_content =
          (assistantMessage.reasoning_content ?? "") + delta.reasoning_content;
        yield { type: "assistant_reasoning_delta", text: delta.reasoning_content };
      }

      if (delta.tool_calls?.length) {
        assistantMessage.tool_calls ??= [];
        mergeToolCallDeltas(assistantMessage.tool_calls, delta.tool_calls);
      }
    }
  }

  const hadContent = Boolean(assistantMessage.content);
  normalizeAssistantMessage(assistantMessage);
  yield {
    type: "assistant_message_ready",
    message: assistantMessage,
    hadContent,
    finishReason,
  };
}

function createEmptyAssistantMessage(): ModelAssistantMessage {
  return {
    role: "assistant",
    content: "",
    reasoning_content: null,
    tool_calls: [],
  };
}

function normalizeAssistantMessage(message: ModelAssistantMessage): void {
  if (!message.content) {
    message.content = message.tool_calls?.length ? null
      : message.reasoning_content
      ? [
        "The model returned internal reasoning but did not produce a final answer.",
        "This usually means the response token budget was exhausted before final text was generated. Try again with a higher model.maxTokens value in YAML or a lower reasoning effort.",
      ].join(" ")
      : "";
  }

  if (message.tool_calls?.length === 0) {
    delete message.tool_calls;
  }
}

function mergeToolCallDeltas(
  target: ModelToolCall[],
  deltas: ModelDeltaToolCall[],
): void {
  for (const delta of deltas) {
    const index = delta.index ?? 0;

    while (target.length <= index) {
      target.push({
        id: "",
        type: "function",
        function: {
          name: "",
          arguments: "",
        },
      });
    }

    const toolCall = target[index];

    if (delta.id) {
      toolCall.id = delta.id;
    }

    if (delta.type) {
      toolCall.type = delta.type;
    }

    if (delta.function?.name) {
      toolCall.function.name = delta.function.name;
    }

    if (typeof delta.function?.arguments === "string") {
      toolCall.function.arguments += delta.function.arguments;
    }
  }
}
