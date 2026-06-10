import fs from "fs/promises";
import type { z } from "zod";

import type { Tool } from "../types.js";
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

type typeInput = z.infer<ReturnType<typeof inputSchema>>;
type typeOutput = z.infer<ReturnType<typeof outputSchema>>;

const FILE_READ_MAX_SIZE_BYTES = 256 * 1024
const FILE_READ_MAX_TOKENS = 25000

export class FileRead implements Tool<typeInput, typeOutput> {
    name = FILE_READ_TOOL_NAME;
    input_schema = inputSchema;
    max_result_size_chars = Infinity;
    strict = true;
    search_hint = "read files";
    should_defer = false;
    always_load = true;

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

    is_enabled(): boolean {
        return true;
    }

    user_facing_name(): string {
        return "Read";
    }

    is_concurrency_safe(): boolean {
        return true;
    }

    async call(input: typeInput): Promise<typeOutput> {


    }
}




async function callInner(
    file_path: string,
    fullFilePath: string,
    resolvedFilePath: string,
    ext: string,
    offset: number,
    limit: number | undefined,
    maxSizeBytes: number,
    maxTokens: number,
    readFileState: ToolUseContext['readFileState'],
    context: ToolUseContext,
    messageId: string | undefined,
): Promise<{
    data: typeOutput
    newMessages?: ReturnType<typeof createUserMessage>[]
}> {
    const lineOffset = offset === 0 ? 0 : offset - 1
    const { content, lineCount, totalLines, totalBytes, readBytes, mtimeMs } =
        await readFileInRange(
            resolvedFilePath,
            lineOffset,
            limit,
            limit === undefined ? maxSizeBytes : undefined,
            context.abortController.signal,
        )

    await validateContentTokens(content, ext, maxTokens)

    readFileState.set(fullFilePath, {
        content,
        timestamp: Math.floor(mtimeMs),
        offset,
        limit,
    })
    context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

    // Snapshot before iterating — a listener that unsubscribes mid-callback
    // would splice the live array and skip the next listener.
    for (const listener of fileReadListeners.slice()) {
        listener(resolvedFilePath, content)
    }

    const data = {
        type: 'text' as const,
        file: {
            filePath: file_path,
            content,
            numLines: lineCount,
            startLine: offset,
            totalLines,
        },
    }
    if (isAutoMemFile(fullFilePath)) {
        memoryFileMtimes.set(data, mtimeMs)
    }

    logFileOperation({
        operation: 'read',
        tool: 'FileReadTool',
        filePath: fullFilePath,
        content,
    })

    const sessionFileType = detectSessionFileType(fullFilePath)
    const analyticsExt = getFileExtensionForAnalytics(fullFilePath)
    logEvent('tengu_session_file_read', {
        totalLines,
        readLines: lineCount,
        totalBytes,
        readBytes,
        offset,
        ...(limit !== undefined && { limit }),
        ...(analyticsExt !== undefined && { ext: analyticsExt }),
        ...(messageId !== undefined && {
            messageID:
                messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        is_session_memory: sessionFileType === 'session_memory',
        is_session_transcript: sessionFileType === 'session_transcript',
    })

    return { data }
}

export default FileRead;
