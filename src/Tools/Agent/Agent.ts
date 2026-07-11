import type { z } from "zod";

import {
  createAgentDefinitions,
  findAgentDefinition,
} from "./registry.js";
import type { AgentDefinitionsResult } from "./definitions.js";
import { runAgentTask, type AgentExecutionMode, type AgentOutput } from "./runner.js";
import type { Runtime } from "../../types/runtime.js";
import type { State } from "../../types/state.js";
import type { Tool, ToolUseContext } from "../types.js";
import { AGENT_TOOL_NAME, DESCRIPTION, renderAgentPrompt } from "./prompt.js";
import { inputSchema, outputSchema } from "./type.js";

type AgentInput = z.infer<ReturnType<typeof inputSchema>>;
type AgentToolOutput = z.infer<ReturnType<typeof outputSchema>>;

export class Agent implements Tool<AgentInput, AgentToolOutput, typeof inputSchema, typeof outputSchema> {
  name = AGENT_TOOL_NAME;
  inputSchema = inputSchema;
  outputSchema = outputSchema;
  strict = true;
  maxResultSizeChars = 20_000;
  searchHint = "delegate complex work to a specialized subagent";
  shouldDefer = false;
  alwaysLoad = true;

  constructor(
    private readonly definitions: AgentDefinitionsResult = createAgentDefinitions(),
  ) {}

  description(): string {
    return DESCRIPTION;
  }

  prompt(): string {
    return renderAgentPrompt(
      this.agentDefinitions().map((agent) =>
        `- ${agent.agentType}: ${agent.whenToUse}`,
      ),
    );
  }

  isEnabled(): boolean {
    return true;
  }

  userFacingName(): string {
    return AGENT_TOOL_NAME;
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  formatResult({ output }: { output: AgentToolOutput }): string {
    const header = `Agent ${output.agentId} (${output.agentType}) ${output.status}.`;

    if (output.status === "async_launched") {
      return [
        header,
        `Mode: ${output.mode}`,
        `Description: ${output.description}`,
        `Output file: ${output.outputFile}`,
        ...(output.worktreePath ? [`Worktree: ${output.worktreePath}`] : []),
      ].join("\n");
    }

    const changedFiles = output.changedFiles?.length
      ? [
        `Changed files:\n${
          output.changedFiles.map((file) => `- ${file}`).join("\n")
        }`,
      ]
      : [];

    return [
      header,
      `Mode: ${output.mode}`,
      `Description: ${output.description}`,
      ...(output.worktreePath ? [`Worktree: ${output.worktreePath}`] : []),
      ...changedFiles,
      "",
      output.result,
    ].join("\n");
  }

  async call(
    input: AgentInput,
    context: ToolUseContext,
    runtime: Runtime,
    state: State,
  ): Promise<AgentOutput> {
    const mode = resolveExecutionMode(input);

    if (mode === "fork" && input.subagent_type) {
      throw new Error("Fork mode inherits the parent context and does not accept subagent_type.");
    }

    if (mode === "fork" && runtime.agentId !== "main") {
      throw new Error("Fork mode is not available inside a subagent.");
    }

    const agent = findAgentDefinition(
      context.options.agentDefinitions.activeAgents,
      mode === "fork" ? undefined : input.subagent_type,
    );

    if (!agent) {
      throw new Error(
        `Agent type '${input.subagent_type ?? "general-purpose"}' not found. Available agents: ${
          context.options.agentDefinitions.activeAgents.map((item) => item.agentType).join(", ")
        }`,
      );
    }

    return runAgentTask({
      parentRuntime: runtime,
      parentState: state,
      agentDefinition: agent,
      prompt: input.prompt,
      description: input.description,
      mode,
      isolation: input.isolation ?? "none",
    });
  }

  private agentDefinitions() {
    return this.definitions.activeAgents;
  }
}

export default Agent;

function resolveExecutionMode(input: AgentInput): AgentExecutionMode {
  if (input.execution_mode) {
    return input.execution_mode;
  }

  if (input.run_in_background) {
    return "async";
  }

  return "sync";
}
