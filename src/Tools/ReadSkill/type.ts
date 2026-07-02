import { z } from "zod";

export const inputSchema = () =>
  z.strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Name of the discovered skill to read."),
    path: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Exact SKILL.md path from dynamic skill metadata, used as a fallback when name is unavailable."),
  }).refine((input) => Boolean(input.name || input.path), {
    message: "Provide either name or path.",
  });

export const outputSchema = () =>
  z.object({
    name: z.string(),
    description: z.string(),
    skillDir: z.string().optional(),
    skillPath: z.string().optional(),
    content: z.string(),
    truncated: z.boolean(),
    note: z.string().optional(),
  });
