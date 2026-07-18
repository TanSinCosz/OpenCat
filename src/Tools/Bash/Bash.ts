import { spawn } from "child_process";
import { z } from "zod";

import { Tool, ToolUseContext } from "../types.js";
import { getCwd } from "../utils/cwd.js";
import { BASH_TOOL_NAME, DESCRIPTION, getMaxTimeoutMs, getSimplePrompt } from "./prompt.js";
import { inputSchema, outputSchema } from "./type.js";

type typeInput = z.infer<ReturnType<typeof inputSchema>>;
type typeOutput = z.infer<ReturnType<typeof outputSchema>>;

type ValidationResult =
    | { result: true }
    | { result: false; message: string; errorCode?: number };

const MAX_COMMAND_LENGTH = 10_000;
const MAX_BUFFER_CHARS = 30_000;

const INTERACTIVE_COMMANDS = /\b(?:vim|vi|nano|less|more|top|htop|ssh|python|node|irb|mysql|psql)\b\s*$/i;
const BACKGROUND_COMMAND = /(?:^|[;&|]\s*)[^;&|]*&\s*$/;
const COMMAND_SUBSTITUTION = /`|\$\(/;
const REDIRECTION = /(^|[^>])>{1,2}(?!>)|</;
const HEREDOC = /<<-?/;
const LONG_PIPELINE = /(?:\|.*){3,}/;

const DANGEROUS_COMMANDS = [
    /^rm(?:\s|$)/i,
    /^del(?:\s|$)/i,
    /^rmdir(?:\s|$)/i,
    /^chmod(?:\s|$)/i,
    /^chown(?:\s|$)/i,
    /^git\s+(?:reset|checkout|clean|push\s+--force|push\s+-f|rebase)(?:\s|$)/i,
    /^(?:curl|wget)(?:\s|$)/i,
    /^(?:npm|pnpm|yarn)\s+(?:install|add)(?:\s|$)/i,
    /^pip\s+install(?:\s|$)/i,
    /^uv\s+add(?:\s|$)/i,
];

export class Bash implements Tool<typeInput, typeOutput, typeof inputSchema, typeof outputSchema> {
    name = BASH_TOOL_NAME;
    searchHint = "execute shell commands";
    maxResultSizeChars = MAX_BUFFER_CHARS;
    strict = true;
    inputSchema = inputSchema;
    outputSchema = outputSchema;

    description(): string {
        return DESCRIPTION;
    }

    prompt(): string {
        return getSimplePrompt();
    }

    isConcurrencySafe(): boolean {
        return false;
    }

    formatResult({ output }: { output: typeOutput }): string {
        if (output.backgroundTaskId) {
            return `Command is running in the background. Task id: ${output.backgroundTaskId}`;
        }

        const sections: string[] = [];
        if (output.returnCodeInterpretation) {
            sections.push(output.returnCodeInterpretation);
        }
        if (output.interrupted) {
            sections.push("Command was interrupted.");
        }
        if (output.stdout) {
            sections.push(`stdout:\n${output.stdout}`);
        }
        if (output.stderr) {
            sections.push(`stderr:\n${output.stderr}`);
        }
        if (output.persistedOutputPath) {
            sections.push(
                `Full output was persisted to ${output.persistedOutputPath} (${output.persistedOutputSize ?? "unknown"} bytes).`,
            );
        }

        return sections.length > 0
            ? sections.join("\n\n")
            : "Command completed with no output.";
    }

    async validateInput(input: typeInput, _context?: ToolUseContext): Promise<ValidationResult> {
        const command = input.command.trim();

        if (!command) {
            return { result: false, message: "Command cannot be empty.", errorCode: 1 };
        }

        if (command.length > MAX_COMMAND_LENGTH) {
            return {
                result: false,
                message: `Command is too long. Keep commands under ${MAX_COMMAND_LENGTH} characters.`,
                errorCode: 2,
            };
        }

        if (input.timeout !== undefined && input.timeout > getMaxTimeoutMs()) {
            return {
                result: false,
                message: `Timeout cannot exceed ${getMaxTimeoutMs()} milliseconds.`,
                errorCode: 3,
            };
        }

        if (input.dangerouslyDisableSandbox) {
            return {
                result: false,
                message: "dangerouslyDisableSandbox is not supported in the initial Bash tool.",
                errorCode: 4,
            };
        }

        const blockedReason = getBlockedCommandReason(command);
        if (blockedReason) {
            return { result: false, message: blockedReason, errorCode: 5 };
        }

        return { result: true };
    }

    async call(input: typeInput, context: ToolUseContext): Promise<typeOutput> {
        const validation = await this.validateInput(input, context);
        if (validation.result === false) {
            throw new Error(validation.message);
        }

        const timeout = input.timeout ?? 120_000;
        return runShellCommand(input.command.trim(), timeout, context);
    }
}

function getBlockedCommandReason(command: string): string | null {
    if (BACKGROUND_COMMAND.test(command)) {
        return "Background execution is not supported in the initial Bash tool.";
    }

    if (INTERACTIVE_COMMANDS.test(command)) {
        return "Interactive commands are not supported because they may wait for keyboard input.";
    }

    if (COMMAND_SUBSTITUTION.test(command)) {
        return "Command substitution with backticks or $() is blocked in the initial Bash tool.";
    }

    if (HEREDOC.test(command)) {
        return "Heredocs are blocked in the initial Bash tool. Use FileWrite for file creation.";
    }

    if (REDIRECTION.test(command)) {
        return "Shell redirection is blocked in the initial Bash tool. Use FileRead/FileWrite/Edit tools for file IO.";
    }

    if (LONG_PIPELINE.test(command)) {
        return "Long pipelines are blocked in the initial Bash tool. Keep commands simple and inspectable.";
    }

    const subcommands = splitSimpleSubcommands(command);
    for (const subcommand of subcommands) {
        if (DANGEROUS_COMMANDS.some(pattern => pattern.test(subcommand.trim()))) {
            return `Potentially destructive or environment-changing command requires a later permission flow: ${subcommand.trim()}`;
        }
    }

    return null;
}

function splitSimpleSubcommands(command: string): string[] {
    return command
        .split(/\s*(?:&&|\|\||;|\|)\s*/g)
        .map(part => part.trim())
        .filter(Boolean);
}

function runShellCommand(
    command: string,
    timeout: number,
    context: ToolUseContext,
): Promise<typeOutput> {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let interrupted = false;
        let settled = false;

        const child = spawn(command, {
            cwd: getCwd(),
            shell: true,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });

        const finish = (result: typeOutput) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            context.abortController.signal.removeEventListener("abort", abortHandler);
            resolve(result);
        };

        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            context.abortController.signal.removeEventListener("abort", abortHandler);
            reject(error);
        };

        const abortHandler = () => {
            interrupted = true;
            child.kill();
        };

        const timeoutId = setTimeout(() => {
            interrupted = true;
            child.kill();
        }, timeout);

        context.abortController.signal.addEventListener("abort", abortHandler, { once: true });

        child.stdout?.on("data", chunk => {
            stdout = appendWithLimit(stdout, String(chunk));
        });

        child.stderr?.on("data", chunk => {
            stderr = appendWithLimit(stderr, String(chunk));
        });

        child.on("error", error => {
            fail(error);
        });

        child.on("close", code => {
            finish({
                stdout,
                stderr,
                interrupted,
                returnCodeInterpretation: code === 0
                    ? undefined
                    : `Command exited with code ${code ?? "unknown"}.`,
            });
        });
    });
}

function appendWithLimit(current: string, chunk: string): string {
    const next = current + chunk;
    if (next.length <= MAX_BUFFER_CHARS) {
        return next;
    }

    return next.slice(0, MAX_BUFFER_CHARS) + "\n[Output truncated]";
}
