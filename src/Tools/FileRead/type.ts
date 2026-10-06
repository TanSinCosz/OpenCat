import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { semanticNumber } from "../utils/semanticNumber.js";

export const inputSchema = lazySchema(() =>
    z.strictObject({
        file_path: z.string().describe('The absolute path to the file to read'),
        offset: semanticNumber(z.number().int().nonnegative().optional()).describe(
            'The line number to start reading from. Only provide if the file is too large to read at once',
        ),
        limit: semanticNumber(z.number().int().positive().optional()).describe(
            'The number of lines to read. Only provide if the file is too large to read at once.',
        ),

    }),
)
export const outputSchema = lazySchema(() =>
    z.discriminatedUnion('type', [
        z.object({
            type: z.literal('text'),
            file: z.object({
                filePath: z.string().describe('The path to the file that was read'),
                content: z.string().describe('The content of the file'),
                numLines: z
                    .number()
                    .describe('Number of lines in the returned content'),
                startLine: z.number().describe('The starting line number'),
                totalLines: z.number().describe('Total number of lines in the file'),
            }),
        }),
        z.object({
            type: z.literal('file_unchanged'),
            file: z.object({
                filePath: z.string().describe('The path to the unchanged file'),
            }),
        }),
    ]),
)
export type ReadFileRangeResult = {
  content: string
  lineCount: number
  totalLines: number
  totalBytes: number
  readBytes: number
  mtimeMs: number
  /** true when output was clipped to maxBytes under truncate mode */
  truncatedByBytes?: boolean
}
