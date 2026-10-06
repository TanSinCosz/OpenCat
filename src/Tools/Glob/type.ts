import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

export const inputSchema = lazySchema(() =>
    z.strictObject({
        pattern: z.string().describe('The glob pattern to match files against'),
        path: z
            .string()
            .optional()
            .describe(
                'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
            ),
    }),
)

export const outputSchema = lazySchema(() =>
    z.object({
        durationMs: z
            .number()
            .describe('Time taken to execute the search in milliseconds'),
        numFiles: z.number().describe('Total number of files found'),
        filenames: z
            .array(z.string())
            .describe('Array of file paths that match the pattern'),
        truncated: z
            .boolean()
            .describe('Whether results were truncated (limited to 100 files)'),
    }),
)