import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { semanticBoolean } from "../utils/semanticBoolean.js";
import { semanticNumber } from "../utils/semanticNumber.js";
import { getMaxTimeoutMs } from "./prompt.js";




const fullInputSchema = lazySchema(() => z.strictObject({
    command: z.string().describe('The command to execute'),
    timeout: semanticNumber(z.number().optional()).describe(`Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`),
    description: z.string().optional().describe(`Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.

For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
- ls → "List files in current directory"
- git status → "Show working tree status"
- npm install → "Install package dependencies"

For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:
- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"
- git reset --hard origin/main → "Discard all local changes and match remote main"
- curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"`),
    run_in_background: semanticBoolean(z.boolean().optional()).describe(`Set to true to run this command in the background. Use Read to read the output later.`),
    dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()).describe('Set this to true to dangerously override sandbox mode and run commands without sandboxing.'),
    _simulatedSedEdit: z.object({
        filePath: z.string(),
        newContent: z.string()
    }).optional().describe('Internal: pre-computed sed edit result from preview')
}));

// Always omit _simulatedSedEdit from the model-facing schema. It is an internal-only
// field set by SedEditPermissionRequest after the user approves a sed edit preview.
// Exposing it in the schema would let the model bypass permission checks and the
// sandbox by pairing an innocuous command with an arbitrary file write.
// Also conditionally remove run_in_background when background tasks are disabled.
export const inputSchema = lazySchema(() => fullInputSchema().omit({
    run_in_background: true,
    _simulatedSedEdit: true
}));



export const outputSchema = lazySchema(() => z.object({
    stdout: z.string().describe('The standard output of the command'),
    stderr: z.string().describe('The standard error output of the command'),
    rawOutputPath: z.string().optional().describe('Path to raw output file for large MCP tool outputs'),
    interrupted: z.boolean().describe('Whether the command was interrupted'),
    isImage: z.boolean().optional().describe('Flag to indicate if stdout contains image data'),
    backgroundTaskId: z.string().optional().describe('ID of the background task if command is running in background'),
    backgroundedByUser: z.boolean().optional().describe('True if the user manually backgrounded the command with Ctrl+B'),
    assistantAutoBackgrounded: z.boolean().optional().describe('True if assistant-mode auto-backgrounded a long-running blocking command'),
    dangerouslyDisableSandbox: z.boolean().optional().describe('Flag to indicate if sandbox mode was overridden'),
    returnCodeInterpretation: z.string().optional().describe('Semantic interpretation for non-error exit codes with special meaning'),
    noOutputExpected: z.boolean().optional().describe('Whether the command is expected to produce no output on success'),
    structuredContent: z.array(z.any()).optional().describe('Structured content blocks'),
    persistedOutputPath: z.string().optional().describe('Path to the persisted full output in tool-results dir (set when output is too large for inline)'),
    persistedOutputSize: z.number().optional().describe('Total size of the output in bytes (set when output is too large for inline)')
}));
