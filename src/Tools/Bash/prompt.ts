import { FILE_EDIT_TOOL_NAME } from "../FileEdit/prompt.js";
import { FILE_READ_TOOL_NAME } from "../FileRead/prompt.js";
import { FILE_WRITE_TOOL_NAME } from "../FileWrite/prompt.js";
import { GLOB_TOOL_NAME } from "../Glob/prompt.js";
import { GREP_TOOL_NAME } from "../Grep/prompt.js";

export const BASH_TOOL_NAME = "Bash";

export const DESCRIPTION = "Execute shell commands";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export function getDefaultTimeoutMs(): number {
    return DEFAULT_TIMEOUT_MS;
}

export function getMaxTimeoutMs(): number {
    return MAX_TIMEOUT_MS;
}

export function getSimplePrompt(): string {
    return [
        "Executes a shell command and returns stdout, stderr, and exit information.",
        "",
        "Use this tool for commands that genuinely need a shell: package scripts, test runners, git inspection, build commands, and small one-off diagnostics.",
        "",
        "Prefer dedicated tools for file work:",
        `- Use ${FILE_READ_TOOL_NAME} to read files, not cat/head/tail.`,
        `- Use ${GLOB_TOOL_NAME} to find files, not find/dir/ls/Get-ChildItem recursive searches.`,
        `- Use ${GREP_TOOL_NAME} to search file contents, not grep/rg/findstr/Select-String/Get-Content pipelines.`,
        `- Use ${FILE_EDIT_TOOL_NAME} to edit files, not sed/awk/perl.`,
        `- Use ${FILE_WRITE_TOOL_NAME} to create or replace files, not echo redirection or heredocs.`,
        "- Respond directly to the user instead of using echo/printf for communication.",
        "",
        "# Initial safety rules",
        "- Keep commands simple and easy to review.",
        "- Prefer one command per tool call. Use compound commands only when the later command depends on the earlier command.",
        "- Avoid changing directories with cd. Prefer absolute paths or run commands from the current working directory.",
        "- Quote paths that contain spaces.",
        "- Do not use interactive commands that wait for keyboard input.",
        "- Do not use sleep loops. Run a direct check command instead.",
        "- Do not use background execution, shell job control, or trailing & in this first version.",
        `- You may specify timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}. Maximum: ${MAX_TIMEOUT_MS}.`,
        "",
        "# Commands that should be treated cautiously",
        "- Destructive file operations such as rm, del, rmdir, chmod, chown, and moving many files.",
        "- Destructive git operations such as git reset, git checkout, git clean, git push --force, and git rebase.",
        "- Network or installer commands such as curl, wget, npm install, pnpm add, yarn add, pip install, and uv add.",
        "- Shell features that hide extra execution, such as command substitution, backticks, redirection, heredocs, and long pipelines.",
        "",
        "# Git guidance",
        "- Git read-only inspection is usually appropriate: git status, git diff, git log, git branch, git show.",
        "- Only create commits, push, or modify branches when the user explicitly asks.",
        "- Never skip hooks with --no-verify unless the user explicitly asks.",
    ].join("\n");
}
