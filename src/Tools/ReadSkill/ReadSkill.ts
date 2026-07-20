import type { z } from "zod";

import type { AgentDefinition } from "../Agent/definitions.js";
import { runAgentTask } from "../Agent/runner.js";
import type { Runtime } from "../../types/runtime.js";
import type { State } from "../../types/state.js";
import type { SkillCommand, Tool, ToolUseContext } from "../types.js";
import {
  DESCRIPTION,
  READ_SKILL_TOOL_NAME,
  renderReadSkillPrompt,
} from "./prompt.js";
import { renderSkillContentForModel, recordInvokedSkill } from "./state.js";
import { inputSchema, outputSchema } from "./type.js";

type ReadSkillInput = z.infer<ReturnType<typeof inputSchema>>;
type ReadSkillOutput = z.infer<ReturnType<typeof outputSchema>>;

const MAX_READ_SKILL_CHARS = 64_000;

export class ReadSkill
  implements Tool<ReadSkillInput, ReadSkillOutput, typeof inputSchema, typeof outputSchema> {
  name = READ_SKILL_TOOL_NAME;
  inputSchema = inputSchema;
  outputSchema = outputSchema;
  maxResultSizeChars = 100_000;
  searchHint = "read discovered project skill instructions";
  shouldDefer = false;
  alwaysLoad = true;
  strict = true;

  description(): string {
    return DESCRIPTION;
  }

  prompt(): string {
    return renderReadSkillPrompt();
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  formatResult({ output }: { output: ReadSkillOutput }): string {
    return [
      `Skill: ${output.name}`,
      `Description: ${output.description}`,
      ...(output.skillPath ? [`Path: ${output.skillPath}`] : []),
      ...(output.status === "forked" && output.agentId
        ? [`Forked agent: ${output.agentId}`]
        : []),
      ...(output.truncated ? ["Note: content was truncated."] : []),
      "",
      output.content,
    ].join("\n");
  }

  async call(
    input: ReadSkillInput,
    context: ToolUseContext,
    runtime: Runtime,
    state: State,
  ): Promise<ReadSkillOutput> {
    const skill = findDiscoveredSkill(input, context);
    if (!skill) {
      throw new Error(
        `ReadSkill can only read skills already discovered in this session. No discovered skill matched ${describeInput(input)}.`,
      );
    }

    const content = renderSkillContentForModel(skill);
    const truncated = content.length > MAX_READ_SKILL_CHARS;
    const visibleContent = truncated
      ? `${content.slice(0, MAX_READ_SKILL_CHARS)}\n[ReadSkill content truncated]`
      : content;

    if (skill.executionContext === "fork") {
      return executeForkedSkill(input, skill, visibleContent, context, runtime, state);
    }

    recordInvokedSkill(state, runtime, skill, visibleContent);
    activateSkillAllowedTools(context, skill);

    return {
      name: skill.name,
      description: skill.description,
      ...(skill.skillDir ? { skillDir: skill.skillDir } : {}),
      ...(skill.skillPath ? { skillPath: skill.skillPath } : {}),
      ...(skill.allowedTools?.length ? { allowedTools: skill.allowedTools } : {}),
      status: "inline",
      content: visibleContent,
      truncated,
      note: truncated
        ? "The skill was longer than the ReadSkill result budget; only the visible prefix was recorded for post-compact restoration."
        : undefined,
    };
  }
}

async function executeForkedSkill(
  input: ReadSkillInput,
  skill: SkillCommand,
  visibleContent: string,
  context: ToolUseContext,
  runtime: Runtime,
  state: State,
): Promise<ReadSkillOutput> {
  const restoreAppState = activateSkillAllowedTools(context, skill);
  try {
    const output = await runAgentTask({
      parentRuntime: runtime,
      parentState: state,
      agentDefinition: createSkillAgentDefinition(skill),
      prompt: buildForkedSkillPrompt(input, skill, visibleContent, state),
      description: `Execute skill: ${skill.name}`,
      mode: "fork",
      isolation: "none",
      maxTurns: 20,
    });
    if (output.status !== "completed") {
      throw new Error(`Forked skill ${skill.name} did not complete.`);
    }

    return {
      name: skill.name,
      description: skill.description,
      ...(skill.skillDir ? { skillDir: skill.skillDir } : {}),
      ...(skill.skillPath ? { skillPath: skill.skillPath } : {}),
      ...(skill.allowedTools?.length ? { allowedTools: skill.allowedTools } : {}),
      status: "forked",
      agentId: output.agentId,
      content: output.result,
      truncated: false,
    };
  } finally {
    restoreAppState?.();
  }
}

function createSkillAgentDefinition(skill: SkillCommand): AgentDefinition {
  return {
    agentType: `skill:${skill.name}`,
    category: "worker",
    whenToUse: `Execute the ${skill.name} skill.`,
    getSystemPrompt: () => [
      `You are executing the ${skill.name} skill in a forked agent.`,
      "Follow the skill instructions and complete the supplied task.",
      "Return a concise result for the parent agent, including any blocker or verification result.",
    ].join("\n"),
    source: "built-in",
    tools: skill.allowedTools?.length ? skill.allowedTools : undefined,
    maxTurns: 20,
  };
}

function buildForkedSkillPrompt(
  input: ReadSkillInput,
  skill: SkillCommand,
  visibleContent: string,
  state: State,
): string {
  const task = input.args?.trim() || getLatestUserMessageText(state);
  return [
    `<skill name="${skill.name}">`,
    visibleContent,
    "</skill>",
    "",
    "<task>",
    task || "Execute this skill for the current user request and report the result.",
    "</task>",
  ].join("\n");
}

function getLatestUserMessageText(state: State): string {
  for (let index = state.Messages.length - 1; index >= 0; index--) {
    const message = state.Messages[index];
    if (message?.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }

  return "";
}

function findDiscoveredSkill(
  input: ReadSkillInput,
  context: ToolUseContext,
): SkillCommand | undefined {
  const name = input.name?.trim();
  if (name) {
    const byName = context.skillRuntime.dynamicSkills.get(name);
    if (byName) {
      return byName;
    }
  }

  const path = input.path?.trim();
  if (!path) {
    return undefined;
  }

  for (const skill of context.skillRuntime.dynamicSkills.values()) {
    if (skill.skillPath === path) {
      return skill;
    }
  }

  return undefined;
}

function describeInput(input: ReadSkillInput): string {
  if (input.name && input.path) {
    return `name="${input.name}" path="${input.path}"`;
  }
  if (input.name) {
    return `name="${input.name}"`;
  }
  if (input.path) {
    return `path="${input.path}"`;
  }
  return "(empty input)";
}

function activateSkillAllowedTools(
  context: ToolUseContext,
  skill: SkillCommand,
): (() => void) | undefined {
  const allowedTools = skill.allowedTools ?? [];
  if (allowedTools.length === 0) {
    return undefined;
  }

  const previousAppState = context.getAppState();
  context.setAppState((previous) => {
    const commandRules =
      previous.toolPermissionContext.alwaysAllowRules.command ?? [];
    return {
      ...previous,
      toolPermissionContext: {
        ...previous.toolPermissionContext,
        alwaysAllowRules: {
          ...previous.toolPermissionContext.alwaysAllowRules,
          command: [...new Set([...commandRules, ...allowedTools])],
        },
      },
    };
  });

  return () => {
    context.setAppState(() => previousAppState);
  };
}

export default ReadSkill;
