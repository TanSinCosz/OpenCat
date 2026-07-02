
import type { JSONSchemaObject } from "../Tools/types.js";

export type DeepSeekRole = "system" | "user" | "assistant" | "tool";

export interface DeepSeekFunctionDefinition {
  name: string;
  description?: string;
  parameters?: JSONSchemaObject;
  strict?: boolean;
}

export interface DeepSeekToolDefinition {
  type: "function";
  function: DeepSeekFunctionDefinition;
}

export type DeepSeekToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
    type: "function";
    function: {
      name: string;
    };
  };

export interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekResponseFormatText {
  type: "text";
}

export interface DeepSeekResponseFormatJsonObject {
  type: "json_object";
}

export type DeepSeekResponseFormat =
  | DeepSeekResponseFormatText
  | DeepSeekResponseFormatJsonObject;

export interface DeepSeekThinkingConfig {
  type: "enabled" | "disabled";
}

export interface DeepSeekStreamOptions {
  include_usage: boolean;
}

export interface DeepSeekSystemMessage {
  role: "system";
  content: string;
  name?: string;
}

export interface DeepSeekUserMessage {
  role: "user";
  content: string;
  name?: string;
}

export interface DeepSeekAssistantMessage {
  role: "assistant";
  content: string | null;
  name?: string;
  prefix?: boolean;
  reasoning_content?: string | null;
  tool_calls?: DeepSeekToolCall[];
}

export interface DeepSeekToolMessage {
  role: "tool";
  content: string;
  tool_call_id: string;
}

export type DeepSeekMessage =
  | DeepSeekSystemMessage
  | DeepSeekUserMessage
  | DeepSeekAssistantMessage
  | DeepSeekToolMessage;

export interface DeepSeekCreateRequest {
  model: "deepseek-v4-flash" | "deepseek-v4-pro";
  messages: DeepSeekMessage[];
  signal?: AbortSignal;
  thinking?: DeepSeekThinkingConfig | null;
  reasoning_effort?: "high" | "max";
  max_tokens?: number | null;
  response_format?: DeepSeekResponseFormat | null;
  stop?: string | string[] | null;
  temperature?: number | null;
  top_p?: number | null;
  tools?: DeepSeekToolDefinition[] | null;
  tool_choice?: DeepSeekToolChoice | null;
  logprobs?: boolean | null;
  top_logprobs?: number | null;
  user_id?: string | null;
  metadata?: Record<string, string>;
  frequency_penalty?: number | null;
  presence_penalty?: number | null;
}

export interface DeepSeekStreamRequest extends DeepSeekCreateRequest {
  stream: true;
  stream_options?: DeepSeekStreamOptions | null;
}

export interface DeepSeekTokenLogprob {
  token: string;
  logprob: number;
  bytes: number[] | null;
  top_logprobs: DeepSeekTokenLogprobTop[];
}

export interface DeepSeekTokenLogprobTop {
  token: string;
  logprob: number;
  bytes: number[] | null;
}

export interface DeepSeekLogprobs {
  content: DeepSeekTokenLogprob[] | null;
  reasoning_content?: DeepSeekTokenLogprob[] | null;
}

export interface DeepSeekChoice {
  index: number;
  message: DeepSeekAssistantMessage;
  finish_reason:
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "insufficient_system_resource";
  logprobs?: DeepSeekLogprobs | null;
}

export interface DeepSeekCompletionTokensDetails {
  reasoning_tokens?: number;
}

export interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  total_tokens: number;
  completion_tokens_details?: DeepSeekCompletionTokensDetails;
  [key: string]: unknown;
}

export interface DeepSeekChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: DeepSeekChoice[];
  usage?: DeepSeekUsage;
  system_fingerprint?: string;
  [key: string]: unknown;
}

export interface DeepSeekDeltaToolCall {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface DeepSeekChunkDelta {
  role?: "assistant" | null;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: DeepSeekDeltaToolCall[];
}

export interface DeepSeekChunkChoice {
  index: number;
  delta: DeepSeekChunkDelta;
  finish_reason:
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "insufficient_system_resource"
  | null;
  logprobs?: DeepSeekLogprobs | null;
}

export interface DeepSeekChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: DeepSeekChunkChoice[];
  usage?: DeepSeekUsage | null;
  system_fingerprint?: string;
  [key: string]: unknown;
}

export interface DeepSeekStreamEnvelope {
  chunk: DeepSeekChatCompletionChunk | null;
  raw: string;
  done: boolean;
}

export interface DeepSeekStreamResult {
  events: DeepSeekStreamEnvelope[];
  response: DeepSeekChatCompletionResponse | null;
  text: string;
  reasoningText: string;
}
