export const MEMORY_SAVE_TOOL_NAME = "MemorySave";

export const DESCRIPTION =
  "Add an explicit user-approved item to long-term memory.";

export function renderMemorySavePrompt(): string {
  return [
    "Adds a concise item to file-based long-term memory.",
    "",
    "Use this only when the user explicitly asks you to remember, save, or add something to memory.",
    "Pass the exact memory the user wants saved. It will be written to a markdown memory file and indexed from MEMORY.md.",
    "Use memoryType when the category is clear: user, feedback, project, or reference.",
    "Do not call this for ordinary conversation, transient task progress, or memory lookup.",
    "Do not use this for deletion yet; that should be handled by a dedicated memory-management tool when available.",
    "Do not save secrets or sensitive information unless the user explicitly asks you to remember that exact information.",
  ].join("\n");
}
