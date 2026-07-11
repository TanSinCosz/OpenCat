import { randomUUID } from "node:crypto";
import type {
  DeepSeekAssistantMessage,
  DeepSeekMessage,
  DeepSeekSystemMessage,
  DeepSeekToolMessage,
  DeepSeekUserMessage,
  DeepSeekUsage,
} from "../deepseek/types.js";
import { estimateTokensFromText } from "../utils/size-estimate.js";

export type MessageId = `msg_${string}`;
export type ToolResultId = `tool_result_${string}`;

export type MessageSource =
  | "user"
  | "system"
  | "assistant"
  | "tool"
  | "runtime"
  | "agent_notification"
  | "agent_message" // sub agent content
  | "auto_compress"
  | "file_restore"
  | "long_term_memory"
  | "dynamic_skill";

export type MessageSize = {
  /**
   * Serialized API-message character count. This includes JSON overhead because
   * braces, field names, tool-call ids, and arguments also enter the context.
   */
  chars: number;
  /**
   * Fast local estimate for threshold decisions. Provider usage is still the
   * source of truth after an API call; this exists for messages that have not
   * been sent yet.
   */
  estimatedTokens: number;
  estimator: "char_weighted_v1";
};

type MessageMeta = {
  id: MessageId;
  createdAt: number;
  source: MessageSource;
  size: MessageSize;
  usage?: DeepSeekUsage;
  /**
   * Context window size immediately after this assistant message completed.
   * This differs from usage when a reasoning continuation made multiple API
   * requests whose billable usage is intentionally accumulated.
   */
  contextTokenCount?: number;
};

export type PersistedToolResult = {
  path: string;
  absolutePath: string;
  size: number;
  sha256: string;
  previewChars: number;
  originalContentType: "text";
};

export type SystemMessage = DeepSeekSystemMessage & MessageMeta;
export type UserMessage = DeepSeekUserMessage & MessageMeta;
export type AssistantMessage = DeepSeekAssistantMessage & MessageMeta;
export type ToolMessage = DeepSeekToolMessage & MessageMeta & {
  toolName?: string;
  toolResultId?: ToolResultId;
  persistedToolResult?: PersistedToolResult;
};

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export function createMessage(
  message: DeepSeekMessage,
  options: {
    source?: MessageSource;
    usage?: DeepSeekUsage;
    contextTokenCount?: number;
  } = {},
): Message {
  return {
    ...message,
    id: createMessageId(),
    createdAt: Date.now(),
    source: options.source ?? getDefaultMessageSource(message),
    size: estimateDeepSeekMessageSize(message),
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.contextTokenCount !== undefined
      ? { contextTokenCount: options.contextTokenCount }
      : {}),
  } as Message;
}

export function toDeepSeekMessage(message: Message): DeepSeekMessage {
  switch (message.role) {
    case "system": {
      const {
        id: _id,
        createdAt: _createdAt,
        source: _source,
        size: _size,
        usage: _usage,
        contextTokenCount: _contextTokenCount,
        ...deepSeekMessage
      } = message;
      return deepSeekMessage;
    }
    case "user": {
      const {
        id: _id,
        createdAt: _createdAt,
        source: _source,
        size: _size,
        usage: _usage,
        contextTokenCount: _contextTokenCount,
        ...deepSeekMessage
      } = message;
      return deepSeekMessage;
    }
    case "assistant": {
      const {
        id: _id,
        createdAt: _createdAt,
        source: _source,
        size: _size,
        usage: _usage,
        contextTokenCount: _contextTokenCount,
        ...assistantMessage
      } = message;
      return assistantMessage;
    }
    case "tool": {
      const {
        id: _id,
        createdAt: _createdAt,
        source: _source,
        size: _size,
        usage: _usage,
        contextTokenCount: _contextTokenCount,
        toolName: _toolName,
        toolResultId: _toolResultId,
        persistedToolResult: _persistedToolResult,
        ...deepSeekMessage
      } = message;
      return deepSeekMessage;
    }
  }
}

export function withMessageSize<T extends DeepSeekMessage & Partial<MessageMeta>>(
  message: T,
): T & { size: MessageSize } {
  return {
    ...message,
    size: estimateDeepSeekMessageSize(toDeepSeekMessage(message as Message)),
  };
}

export function estimateDeepSeekMessageSize(message: DeepSeekMessage): MessageSize {
  const serialized = JSON.stringify(message);

  return {
    chars: serialized.length,
    estimatedTokens: estimateTokensFromText(serialized),
    estimator: "char_weighted_v1",
  };
}

function createMessageId(): MessageId {
  return `msg_${randomUUID()}`;
}

function getDefaultMessageSource(message: DeepSeekMessage): MessageSource {
  switch (message.role) {
    case "system":
      return "system";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
  }
}
