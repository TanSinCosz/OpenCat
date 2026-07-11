import type { z } from "zod";

import { searchLongTermMemory } from "../../Memory/runtime.js";
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
  searchHint = "search long-term memory";
  shouldDefer = false;
  alwaysLoad = false;

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
    return searchLongTermMemory(runtime, input.query, {
      topK: input.topK ?? 8,
      scope: input.scope ?? "user",
      threshold: input.threshold,
    });
  }
}

export default MemorySearch;
