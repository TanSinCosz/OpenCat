import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { Bash } from "../src/Tools/Bash/Bash.js";
import { executeToolCall } from "../src/Tools/executor.js";
import { FileRead } from "../src/Tools/FileRead/FileRead.js";
import { Glob } from "../src/Tools/Glob/Glob.js";
import { Grep } from "../src/Tools/Grep/Grep.js";
import { MemorySearch } from "../src/Tools/MemorySearch/MemorySearch.js";
import type { MemoryTool } from "../src/Memory/Memory.js";
import type { SearchMemoryOptions } from "../src/Memory/type.js";
import type { Tool } from "../src/Tools/types.js";
import { expandPath } from "../src/Tools/utils/path.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("executeToolCall runs tools with the runtime working directory", async () => {
  const runtimeCwd = await mkdtemp(join(tmpdir(), "opencat-tool-cwd-"));
  const runtime = createRuntime({
    cwd: runtimeCwd,
    modelRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 128,
    },
    transcriptStore: false,
    tools: [{
      name: "CwdProbe",
      inputSchema: z.object({}),
      outputSchema: z.object({ cwd: z.string() }),
      description: () => "Report the active working directory.",
      prompt: () => "Report the active working directory.",
      call: () => ({ cwd: expandPath("relative.txt") }),
      formatResult: ({ output }) => output.cwd,
    } satisfies Tool<Record<string, never>, { cwd: string }>],
  });

  const result = await executeToolCall(
    {
      id: "call_cwd_probe",
      type: "function",
      function: {
        name: "CwdProbe",
        arguments: "{}",
      },
    },
    runtime.tools,
    runtime,
    createState(),
  );

  assert.equal(result.content, join(runtimeCwd, "relative.txt"));
});

test("executeToolCall returns a tool result when a tool is unavailable", async () => {
  const state = createState();
  const runtime = createRuntime({
    cwd: process.cwd(),
    agentId: "agent_explore_test",
    agentRole: "subagent",
    agentType: "Explore",
    modelRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 128,
    },
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
    modelRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 128,
    },
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

test("executeToolCall allows tools granted by temporary command rules", async () => {
  const state = createState();
  const runtime = createRuntime({
    cwd: process.cwd(),
    modelRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 128,
    },
    transcriptStore: false,
    tools: [createNoopTool("Edit")],
    permissionContext: {
      mode: "default",
      alwaysAllowRules: {
        command: ["Edit"],
      },
    },
    canUseTool: () => ({
      behavior: "deny",
      message: "ordinary permission callback was bypassed",
    }),
  });

  const result = await executeToolCall(
    {
      id: "call_allowed_edit",
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
  assert.equal(result.tool_call_id, "call_allowed_edit");
  assert.equal(result.content, "{\"ok\":true}");
});

test("executeToolCall cannot bypass a hard fork policy with temporary rules", async () => {
  const state = createState();
  const runtime = createRuntime({
    cwd: process.cwd(),
    modelRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 128,
    },
    transcriptStore: false,
    tools: [createNoopTool("Edit")],
    enforceCanUseToolBeforeTemporaryRules: true,
    permissionContext: {
      mode: "default",
      alwaysAllowRules: {
        command: ["Edit"],
      },
    },
    canUseTool: () => ({
      behavior: "deny",
      message: "hard fork policy denied Edit",
    }),
  });

  const result = await executeToolCall(
    {
      id: "call_hard_denied_edit",
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

  assert.match(result.content, /hard fork policy denied Edit/);
});

test("executeToolCall uses model-facing formatted tool results", async () => {
  const state = createState();
  const runtime = createRuntime({
    cwd: process.cwd(),
    modelRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 128,
    },
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

test("legacy MemorySearch preserves scope, threshold and lazy service ownership", async () => {
  const calls: Array<{ query: string; options: SearchMemoryOptions }> = [];
  const memory = {
    async search(query: string, options: SearchMemoryOptions) {
      calls.push({ query, options });
      return { results: [] };
    },
  } as unknown as MemoryTool;
  const runtime = createRuntime({
    modelRuntimeConfig: { apiKey: "test-key", model: "test-model", maxTokens: 128 },
    longTermMemoryConfig: {
      enabled: true, searchThreshold: 0.42,
      userId: "memory-user", agentId: "memory-agent", runId: "memory-run",
    },
    legacyMemory: memory,
    transcriptStore: false,
    tools: [new MemorySearch()],
  });

  for (const scope of ["user", "agent", "run"] as const) {
    await executeToolCall({
      id: `search-${scope}`, type: "function",
      function: { name: "MemorySearch", arguments: JSON.stringify({ query: "remembered decision", scope }) },
    }, runtime.tools, runtime, createState());
  }
  assert.deepEqual(calls.map((call) => call.options.filters), [
    { user_id: "memory-user" }, { agent_id: "memory-agent" }, { run_id: "memory-run" },
  ]);
  assert.ok(calls.every((call) => call.query === "remembered decision" && call.options.topK === 8 && call.options.threshold === 0.42));
  assert.equal(runtime.legacyMemory, memory);

  await executeToolCall({
    id: "search-custom", type: "function",
    function: { name: "MemorySearch", arguments: JSON.stringify({ query: "custom", topK: 11, threshold: 0.7 }) },
  }, runtime.tools, runtime, createState());
  assert.equal(calls.at(-1)?.options.topK, 11);
  assert.equal(calls.at(-1)?.options.threshold, 0.7);
});

test("disabled legacy search needs no vector configuration or service", async () => {
  const runtime = createRuntime({
    modelRuntimeConfig: { apiKey: "test-key", model: "test-model", maxTokens: 128 },
    longTermMemoryConfig: { enabled: false },
    transcriptStore: false,
  });
  const output = await new MemorySearch().call(
    { query: "unused" }, runtime.toolUseContext, runtime, createState(),
  );
  assert.deepEqual(output, { results: [] });
  assert.equal(runtime.legacyMemory, undefined);
  assert.equal(runtime.legacyMemoryConfig, undefined);
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
