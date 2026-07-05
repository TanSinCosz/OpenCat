import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { executeToolCall } from "../src/Tools/executor.js";
import type { Tool } from "../src/Tools/types.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("executeToolCall returns a tool result when a tool is unavailable", async () => {
  const state = createState();
  const runtime = createRuntime({
    cwd: process.cwd(),
    agentId: "agent_explore_test",
    agentRole: "subagent",
    agentType: "Explore",
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 128,
    },
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
    tools: [createNoopTool("Read")],
  });

  const result = await executeToolCall(
    {
      id: "call_missing_edit",
      type: "function",
      function: {
        name: "Edit",
        arguments: "{}",
      },
    },
    runtime.tools,
    runtime,
    state,
  );

  assert.equal(result.role, "tool");
  assert.equal(result.tool_call_id, "call_missing_edit");
  assert.match(result.content, /Tool unavailable: Edit/);
  assert.match(result.content, /does not have permission/);
  assert.match(result.content, /Available tools for this agent: Read/);
});

test("executeToolCall returns a permission-denied tool result", async () => {
  const state = createState();
  const runtime = createRuntime({
    cwd: process.cwd(),
    agentId: "agent_session_test",
    agentRole: "session",
    agentType: "session_memory",
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 128,
    },
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
    tools: [createNoopTool("Edit")],
    canUseTool: () => ({
      behavior: "deny",
      message: "Session memory agent may only edit its notes file.",
    }),
  });

  const result = await executeToolCall(
    {
      id: "call_denied_edit",
      type: "function",
      function: {
        name: "Edit",
        arguments: "{}",
      },
    },
    runtime.tools,
    runtime,
    state,
  );

  assert.equal(result.role, "tool");
  assert.equal(result.tool_call_id, "call_denied_edit");
  assert.match(result.content, /Permission denied for tool Edit/);
  assert.match(result.content, /only edit its notes file/);
});

function createNoopTool(name: string): Tool {
  return {
    name,
    inputSchema: z.object({}),
    outputSchema: z.object({
      ok: z.boolean(),
    }),
    description: () => `${name} test tool`,
    prompt: () => `${name} test prompt`,
    call: () => ({ ok: true }),
  };
}

function createMemoryConfig() {
  return {
    embedder: {
      provider: "test",
      config: {},
    },
    vectorStore: {
      provider: "test",
      config: {},
    },
    llm: {
      provider: "test",
      config: {},
    },
  };
}
