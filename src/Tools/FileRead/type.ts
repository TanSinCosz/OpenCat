import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { semanticNumber } from "../utils/semanticNumber.js";

export const PDF_MAX_PAGES_PER_READ = 20;

export const inputSchema = lazySchema(() =>
    z.strictObject({
        file_path: z.string().describe('The absolute path to the file to read'),
        offset: semanticNumber(z.number().int().nonnegative().optional()).describe(
            'The line number to start reading from. Only provide if the file is too large to read at once',
        ),
        limit: semanticNumber(z.number().int().positive().optional()).describe(
            'The number of lines to read. Only provide if the file is too large to read at once.',
        ),
        // pages: z
        //     .string()
        //     .optional()
        //     .describe(
        //         `Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
        //     ),
    }),
)
export const outputSchema = lazySchema(() =>
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
)

