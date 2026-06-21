import type { DeepSeekMessage, DeepSeekToolCall } from "../deepseek/types.js";
import type { Runtime } from "../types/type.js";
import type { Tool, Tools } from "./types.js";

export async function executeToolCall(
  toolCall: DeepSeekToolCall,
  tools: Tools,
  runtime: Runtime,
): Promise<DeepSeekMessage> {
  const tool = findTool(tools, toolCall.function.name);

  if (!tool) {
    return createToolResultMessage(
      toolCall.id,
      `Tool not found: ${toolCall.function.name}`,
    );
  }

  try {
    const parsedInput = parseToolArguments(toolCall.function.arguments);
    const validation = validateToolInput(tool, parsedInput);

    if (validation.ok === false) {
      return createToolResultMessage(toolCall.id, validation.error);
    }

    const output = await tool.call(
      validation.input as Record<string, unknown>,
      runtime.toolUseContext,
    );
    return createToolResultMessage(toolCall.id, stringifyToolResult(output));
  } catch (error) {
    return createToolResultMessage(toolCall.id, stringifyError(error));
  }
}

function findTool(tools: Tools, name: string): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}

function parseToolArguments(raw: string): unknown {
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

function validateToolInput(
  tool: Tool,
  input: unknown,
): { ok: true; input: unknown } | { ok: false; error: string } {
  const schema =
    typeof tool.inputSchema === "function" ? tool.inputSchema() : tool.inputSchema;
  const result = schema.safeParse(input);

  if (!result.success) {
    return {
      ok: false,
      error: result.error.message,
    };
  }

  return {
    ok: true,
    input: result.data,
  };
}

function createToolResultMessage(
  toolCallId: string,
  content: string,
): DeepSeekMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content,
  };
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
