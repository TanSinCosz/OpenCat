/** 把核心事件和历史消息转换为 Web 展示数据；隐藏运行时注入并限制预览长度。 */
import type { QueryEvent } from "../../query/types.js";
import type { Message } from "../../types/messages.js";
import type { ModelAssistantMessage } from "../../openai-compatible/types.js";

export const MAX_SESSION_HISTORY_MESSAGES = 200;
const MAX_HISTORY_TOOL_CHARS = 2_000;
const MAX_HISTORY_REASONING_CHARS = 4_000;

export function normalizeQueryEvent(
  event: QueryEvent,
  includeRawEvents: boolean,
): unknown | undefined {
  if (includeRawEvents) {
    // 调试视图保留核心事件；普通视图只输出页面需要的摘要和预览。
    return event;
  }

  switch (event.type) {
    case "context_ready":
      {
        const serializedMessages = JSON.stringify(event.messages);
        return {
          type: event.type,
          systemPromptChars: event.systemPrompt.length,
          messageCount: event.messages.length,
          hasLongTermMemory: serializedMessages.includes("<long_term_memory>"),
          hasSessionMemory: serializedMessages.includes("<session_memory>"),
          hasLocalCompactSummary: serializedMessages.includes("<local_compact_summary>"),
          hasToolResultBudget: serializedMessages.includes("<tool-result-budget>"),
          hasToolResultCompact: serializedMessages.includes("<tool-result-compact>"),
          hasHistorySnipMarker: serializedMessages.includes("[History snipped:"),
          stats: event.stats,
        };
      }
    case "model_stream_event":
      return undefined;
    case "model_usage":
      const promptCacheHitTokens = event.usage.prompt_cache_hit_tokens ??
        event.usage.prompt_tokens_details?.cached_tokens ??
        0;
      return {
        type: event.type,
        promptTokens: event.usage.prompt_tokens,
        completionTokens: event.usage.completion_tokens,
        totalTokens: event.usage.total_tokens,
        promptCacheHitTokens,
        promptCacheMissTokens: event.usage.prompt_cache_miss_tokens ??
          Math.max(0, event.usage.prompt_tokens - promptCacheHitTokens),
        sessionPromptTokens: event.sessionUsage.promptTokens,
        sessionCompletionTokens: event.sessionUsage.completionTokens,
        sessionTotalTokens: event.sessionUsage.totalTokens,
        sessionPromptCacheHitTokens: event.sessionUsage.promptCacheHitTokens,
        sessionPromptCacheMissTokens: event.sessionUsage.promptCacheMissTokens,
      };
    case "assistant_message":
      return {
        type: event.type,
        message: normalizeAssistantMessageForWeb(event.message),
        usage: event.usage,
      };
    case "tool_permission":
      return {
        type: event.type,
        toolCallId: event.toolCall.id,
        toolName: event.toolCall.function.name,
        behavior: event.behavior,
        reason: event.reason,
        reasonPreview: previewText(event.reason),
      };
    case "tool_permission_request":
      return {
        type: event.type,
        approvalId: event.approvalId,
        toolCallId: event.toolCall.id,
        toolName: event.toolCall.function.name,
        mode: event.mode,
        reason: event.reason,
        reasonPreview: previewText(event.reason),
      };
    case "tool_result":
      {
        const content = typeof event.message.content === "string"
          ? event.message.content
          : "";

        return {
          type: event.type,
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.function.name,
          contentChars: content.length,
          contentPreview: previewText(content),
        };
      }
    default:
      return event;
  }
}

function previewText(value: string, maxChars = 500): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}... [${value.length - maxChars} chars hidden]`;
}

function normalizeAssistantMessageForWeb(
  message: ModelAssistantMessage,
): unknown {
  const reasoningContent = message.reasoning_content ?? "";

  return {
    ...message,
    reasoning_content: reasoningContent
      ? previewText(reasoningContent, MAX_HISTORY_REASONING_CHARS)
      : reasoningContent,
    reasoning_content_chars: reasoningContent.length,
  };
}

export function normalizeSessionHistoryMessage(message: Message): unknown | null {
  if (isHiddenRuntimeContextMessage(message)) {
    return null;
  }

  switch (message.role) {
    case "system":
      return null;
    case "user":
      return {
        role: message.role,
        content: message.content,
      };
    case "assistant":
      {
        const reasoningContent = message.reasoning_content ?? "";
        return {
          role: message.role,
          content: typeof message.content === "string" ? message.content : "",
          reasoningContent: previewText(
            reasoningContent,
            MAX_HISTORY_REASONING_CHARS,
          ),
          reasoningChars: reasoningContent.length,
          toolCalls: message.tool_calls ?? [],
          usage: message.usage,
        };
      }
    case "tool":
      return {
        role: message.role,
        toolCallId: message.tool_call_id,
        toolName: message.toolName,
        contentPreview: previewText(message.content, MAX_HISTORY_TOOL_CHARS),
      };
  }
}

function isHiddenRuntimeContextMessage(message: Message): boolean {
  return message.source === "runtime" ||
    (message.role === "user" && message.name === "opencat_context");
}
