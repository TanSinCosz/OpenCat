import type { z } from "zod";

import { createMemoryConfig } from "../../Memory/config.js";
import { MemoryTool } from "../../Memory/Memory.js";
import type { Runtime } from "../../types/runtime.js";
import type { State } from "../../types/state.js";
import type { Tool, ToolUseContext } from "../types.js";
import {
  DESCRIPTION,
  MEMORY_SEARCH_TOOL_NAME,
  renderMemorySearchPrompt,
} from "./prompt.js";
import { inputSchema, outputSchema } from "./type.js";

type MemorySearchInput = z.infer<ReturnType<typeof inputSchema>>;
type MemorySearchOutput = z.infer<ReturnType<typeof outputSchema>>;

export class MemorySearch
  implements Tool<MemorySearchInput, MemorySearchOutput, typeof inputSchema, typeof outputSchema> {
  name = MEMORY_SEARCH_TOOL_NAME;
  inputSchema = inputSchema;
  outputSchema = outputSchema;
  strict = true;
  maxResultSizeChars = 20_000;

  description(): string {
    return DESCRIPTION;
  }

  prompt(): string {
    return renderMemorySearchPrompt();
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  formatResult({ output }: { output: MemorySearchOutput }): string {
    if (output.results.length === 0) {
      return "No matching long-term memories found.";
    }

    return [
      `Found ${output.results.length} matching long-term memor${
        output.results.length === 1 ? "y" : "ies"
      }.`,
      ...output.results.map((result, index) => {
        const score = result.score === undefined
          ? ""
          : ` score=${result.score.toFixed(3)}`;
        return `${index + 1}. [${result.id}${score}] ${result.memory}`;
      }),
    ].join("\n");
  }

  async call(
    input: MemorySearchInput,
    _context: ToolUseContext,
    runtime: Runtime,
    _state: State,
  ): Promise<MemorySearchOutput> {
    const config = runtime.longTermMemoryConfig;
    if (!config.enabled) {
      return { results: [] };
    }

    // 默认智能体使用文件记忆；只有调用此兼容工具时才初始化向量服务。
    const memory = runtime.legacyMemory ??= new MemoryTool(
      runtime.legacyMemoryConfig ?? createMemoryConfig({
        cwd: runtime.cwd,
        config: runtime.appConfig,
      }),
    );
    const scope = input.scope ?? "user";
    return memory.search(input.query, {
      topK: input.topK ?? 8,
      threshold: input.threshold ?? config.searchThreshold,
      filters: scope === "run"
        ? { run_id: config.runId }
        : scope === "agent"
          ? { agent_id: config.agentId }
          : { user_id: config.userId },
    });
  }
}

export default MemorySearch;
