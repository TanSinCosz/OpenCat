/** SWE 调查、修复和完整任务的提示词生成，不执行任务。 */
import type { SweBenchInstance, SweDraftKind } from "./types.js";

export function parseSweDraftKind(value: string | null): SweDraftKind {
  return value === "fix" || value === "standard" ? value : "investigate";
}

export function buildSweDraftPrompt(
  instance: SweBenchInstance,
  kind: SweDraftKind,
): string {
  if (kind === "investigate") {
    return buildSweInvestigatePrompt(instance);
  }

  if (kind === "fix") {
    return [
      "Based on the investigation from the previous turn, implement the smallest correct fix now.",
      "Modify only the checked-out SWE workspace for this item. Re-read any file you edit before changing it.",
      "After editing, run the most relevant tests you can. If tests cannot run, explain exactly why and what you verified instead.",
      "Finish with a concise summary of changed files, the behavior fixed, and verification results.",
      "",
      "<swe_task_followup>",
      `<instance_id>${instance.instance_id}</instance_id>`,
      "</swe_task_followup>",
    ].join("\n");
  }

  return [
    "You are working on a SWE-bench Verified issue in OpenCat.",
    "Modify the checked-out repository to fix the issue. Prefer minimal, well-tested changes.",
    "Use the available tools to inspect, edit, and verify the code.",
    "Do not fetch unrelated web content unless the repository itself requires it.",
    "Before editing, inspect the relevant files in the workspace. After editing, run the most relevant tests you can.",
    "",
    "<swe_task>",
    `<instance_id>${instance.instance_id}</instance_id>`,
    `<repo>${instance.repo}</repo>`,
    "",
    "<problem_statement>",
    instance.problem_statement,
    "</problem_statement>",
    instance.hints_text ? `\n<hints_text>\n${instance.hints_text}\n</hints_text>` : "",
    "</swe_task>",
  ].filter((line) => line !== "").join("\n");
}

function buildSweInvestigatePrompt(instance: SweBenchInstance): string {
  return [
    "You are working on a SWE-bench Verified issue in OpenCat.",
    "First investigate only. Do not modify files yet. Do not call Edit or Write.",
    "Read the issue, inspect the checked-out repository, identify the likely root cause, and explain the smallest code change you would make next.",
    "Use tools to inspect relevant files. Do not fetch unrelated web content unless the repository itself requires it.",
    "End with a concise investigation summary: root cause, relevant files/functions, proposed fix, and tests to run.",
    "",
    "<swe_task>",
    `<instance_id>${instance.instance_id}</instance_id>`,
    `<repo>${instance.repo}</repo>`,
    "",
    "<problem_statement>",
    instance.problem_statement,
    "</problem_statement>",
    instance.hints_text ? `\n<hints_text>\n${instance.hints_text}\n</hints_text>` : "",
    "</swe_task>",
  ].filter((line) => line !== "").join("\n");
}
