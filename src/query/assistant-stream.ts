import type { DeepSeekClient } from "../deepseek/client.js";
import type {
  DeepSeekAssistantMessage,
  DeepSeekChatCompletionResponse,
  DeepSeekCreateRequest,
  DeepSeekDeltaToolCall,
  DeepSeekStreamEnvelope,
  DeepSeekToolCall,
} from "../deepseek/types.js";

export type AssistantStreamUpdate =
  | { type: "model_stream_event"; event: DeepSeekStreamEnvelope }
  | { type: "assistant_reasoning_delta"; text: string }
  | { type: "assistant_text_delta"; text: string }
  | {
    type: "assistant_message_ready";
    message: DeepSeekAssistantMessage;
    hadContent: boolean;
    finishReason: DeepSeekChatCompletionResponse["choices"][number]["finish_reason"];
  };

export async function* streamAssistantMessage(
  client: DeepSeekClient,
  request: DeepSeekCreateRequest & { stream: true },
): AsyncGenerator<AssistantStreamUpdate, void, void> {
  const assistantMessage = createEmptyAssistantMessage();
  let finishReason: DeepSeekChatCompletionResponse["choices"][number]["finish_reason"] =
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

function createEmptyAssistantMessage(): DeepSeekAssistantMessage {
  return {
    role: "assistant",
    content: "",
    reasoning_content: null,
    tool_calls: [],
  };
}

function normalizeAssistantMessage(message: DeepSeekAssistantMessage): void {
  if (!message.content) {
    message.content = message.tool_calls?.length ? null
      : message.reasoning_content
      ? [
        "The model returned internal reasoning but did not produce a final answer.",
        "This usually means the response token budget was exhausted before final text was generated. Try again with a higher OPENCAT_MAX_TOKENS value or a lower reasoning effort.",
      ].join(" ")
      : "";
  }

  if (message.tool_calls?.length === 0) {
    delete message.tool_calls;
  }
}

function mergeToolCallDeltas(
  target: DeepSeekToolCall[],
  deltas: DeepSeekDeltaToolCall[],
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
