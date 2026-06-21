import type {
  DeepSeekAssistantMessage,
  DeepSeekMessage,
  DeepSeekStreamEnvelope,
  DeepSeekToolCall,
} from "../deepseek/types.js";
import type { SystemPromptOptions } from "../system-prompt.js";
import type { Runtime, State } from "../types/type.js";

export type QueryEvent =
  | { type: "context_ready"; systemPrompt: string; messages: DeepSeekMessage[] }
  | { type: "model_stream_start"; turn: number }
  | { type: "model_stream_event"; event: DeepSeekStreamEnvelope }
  | { type: "assistant_text_delta"; text: string }
  | { type: "assistant_message"; message: DeepSeekAssistantMessage }
  | { type: "tool_use"; toolCall: DeepSeekToolCall }
  | { type: "tool_result"; toolCall: DeepSeekToolCall; message: DeepSeekMessage }
  | { type: "turn_end"; turn: number; hasToolUse: boolean }
  | { type: "done"; reason: "completed" | "max_turns" };

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
