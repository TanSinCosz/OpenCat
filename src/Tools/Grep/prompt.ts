import { AGENT_TOOL_NAME } from '../Agent/prompt.js'
import { BASH_TOOL_NAME } from '../Bash/prompt.js'

export const GREP_TOOL_NAME = 'Grep'

export function getDescription(): string {
    return `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use ${GREP_TOOL_NAME} for content search tasks. NEVER invoke \`grep\`, \`rg\`, \`findstr\`, \`Select-String\`, or \`Get-Content | Select-String\` as a ${BASH_TOOL_NAME} command. The ${GREP_TOOL_NAME} tool has been optimized for correct permissions and access.
  - Use Glob for file-name/path searches instead of shell commands such as \`find\`, recursive \`dir\`, recursive \`ls\`, or recursive \`Get-ChildItem\`.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use ${AGENT_TOOL_NAME} tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
`
}
