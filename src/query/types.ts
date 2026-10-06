import type {
  ModelAssistantMessage,
  ModelMessage,
  ModelStreamEnvelope,
  ModelToolCall,
  ModelUsage,
} from "../openai-compatible/types.js";
import type { Message } from "../types/messages.js";
import type { RuntimeUsageStats } from "../types/runtime.js";

/** 用户对计划的审批结果；工具执行权限回调另使用 Tools/types.ts 的 ToolPermissionDecision。 */
export type ToolApprovalDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; reason?: string };

export type ToolApprovalRequest = {
  approvalId: string;
  toolCall: ModelToolCall;
  mode: "plan";
  reason: string;
};

export type QueryEvent =
  | {
    type: "context_ready";
    systemPrompt: string;
    messages: ModelMessage[];
    stats: MessageProjectionStats;
  }
  | { type: "model_stream_start"; turn: number }
  | { type: "model_stream_event"; event: ModelStreamEnvelope }
  | {
    type: "model_usage";
    usage: ModelUsage;
    sessionUsage: RuntimeUsageStats;
  }
  | {
    type: "reasoning_continuation";
    phase: "continue_reasoning" | "force_final_answer";
    round: number;
    reasoningChars: number;
  }
  | { type: "assistant_reasoning_delta"; text: string }
  | { type: "assistant_text_delta"; text: string }
  | {
    type: "assistant_message";
    message: ModelAssistantMessage;
    usage?: ModelUsage;
  }
  | { type: "tool_use"; toolCall: ModelToolCall }
  | {
    type: "tool_permission_request";
    approvalId: string;
    toolCall: ModelToolCall;
    mode: "plan";
    reason: string;
  }
  | {
    type: "tool_permission";
    toolCall: ModelToolCall;
    behavior: "denied";
    reason: string;
  }
  | {
    type: "tool_result";
    toolCall: ModelToolCall;
    message: ModelMessage;
    succeeded: boolean;
  }
  | { type: "turn_end"; turn: number; hasToolUse: boolean }
  | {
    type: "done";
    reason: "completed" | "max_turns";
    sessionUsage: RuntimeUsageStats;
  };

export interface QueryOptions {
  maxTurns?: number;
  /**
   * Forked agents already inherit the exact context sent to the parent model.
   * Re-materializing volatile context would reorder that prefix and lose cache.
   */
  skipRequestContextMaterialization?: boolean;
  /**
   * The first turn already contains the parent's final projected prefix.
   * Preserve it byte-for-byte for prompt-cache reuse.
   */
  usePreprojectedMessagesOnFirstTurn?: boolean;
  requestToolPermission?: (
    request: ToolApprovalRequest,
  ) => Promise<ToolApprovalDecision>;
}

export interface MessagesForQuery {
  systemPrompt: string;
  messages: ModelMessage[];
  forkContextMessages: Message[];
  stats: MessageProjectionStats;
}

export interface MessageProjectionStats {
  toolResultBudgetReplacementCount: number;
  bulkyToolCompactNeeded: boolean;
  bulkyToolCompactCount: number;
  historySnipCount: number;
  toolResultCharsBeforeBudget: number;
  toolResultCharsAfterBudget: number;
  toolResultCharsAfterCompact: number;
}
