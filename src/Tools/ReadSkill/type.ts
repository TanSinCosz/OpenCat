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
    args: z
      .string()
      .trim()
      .optional()
      .describe("Optional task details for a forked skill. Use this to tell the forked skill what to do."),
  }).refine((input) => Boolean(input.name || input.path), {
    message: "Provide either name or path.",
  });

export const outputSchema = () =>
  z.object({
    name: z.string(),
    description: z.string(),
    skillDir: z.string().optional(),
    skillPath: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    status: z.enum(["inline", "forked"]).optional(),
    agentId: z.string().optional(),
    content: z.string(),
    truncated: z.boolean(),
    note: z.string().optional(),
  });
