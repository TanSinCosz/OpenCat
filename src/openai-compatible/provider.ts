import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

import type {
  ModelCreateRequest,
  ModelMessage,
  ModelUserContentPart,
} from "./types.js";

export type ModelProvider = "deepseek" | "volcengine" | "openai-compatible";

export interface ProviderProfile {
  name: ModelProvider;
  displayName: string;
  apiKeyConfigField: string;
  defaultBaseUrl?: string;
  /** Provider-only fields accepted in assistant history messages. */
  assistantMessageExtensions: ReadonlySet<"prefix" | "reasoning_content">;
  /** Provider-only fields accepted at the top level of a request. */
  requestExtensions: ReadonlySet<
    "user_id" | "thinking" | "reasoning_effort"
  >;
  /** User content blocks accepted by this provider's Chat API. */
  userContentParts: ReadonlySet<ModelUserContentPart["type"]>;
}

export interface ProviderSettings {
  provider?: ModelProvider;
  baseUrl?: string;
}

const DEEPSEEK_PROFILE: ProviderProfile = {
  name: "deepseek",
  displayName: "DeepSeek",
  apiKeyConfigField: "model.apiKey",
  defaultBaseUrl: "https://api.deepseek.com",
  assistantMessageExtensions: new Set(["prefix", "reasoning_content"]),
  requestExtensions: new Set(["user_id", "thinking", "reasoning_effort"]),
  userContentParts: new Set(["text"]),
};

const VOLCENGINE_PROFILE: ProviderProfile = {
  name: "volcengine",
  displayName: "Volcengine Ark",
  apiKeyConfigField: "model.apiKey",
  defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  assistantMessageExtensions: new Set(),
  requestExtensions: new Set(),
  userContentParts: new Set(["text", "image_url"]),
};

const OPENAI_COMPATIBLE_PROFILE: ProviderProfile = {
  name: "openai-compatible",
  displayName: "OpenAI-compatible provider",
  apiKeyConfigField: "model.apiKey",
  assistantMessageExtensions: new Set(),
  requestExtensions: new Set(["reasoning_effort"]),
  userContentParts: new Set(["text", "image_url"]),
};

const PROFILES: Record<ModelProvider, ProviderProfile> = {
  deepseek: DEEPSEEK_PROFILE,
  volcengine: VOLCENGINE_PROFILE,
  "openai-compatible": OPENAI_COMPATIBLE_PROFILE,
};

export function resolveModelProvider(settings: ProviderSettings): ModelProvider {
  if (settings.provider) {
    return settings.provider;
  }

  const baseUrl = settings.baseUrl?.toLowerCase() ?? "";
  if (baseUrl.includes("volces.com") || baseUrl.includes("volcengine")) {
    return "volcengine";
  }
  if (!baseUrl || baseUrl.includes("deepseek")) {
    return "deepseek";
  }
  return "openai-compatible";
}

export function getProviderProfile(
  settings: ProviderSettings,
): ProviderProfile {
  return PROFILES[resolveModelProvider(settings)];
}

export function getProviderBaseUrl(settings: ProviderSettings): string | undefined {
  return settings.baseUrl ?? getProviderProfile(settings).defaultBaseUrl;
}

export function applyProviderRequestExtensions(
  request: ChatCompletionCreateParamsNonStreaming & Record<string, unknown>,
  input: ModelCreateRequest,
  profile: ProviderProfile,
): ChatCompletionCreateParamsNonStreaming & Record<string, unknown> {
  if (profile.requestExtensions.has("user_id") && input.user_id) {
    request.user_id = input.user_id;
  }
  if (
    profile.requestExtensions.has("thinking") &&
    input.thinking !== undefined
  ) {
    request.thinking = input.thinking;
  }
  if (
    profile.requestExtensions.has("reasoning_effort") &&
    input.reasoning_effort !== undefined
  ) {
    (request as Record<string, unknown>).reasoning_effort =
      input.reasoning_effort;
  }

  return request;
}

export function assertProviderSupportsMessages(
  messages: readonly ModelMessage[],
  profile: ProviderProfile,
): void {
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string") {
      continue;
    }

    if (message.content.length === 0) {
      throw new Error("A multimodal user message must contain at least one content part.");
    }

    for (const part of message.content) {
      if (!profile.userContentParts.has(part.type)) {
        throw new Error(
          `${profile.displayName} Chat API does not support user content part '${part.type}' in this client profile.`,
        );
      }
      if (part.type === "image_url" && !part.image_url.url.trim()) {
        throw new Error("Image URL must not be empty.");
      }
    }
  }
}

export function toProviderAssistantMessage(
  message: Extract<ModelMessage, { role: "assistant" }>,
  profile: ProviderProfile,
): ChatCompletionMessageParam {
  const result: Record<string, unknown> = {
    role: "assistant",
    content: message.content,
    name: message.name,
    tool_calls: message.tool_calls,
  };

  if (profile.assistantMessageExtensions.has("prefix")) {
    result.prefix = message.prefix;
  }
  if (profile.assistantMessageExtensions.has("reasoning_content")) {
    result.reasoning_content = message.reasoning_content;
  }

  return result as unknown as ChatCompletionMessageParam;
}
