import { z } from "zod";

export const planActionSchema = () =>
  z.enum(["enter", "request_approval", "exit"]);

export const inputSchema = () =>
  z.strictObject({
    action: planActionSchema().describe(
      "Use enter to switch into plan mode, request_approval to submit a completed plan for user approval, or exit only when explicitly instructed.",
    ),
    plan: z
      .string()
      .optional()
      .describe("The concise plan or reason for the mode change. Required for request_approval."),
  }).superRefine((input, context) => {
    if (input.action === "request_approval" && !input.plan?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["plan"],
        message: "plan is required when action is request_approval.",
      });
    }
  });

export const outputSchema = () =>
  z.object({
    oldMode: z.enum(["default", "plan"]),
    newMode: z.enum(["default", "plan"]),
    message: z.string(),
    plan: z.string().optional(),
  });
