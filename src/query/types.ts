import type {
  DeepSeekAssistantMessage,
  DeepSeekMessage,
  DeepSeekStreamEnvelope,
  DeepSeekToolCall,
  DeepSeekUsage,
} from "../deepseek/types.js";
import type { SystemPromptOptions } from "../system-prompt.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import type { RuntimeUsageStats } from "../types/runtime.js";

export type QueryEvent =
  | { type: "context_ready"; systemPrompt: string; messages: DeepSeekMessage[] }
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
  | { type: "assistant_message"; message: DeepSeekAssistantMessage }
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
  promptOptions?: SystemPromptOptions;
  messagesForQueryBuilder?: MessagesForQueryBuilder;
}

export interface MessagesForQuery {
  systemPrompt: string;
  messages: DeepSeekMessage[];
}

export type MessagesForQueryBuilder = (
  runtime: Runtime,
  state: State,
) => Promise<MessagesForQuery>;

export interface MessageCompressionStep {
  name: string;
  apply(
    messages: DeepSeekMessage[],
    context: MessageCompressionContext,
  ): Promise<DeepSeekMessage[]> | DeepSeekMessage[];
}

export interface MessageCompressionContext {
  runtime: Runtime;
  state: State;
  systemPrompt: string;
}
