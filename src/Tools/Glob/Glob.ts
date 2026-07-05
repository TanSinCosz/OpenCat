import { spawn } from "child_process";
import { stat } from "fs/promises";
import path, { isAbsolute, join } from "path";
import { z } from "zod";

import { Tool, ToolUseContext } from "../types.js";
import { getCwd } from "../utils/cwd.js";
import { expandPath } from "../utils/path.js";
import { resolveRipgrepCommand } from "../utils/ripgrep.js";
import { DESCRIPTION, GLOB_TOOL_NAME } from "./prompt.js";
import { inputSchema, outputSchema } from "./type.js";

type typeInput = z.infer<ReturnType<typeof inputSchema>>;
type typeOutput = z.infer<ReturnType<typeof outputSchema>>;

type ValidationResult =
    | { result: true }
    | { result: false; message: string; errorCode?: number };

type GlobFilesOptions = {
    limit: number;
    signal?: AbortSignal;
};

export class Glob
    implements Tool<typeInput, typeOutput, typeof inputSchema, typeof outputSchema> {
    name = GLOB_TOOL_NAME;
    inputSchema = inputSchema;
    outputSchema = outputSchema;
    searchHint = "find files by name pattern or wildcard";
    maxResultSizeChars = 100_000;

    async description(): Promise<string> {
        return DESCRIPTION;
    }

    async prompt(): Promise<string> {
        return DESCRIPTION;
    }

    isConcurrencySafe(): boolean {
        return true;
    }

    async validateInput({ pattern, path }: typeInput): Promise<ValidationResult> {
        if (!pattern.trim()) {
            return {
                result: false,
                message: "Glob pattern cannot be empty.",
                errorCode: 1,
            };
        }

        if (path === "undefined" || path === "null") {
            return {
                result: false,
                message:
                    'Path must be omitted when using the default directory. Do not pass "undefined" or "null".',
                errorCode: 2,
            };
        }

        if (!path) {
            return { result: true };
        }

        const absolutePath = expandPath(path);

        // Avoid stat on UNC paths because it can trigger network side effects.
        if (absolutePath.startsWith("\\\\") || absolutePath.startsWith("//")) {
            return { result: true };
        }

        try {
            const stats = await stat(absolutePath);

            if (!stats.isDirectory()) {
                return {
                    result: false,
                    message: `Path is not a directory: ${path}`,
                    errorCode: 4,
                };
            }
        } catch (error) {
            if (isENOENT(error)) {
                return {
                    result: false,
                    message: `Directory does not exist: ${path}.`,
                    errorCode: 3,
                };
            }

            throw error;
        }

        return { result: true };
    }

    async call(input: typeInput, context: ToolUseContext): Promise<typeOutput> {
        const start = Date.now();
        const searchPath = input.path ? expandPath(input.path) : getCwd();
        const limit = 100;

        const files = await globFiles(input.pattern, searchPath, {
            limit: limit + 1,
            signal: context.abortController.signal,
        });

        const truncated = files.length > limit;
        const limitedFiles = files.slice(0, limit);

        return {
            durationMs: Date.now() - start,
            numFiles: limitedFiles.length,
            filenames: limitedFiles.map((filePath) =>
                toRelativePath(filePath, searchPath),
            ),
            truncated,
        };
    }
}

export async function globFiles(
    pattern: string,
    cwd: string,
    options: GlobFilesOptions,
): Promise<string[]> {
    const ripgrepCommand = await resolveRipgrepCommand();
    const output = await runCommand(
        ripgrepCommand,
        ["--files", "--glob", pattern, "--sort=modified", "--no-ignore", "--hidden"],
        cwd,
        options.signal,
    );

    return output
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, options.limit)
        .map((filePath) => (isAbsolute(filePath) ? filePath : join(cwd, filePath)));
}

export function toRelativePath(filePath: string, cwd = process.cwd()): string {
    const relative = path.relative(cwd, filePath);

    const result =
        relative && !relative.startsWith("..") && !path.isAbsolute(relative)
            ? relative
            : filePath;

    return normalizePathForOutput(result);
}

function normalizePathForOutput(filePath: string): string {
    return filePath.replaceAll("\\", "/");
}

function runCommand(
    command: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            signal,
            shell: false,
            windowsHide: true,
        });

        let stdout = "";
        let stderr = "";

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");

        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });

        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });

        child.on("error", reject);

        child.on("close", (code) => {
            if (code === 0 || (code === 1 && stdout.trim() === "")) {
                resolve(stdout);
                return;
            }

            reject(new Error(stderr || `${command} exited with code ${code}`));
        });
    });
}

function isENOENT(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
