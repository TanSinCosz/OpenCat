import { randomUUID } from "node:crypto";
import type {
  ModelAssistantMessage,
  ModelMessage,
  ModelSystemMessage,
  ModelToolMessage,
  ModelUserMessage,
  ModelUsage,
} from "../openai-compatible/types.js";
import { estimateTokensFromText } from "../utils/size-estimate.js";

export type MessageId = `msg_${string}`;

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
  | "dynamic_skill"
  | "todo_list"
  | "plan_mode"
  | "plan_file"
  | "agent_task_status"
  | "background_task_status"
  | "task_notification";

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
  usage?: ModelUsage;
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

export type SystemMessage = ModelSystemMessage & MessageMeta;
export type UserMessage = ModelUserMessage & MessageMeta;
export type AssistantMessage = ModelAssistantMessage & MessageMeta;
export type ToolMessage = ModelToolMessage & MessageMeta & {
  toolName?: string;
  persistedToolResult?: PersistedToolResult;
};

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export function createMessage(
  message: ModelMessage,
  options: {
    source?: MessageSource;
    usage?: ModelUsage;
    contextTokenCount?: number;
  } = {},
): Message {
  return {
    ...message,
    id: createMessageId(),
    createdAt: Date.now(),
    source: options.source ?? getDefaultMessageSource(message),
    size: estimateModelMessageSize(message),
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.contextTokenCount !== undefined
      ? { contextTokenCount: options.contextTokenCount }
      : {}),
  } as Message;
}

export function toModelMessage(message: Message): ModelMessage {
  switch (message.role) {
    case "system": {
      const {
        id: _id,
        createdAt: _createdAt,
        source: _source,
        size: _size,
        usage: _usage,
        contextTokenCount: _contextTokenCount,
        ...modelMessage
      } = message;
      return modelMessage;
    }
    case "user": {
      const {
        id: _id,
        createdAt: _createdAt,
        source: _source,
        size: _size,
        usage: _usage,
        contextTokenCount: _contextTokenCount,
        ...modelMessage
      } = message;
      return modelMessage;
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
        // 旧日志可能带有已废弃的字段，恢复时保留日志，但不传给模型 API。
        toolResultId: _legacyToolResultId,
        persistedToolResult: _persistedToolResult,
        ...modelMessage
      } = message as ToolMessage & { toolResultId?: unknown };
      return modelMessage;
    }
  }
}

export function withMessageSize<T extends ModelMessage & Partial<MessageMeta>>(
  message: T,
): T & { size: MessageSize } {
  return {
    ...message,
    size: estimateModelMessageSize(toModelMessage(message as Message)),
  };
}

export function estimateModelMessageSize(message: ModelMessage): MessageSize {
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

function getDefaultMessageSource(message: ModelMessage): MessageSource {
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
