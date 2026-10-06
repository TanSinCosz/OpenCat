import type { z } from "zod";

import { recordTranscriptStateSnapshot } from "../../transcript/persistence.js";
import type { Runtime } from "../../types/runtime.js";
import type { State } from "../../types/state.js";
import { stopBackgroundTask } from "../Bash/background.js";
import type { Tool, ToolUseContext } from "../types.js";
import {
  DESCRIPTION,
  TASK_STOP_TOOL_NAME,
  renderTaskStopPrompt,
} from "./prompt.js";
import { inputSchema, outputSchema } from "./type.js";

type TaskStopInput = z.infer<ReturnType<typeof inputSchema>>;
type TaskStopOutput = z.infer<ReturnType<typeof outputSchema>>;

export class TaskStop
  implements Tool<TaskStopInput, TaskStopOutput, typeof inputSchema, typeof outputSchema> {
  name = TASK_STOP_TOOL_NAME;
  inputSchema = inputSchema;
  outputSchema = outputSchema;
  strict = true;
  maxResultSizeChars = 4_000;

  description(): string {
    return DESCRIPTION;
  }

  prompt(): string {
    return renderTaskStopPrompt();
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  formatResult({ output }: { output: TaskStopOutput }): string {
    return output.message;
  }

  async call(
    input: TaskStopInput,
    _context: ToolUseContext,
    runtime: Runtime,
    state: State,
  ): Promise<TaskStopOutput> {
    const result = await stopBackgroundTask(input.task_id, state, {
      reason: "Stopped by TaskStop.",
      suppressNotification: true,
    });
    await recordTranscriptStateSnapshot(runtime, state, "background_task");

    return {
      stopped: result.stopped,
      taskId: input.task_id,
      status: result.task?.status,
      command: result.task?.command,
      outputFile: result.task?.outputFile,
      message: result.message,
    };
  }
}

export default TaskStop;

