import type { z } from "zod";

import type { Tool, ToolUseContext } from "../types.js";
import {
    DESCRIPTION,
    FILE_READ_TOOL_NAME,
    LINE_FORMAT_INSTRUCTION,
    OFFSET_INSTRUCTION_DEFAULT,
    renderPromptTemplate,
    OFFSET_INSTRUCTION_TARGETED
} from "./prompt.js";
import { formatFileSize } from "../utils/format.js";
import { inputSchema, outputSchema } from "./type.js";
import { expandPath } from "../utils/path.js";
import { hasBinaryExtension } from "../utils/BinaryFile.js";
import { discoverSkillsForReadPath } from "../utils/discoverSkillsForReadPath.js";
import { ReadFileRangeResult } from "./type.js";
import { stat, readFile } from 'fs/promises'
import { getFileModificationTimeAsync } from "../utils/fileState.js";
import { estimateTokensFromText } from "../../utils/size-estimate.js";

type typeInput = z.infer<ReturnType<typeof inputSchema>>;
type typeOutput = z.infer<ReturnType<typeof outputSchema>>;

const FILE_READ_MAX_SIZE_BYTES = 256 * 1024
const FILE_READ_MAX_ESTIMATED_TOKENS = 25000

export class FileRead implements Tool<typeInput, typeOutput, typeof inputSchema, typeof outputSchema> {
    name = FILE_READ_TOOL_NAME;
    inputSchema = inputSchema;
    outputSchema = outputSchema;
    maxResultSizeChars = Infinity;
    strict = true;
    searchHint = "read files";
    shouldDefer = false;
    alwaysLoad = true;

    description(): string {
        return DESCRIPTION;
    }

    prompt() {
        return renderPromptTemplate(
            LINE_FORMAT_INSTRUCTION,
            `. Files larger than ${formatFileSize(FILE_READ_MAX_SIZE_BYTES)} will return an error; use offset and limit for larger files`,
            OFFSET_INSTRUCTION_TARGETED,
        )
    }

    isEnabled(): boolean {
        return true;
    }

    userFacingName(): string { // 显示在前端的名称
        return "Read";
    }

    isConcurrencySafe(): boolean {
        return true;
    }

    formatResult({ output }: { output: typeOutput }): string {
        if (output.type === 'file_unchanged') {
            return `File has not changed since last read: ${output.file.filePath}`;
        }

        const lineRange = output.file.numLines > 0
            ? `lines ${output.file.startLine}-${output.file.startLine + output.file.numLines - 1}`
            : `line ${output.file.startLine}`;

        return [
            `${output.file.filePath} (${lineRange} of ${output.file.totalLines}):`,
            output.file.content,
        ].join('\n')
    }

    async call(
        { file_path, offset = 1, limit }: typeInput,
        context: ToolUseContext,
    ): Promise<typeOutput> {
        const fullFilePath = expandPath(file_path)
        const cacheRange = normalizeReadCacheRange(offset, limit)

        if (hasBinaryExtension(fullFilePath)) {
            throw new Error('This tool cannot read binary files.')
        }

        const lineOffset = offset === 0 ? 0 : offset - 1
        const startLine = Math.max(offset, 1)


        const existingState = context.readFileState.get(fullFilePath)

        if (
            existingState &&
            !existingState.isPartialView &&
            existingState.offset === cacheRange.offset &&
            existingState.limit === cacheRange.limit
        ) {
            const mtimeMs = await getFileModificationTimeAsync(fullFilePath)

            if (mtimeMs === existingState.timestamp) {
                return {
                    type: 'file_unchanged',
                    file: {
                        filePath: file_path,
                    },
                }
            }
        }

        const { content, lineCount, totalLines, mtimeMs } = await readFileInRange(
            fullFilePath,
            lineOffset,
            limit,
            limit === undefined ? FILE_READ_MAX_SIZE_BYTES : undefined,
            context.abortController.signal,
        )
        await discoverSkillsForReadPath(fullFilePath, context)
        const numberedContent = formatContentWithLineNumbers(content, startLine)
        validateEstimatedContentTokens(
            numberedContent,
            FILE_READ_MAX_ESTIMATED_TOKENS,
        )


        context.readFileState?.set(fullFilePath, {
            content,
            timestamp: Math.floor(mtimeMs),
            offset: cacheRange.offset,
            limit: cacheRange.limit,
        })

        return {
            type: 'text',
            file: {
                filePath: file_path,
                content: numberedContent,
                numLines: lineCount,
                startLine,
                totalLines,
            },
        }
    }
}

function validateEstimatedContentTokens(
    content: string,
    maxTokens: number,
): void {
    const tokenCount = estimateTokensFromText(content)
    if (tokenCount > maxTokens) {
        throw new Error(
            `File content (${tokenCount} estimated tokens) exceeds maximum allowed estimated tokens (${maxTokens}). Use offset and limit to read specific portions of the file.`,
        )
    }
}

function normalizeReadCacheRange(
    offset: number,
    limit: number | undefined,
): { offset: number | undefined; limit: number | undefined } {
    if (offset <= 1 && limit === undefined) {
        return { offset: undefined, limit: undefined }
    }

    return { offset, limit }
}

export class FileTooLargeError extends Error {
    constructor(
        public sizeInBytes: number,
        public maxSizeBytes: number,
    ) {
        super(
            `File content (${formatFileSize(sizeInBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). Use offset and limit to read specific portions of the file.`,
        )
        this.name = 'FileTooLargeError'
    }
}

export async function readFileInRange(
    filePath: string,
    offset = 0,
    maxLines?: number,
    maxBytes?: number,
    signal?: AbortSignal,
): Promise<ReadFileRangeResult> {
    signal?.throwIfAborted()

    const stats = await stat(filePath)

    if (stats.isDirectory()) {
        throw new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`)
    }

    if (maxBytes !== undefined && stats.size > maxBytes) {
        throw new FileTooLargeError(stats.size, maxBytes)
    }

    const raw = await readFile(filePath, { encoding: 'utf8', signal })
    signal?.throwIfAborted()

    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const lines = text.split('\n').map(line =>
        line.endsWith('\r') ? line.slice(0, -1) : line,
    )

    const end = maxLines === undefined ? undefined : offset + maxLines
    const selectedLines = lines.slice(offset, end)
    const content = selectedLines.join('\n')

    return {
        content,
        lineCount: selectedLines.length,
        totalLines: lines.length,
        totalBytes: Buffer.byteLength(text, 'utf8'),
        readBytes: Buffer.byteLength(content, 'utf8'),
        mtimeMs: stats.mtimeMs,
    }
}

export function formatContentWithLineNumbers(
    content: string,
    startLine: number,
): string {
    const lines = content.split('\n')

    if (lines.length > 0 && lines[lines.length - 1] === '' && content.endsWith('\n')) {
        lines.pop()
    }

    return lines.map((line, index) => `${startLine + index}\t${line}`).join('\n')
}



export default FileRead;









