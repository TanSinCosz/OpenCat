export const PLAN_TOOL_NAME = "Plan";

export const DESCRIPTION =
  "Switch between planning-only mode and normal execution mode.";

export function renderPlanPrompt(): string {
  return [
    "Use this tool to control planning-only mode and submit a completed plan for user approval.",
    "",
    "Plan mode:",
    "- Use action: enter before risky, broad, or multi-file work when the user needs to approve the approach first.",
    "- In plan mode, you may inspect context and update TodoWrite, but write-like tools are blocked.",
    "- After you have a concrete plan, call this tool with action: request_approval and include the plan. This sends the plan to the UI for user approval.",
    "- Do not attempt Write, Edit, Bash, Agent, MemorySave, or SendMessage while waiting for plan approval.",
    "",
    "Default mode:",
    "- Approval of request_approval switches the agent back to default mode.",
    "- Use action: exit only when the user explicitly instructs you to leave plan mode without the approval flow.",
    "- After exiting plan mode, continue using TodoWrite to track execution progress when useful.",
  ].join("\n");
}
