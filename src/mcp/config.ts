import path from "node:path";
import { getAppConfig, type AppConfig } from "../config/load-config.js";
import { createAgentDefinitions } from "../Tools/Agent/index.js";
import { createDefaultTools } from "../Tools/index.js";
import type { Tools } from "../Tools/types.js";
import { connectMcpStdioServers, connectMcpStreamableHttpServers, type McpConnection } from "./index.js";
import type { McpStdioServerConfig, McpStreamableHttpServerConfig } from "./types.js";

export type LoadedMcpConfig = {
  stdio: McpStdioServerConfig[];
  http: McpStreamableHttpServerConfig[];
  path?: string;
};

export async function createToolsWithConfiguredMcp(cwd = process.cwd(), config = getAppConfig()): Promise<{
  tools: Tools; mcpConnections: McpConnection[];
}> {
  const agentDefinitions = createAgentDefinitions();
  const defaultTools = createDefaultTools({ agentDefinitions });
  const mcpConnections = await connectConfiguredMcpServers(cwd, config);
  return { tools: [...defaultTools, ...mcpConnections.flatMap((connection) => connection.tools)], mcpConnections };
}

export async function connectConfiguredMcpServers(cwd = process.cwd(), appConfig = getAppConfig()): Promise<McpConnection[]> {
  const config = loadMcpConfig(cwd, appConfig);
  const [stdio, http] = await Promise.all([
    connectMcpStdioServers(config.stdio), connectMcpStreamableHttpServers(config.http),
  ]);
  return [...stdio, ...http];
}

/** MCP is part of the application YAML; never search a task worktree for another config. */
export function loadMcpConfig(cwd = process.cwd(), config: AppConfig = getAppConfig()): LoadedMcpConfig {
  return {
    stdio: config.mcp.stdio.map((server) => ({
      ...server, cwd: server.cwd ? path.resolve(cwd, server.cwd) : cwd,
      args: server.args ? [...server.args] : undefined,
      env: server.env ? { ...server.env } : undefined,
    })),
    http: config.mcp.http.map((server) => ({ ...server })),
    path: config.configPath,
  };
}
