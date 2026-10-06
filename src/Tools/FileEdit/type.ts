import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { semanticBoolean } from "../utils/semanticBoolean.js";

export const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('The absolute path to the file to modify'),
    old_string: z.string().describe('The text to replace'),
    new_string: z
      .string()
      .describe(
        'The text to replace it with (must be different from old_string)',
      ),
    replace_all: semanticBoolean(
      z.boolean().default(false).optional(),
    ).describe('Replace all occurrences of old_string (default false)'),
  }),
)

export type FileEdit = {
  old_string: string
  new_string: string
  replace_all: boolean
}

export const hunkSchema = lazySchema(() =>
  z.object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  }),
)

export const gitDiffSchema = lazySchema(() =>
  z.object({
    filename: z.string(),
    status: z.enum(['modified', 'added']),
    additions: z.number(),
    deletions: z.number(),
    changes: z.number(),
    patch: z.string(),
    repository: z
      .string()
      .nullable()
      .optional()
      .describe('GitHub owner/repo when available'),
  }),
)

export const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string().describe('The file path that was edited'),
    oldString: z.string().describe('The original string that was replaced'),
    newString: z.string().describe('The new string that replaced it'),
    originalFile: z
      .string()
      .describe('The original file contents before editing'),
    structuredPatch: z
      .array(hunkSchema())
      .describe('Diff patch showing the changes'),
    userModified: z
      .boolean()
      .describe('Whether the user modified the proposed changes'),
    replaceAll: z.boolean().describe('Whether all occurrences were replaced'),
    gitDiff: gitDiffSchema().optional(),
  }),
)
