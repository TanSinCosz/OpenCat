import type { z } from "zod";

import { appendFileMemorySignal } from "../../Memory/file-memory.js";
import type { Runtime } from "../../types/runtime.js";
import type { State } from "../../types/state.js";
import type { Tool, ToolUseContext } from "../types.js";
import {
  DESCRIPTION,
  MEMORY_SAVE_TOOL_NAME,
  renderMemorySavePrompt,
} from "./prompt.js";
import { inputSchema, outputSchema } from "./type.js";

type MemorySaveInput = z.infer<ReturnType<typeof inputSchema>>;
type MemorySaveOutput = z.infer<ReturnType<typeof outputSchema>>;

export class MemorySave
  implements Tool<MemorySaveInput, MemorySaveOutput, typeof inputSchema, typeof outputSchema> {
  name = MEMORY_SAVE_TOOL_NAME;
  inputSchema = inputSchema;
  outputSchema = outputSchema;
  strict = true;
  maxResultSizeChars = 20_000;

  description(): string {
    return DESCRIPTION;
  }

  prompt(): string {
    return renderMemorySavePrompt();
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  formatResult({ output }: { output: MemorySaveOutput }): string {
    if (output.results.length === 0) {
      return "No long-term memory signal was staged.";
    }

    return [
      `Staged ${output.results.length} long-term memory signal${
        output.results.length === 1 ? "" : "s"
      } for manual AutoDream consolidation.`,
      ...output.results.map((result) => `- ${result.id}: ${result.memory}`),
    ].join("\n");
  }

  async call(
    input: MemorySaveInput,
    _context: ToolUseContext,
    runtime: Runtime,
    _state: State,
  ): Promise<MemorySaveOutput> {
    return appendFileMemorySignal(runtime, {
      memory: input.memory,
      reason: input.reason,
      type: input.memoryType,
      operation: input.operation,
    });
  }
}

export default MemorySave;
