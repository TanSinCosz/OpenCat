import { randomUUID } from "node:crypto";
import type {
  DeepSeekAssistantMessage,
  DeepSeekMessage,
  DeepSeekSystemMessage,
  DeepSeekToolMessage,
  DeepSeekUserMessage,
} from "../deepseek/types.js";

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

type MessageMeta = {
  id: MessageId;
  createdAt: number;
  source: MessageSource;
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
  options: { source?: MessageSource } = {},
): Message {
  return {
    ...message,
    id: createMessageId(),
    createdAt: Date.now(),
    source: options.source ?? getDefaultMessageSource(message),
  } as Message;
}

export function toDeepSeekMessage(message: Message): DeepSeekMessage {
  switch (message.role) {
    case "system": {
      const {
        id: _id,
        createdAt: _createdAt,
        source: _source,
        ...deepSeekMessage
      } = message;
      return deepSeekMessage;
    }
    case "user": {
      const {
        id: _id,
        createdAt: _createdAt,
        source: _source,
        ...deepSeekMessage
      } = message;
      return deepSeekMessage;
    }
    case "assistant": {
      const {
        id: _id,
        createdAt: _createdAt,
        source: _source,
        reasoning_content: _reasoningContent,
        ...deepSeekMessage
      } = message;
      return deepSeekMessage;
    }
    case "tool": {
      const {
        id: _id,
        createdAt: _createdAt,
        source: _source,
        toolName: _toolName,
        toolResultId: _toolResultId,
        persistedToolResult: _persistedToolResult,
        ...deepSeekMessage
      } = message;
      return deepSeekMessage;
    }
  }
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
