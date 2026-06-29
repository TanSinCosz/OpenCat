import { FILE_EDIT_TOOL_NAME } from "./prompt.js";
import { Tool, ToolUseContext } from "../types.js";
import { outputSchema, inputSchema } from "./type.js";
import { z } from "zod";
import { getEditToolDescription } from "./prompt.js";
import { expandPath } from "../utils/path.js";

import { discoverSkillsForReadPath } from "../utils/discoverSkillsForReadPath.js";
import { getFileModificationTimeAsync } from "../utils/fileState.js";
import { createStructuredPatch } from "../utils/patch.js";

import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'


type typeInput = z.infer<ReturnType<typeof inputSchema>>;
type typeOutput = z.infer<ReturnType<typeof outputSchema>>;

type ValidationResult =
    | { result: true }
    | { result: false; message: string };

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

export class FileEdit implements Tool<typeInput, typeOutput, typeof inputSchema, typeof outputSchema> {

    name = FILE_EDIT_TOOL_NAME;
    searchHint = 'modify file contents in place';
    maxResultSizeChars = 100_000;
    strict = true;
    async description() {
        return 'A tool for editing files'
    };
    async prompt() {
        return getEditToolDescription()
    };
    inputSchema = inputSchema;
    outputSchema = outputSchema;
    isConcurrencySafe(): boolean {
        return false;
    }

    async validateInput(
        input: typeInput,
        context: ToolUseContext,
    ): Promise<ValidationResult> {
        const prepared = await prepareEdit(input, context)
        if ('message' in prepared) {
            return { result: false, message: prepared.message }
        }

        return { result: true }
    }

    async call(input: typeInput, context: ToolUseContext): Promise<typeOutput> {
        const { file_path, new_string } = input
        const prepared = await prepareEdit(input, context)

        if ('message' in prepared) {
            throw new Error(prepared.message)
        }

        await discoverSkillsForReadPath(prepared.absoluteFilePath, context)

        const updatedFile = prepared.replaceAll
            ? prepared.originalFileContents.replaceAll(prepared.actualOldString, new_string)
            : prepared.originalFileContents.replace(prepared.actualOldString, new_string)

        await writeTextFile(prepared.absoluteFilePath, updatedFile)

        const timestamp = await getFileModificationTimeAsync(prepared.absoluteFilePath)
        context.readFileState.set(prepared.absoluteFilePath, {
            content: updatedFile,
            timestamp,
            offset: undefined,
            limit: undefined,
        })

        return {
            filePath: file_path,
            oldString: prepared.actualOldString,
            newString: new_string,
            originalFile: prepared.originalFileContents,
            structuredPatch: createStructuredPatch(
                file_path,
                prepared.originalFileContents,
                updatedFile,
            ),
            userModified: false,
            replaceAll: prepared.replaceAll,
        }
    }
}

async function prepareEdit(
    input: typeInput,
    context: ToolUseContext,
): Promise<PreparedEdit> {
    const { file_path, old_string, new_string, replace_all = false } = input
    const absoluteFilePath = expandPath(file_path)

    if (old_string === new_string) {
        return {
            ok: false,
            message: 'old_string and new_string are the same.',
        }
    }

    const originalFileContents = await readTextFileOrNull(absoluteFilePath)

    if (originalFileContents === null) {
        if (old_string === '') {
            return {
                ok: true,
                absoluteFilePath,
                originalFileContents: '',
                actualOldString: '',
                replaceAll: replace_all,
            }
        }

        return {
            ok: false,
            message: `File does not exist: ${file_path}`,
        }
    }

    if (old_string === '' && originalFileContents.trim() !== '') {
        return {
            ok: false,
            message: 'Cannot create new file - file already exists.',
        }
    }

    const lastRead = context.readFileState.get(absoluteFilePath)
    if (!lastRead || lastRead.isPartialView) {
        return {
            ok: false,
            message: 'File has not been read yet. Read it first before editing.',
        }
    }

    const lastWriteTime = await getFileModificationTimeAsync(absoluteFilePath)
    if (lastWriteTime > lastRead.timestamp) {
        return {
            ok: false,
            message: 'File has been modified since read. Read it again before editing.',
        }
    }

    const actualOldString = findActualString(originalFileContents, old_string)

    if (actualOldString === null) {
        return {
            ok: false,
            message: `String to replace not found in file.\nString: ${old_string}`,
        }
    }

    const matches = actualOldString === ''
        ? 1
        : originalFileContents.split(actualOldString).length - 1

    if (matches > 1 && !replace_all) {
        return {
            ok: false,
            message: `Found ${matches} matches of the string to replace, but replace_all is false.`,
        }
    }

    return {
        ok: true,
        absoluteFilePath,
        originalFileContents,
        actualOldString,
        replaceAll: replace_all,
    }
}



export async function readTextFileOrNull(filePath: string): Promise<string | null> {
    try {
        return await readFile(filePath, 'utf8')
    } catch (error) {
        if (isENOENT(error)) {
            return null
        }

        throw error
    }
}

export async function readTextFileOrEmpty(filePath: string): Promise<string> {
    return (await readTextFileOrNull(filePath)) ?? ''
}

export function findActualString(
    fileContent: string,
    oldString: string,
): string | null {
    if (oldString === '') {
        return ''
    }

    if (fileContent.includes(oldString)) {
        return oldString
    }

    // 模型常常给 \n，但 Windows 文件里可能是 \r\n
    const crlfOldString = oldString.replaceAll('\n', '\r\n')
    if (crlfOldString !== oldString && fileContent.includes(crlfOldString)) {
        return crlfOldString
    }

    // 反过来也兼容一下：模型给 \r\n，但文件里是 \n
    const lfOldString = oldString.replaceAll('\r\n', '\n')
    if (lfOldString !== oldString && fileContent.includes(lfOldString)) {
        return lfOldString
    }

    return null
}

export async function writeTextFile(
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
