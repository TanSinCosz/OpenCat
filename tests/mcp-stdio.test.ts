import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeToolCall } from "../src/Tools/executor.js";
import {
  closeMcpStdioConnections,
  connectMcpStdioServer,
} from "../src/mcp/index.js";
import { createStreamRequest } from "../src/query/request.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("MCP stdio server tools are listed, exposed, and callable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-mcp-stdio-"));
  const serverPath = join(cwd, "fake-mcp-server.mjs");
  await writeFile(serverPath, createFakeMcpServerSource(), "utf8");

  const connection = await connectMcpStdioServer({
    name: "fake",
    command: process.execPath,
    args: [serverPath],
    cwd,
  });

  try {
    assert.equal(connection.tools.length, 1);
    assert.equal(connection.tools[0]?.name, "fake__echo");

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

    const request = await createStreamRequest(runtime, []);
    assert.equal(request.tools?.[0]?.function.name, "fake__echo");
    assert.deepEqual(request.tools?.[0]?.function.parameters, {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    });

    const toolResult = await executeToolCall(
      {
        id: "call_1",
        type: "function",
        function: {
          name: "fake__echo",
          arguments: JSON.stringify({ text: "hello" }),
        },
      },
      runtime.tools,
      runtime,
      state,
    );

    assert.equal(toolResult.role, "tool");
    assert.equal(toolResult.tool_call_id, "call_1");
    assert.match(toolResult.content, /echo:hello/);
  } finally {
    closeMcpStdioConnections([connection]);
  }
});

function createFakeMcpServerSource(): string {
  return `
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

rl.on("line", line => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0.0" }
      }
    });
    return;
  }

  if (message.method === "notifications/initialized") {
    return;
  }

  if (message.method === "tools/list") {
    send({
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo input text",
            inputSchema: {
              type: "object",
              properties: {
                text: { type: "string" }
              },
              required: ["text"],
              additionalProperties: false
            }
          }
        ]
      }
    });
    return;
  }

  if (message.method === "tools/call") {
    send({
      id: message.id,
      result: {
        content: [
          {
            type: "text",
            text: "echo:" + message.params.arguments.text
          }
        ]
      }
    });
    return;
  }

  send({
    id: message.id,
    error: {
      code: -32601,
      message: "Method not found"
    }
  });
});
`;
}
