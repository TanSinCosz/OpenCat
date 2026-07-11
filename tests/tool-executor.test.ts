import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { Bash } from "../src/Tools/Bash/Bash.js";
import { executeToolCall } from "../src/Tools/executor.js";
import { FileRead } from "../src/Tools/FileRead/FileRead.js";
import { Glob } from "../src/Tools/Glob/Glob.js";
import { Grep } from "../src/Tools/Grep/Grep.js";
import { MemorySearch } from "../src/Tools/MemorySearch/MemorySearch.js";
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

test("executeToolCall uses model-facing formatted tool results", async () => {
  const state = createState();
  const runtime = createRuntime({
    cwd: process.cwd(),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 128,
    },
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
    tools: [
      {
        name: "Edit",
        inputSchema: z.object({}),
        outputSchema: z.object({
          filePath: z.string(),
          originalFile: z.string(),
        }),
        description: () => "Edit test tool",
        prompt: () => "Edit test prompt",
        call: () => ({
          filePath: "large.ts",
          originalFile: "x".repeat(20_000),
        }),
        formatResult: ({ output }) =>
          `The file ${output.filePath} has been updated successfully.`,
      } satisfies Tool<Record<string, never>, {
        filePath: string;
        originalFile: string;
      }>,
    ],
  });

  const result = await executeToolCall(
    {
      id: "call_formatted_edit",
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
  assert.equal(result.tool_call_id, "call_formatted_edit");
  assert.equal(
    result.content,
    "The file large.ts has been updated successfully.",
  );
  assert.doesNotMatch(result.content, /x{100}/);
});

test("built-in formatResult methods return model-facing text", () => {
  assert.equal(
    new Bash().formatResult?.({
      output: {
        stdout: "ok",
        stderr: "",
        interrupted: false,
      },
    }),
    "stdout:\nok",
  );

  assert.equal(
    new FileRead().formatResult?.({
      output: {
        type: "text",
        file: {
          filePath: "src/main.ts",
          content: "1\tconsole.log('ok')",
          numLines: 1,
          startLine: 1,
          totalLines: 10,
        },
      },
    }),
    "src/main.ts (lines 1-1 of 10):\n1\tconsole.log('ok')",
  );

  assert.equal(
    new Glob().formatResult?.({
      output: {
        durationMs: 3,
        numFiles: 2,
        filenames: ["src/a.ts", "src/b.ts"],
        truncated: false,
      },
    }),
    "src/a.ts\nsrc/b.ts\n\nFound 2 file(s) in 3ms.",
  );

  assert.equal(
    new Grep().formatResult?.({
      output: {
        mode: "content",
        numFiles: 0,
        filenames: [],
        content: "src/a.ts:1:needle",
        numLines: 1,
      },
    }),
    "src/a.ts:1:needle\n\nReturned 1 matching line(s).",
  );

  assert.match(
    new MemorySearch().formatResult?.({
      output: {
        results: [
          {
            id: "mem_1",
            memory: "User prefers concise answers.",
            score: 0.75,
          },
        ],
      },
    }) ?? "",
    /1\. \[mem_1 score=0\.750\] User prefers concise answers\./,
  );
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
