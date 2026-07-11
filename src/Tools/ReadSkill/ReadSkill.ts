import type { z } from "zod";

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
  maxResultSizeChars = 80_000;
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
    return true;
  }

  formatResult({ output }: { output: ReadSkillOutput }): string {
    return [
      `Skill: ${output.name}`,
      `Description: ${output.description}`,
      ...(output.skillPath ? [`Path: ${output.skillPath}`] : []),
      ...(output.truncated ? ["Note: content was truncated."] : []),
      "",
      output.content,
    ].join("\n");
  }

  call(
    input: ReadSkillInput,
    context: ToolUseContext,
    runtime: Runtime,
    state: State,
  ): ReadSkillOutput {
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

    recordInvokedSkill(state, runtime, skill, visibleContent);

    return {
      name: skill.name,
      description: skill.description,
      ...(skill.skillDir ? { skillDir: skill.skillDir } : {}),
      ...(skill.skillPath ? { skillPath: skill.skillPath } : {}),
      content: visibleContent,
      truncated,
      note: truncated
        ? "The skill was longer than the ReadSkill result budget; only the visible prefix was recorded for post-compact restoration."
        : undefined,
    };
  }
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

export default ReadSkill;
