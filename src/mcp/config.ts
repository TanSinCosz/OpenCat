import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { createAgentDefinitions } from "../Tools/Agent/index.js";
import { createDefaultTools } from "../Tools/index.js";
import type { Tools } from "../Tools/types.js";
import {
  connectMcpStdioServers,
  connectMcpStreamableHttpServers,
  type McpConnection,
} from "./index.js";
import type {
  McpStdioServerConfig,
  McpStreamableHttpServerConfig,
} from "./types.js";

export type McpConfigFile = {
  mcpServers?: Record<string, Omit<McpStdioServerConfig, "name">>;
  stdio?: McpStdioServerConfig[];
  http?: McpStreamableHttpServerConfig[];
};

export type LoadedMcpConfig = {
  stdio: McpStdioServerConfig[];
  http: McpStreamableHttpServerConfig[];
  path?: string;
};

export async function createToolsWithConfiguredMcp(
  cwd = process.cwd(),
): Promise<{
  tools: Tools;
  mcpConnections: McpConnection[];
}> {
  const agentDefinitions = createAgentDefinitions();
  const defaultTools = createDefaultTools({ agentDefinitions });
  const mcpConnections = await connectConfiguredMcpServers(cwd);
  const mcpTools = mcpConnections.flatMap((connection) => connection.tools);

  return {
    tools: [...defaultTools, ...mcpTools],
    mcpConnections,
  };
}

export async function connectConfiguredMcpServers(
  cwd = process.cwd(),
): Promise<McpConnection[]> {
  const config = loadMcpConfig(cwd);
  const [stdioConnections, httpConnections] = await Promise.all([
    connectMcpStdioServers(config.stdio),
    connectMcpStreamableHttpServers(config.http),
  ]);

  return [...stdioConnections, ...httpConnections];
}

export function loadMcpConfig(cwd = process.cwd()): LoadedMcpConfig {
  const configPath = resolveMcpConfigPath(cwd);
  if (!configPath || !existsSync(configPath)) {
    return { stdio: [], http: [] };
  }

  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as McpConfigFile;
  const stdio: McpStdioServerConfig[] = [];

  for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
    stdio.push(normalizeStdioServerConfig({ name, ...server }, cwd));
  }

  for (const server of parsed.stdio ?? []) {
    stdio.push(normalizeStdioServerConfig(server, cwd));
  }

  const http = (parsed.http ?? []).map((server) => ({
    ...server,
    name: server.name.trim(),
  }));

  return { stdio, http, path: configPath };
}

function resolveMcpConfigPath(cwd: string): string | undefined {
  const explicit = process.env.OPENCAT_MCP_CONFIG?.trim();
  if (explicit) {
    return path.resolve(cwd, explicit);
  }

  return path.join(cwd, ".opencat", "mcp.json");
}

function normalizeStdioServerConfig(
  server: McpStdioServerConfig,
  cwd: string,
): McpStdioServerConfig {
  return {
    ...server,
    name: server.name.trim(),
    cwd: server.cwd ? path.resolve(cwd, server.cwd) : cwd,
  };
}
