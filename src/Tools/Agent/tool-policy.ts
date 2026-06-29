import type { Tool, Tools } from "../types.js";
import type { AgentDefinition } from "./definitions.js";

export type ResolvedAgentTools = {
  hasWildcard: boolean;
  validTools: string[];
  invalidTools: string[];
  resolvedTools: Tools;
};

const READ_ONLY_TOOL_NAMES = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
]);

const VERIFY_TOOL_NAMES = new Set([
  ...READ_ONLY_TOOL_NAMES,
  "Bash",
]);

const WRITING_TOOL_NAMES = new Set([
  "Edit",
  "Write",
]);

const ALL_SUBAGENT_DISALLOWED_TOOL_NAMES = new Set([
  "Agent",
]);

const ASYNC_AGENT_DISALLOWED_TOOL_NAMES = new Set([
  "Agent",
]);

const READ_ONLY_AGENT_CATEGORIES = new Set([
  "explore",
  "plan",
  "verify",
]);

function parseToolSpec(spec: string): string {
  return spec.trim().replace(/\(.+\)$/, "");
}

function isMcpTool(tool: Tool): boolean {
  return tool.name.startsWith("mcp__");
}

function isReadOnlyAgent(agentDefinition: AgentDefinition): boolean {
  return READ_ONLY_AGENT_CATEGORIES.has(agentDefinition.category);
}

function isToolAllowedByDefault(
  tool: Tool,
  agentDefinition: AgentDefinition,
  isAsync: boolean,
): boolean {
  if (isMcpTool(tool)) {
    return true;
  }

  if (ALL_SUBAGENT_DISALLOWED_TOOL_NAMES.has(tool.name)) {
    return false;
  }

  if (isAsync && ASYNC_AGENT_DISALLOWED_TOOL_NAMES.has(tool.name)) {
    return false;
  }

  if (agentDefinition.category === "verify") {
    return VERIFY_TOOL_NAMES.has(tool.name) && !WRITING_TOOL_NAMES.has(tool.name);
  }

  if (isReadOnlyAgent(agentDefinition)) {
    return READ_ONLY_TOOL_NAMES.has(tool.name) && !WRITING_TOOL_NAMES.has(tool.name);
  }

  return true;
}

/**
 * Resolve the concrete tool list visible to a child agent.
 *
 * This mirrors the official shape: first remove tools that subagents should not
 * receive globally, then apply the agent definition's allow/deny list. Built-in
 * read-only agents get a conservative default even when their definition omits
 * an explicit `tools` list.
 */
export function resolveAgentTools(
  agentDefinition: AgentDefinition,
  availableTools: readonly Tool[],
  options: { isAsync?: boolean; isFork?: boolean } = {},
): ResolvedAgentTools {
  if (options.isFork) {
    return {
      hasWildcard: true,
      validTools: [],
      invalidTools: [],
      resolvedTools: availableTools,
    };
  }

  const isAsync = options.isAsync ?? false;
  const filteredAvailableTools = availableTools.filter((tool) =>
    isToolAllowedByDefault(tool, agentDefinition, isAsync),
  );
  const availableByName = new Map(
    filteredAvailableTools.map((tool) => [tool.name, tool]),
  );
  const denied = new Set(
    (agentDefinition.disallowedTools ?? []).map(parseToolSpec),
  );
  const allowedAvailableTools = filteredAvailableTools.filter(
    (tool) => !denied.has(tool.name),
  );

  const toolSpecs = agentDefinition.tools;
  const hasWildcard =
    !toolSpecs ||
    toolSpecs.length === 0 ||
    toolSpecs.includes("*");

  if (hasWildcard) {
    return {
      hasWildcard: true,
      validTools: [],
      invalidTools: [],
      resolvedTools: allowedAvailableTools,
    };
  }

  const validTools: string[] = [];
  const invalidTools: string[] = [];
  const resolvedTools: Tool[] = [];
  const seen = new Set<string>();

  for (const spec of toolSpecs) {
    const toolName = parseToolSpec(spec);
    const tool = availableByName.get(toolName);
    if (!tool || denied.has(tool.name)) {
      invalidTools.push(spec);
      continue;
    }

    validTools.push(spec);
    if (!seen.has(tool.name)) {
      resolvedTools.push(tool);
      seen.add(tool.name);
    }
  }

  return {
    hasWildcard: false,
    validTools,
    invalidTools,
    resolvedTools,
  };
}
