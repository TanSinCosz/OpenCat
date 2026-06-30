import type { z } from "zod";

import {
  buildLongTermMemoryFilters,
  getOrCreateLongTermMemory,
} from "../../Memory/runtime.js";
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
  searchHint = "save durable long-term memory";
  shouldDefer = false;
  alwaysLoad = true;

  description(): string {
    return DESCRIPTION;
  }

  prompt(): string {
    return renderMemorySavePrompt();
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  async call(
    input: MemorySaveInput,
    _context: ToolUseContext,
    runtime: Runtime,
    _state: State,
  ): Promise<MemorySaveOutput> {
    const memory = getOrCreateLongTermMemory(runtime);
    if (!memory) {
      return { results: [] };
    }

    // The tool is only the model-visible "add this memory" intent.
    // Namespace, extraction strategy, dedupe, linking, and persistence stay in
    // the Memory service so the model does not need to reason about internals.
    const filters = buildLongTermMemoryFilters(
      runtime.longTermMemoryConfig,
      "user",
    );

    return memory.add(input.memory, {
      filters,
      metadata: {
        source: "MemorySave",
        ...(input.reason ? { reason: input.reason } : {}),
      },
      infer: true,
      userId: filters.user_id,
      agentId: filters.agent_id,
      runId: filters.run_id,
    });
  }
}

export default MemorySave;
