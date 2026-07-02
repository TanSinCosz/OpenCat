import { createRuntimeContextMessage } from "../query/runtime-context.js";
import type { AutoCompressSummaryId } from "../types/context.js";
import type { Message } from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { InvokedSkill, State } from "../types/state.js";

const MAX_POST_COMPACT_SKILLS = 5;
const MAX_POST_COMPACT_SKILL_CHARS = 16_000;
const MAX_POST_COMPACT_SKILLS_TOTAL_CHARS = 48_000;

export type PostCompactInvokedSkillRestoreResult = {
  candidateCount: number;
  restoredCount: number;
  skippedCount: number;
};

/**
 * Restores invoked skill guidance only after compaction has removed history.
 *
 * ReadSkill tool results normally live in state.Messages. After auto-compress,
 * the exact tool result may be summarized away, so this function reattaches a
 * small recent subset as runtime context. It is guarded per summary id to avoid
 * duplicate attachments on repeated projection builds.
 */
export function restoreInvokedSkillsAfterAutoCompress(
  runtime: Runtime,
  state: State,
  summaryId: AutoCompressSummaryId,
  preservedMessages: readonly Message[],
): PostCompactInvokedSkillRestoreResult {
  if (state.autoCompress.invokedSkillsRestoredForSummaryId === summaryId) {
    return { candidateCount: 0, restoredCount: 0, skippedCount: 0 };
  }

  state.autoCompress.invokedSkillsRestoredForSummaryId = summaryId;

  const candidates = selectPostCompactInvokedSkills(
    state.invokedSkills,
    runtime.agentId,
    collectPreservedReadSkillNames(preservedMessages),
  );
  const restored = limitInvokedSkillsForRestore(candidates);

  if (restored.length > 0) {
    state.runtimeContextMessages.push(createRuntimeContextMessage({
      source: "dynamic_skill",
      content: renderPostCompactInvokedSkills(restored),
    }));
  }

  return {
    candidateCount: candidates.length,
    restoredCount: restored.length,
    skippedCount: candidates.length - restored.length,
  };
}

function selectPostCompactInvokedSkills(
  invokedSkills: readonly InvokedSkill[],
  agentId: string,
  preservedSkillNames: ReadonlySet<string>,
): InvokedSkill[] {
  return invokedSkills
    .filter((skill) =>
      skill.agentId === agentId && !preservedSkillNames.has(skill.name)
    )
    .sort((left, right) => right.invokedAt - left.invokedAt)
    .slice(0, MAX_POST_COMPACT_SKILLS);
}

function limitInvokedSkillsForRestore(
  skills: readonly InvokedSkill[],
): InvokedSkill[] {
  const restored: InvokedSkill[] = [];
  let remaining = MAX_POST_COMPACT_SKILLS_TOTAL_CHARS;

  for (const skill of skills) {
    if (remaining <= 0) {
      break;
    }

    const content = limitSkillContent(skill.content, remaining);
    if (!content.trim()) {
      continue;
    }

    const next = { ...skill, content };
    restored.push(next);
    remaining -= renderOnePostCompactSkill(next).length;
  }

  return restored;
}

function limitSkillContent(content: string, remainingChars: number): string {
  const maxChars = Math.min(MAX_POST_COMPACT_SKILL_CHARS, remainingChars);
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, Math.max(0, maxChars))}\n[Invoked skill truncated during post-compact restore]`;
}

function renderPostCompactInvokedSkills(skills: readonly InvokedSkill[]): string {
  return [
    "<post-compact-invoked-skills>",
    "The following skill instructions were read before auto-compress and have been restored into the current context.",
    ...skills.map(renderOnePostCompactSkill),
    "</post-compact-invoked-skills>",
  ].join("\n");
}

function renderOnePostCompactSkill(skill: InvokedSkill): string {
  return [
    `<skill name="${escapeAttribute(skill.name)}">`,
    `<description>${skill.description}</description>`,
    skill.skillDir ? `<skill_dir>${skill.skillDir}</skill_dir>` : "",
    skill.skillPath ? `<skill_path>${skill.skillPath}</skill_path>` : "",
    "<content>",
    skill.content,
    "</content>",
    "</skill>",
  ].filter(Boolean).join("\n");
}

function collectPreservedReadSkillNames(messages: readonly Message[]): Set<string> {
  const names = new Set<string>();

  for (const message of messages) {
    if (message.role !== "tool" || message.toolName !== "ReadSkill") {
      continue;
    }

    try {
      const value = JSON.parse(message.content) as unknown;
      if (isRecord(value) && typeof value.name === "string") {
        names.add(value.name);
      }
    } catch {
      // Non-JSON tool results are ignored; restoration is best-effort.
    }
  }

  return names;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
