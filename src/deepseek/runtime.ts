import OpenAI, { type ClientOptions } from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";

import type { DeepSeekRuntimeSettings } from "../types/config.js";
import { normalizeDeepSeekApiError } from "./errors.js";

export interface DeepSeekRuntimeConfig {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";

export function createDeepSeekOpenAIClient(
  config: DeepSeekRuntimeConfig
): OpenAI {
  const options: ClientOptions = {
    apiKey: config.apiKey,
    baseURL: config.baseUrl ?? DEFAULT_BASE_URL,
    defaultHeaders: config.headers,
    fetch: config.fetchImpl,
  };

  return new OpenAI(options);
}

export async function sendDeepSeekSdkRequest(
  config: DeepSeekRuntimeConfig,
  request: ChatCompletionCreateParamsNonStreaming
): Promise<ChatCompletion> {
  const client = createDeepSeekOpenAIClient(config);
  try {
    return await client.chat.completions.create(request);
  } catch (error) {
    throw normalizeDeepSeekApiError(error);
  }
}

export async function* streamDeepSeekSdkRequest(
  config: DeepSeekRuntimeConfig,
  request: ChatCompletionCreateParamsStreaming
): AsyncGenerator<ChatCompletionChunk, void, void> {
  const client = createDeepSeekOpenAIClient(config);
  let stream: AsyncIterable<ChatCompletionChunk>;
  try {
    stream = await client.chat.completions.create(request);
  } catch (error) {
    throw normalizeDeepSeekApiError(error);
  }

  try {
    for await (const chunk of stream) {
      yield chunk;
    }
  } catch (error) {
    throw normalizeDeepSeekApiError(error);
  }
}

export function toDeepSeekRuntimeConfig(
  config: DeepSeekRuntimeSettings,
  fetchImpl?: typeof fetch
): DeepSeekRuntimeConfig {
  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    headers: config.headers,
    fetchImpl,
  };
}
