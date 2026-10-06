import type { z } from "zod";

import { recordTranscriptStateSnapshot } from "../../transcript/persistence.js";
import type { Runtime } from "../../types/runtime.js";
import type { State } from "../../types/state.js";
import { persistPlan } from "../../plan/persistence.js";
import type { Tool, ToolUseContext } from "../types.js";
import {
  DESCRIPTION,
  PLAN_TOOL_NAME,
  renderPlanPrompt,
} from "./prompt.js";
import { inputSchema, outputSchema } from "./type.js";

type PlanInput = z.infer<ReturnType<typeof inputSchema>>;
type PlanOutput = z.infer<ReturnType<typeof outputSchema>>;

export class Plan
  implements Tool<PlanInput, PlanOutput, typeof inputSchema, typeof outputSchema> {
  name = PLAN_TOOL_NAME;
  inputSchema = inputSchema;
  outputSchema = outputSchema;
  strict = true;
  maxResultSizeChars = 100_000;

  description(): string {
    return DESCRIPTION;
  }

  prompt(): string {
    return renderPlanPrompt();
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  formatResult({ output }: { output: PlanOutput }): string {
    return [
      output.message,
      ...(output.plan ? [`Plan:\n${output.plan}`] : []),
    ].join("\n");
  }

  async call(
    input: PlanInput,
    _context: ToolUseContext,
    runtime: Runtime,
    state: State,
  ): Promise<PlanOutput> {
    const oldMode = state.mode;
    const newMode = input.action === "enter" ? "plan" : "default";
    const plan = input.plan?.trim();

    if (plan) {
      await persistPlan(runtime, state, plan);
    }

    state.mode = newMode;
    runtime.toolUseContext.permissionContext = {
      ...runtime.toolUseContext.permissionContext,
      mode: newMode,
    };

    await recordTranscriptStateSnapshot(runtime, state, "mode");

    return {
      oldMode,
      newMode,
      ...(plan ? { plan } : {}),
      message: renderPlanModeMessage(input.action, oldMode, newMode),
    };
  }
}

function renderPlanModeMessage(
  action: PlanInput["action"],
  oldMode: State["mode"],
  newMode: State["mode"],
): string {
  if (action === "request_approval") {
    return oldMode === "plan"
      ? "Plan approved. Switched from plan mode to default mode."
      : "Plan approval acknowledged. The agent is already in default mode.";
  }

  return oldMode === newMode
    ? `Already in ${newMode} mode.`
    : `Switched from ${oldMode} mode to ${newMode} mode.`;
}

export default Plan;
