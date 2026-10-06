import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import { executeToolCall } from "../src/Tools/executor.js";
import {
  closeMcpConnections,
  connectMcpStreamableHttpServer,
} from "../src/mcp/index.js";
import { createStreamRequest } from "../src/query/request.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("MCP streamable HTTP server supports bearer auth", async () => {
  const requests: Array<{ authorization?: string; sessionId?: string; method?: string }> = [];
  const server = createServer(async (request, response) => {
    await handleFakeMcpHttpRequest(request, response, requests);
  });
  await listen(server);

  const address = server.address();
  assert.ok(address && typeof address === "object");

  const connection = await connectMcpStreamableHttpServer({
    name: "remote",
    url: `http://127.0.0.1:${address.port}/mcp`,
    auth: {
      type: "bearer",
      token: "test-token",
    },
  });

  try {
    assert.equal(connection.tools.length, 1);
    assert.equal(connection.tools[0]?.name, "remote__echo");
    assert.ok(requests.every((item) => item.authorization === "Bearer test-token"));
    assert.ok(requests.some((item) => item.sessionId === "session-1"));

    const state = createState();
    const runtime = createRuntime({
      modelRuntimeConfig: {
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        maxTokens: 1024,
      },
      tools: connection.tools,
      mcpConnections: [connection],
    });

    const streamRequest = await createStreamRequest(runtime, []);
    assert.equal(streamRequest.tools?.[0]?.function.name, "remote__echo");

    const toolResult = await executeToolCall(
      {
        id: "call_1",
        type: "function",
        function: {
          name: "remote__echo",
          arguments: JSON.stringify({ text: "hello" }),
        },
      },
      runtime.tools,
      runtime,
      state,
    );

    assert.equal(toolResult.role, "tool");
    assert.match(toolResult.content, /remote:hello/);
  } finally {
    closeMcpConnections([connection]);
    await closeServer(server);
  }
});

async function handleFakeMcpHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: Array<{ authorization?: string; sessionId?: string; method?: string }>,
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/mcp") {
    response.writeHead(404).end();
    return;
  }

  const message = JSON.parse(await readRequestBody(request));
  requests.push({
    authorization: request.headers.authorization,
    sessionId: request.headers["mcp-session-id"] as string | undefined,
    method: message.method,
  });

  if (request.headers.authorization !== "Bearer test-token") {
    response.writeHead(401).end("missing bearer token");
    return;
  }

  if (message.method === "notifications/initialized") {
    response.writeHead(202).end();
    return;
  }

  response.setHeader("content-type", "application/json");

  if (message.method === "initialize") {
    response.setHeader("mcp-session-id", "session-1");
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-http-mcp", version: "1.0.0" },
      },
    }));
    return;
  }

  if (message.method === "tools/list") {
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo input text",
            inputSchema: {
              type: "object",
              properties: {
                text: { type: "string" },
              },
              required: ["text"],
              additionalProperties: false,
            },
          },
        ],
      },
    }));
    return;
  }

  if (message.method === "tools/call") {
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          {
            type: "text",
            text: `remote:${message.params.arguments.text}`,
          },
        ],
      },
    }));
    return;
  }

  response.end(JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32601,
      message: "Method not found",
    },
  }));
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
