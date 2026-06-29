import { z } from "zod";

const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((domain) => !domain.includes("*"), {
    message: "Domain filters do not support wildcards.",
  });

export const inputSchema = () =>
  z
    .strictObject({
      query: z
        .string()
        .trim()
        .min(2)
        .max(1_000)
        .describe("The web search query."),
      allowed_domains: z
        .array(domainSchema)
        .max(20)
        .optional()
        .describe("Only include results from these domains."),
      blocked_domains: z
        .array(domainSchema)
        .max(20)
        .optional()
        .describe("Exclude results from these domains."),
    })
    .refine(
      (input) =>
        !(input.allowed_domains?.length && input.blocked_domains?.length),
      {
        message:
          "allowed_domains and blocked_domains cannot be used together.",
      },
    );

export const outputSchema = () =>
  z.object({
    query: z.string(),
    results: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
      }),
    ),
    summary: z.string(),
    durationSeconds: z.number(),
    searchRequests: z.number(),
    filteredOutCount: z.number(),
    errors: z.array(z.string()).optional(),
  });

