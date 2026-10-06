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

import {
  sendOpenAICompatibleRequest,
  streamOpenAICompatibleRequest,
  toOpenAICompatibleTransportConfig,
} from "./transport.js";
import {
  applyProviderRequestExtensions,
  assertProviderSupportsMessages,
  getProviderProfile,
  toProviderAssistantMessage,
  type ProviderProfile,
} from "./provider.js";
import type { ModelRuntimeSettings } from "../types/config.js";
import type {
  ModelAssistantMessage,
  ModelChatCompletionChunk,
  ModelChatCompletionResponse,
  ModelChunkChoice,
  ModelCreateRequest,
  ModelDeltaToolCall,
  ModelMessage,
  ModelStreamEnvelope,
  ModelStreamRequest,
  ModelStreamResult,
  ModelToolCall,
  ModelToolDefinition,
  ModelToolChoice,
  ModelUsage,
  ModelLogprobs,
  ModelResponseFormat,
} from "./types.js";

type StreamResponseSnapshot = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<
    Omit<ModelChatCompletionResponse["choices"][number], "finish_reason"> & {
      finish_reason: ModelChunkChoice["finish_reason"];
    }
  >;
  usage?: ModelUsage;
  system_fingerprint?: string;
};

export interface CreateOpenAICompatibleClientOptions {
  config: ModelRuntimeSettings;
  fetchImpl?: typeof fetch;
}

export interface OpenAICompatibleClient {
  create(input: ModelCreateRequest): Promise<ModelChatCompletionResponse>;
  stream(
    input: ModelStreamRequest
  ): AsyncGenerator<ModelStreamEnvelope, void, void>;
  collectStream(input: ModelStreamRequest): Promise<ModelStreamResult>;
}

export function createOpenAICompatibleClient(
  options: CreateOpenAICompatibleClientOptions
): OpenAICompatibleClient {
  const runtimeConfig = toOpenAICompatibleTransportConfig(
    options.config,
    options.fetchImpl
  );
  const providerProfile = getProviderProfile(options.config);

  async function create(
    input: ModelCreateRequest
  ): Promise<ModelChatCompletionResponse> {
    const sdkRequest = toOpenAICreateRequest(input, providerProfile);
    const sdkResponse = await sendOpenAICompatibleRequest(runtimeConfig, sdkRequest, {
      signal: input.signal,
    });
    return fromOpenAIResponse(sdkResponse);
  }

  async function* stream(
    input: ModelStreamRequest
  ): AsyncGenerator<ModelStreamEnvelope, void, void> {
    const sdkRequest = toOpenAIStreamRequest(input, providerProfile);

    for await (
      const chunk of streamOpenAICompatibleRequest(runtimeConfig, sdkRequest, {
        signal: input.signal,
      })
    ) {
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
    input: ModelStreamRequest
  ): Promise<ModelStreamResult> {
    return collectModelStream(stream(input));
  }

  return {
    create,
    stream,
    collectStream,
  };
}

function toOpenAICreateRequest(
  input: ModelCreateRequest,
  providerProfile: ProviderProfile,
): ChatCompletionCreateParamsNonStreaming {
  assertProviderSupportsMessages(input.messages, providerProfile);

  const request: ChatCompletionCreateParamsNonStreaming & Record<string, unknown> = {
    model: input.model,
    messages: input.messages.map((message) =>
      toOpenAIMessage(message, providerProfile)),
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
    metadata: input.metadata,
    frequency_penalty: input.frequency_penalty ?? undefined,
    presence_penalty: input.presence_penalty ?? undefined,
  };

  const toolChoice = toOpenAIToolChoice(input.tool_choice ?? undefined);
  if (toolChoice !== undefined) {
    request.tool_choice = toolChoice;
  }

  return applyProviderRequestExtensions(request, input, providerProfile);
}

function toOpenAIStreamRequest(
  input: ModelStreamRequest,
  providerProfile: ProviderProfile,
): ChatCompletionCreateParamsStreaming {
  const request: ChatCompletionCreateParamsStreaming & Record<string, unknown> = {
    ...toOpenAICreateRequest(input, providerProfile),
    stream: true,
  };

  if (input.stream_options !== undefined) {
    request.stream_options = input.stream_options;
  }

  return request;
}

function toOpenAIMessage(
  message: ModelMessage,
  providerProfile: ProviderProfile,
): ChatCompletionMessageParam {
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
      return toProviderAssistantMessage(message, providerProfile);

    case "tool":
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.tool_call_id,
      };
  }
}

function toOpenAITool(tool: ModelToolDefinition): ChatCompletionTool {
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
  toolChoice: ModelToolChoice | undefined
): ChatCompletionToolChoiceOption | undefined {
  if (!toolChoice) {
    return undefined;
  }

  return toolChoice;
}

function fromOpenAIResponse(
  response: ChatCompletion
): ModelChatCompletionResponse {
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
): ModelChatCompletionChunk {
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

function fromOpenAIAssistantMessage(message: ChatCompletion.Choice["message"]): ModelAssistantMessage {
  return {
    role: "assistant",
    content: message.content,
    reasoning_content: getMessageReasoningContent(message),
    tool_calls: message.tool_calls?.map(fromOpenAIToolCall),
  };
}

function fromOpenAIToolCall(toolCall: ChatCompletionMessageToolCall): ModelToolCall {
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
): ModelDeltaToolCall {
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
): ModelUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const rawUsage = usage as unknown as Record<string, unknown>;
  const promptDetails = isRecord(rawUsage.prompt_tokens_details)
    ? rawUsage.prompt_tokens_details
    : undefined;
  const cacheHitTokens = readNonNegativeNumber(
    rawUsage.prompt_cache_hit_tokens,
  ) ?? readNonNegativeNumber(promptDetails?.cached_tokens);
  const cacheMissTokens = readNonNegativeNumber(
    rawUsage.prompt_cache_miss_tokens,
  ) ?? (cacheHitTokens === undefined
    ? undefined
    : Math.max(0, usage.prompt_tokens - cacheHitTokens));

  return {
    ...usage,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(cacheHitTokens === undefined
      ? {}
      : { prompt_cache_hit_tokens: cacheHitTokens }),
    ...(cacheMissTokens === undefined
      ? {}
      : { prompt_cache_miss_tokens: cacheMissTokens }),
  };
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function collectModelStream(
  stream: AsyncIterable<ModelStreamEnvelope>
): Promise<ModelStreamResult> {
  const events: ModelStreamEnvelope[] = [];
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
  chunk: ModelChatCompletionChunk
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
  chunkChoice: ModelChunkChoice
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
  chunk: ModelChatCompletionChunk
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
): ModelChatCompletionResponse | null {
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

function collectInitialToolCalls(choice: ModelChunkChoice): ModelToolCall[] {
  const toolCalls: ModelToolCall[] = [];

  if (choice.delta.tool_calls?.length) {
    mergeToolCalls(toolCalls, choice.delta.tool_calls);
  }

  return toolCalls;
}

function mergeToolCalls(
  target: ModelToolCall[],
  deltaToolCalls: NonNullable<ModelChunkChoice["delta"]["tool_calls"]>
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
  responseFormat: ModelResponseFormat
): ChatCompletionCreateParamsNonStreaming["response_format"] {
  return responseFormat as ChatCompletionCreateParamsNonStreaming["response_format"];
}

function toOpenAIJsonSchema(
  schema: ModelToolDefinition["function"]["parameters"]
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
): ModelLogprobs | null | undefined {
  if (!logprobs) {
    return logprobs === null ? null : undefined;
  }

  const extendedLogprobs = logprobs as typeof logprobs & {
    reasoning_content?: ModelLogprobs["reasoning_content"];
  };

  return {
    content: (logprobs.content as ModelLogprobs["content"]) ?? null,
    reasoning_content: extendedLogprobs.reasoning_content ?? null,
  };
}

function normalizeFinishReason(
  finishReason: string | null
): ModelChatCompletionResponse["choices"][number]["finish_reason"] {
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
): ModelChunkChoice["finish_reason"] {
  if (finishReason === null) {
    return null;
  }

  return normalizeFinishReason(finishReason);
}
