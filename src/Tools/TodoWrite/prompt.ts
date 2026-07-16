export const TODO_WRITE_TOOL_NAME = "TodoWrite";

export const DESCRIPTION =
  "Update the current agent's todo list for multi-step work.";

export function renderTodoWritePrompt(): string {
  return [
    "Use this tool to create and maintain a structured todo list for the current coding session.",
    "",
    "Use it proactively when:",
    "- The user explicitly asks for a todo list.",
    "- The task has 3 or more meaningful steps.",
    "- The task spans multiple files, tools, or verification phases.",
    "- You discover follow-up work while implementing.",
    "",
    "Do not use it for single-step, trivial, or purely informational requests.",
    "",
    "Rules:",
    "- Send the complete todo list on every update.",
    "- Keep at most one item in_progress.",
    "- Mark a task completed immediately after it is actually done.",
    "- Do not mark a task completed if tests/checks are failing or work is partial.",
    "- Remove stale items that no longer apply.",
    "- Every item must include both content and activeForm.",
  ].join("\n");
}
