import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";

import type { DeepSeekRuntimeSettings } from "../types/type.js";
import {
  sendDeepSeekSdkRequest,
  streamDeepSeekSdkRequest,
  toDeepSeekRuntimeConfig,
} from "./runtime.js";
import type {
  DeepSeekAssistantMessage,
  DeepSeekChatCompletionChunk,
  DeepSeekChatCompletionResponse,
  DeepSeekChunkChoice,
  DeepSeekCreateRequest,
  DeepSeekDeltaToolCall,
  DeepSeekMessage,
  DeepSeekStreamEnvelope,
  DeepSeekStreamRequest,
  DeepSeekStreamResult,
  DeepSeekToolCall,
  DeepSeekToolDefinition,
  DeepSeekToolChoice,
  DeepSeekUsage,
  DeepSeekLogprobs,
  DeepSeekResponseFormat,
} from "./types.js";

type StreamResponseSnapshot = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<
    Omit<DeepSeekChatCompletionResponse["choices"][number], "finish_reason"> & {
      finish_reason: DeepSeekChunkChoice["finish_reason"];
    }
  >;
  usage?: DeepSeekUsage;
  system_fingerprint?: string;
};

export interface CreateDeepSeekClientOptions {
  config: DeepSeekRuntimeSettings;
  fetchImpl?: typeof fetch;
}

export interface DeepSeekClient {
  create(input: DeepSeekCreateRequest): Promise<DeepSeekChatCompletionResponse>;
  stream(
    input: DeepSeekStreamRequest
  ): AsyncGenerator<DeepSeekStreamEnvelope, void, void>;
  collectStream(input: DeepSeekStreamRequest): Promise<DeepSeekStreamResult>;
}

export function createDeepSeekClient(
  options: CreateDeepSeekClientOptions
): DeepSeekClient {
  const runtimeConfig = toDeepSeekRuntimeConfig(
    options.config,
    options.fetchImpl
  );

  async function create(
    input: DeepSeekCreateRequest
  ): Promise<DeepSeekChatCompletionResponse> {
    const sdkRequest = toOpenAICreateRequest(
      prependSystemPrompt(input, options.config.systemPrompt)
    );
    const sdkResponse = await sendDeepSeekSdkRequest(runtimeConfig, sdkRequest);
    return fromOpenAIResponse(sdkResponse);
  }

  async function* stream(
    input: DeepSeekStreamRequest
  ): AsyncGenerator<DeepSeekStreamEnvelope, void, void> {
    const sdkRequest = toOpenAIStreamRequest(
      prependSystemPrompt(input, options.config.systemPrompt)
    );

    for await (const chunk of streamDeepSeekSdkRequest(runtimeConfig, sdkRequest)) {
      yield {
        chunk: fromOpenAIChunk(chunk),
        raw: JSON.stringify(chunk),
        done: false,
      };
    }

    yield {
      chunk: null,
      raw: "[DONE]",
      done: true,
    };
  }

  async function collectStream(
    input: DeepSeekStreamRequest
  ): Promise<DeepSeekStreamResult> {
    return collectDeepSeekStream(stream(input));
  }

  return {
    create,
    stream,
    collectStream,
  };
}

function prependSystemPrompt<T extends { messages: DeepSeekMessage[] }>(
  input: T,
  systemPrompt: string | undefined
): T {
  if (!systemPrompt) {
    return input;
  }

  return {
    ...input,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      ...input.messages,
    ],
  };
}

function toOpenAICreateRequest(
  input: DeepSeekCreateRequest
): ChatCompletionCreateParamsNonStreaming {
  const request: ChatCompletionCreateParamsNonStreaming & Record<string, unknown> = {
    model: input.model,
    messages: input.messages.map(toOpenAIMessage),
    max_tokens: input.max_tokens,
    temperature: input.temperature,
    response_format: input.response_format
      ? toOpenAIResponseFormat(input.response_format)
      : undefined,
    stop: input.stop ?? undefined,
    top_p: input.top_p ?? undefined,
    tools: input.tools?.map(toOpenAITool),
    logprobs: input.logprobs ?? undefined,
    top_logprobs: input.top_logprobs ?? undefined,
    user: input.user_id ?? undefined,
    metadata: input.metadata,
    frequency_penalty: input.frequency_penalty ?? undefined,
    presence_penalty: input.presence_penalty ?? undefined,
  };

  const toolChoice = toOpenAIToolChoice(input.tool_choice ?? undefined);
  if (toolChoice !== undefined) {
    request.tool_choice = toolChoice;
  }

  if (input.thinking !== undefined) {
    request.thinking = input.thinking;
  }

  if (input.reasoning_effort !== undefined) {
    (request as Record<string, unknown>).reasoning_effort = input.reasoning_effort;
  }

  return request;
}

function toOpenAIStreamRequest(
  input: DeepSeekStreamRequest
): ChatCompletionCreateParamsStreaming {
  const request: ChatCompletionCreateParamsStreaming & Record<string, unknown> = {
    ...toOpenAICreateRequest(input),
    stream: true,
  };

  if (input.stream_options !== undefined) {
    request.stream_options = input.stream_options;
  }

  return request;
}

function toOpenAIMessage(message: DeepSeekMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
      return {
        role: "system",
        content: message.content,
        name: message.name,
      };

    case "user":
      return {
        role: "user",
        content: message.content,
        name: message.name,
      };

    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        name: message.name,
        tool_calls: message.tool_calls?.map(toOpenAIToolCall),
        prefix: message.prefix,
        reasoning_content: message.reasoning_content,
      } as ChatCompletionMessageParam;

    case "tool":
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.tool_call_id,
      };
  }
}

function toOpenAITool(tool: DeepSeekToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
        ? toOpenAIJsonSchema(tool.function.parameters)
        : undefined,
      strict: tool.function.strict,
    },
  };
}

function toOpenAIToolChoice(
  toolChoice: DeepSeekToolChoice | undefined
): ChatCompletionToolChoiceOption | undefined {
  if (!toolChoice) {
    return undefined;
  }

  return toolChoice;
}

function toOpenAIToolCall(toolCall: DeepSeekToolCall): ChatCompletionMessageToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  };
}

function fromOpenAIResponse(
  response: ChatCompletion
): DeepSeekChatCompletionResponse {
  return {
    id: response.id,
    object: "chat.completion",
    created: response.created,
    model: response.model,
    choices: response.choices.map((choice) => ({
      index: choice.index,
      finish_reason: normalizeFinishReason(choice.finish_reason),
      logprobs: fromOpenAILogprobs(choice.logprobs),
      message: fromOpenAIAssistantMessage(choice.message),
    })),
    usage: fromOpenAIUsage(response.usage),
    system_fingerprint: response.system_fingerprint,
  };
}

function fromOpenAIChunk(
  chunk: ChatCompletionChunk
): DeepSeekChatCompletionChunk {
  return {
    id: chunk.id,
    object: "chat.completion.chunk",
    created: chunk.created,
    model: chunk.model,
    choices: chunk.choices.map((choice) => ({
      index: choice.index,
      delta: {
        role: choice.delta.role === "assistant" ? "assistant" : null,
        content: choice.delta.content ?? null,
        reasoning_content: getReasoningContent(choice.delta),
        tool_calls: choice.delta.tool_calls?.map(fromOpenAIDeltaToolCall),
      },
      finish_reason: normalizeChunkFinishReason(choice.finish_reason),
      logprobs: fromOpenAILogprobs(choice.logprobs),
    })),
    usage: fromOpenAIUsage(chunk.usage),
    system_fingerprint: chunk.system_fingerprint,
  };
}

function fromOpenAIAssistantMessage(message: ChatCompletion.Choice["message"]): DeepSeekAssistantMessage {
  return {
    role: "assistant",
    content: message.content,
    reasoning_content: getMessageReasoningContent(message),
    tool_calls: message.tool_calls?.map(fromOpenAIToolCall),
  };
}

function fromOpenAIToolCall(toolCall: ChatCompletionMessageToolCall): DeepSeekToolCall {
  if ("function" in toolCall) {
    return {
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    };
  }

  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: "",
      arguments: "",
    },
  };
}

function fromOpenAIDeltaToolCall(
  toolCall: ChatCompletionChunk.Choice.Delta.ToolCall
): DeepSeekDeltaToolCall {
  return {
    index: toolCall.index,
    id: toolCall.id,
    type: toolCall.type === "function" ? "function" : undefined,
    function:
      toolCall.function
        ? {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        }
        : undefined,
  };
}

function fromOpenAIUsage(
  usage: ChatCompletion["usage"] | ChatCompletionChunk["usage"] | null | undefined
): DeepSeekUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    ...usage,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  };
}

async function collectDeepSeekStream(
  stream: AsyncIterable<DeepSeekStreamEnvelope>
): Promise<DeepSeekStreamResult> {
  const events: DeepSeekStreamEnvelope[] = [];
  let response: StreamResponseSnapshot | null = null;
  const reasoningTexts: string[] = [];

  for await (const event of stream) {
    events.push(event);

    if (!event.done && event.chunk) {
      applyChunkReasoning(reasoningTexts, event.chunk);
      response = applyChunkToResponse(response, event.chunk);
    }
  }

  return {
    events,
    response: finalizeStreamResponseSnapshot(response),
    text: response?.choices[0]?.message.content ?? "",
    reasoningText: reasoningTexts[0] ?? "",
  };
}

function applyChunkToResponse(
  current: StreamResponseSnapshot | null,
  chunk: DeepSeekChatCompletionChunk
): StreamResponseSnapshot {
  if (!current) {
    return {
      id: chunk.id,
      object: "chat.completion",
      created: chunk.created,
      model: chunk.model,
      choices: chunk.choices.map((choice) => ({
        index: choice.index,
        finish_reason: choice.finish_reason,
        logprobs: choice.logprobs ?? undefined,
        message: {
          role: "assistant",
          content: choice.delta.content ?? "",
          reasoning_content: choice.delta.reasoning_content ?? null,
          tool_calls: collectInitialToolCalls(choice),
        },
      })),
      usage: chunk.usage ?? undefined,
      system_fingerprint: chunk.system_fingerprint,
    };
  }

  for (const choice of chunk.choices) {
    const target = ensureChoice(current, choice.index);
    applyChunkChoice(target, choice);
  }

  if (chunk.usage) {
    current.usage = chunk.usage;
  }

  return current;
}

function ensureChoice(
  response: StreamResponseSnapshot,
  index: number
) {
  while (response.choices.length <= index) {
    response.choices.push({
      index: response.choices.length,
      finish_reason: null,
      logprobs: undefined,
      message: {
        role: "assistant",
        content: "",
        reasoning_content: null,
        tool_calls: [],
      },
    });
  }

  return response.choices[index];
}

function applyChunkChoice(
  target: StreamResponseSnapshot["choices"][number],
  chunkChoice: DeepSeekChunkChoice
): void {
  const delta = chunkChoice.delta;

  if (typeof delta.content === "string") {
    target.message.content = (target.message.content ?? "") + delta.content;
  }

  if (typeof delta.reasoning_content === "string") {
    target.message.reasoning_content =
      (target.message.reasoning_content ?? "") + delta.reasoning_content;
  }

  if (delta.tool_calls?.length) {
    target.message.tool_calls = target.message.tool_calls ?? [];
    mergeToolCalls(target.message.tool_calls, delta.tool_calls);
  }

  if (chunkChoice.finish_reason !== null) {
    target.finish_reason = chunkChoice.finish_reason;
  }
}

function applyChunkReasoning(
  reasoningTexts: string[],
  chunk: DeepSeekChatCompletionChunk
): void {
  for (const choice of chunk.choices) {
    if (typeof choice.delta.reasoning_content !== "string") {
      continue;
    }

    while (reasoningTexts.length <= choice.index) {
      reasoningTexts.push("");
    }

    reasoningTexts[choice.index] += choice.delta.reasoning_content;
  }
}

function finalizeStreamResponseSnapshot(
  response: StreamResponseSnapshot | null
): DeepSeekChatCompletionResponse | null {
  if (!response) {
    return null;
  }

  return {
    id: response.id,
    object: "chat.completion",
    created: response.created,
    model: response.model,
    choices: response.choices.map((choice) => ({
      ...choice,
      finish_reason: normalizeFinishReason(choice.finish_reason ?? "stop"),
      message: {
        ...choice.message,
        reasoning_content: choice.message.reasoning_content ?? null,
      },
    })),
    usage: response.usage,
    system_fingerprint: response.system_fingerprint,
  };
}

function collectInitialToolCalls(choice: DeepSeekChunkChoice): DeepSeekToolCall[] {
  const toolCalls: DeepSeekToolCall[] = [];

  if (choice.delta.tool_calls?.length) {
    mergeToolCalls(toolCalls, choice.delta.tool_calls);
  }

  return toolCalls;
}

function mergeToolCalls(
  target: DeepSeekToolCall[],
  deltaToolCalls: NonNullable<DeepSeekChunkChoice["delta"]["tool_calls"]>
): void {
  for (const deltaToolCall of deltaToolCalls) {
    const index = deltaToolCall.index ?? 0;

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

    if (deltaToolCall.id) {
      toolCall.id = deltaToolCall.id;
    }

    if (deltaToolCall.type) {
      toolCall.type = deltaToolCall.type;
    }

    if (deltaToolCall.function?.name) {
      toolCall.function.name = deltaToolCall.function.name;
    }

    if (typeof deltaToolCall.function?.arguments === "string") {
      toolCall.function.arguments += deltaToolCall.function.arguments;
    }
  }
}

function getReasoningContent(
  delta: ChatCompletionChunk.Choice.Delta
): string | null {
  const extendedDelta = delta as ChatCompletionChunk.Choice.Delta & {
    reasoning_content?: string | null;
  };

  return extendedDelta.reasoning_content ?? null;
}

function toOpenAIResponseFormat(
  responseFormat: DeepSeekResponseFormat
): ChatCompletionCreateParamsNonStreaming["response_format"] {
  return responseFormat as ChatCompletionCreateParamsNonStreaming["response_format"];
}

function toOpenAIJsonSchema(
  schema: DeepSeekToolDefinition["function"]["parameters"]
): Record<string, unknown> {
  return schema as unknown as Record<string, unknown>;
}

function getMessageReasoningContent(
  message: ChatCompletion.Choice["message"]
): string | null {
  const extendedMessage = message as ChatCompletion.Choice["message"] & {
    reasoning_content?: string | null;
  };

  return extendedMessage.reasoning_content ?? null;
}

function fromOpenAILogprobs(
  logprobs: ChatCompletion.Choice["logprobs"] | ChatCompletionChunk.Choice["logprobs"] | null | undefined
): DeepSeekLogprobs | null | undefined {
  if (!logprobs) {
    return logprobs === null ? null : undefined;
  }

  const extendedLogprobs = logprobs as typeof logprobs & {
    reasoning_content?: DeepSeekLogprobs["reasoning_content"];
  };

  return {
    content: (logprobs.content as DeepSeekLogprobs["content"]) ?? null,
    reasoning_content: extendedLogprobs.reasoning_content ?? null,
  };
}

function normalizeFinishReason(
  finishReason: string | null
): DeepSeekChatCompletionResponse["choices"][number]["finish_reason"] {
  switch (finishReason) {
    case "stop":
    case "length":
    case "tool_calls":
    case "content_filter":
    case "insufficient_system_resource":
      return finishReason;
    case "function_call":
      return "tool_calls";
    default:
      return "insufficient_system_resource";
  }
}

function normalizeChunkFinishReason(
  finishReason: string | null
): DeepSeekChunkChoice["finish_reason"] {
  if (finishReason === null) {
    return null;
  }

  return normalizeFinishReason(finishReason);
}
