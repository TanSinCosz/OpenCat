import type {
  DeepSeekCreateRequest,
  DeepSeekMessage,
  DeepSeekStreamRequest,
  DeepSeekToolDefinition,
} from "../deepseek/types.js";
import type { Runtime } from "../types/runtime.js";
import type { JSONSchemaObject, Tool, Tools } from "../Tools/types.js";
import { z } from "zod";

export async function createStreamRequest(
  runtime: Runtime,
  messages: DeepSeekMessage[],
): Promise<DeepSeekStreamRequest> {
  return {
    model: runtime.deepSeekRuntimeConfig.model as DeepSeekCreateRequest["model"],
    messages,
    signal: runtime.toolUseContext.abortController.signal,
    max_tokens: runtime.deepSeekRuntimeConfig.maxTokens,
    reasoning_effort:
      runtime.deepSeekRuntimeConfig.reasoningEffort === "high" ||
      runtime.deepSeekRuntimeConfig.reasoningEffort === "max"
        ? runtime.deepSeekRuntimeConfig.reasoningEffort
        : undefined,
    tools: await toDeepSeekTools(runtime.tools),
    tool_choice: runtime.tools.length > 0 ? "auto" : undefined,
    stream: true,
    stream_options: {
      include_usage: true,
    },
  };
}

async function toDeepSeekTools(
  tools: Tools,
): Promise<DeepSeekToolDefinition[] | undefined> {
  if (tools.length === 0) {
    return undefined;
  }

  return Promise.all(
    tools.map(async (tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: await tool.description(),
        parameters: toToolInputParameters(tool),
        strict: tool.strict,
      },
    })),
  );
}

function toToolInputParameters(tool: Tool): JSONSchemaObject {
  if (tool.inputJsonSchema) {
    return tool.inputJsonSchema;
  }

  const schema =
    typeof tool.inputSchema === "function" ? tool.inputSchema() : tool.inputSchema;

  try {
    return z.toJSONSchema(schema) as JSONSchemaObject;
  } catch {
    return {
      type: "object",
      additionalProperties: true,
    };
  }
}
