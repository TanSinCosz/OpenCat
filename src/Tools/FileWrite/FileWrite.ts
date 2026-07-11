import { FILE_WRITE_TOOL_NAME } from "./prompt.js";
import { Tool, ToolUseContext } from "../types.js";
import { outputSchema, inputSchema } from "./type.js";
import { z } from "zod";
import { getWriteToolDescription } from "./prompt.js";
import { expandPath } from "../utils/path.js";

import { discoverSkillsForReadPath } from "../utils/discoverSkillsForReadPath.js";
import { getFileModificationTimeAsync } from "../utils/fileState.js";

import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'


type typeInput = z.infer<ReturnType<typeof inputSchema>>;
type typeOutput = z.infer<ReturnType<typeof outputSchema>>;

type ValidationResult =
    | { result: true }
    | { result: false; message: string; errorCode?: number };

type PreparedEdit =
    | {
        ok: true;
        absoluteFilePath: string;
        originalFileContents: string;
        actualOldString: string;
        replaceAll: boolean;
    }
    | {
        ok: false;
        message: string;
    };

export class FileWrite implements Tool<typeInput, typeOutput, typeof inputSchema, typeof outputSchema> {

    name = FILE_WRITE_TOOL_NAME;
    searchHint = 'create or overwrite files';
    maxResultSizeChars = 100_000;
    strict = true;
    async description() {
        return 'Write a file to the local filesystem.'
    };
    async prompt() {
        return getWriteToolDescription()
    };
    inputSchema = inputSchema;
    outputSchema = outputSchema;
    isConcurrencySafe(): boolean {
        return false;
    }

    formatResult({ output }: { output: typeOutput }): string {
        if (output.type === 'create') {
            return `The file ${output.filePath} has been created successfully.`
        }

        return `The file ${output.filePath} has been updated successfully.`
    }

    async validateInput(
        { file_path }: typeInput,
        context: ToolUseContext,
    ): Promise<ValidationResult> {
        const absoluteFilePath = expandPath(file_path)

        const exists = await pathExists(absoluteFilePath)
        if (!exists) {
            return { result: true }
        }

        const lastRead = context.readFileState.get(absoluteFilePath)
        if (!lastRead || lastRead.isPartialView) {
            return {
                result: false,
                message: 'File has not been read yet. Read it first before writing to it.',
                errorCode: 2,
            }
        }

        const currentTimestamp = await getFileModificationTimeAsync(absoluteFilePath)

        if (currentTimestamp > lastRead.timestamp) {
            return {
                result: false,
                message:
                    'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
                errorCode: 3,
            }
        }

        return { result: true }
    }

    async call(
        { file_path, content }: typeInput,
        context: ToolUseContext,
    ): Promise<typeOutput> {
        const absoluteFilePath = expandPath(file_path)

        await discoverSkillsForReadPath(absoluteFilePath, context)

        const originalFile = await readTextFileOrNull(absoluteFilePath)

        if (originalFile !== null) {
            const lastRead = context.readFileState.get(absoluteFilePath)

            if (!lastRead || lastRead.isPartialView) {
                throw new Error(
                    'File has not been read yet. Read it first before writing to it.',
                )
            }

            const currentTimestamp = await getFileModificationTimeAsync(absoluteFilePath)

            if (currentTimestamp > lastRead.timestamp) {
                throw new Error(
                    'File has been modified since read. Read it again before writing.',
                )
            }
        }

        await writeTextFile(absoluteFilePath, content)

        const timestamp = await getFileModificationTimeAsync(absoluteFilePath)

        context.readFileState.set(absoluteFilePath, {
            content,
            timestamp,
            offset: undefined,
            limit: undefined,
        })

        return {
            type: originalFile === null ? 'create' : 'update',
            filePath: file_path,
            content,
            structuredPatch:
                originalFile === null
                    ? []
                    : [
                        {
                            oldStart: 1,
                            oldLines: originalFile.split('\n').length,
                            newStart: 1,
                            newLines: content.split('\n').length,
                            lines: [],
                        },
                    ],
            originalFile,
        }
    }
}


async function pathExists(filePath: string): Promise<boolean> {
    try {
        await readFile(filePath)
        return true
    } catch (error) {
        if (isENOENT(error)) {
            return false
        }

        throw error
    }
}

async function readTextFileOrNull(filePath: string): Promise<string | null> {
    try {
        return await readFile(filePath, 'utf8')
    } catch (error) {
        if (isENOENT(error)) {
            return null
        }

        throw error
    }
}

async function writeTextFile(
    filePath: string,
    content: string,
): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, 'utf8')
}

function isENOENT(error: unknown): boolean {
    return (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
    )
}
