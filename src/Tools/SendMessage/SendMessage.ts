import type { z } from "zod";

import { queueAgentMessage } from "../Agent/state.js";
import type { Runtime } from "../../types/runtime.js";
import type { State } from "../../types/state.js";
import type { Tool, ToolUseContext } from "../types.js";
import {
  DESCRIPTION,
  SEND_MESSAGE_TOOL_NAME,
  renderSendMessagePrompt,
} from "./prompt.js";
import { inputSchema, outputSchema } from "./type.js";

type SendMessageInput = z.infer<ReturnType<typeof inputSchema>>;
type SendMessageOutput = z.infer<ReturnType<typeof outputSchema>>;

export class SendMessage
  implements Tool<SendMessageInput, SendMessageOutput, typeof inputSchema, typeof outputSchema> {
  name = SEND_MESSAGE_TOOL_NAME;
  inputSchema = inputSchema;
  outputSchema = outputSchema;
  strict = true;
  maxResultSizeChars = 4_000;
  searchHint = "send an instruction to a running subagent";
  shouldDefer = false;
  alwaysLoad = true;

  description(): string {
    return DESCRIPTION;
  }

  prompt(): string {
    return renderSendMessagePrompt();
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  formatResult({ output }: { output: SendMessageOutput }): string {
    return [
      output.success ? "Message queued." : "Message not queued.",
      ...(output.agentId ? [`Agent: ${output.agentId}`] : []),
      ...(output.pendingMessageCount !== undefined
        ? [`Pending messages: ${output.pendingMessageCount}`]
        : []),
      output.message,
    ].join("\n");
  }

  call(
    input: SendMessageInput,
    _context: ToolUseContext,
    _runtime: Runtime,
    state: State,
  ): SendMessageOutput {
    const agentId = input.to.trim();
    const task = state.agentTasks[agentId];

    if (!task) {
      return {
        success: false,
        queued: false,
        agentId,
        message: `Agent not found: ${agentId}.`,
      };
    }

    if (task.status !== "running") {
      return {
        success: false,
        queued: false,
        agentId,
        pendingMessageCount: task.pendingMessages.length,
        message: `Agent ${agentId} is ${task.status}; only running agents can receive pending messages.`,
      };
    }

    const queued = queueAgentMessage(state.agentTasks, agentId, input.message);
    const pendingMessageCount = state.agentTasks[agentId]?.pendingMessages.length ?? 0;

    return {
      success: queued,
      queued,
      agentId,
      pendingMessageCount,
      message: queued
        ? `Message queued for ${agentId}.`
        : `Unable to queue message for ${agentId}.`,
    };
  }
}

export default SendMessage;
