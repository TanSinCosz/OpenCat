import { z } from "zod";

import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import type { Tool, ToolUseContext } from "../Tools/types.js";
import { McpStreamableHttpClient } from "./http-client.js";
import { McpStdioClient } from "./stdio-client.js";
import type {
  McpClient,
  McpStreamableHttpServerConfig,
  McpStdioServerConfig,
  McpToolCallResult,
  McpToolDefinition,
} from "./types.js";

export type McpConnection = {
  client: McpClient;
  tools: Tool[];
};

export async function connectMcpStdioServer(
  config: McpStdioServerConfig,
): Promise<McpConnection> {
  const client = new McpStdioClient(config);
  await client.connect();

  return createMcpConnection(config.name, client);
}

export async function connectMcpStdioServers(
  configs: readonly McpStdioServerConfig[],
): Promise<McpConnection[]> {
  return Promise.all(configs.map((config) => connectMcpStdioServer(config)));
}

export async function connectMcpStreamableHttpServer(
  config: McpStreamableHttpServerConfig,
): Promise<McpConnection> {
  const client = new McpStreamableHttpClient(config);
  await client.connect();

  return createMcpConnection(config.name, client);
}

export async function connectMcpStreamableHttpServers(
  configs: readonly McpStreamableHttpServerConfig[],
): Promise<McpConnection[]> {
  return Promise.all(
    configs.map((config) => connectMcpStreamableHttpServer(config)),
  );
}

export function closeMcpConnections(
  connections: readonly McpConnection[],
): void {
  for (const connection of connections) {
    connection.client.close();
  }
}

export const closeMcpStdioConnections = closeMcpConnections;

async function createMcpConnection(
  serverName: string,
  client: McpClient,
): Promise<McpConnection> {
  const result = await client.listTools();
  const tools = result.tools.map((tool) =>
    new McpToolAdapter(serverName, client, tool),
  );

  return { client, tools };
}

class McpToolAdapter implements Tool<Record<string, unknown>, McpToolCallResult> {
  readonly name: string;
  readonly inputSchema = z.record(z.string(), z.unknown());
  readonly outputSchema = z.unknown();
  readonly maxResultSizeChars = 100_000;
  readonly strict = false;

  constructor(
    private readonly serverName: string,
    private readonly client: McpClient,
    private readonly definition: McpToolDefinition,
  ) {
    this.name = createMcpToolName(serverName, definition.name);
  }

  get inputJsonSchema() {
    return this.definition.inputSchema;
  }

  description(): string {
    return [
      `[MCP:${this.serverName}] ${this.definition.description ?? this.definition.name}`,
      `Original MCP tool name: ${this.definition.name}`,
    ].join("\n");
  }

  prompt(): string {
    return this.description();
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  call(
    input: Record<string, unknown>,
    _context: ToolUseContext,
    _runtime: Runtime,
    _state: State,
  ): Promise<McpToolCallResult> {
    return this.client.callTool(this.definition.name, input);
  }
}

function createMcpToolName(serverName: string, toolName: string): string {
  return sanitizeToolName(`${serverName}__${toolName}`);
}

function sanitizeToolName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return /^[a-zA-Z_]/.test(sanitized) ? sanitized : `mcp_${sanitized}`;
}
