
import type { JSONSchemaObject } from "../Tools/types.js";

export interface ModelFunctionDefinition {
  name: string;
  description?: string;
  parameters?: JSONSchemaObject;
  strict?: boolean;
}

export interface ModelToolDefinition {
  type: "function";
  function: ModelFunctionDefinition;
}

export type ModelToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
    type: "function";
    function: {
      name: string;
    };
  };

export interface ModelToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelResponseFormatText {
  type: "text";
}

export interface ModelResponseFormatJsonObject {
  type: "json_object";
}

export type ModelResponseFormat =
  | ModelResponseFormatText
  | ModelResponseFormatJsonObject;

export interface ModelThinkingConfig {
  type: "enabled" | "disabled";
}

export interface ModelStreamOptions {
  include_usage: boolean;
}

export interface ModelSystemMessage {
  role: "system";
  content: string;
  name?: string;
}

export interface ModelTextContentPart {
  type: "text";
  text: string;
}

export type ModelImageDetail = "auto" | "low" | "high";

export interface ModelImageUrlContentPart {
  type: "image_url";
  image_url: {
    /** Public image URL or a data:image/...;base64,... URL. */
    url: string;
    detail?: ModelImageDetail;
  };
}

export type ModelUserContentPart =
  | ModelTextContentPart
  | ModelImageUrlContentPart;

export type ModelUserContent = string | ModelUserContentPart[];

export interface ModelUserMessage {
  role: "user";
  content: ModelUserContent;
  name?: string;
}

export interface ModelAssistantMessage {
  role: "assistant";
  content: string | null;
  name?: string;
  prefix?: boolean;
  reasoning_content?: string | null;
  tool_calls?: ModelToolCall[];
}

export interface ModelToolMessage {
  role: "tool";
  content: string;
  tool_call_id: string;
}

export type ModelMessage =
  | ModelSystemMessage
  | ModelUserMessage
  | ModelAssistantMessage
  | ModelToolMessage;

export interface ModelCreateRequest {
  model: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
  thinking?: ModelThinkingConfig | null;
  reasoning_effort?: "high" | "max";
  max_tokens?: number | null;
  response_format?: ModelResponseFormat | null;
  stop?: string | string[] | null;
  temperature?: number | null;
  top_p?: number | null;
  tools?: ModelToolDefinition[] | null;
  tool_choice?: ModelToolChoice | null;
  logprobs?: boolean | null;
  top_logprobs?: number | null;
  user_id?: string | null;
  metadata?: Record<string, string>;
  frequency_penalty?: number | null;
  presence_penalty?: number | null;
}

export interface ModelStreamRequest extends ModelCreateRequest {
  stream: true;
  stream_options?: ModelStreamOptions | null;
}

export interface ModelTokenLogprob {
  token: string;
  logprob: number;
  bytes: number[] | null;
  top_logprobs: ModelTokenLogprobTop[];
}

export interface ModelTokenLogprobTop {
  token: string;
  logprob: number;
  bytes: number[] | null;
}

export interface ModelLogprobs {
  content: ModelTokenLogprob[] | null;
  reasoning_content?: ModelTokenLogprob[] | null;
}

export interface ModelChoice {
  index: number;
  message: ModelAssistantMessage;
  finish_reason:
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "insufficient_system_resource";
  logprobs?: ModelLogprobs | null;
}

export interface ModelCompletionTokensDetails {
  reasoning_tokens?: number;
}

export interface ModelPromptTokensDetails {
  cached_tokens?: number;
}

export interface ModelUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  total_tokens: number;
  prompt_tokens_details?: ModelPromptTokensDetails;
  completion_tokens_details?: ModelCompletionTokensDetails;
  [key: string]: unknown;
}

export interface ModelChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ModelChoice[];
  usage?: ModelUsage;
  system_fingerprint?: string;
  [key: string]: unknown;
}

export interface ModelDeltaToolCall {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ModelChunkDelta {
  role?: "assistant" | null;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ModelDeltaToolCall[];
}

export interface ModelChunkChoice {
  index: number;
  delta: ModelChunkDelta;
  finish_reason:
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "insufficient_system_resource"
  | null;
  logprobs?: ModelLogprobs | null;
}

export interface ModelChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ModelChunkChoice[];
  usage?: ModelUsage | null;
  system_fingerprint?: string;
  [key: string]: unknown;
}

export interface ModelStreamEnvelope {
  chunk: ModelChatCompletionChunk | null;
  raw: string;
  done: boolean;
}

export interface ModelStreamResult {
  events: ModelStreamEnvelope[];
  response: ModelChatCompletionResponse | null;
  text: string;
  reasoningText: string;
}
