import type {
  DeepSeekAssistantMessage,
  DeepSeekMessage,
  DeepSeekStreamEnvelope,
  DeepSeekToolCall,
  DeepSeekUsage,
} from "../deepseek/types.js";
import type { Message } from "../types/messages.js";
import type { RuntimeUsageStats } from "../types/runtime.js";

export type QueryEvent =
  | {
    type: "context_ready";
    systemPrompt: string;
    messages: DeepSeekMessage[];
    stats: MessageProjectionStats;
  }
  | { type: "model_stream_start"; turn: number }
  | { type: "model_stream_event"; event: DeepSeekStreamEnvelope }
  | {
    type: "model_usage";
    usage: DeepSeekUsage;
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
    message: DeepSeekAssistantMessage;
    usage?: DeepSeekUsage;
  }
  | { type: "tool_use"; toolCall: DeepSeekToolCall }
  | { type: "tool_result"; toolCall: DeepSeekToolCall; message: DeepSeekMessage }
  | { type: "turn_end"; turn: number; hasToolUse: boolean }
  | {
    type: "done";
    reason: "completed" | "max_turns";
    sessionUsage: RuntimeUsageStats;
  };

export interface QueryOptions {
  maxTurns?: number;
}

export interface MessagesForQuery {
  systemPrompt: string;
  messages: DeepSeekMessage[];
  forkContextMessages: Message[];
  stats: MessageProjectionStats;
}

export interface MessageProjectionStats {
  toolResultBudgetReplacementCount: number;
  bulkyToolCompactCount: number;
  historySnipCount: number;
  hardHistorySnipApplied: boolean;
  toolResultCharsBeforeBudget: number;
  toolResultCharsAfterBudget: number;
  toolResultCharsAfterCompact: number;
}
