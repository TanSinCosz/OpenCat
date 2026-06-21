import type {
  DeepSeekCreateRequest,
  DeepSeekMessage,
  DeepSeekToolDefinition,
} from "../deepseek/types.js";
import type { Runtime } from "../types/type.js";
import type { Tools } from "../Tools/types.js";

export async function createStreamRequest(
  runtime: Runtime,
  messages: DeepSeekMessage[],
): Promise<DeepSeekCreateRequest & { stream: true }> {
  return {
    model: runtime.deepSeekRuntimeConfig.model as DeepSeekCreateRequest["model"],
    messages,
    max_tokens: runtime.deepSeekRuntimeConfig.maxTokens,
    reasoning_effort:
      runtime.deepSeekRuntimeConfig.reasoningEffort === "high" ||
      runtime.deepSeekRuntimeConfig.reasoningEffort === "max"
        ? runtime.deepSeekRuntimeConfig.reasoningEffort
        : undefined,
    tools: await toDeepSeekTools(runtime.tools),
    tool_choice: runtime.tools.length > 0 ? "auto" : undefined,
    stream: true,
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
        parameters: {
          type: "object",
          additionalProperties: true,
        },
        strict: tool.strict,
      },
    })),
  );
}
