import type { SkillCommand } from "../types.js";
import type { Runtime } from "../../types/runtime.js";
import type { InvokedSkill, State } from "../../types/state.js";

export function renderSkillContentForModel(skill: SkillCommand): string {
  const skillDir = skill.skillDir ?? "";
  const body = skill.content.trim();
  const content = skillDir
    ? `Base directory for this skill: ${skillDir}\n\n${body}`
    : body;

  return content
    .replace(/\$\{OPENCAT_SKILL_DIR\}/g, skillDir)
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir);
}

/**
 * Records only the content the model actually saw from ReadSkill.
 *
 * This list is not injected on every turn. It is a post-compact recovery index:
 * normal history carries the tool result, and invokedSkills restores the same
 * guidance only after compression has removed the original tool result.
 */
export function recordInvokedSkill(
  state: State,
  runtime: Runtime,
  skill: SkillCommand,
  visibleContent: string,
): InvokedSkill {
  const agentId = runtime.agentId ?? null;
  const existingIndex = state.invokedSkills.findIndex((entry) =>
    entry.agentId === agentId && entry.name === skill.name
  );
  const entry: InvokedSkill = {
    name: skill.name,
    description: skill.description,
    content: visibleContent,
    invokedAt: Date.now(),
    agentId,
    ...(skill.skillDir ? { skillDir: skill.skillDir } : {}),
    ...(skill.skillPath ? { skillPath: skill.skillPath } : {}),
  };

  if (existingIndex === -1) {
    state.invokedSkills.push(entry);
  } else {
    state.invokedSkills[existingIndex] = entry;
  }

  return entry;
}
