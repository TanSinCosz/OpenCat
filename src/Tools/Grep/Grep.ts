import { spawn } from "child_process";
import { stat } from "fs/promises";
import path, { isAbsolute, join } from "path";
import { z } from "zod";

import { Tool, ToolUseContext } from "../types.js";
import { getCwd } from "../utils/cwd.js";
import { expandPath } from "../utils/path.js";
import { resolveRipgrepCommand } from "../utils/ripgrep.js";
import { getDescription, GREP_TOOL_NAME } from "./prompt.js";
import { inputSchema, outputSchema } from "./type.js";


const DEFAULT_HEAD_LIMIT = 250
type typeInput = z.infer<ReturnType<typeof inputSchema>>;
type typeOutput = z.infer<ReturnType<typeof outputSchema>>;

type ValidationResult =
    | { result: true }
    | { result: false; message: string; errorCode?: number };

const VCS_DIRECTORIES_TO_EXCLUDE = [
    '.git',
    '.svn',
    '.hg',
    '.bzr',
    '.jj',
    '.sl',
] as const

export class Grep
    implements Tool<typeInput, typeOutput, typeof inputSchema, typeof outputSchema> {
    name = GREP_TOOL_NAME;
    inputSchema = inputSchema;
    outputSchema = outputSchema;
    searchHint = "search file contents with regex (ripgrep)";
    maxResultSizeChars = 20_000;

    async description(): Promise<string> {
        return getDescription();
    }

    async prompt(): Promise<string> {
        return getDescription()
    }

    isConcurrencySafe(): boolean {
        return true;
    }

    async validateInput(
        { pattern, path }: typeInput,
    ): Promise<ValidationResult> {
        if (!pattern.trim()) {
            return {
                result: false,
                message: 'Search pattern cannot be empty.',
                errorCode: 1,
            }
        }

        if (path === 'undefined' || path === 'null') {
            return {
                result: false,
                message: 'Path must be omitted when using the default directory.',
                errorCode: 2,
            }
        }

        if (!path) {
            return { result: true }
        }

        const absolutePath = expandPath(path)

        if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
            return { result: true }
        }

        try {
            await stat(absolutePath)
        } catch (error) {
            if (isENOENT(error)) {
                return {
                    result: false,
                    message: `Path does not exist: ${path}.`,
                    errorCode: 3,
                }
            }

            throw error
        }

        return { result: true }
    }

    async call(
        {
            pattern,
            path,
            glob,
            type,
            output_mode = 'files_with_matches',
            '-B': before,
            '-A': after,
            '-C': contextC,
            context: contextLines,
            '-n': showLineNumbers = true,
            '-i': caseInsensitive = false,
            head_limit,
            offset = 0,
            multiline = false,
        }: typeInput,
        context: ToolUseContext,
    ): Promise<typeOutput> {
        const searchPath = path ? expandPath(path) : getCwd()

        const args: string[] = ['--hidden', '--max-columns', '500']

        for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
            args.push('--glob', `!${dir}`)
        }

        if (multiline) {
            args.push('-U', '--multiline-dotall')
        }

        if (caseInsensitive) {
            args.push('-i')
        }

        if (output_mode === 'files_with_matches') {
            args.push('-l')
        } else if (output_mode === 'count') {
            args.push('-c')
        }

        if (output_mode === 'content' && showLineNumbers) {
            args.push('-n')
        }

        if (output_mode === 'content') {
            const finalContext = contextLines ?? contextC
            if (finalContext !== undefined) {
                args.push('-C', String(finalContext))
            } else {
                if (before !== undefined) args.push('-B', String(before))
                if (after !== undefined) args.push('-A', String(after))
            }
        }

        if (pattern.startsWith('-')) {
            args.push('-e', pattern)
        } else {
            args.push(pattern)
        }

        if (type) {
            args.push('--type', type)
        }

        if (glob) {
            for (const globPattern of splitGlobPatterns(glob)) {
                args.push('--glob', globPattern)
            }
        }

        args.push('.')

        const results = await runRipgrep(
            args,
            searchPath,
            context.abortController.signal,
        )

        if (output_mode === 'content') {
            const { items, appliedLimit } = applyHeadLimit(results, head_limit, offset)

            const lines = items.map(line => relativizeRipgrepLine(line))

            return {
                mode: 'content',
                numFiles: 0,
                filenames: [],
                content: lines.join('\n'),
                numLines: lines.length,
                ...(appliedLimit !== undefined && { appliedLimit }),
                ...(offset > 0 && { appliedOffset: offset }),
            }
        }

        if (output_mode === 'count') {
            const { items, appliedLimit } = applyHeadLimit(results, head_limit, offset)
            const lines = items.map(line => relativizeCountLine(line))

            let numMatches = 0
            let numFiles = 0

            for (const line of lines) {
                const index = line.lastIndexOf(':')
                if (index === -1) continue

                const count = Number(line.slice(index + 1))
                if (!Number.isNaN(count)) {
                    numMatches += count
                    numFiles += 1
                }
            }

            return {
                mode: 'count',
                numFiles,
                filenames: [],
                content: lines.join('\n'),
                numMatches,
                ...(appliedLimit !== undefined && { appliedLimit }),
                ...(offset > 0 && { appliedOffset: offset }),
            }
        }

        const sortedFiles = await sortFilesByMtimeDesc(
            results.map(file => (isAbsolute(file) ? file : join(searchPath, file))),
        )
        const { items, appliedLimit } = applyHeadLimit(
            sortedFiles,
            head_limit,
            offset,
        )

        return {
            mode: 'files_with_matches',
            numFiles: items.length,
            filenames: items.map(file => toRelativePath(file, searchPath)),
            ...(appliedLimit !== undefined && { appliedLimit }),
            ...(offset > 0 && { appliedOffset: offset }),
        }
    }
}

function applyHeadLimit<T>(
    items: T[],
    limit: number | undefined,
    offset = 0,
): { items: T[]; appliedLimit?: number } {
    if (limit === 0) {
        return { items: items.slice(offset) }
    }

    const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT
    const sliced = items.slice(offset, offset + effectiveLimit)

    return {
        items: sliced,
        ...(items.length - offset > effectiveLimit
            ? { appliedLimit: effectiveLimit }
            : {}),
    }
}

function splitGlobPatterns(glob: string): string[] {
    const result: string[] = []

    for (const raw of glob.split(/\s+/)) {
        if (!raw) continue

        if (raw.includes('{') && raw.includes('}')) {
            result.push(raw)
        } else {
            result.push(...raw.split(',').filter(Boolean))
        }
    }

    return result
}
function relativizeRipgrepLine(line: string): string {
    const index = line.indexOf(':')
    if (index <= 0) return line

    const filePath = line.slice(0, index)
    const rest = line.slice(index)

    return `${toRelativePath(filePath)}${rest}`
}

function relativizeCountLine(line: string): string {
    const index = line.lastIndexOf(':')
    if (index <= 0) return line

    const filePath = line.slice(0, index)
    const rest = line.slice(index)

    return `${toRelativePath(filePath)}${rest}`
}


function isENOENT(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function runRipgrep(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    timeoutMs = 30_000,
): Promise<string[]> {
    const ripgrepCommand = await resolveRipgrepCommand();

    return new Promise((resolve, reject) => {
        const child = spawn(ripgrepCommand, args, {
            cwd,
            signal,
            shell: false,
            windowsHide: true,
        })

        const timer = setTimeout(() => {
            child.kill()
            reject(new Error('ripgrep timed out'))
        }, timeoutMs)

        let stdout = ''
        let stderr = ''

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        child.stdout.on('data', chunk => {
            stdout += chunk
        })

        child.stderr.on('data', chunk => {
            stderr += chunk
        })

        child.on('error', error => {
            clearTimeout(timer)
            reject(error)
        })

        child.on('close', code => {
            clearTimeout(timer)

            if (code === 0 || code === 1) {
                resolve(stdout.split(/\r?\n/).filter(Boolean))
                return
            }

            reject(new Error(stderr || `ripgrep exited with code ${code}`))
        })
    })
}



export function toRelativePath(filePath: string, cwd = process.cwd()): string {
    const relativePath = path.relative(cwd, filePath)

    if (
        relativePath &&
        !relativePath.startsWith('..') &&
        !path.isAbsolute(relativePath)
    ) {
        return normalizePathForOutput(relativePath)
    }

    return normalizePathForOutput(filePath)
}

function normalizePathForOutput(filePath: string): string {
    return filePath.replaceAll('\\', '/')
}

export async function sortFilesByMtimeDesc(
    files: string[],
): Promise<string[]> {
    const entries = await Promise.all(
        files.map(async file => {
            try {
                const stats = await stat(file)
                return {
                    file,
                    mtimeMs: stats.mtimeMs,
                }
            } catch {
                // 搜索到之后文件可能被删除，失败的放最后
                return {
                    file,
                    mtimeMs: 0,
                }
            }
        }),
    )

    return entries
        .sort((a, b) => {
            const timeDiff = b.mtimeMs - a.mtimeMs
            if (timeDiff !== 0) {
                return timeDiff
            }

            return a.file.localeCompare(b.file)
        })
        .map(entry => entry.file)
}
