import type { DeepSeekMessage, DeepSeekToolCall } from "../deepseek/types.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import type { Tool, Tools } from "./types.js";

export async function executeToolCall(
  toolCall: DeepSeekToolCall,
  tools: Tools,
  runtime: Runtime,
  state: State,
): Promise<DeepSeekMessage> {
  const tool = findTool(tools, toolCall.function.name);

  if (!tool) {
    return createToolResultMessage(
      toolCall.id,
      renderUnavailableToolMessage(toolCall.function.name, tools, runtime),
    );
  }

  try {
    const parsedInput = parseToolArguments(toolCall.function.arguments);
    const validation = validateToolInput(tool, parsedInput);

    if (validation.ok === false) {
      return createToolResultMessage(toolCall.id, validation.error);
    }

    const permittedInput = await applyToolPermission(
      tool,
      validation.input,
      runtime,
      state,
    );
    if (permittedInput.ok === false) {
      return createToolResultMessage(
        toolCall.id,
        `Permission denied for tool ${tool.name}: ${permittedInput.error}`,
      );
    }

    const output = await tool.call(
      permittedInput.input as Record<string, unknown>,
      runtime.toolUseContext,
      runtime,
      state,
    );
    return createToolResultMessage(
      toolCall.id,
      formatToolResult(tool, output),
    );
  } catch (error) {
    return createToolResultMessage(toolCall.id, stringifyError(error));
  }
}

async function applyToolPermission(
  tool: Tool,
  input: unknown,
  runtime: Runtime,
  state: State,
): Promise<{ ok: true; input: unknown } | { ok: false; error: string }> {
  const canUseTool = runtime.toolUseContext.canUseTool;
  if (!canUseTool) {
    return { ok: true, input };
  }

  const decision = await canUseTool(
    tool,
    input,
    runtime.toolUseContext,
    runtime,
    state,
  );

  if (decision.behavior === "deny") {
    return { ok: false, error: decision.message };
  }

  return {
    ok: true,
    input: decision.updatedInput ?? input,
  };
}

function findTool(tools: Tools, name: string): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}

function renderUnavailableToolMessage(
  toolName: string,
  tools: Tools,
  runtime: Runtime,
): string {
  const availableTools = tools.map((tool) => tool.name).join(", ") || "(none)";
  const agentLabel = runtime.agentType
    ? `${runtime.agentRole}:${runtime.agentType}`
    : runtime.agentRole;

  return [
    `Tool unavailable: ${toolName}`,
    `The current agent/runtime (${agentLabel}) does not have permission to use this tool, or the tool is not loaded for this agent.`,
    `Available tools for this agent: ${availableTools}.`,
    "Choose an available tool or report the blocker to the parent agent/user.",
  ].join("\n");
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

function formatToolResult(tool: Tool, output: unknown): string {
  if (!tool.formatResult) {
    return stringifyToolResult(output);
  }

  return tool.formatResult({ output });
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
