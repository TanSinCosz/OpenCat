import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DeepSeekClient } from "../src/deepseek/client.js";
import type {
  DeepSeekStreamEnvelope,
  DeepSeekStreamRequest,
} from "../src/deepseek/types.js";
import {
  executeToolCall,
  executeToolCallWithMetadata,
} from "../src/Tools/executor.js";
import { Plan } from "../src/Tools/Plan/Plan.js";
import { FileWrite } from "../src/Tools/FileWrite/FileWrite.js";
import { query } from "../src/query.js";
import type { QueryEvent, ToolPermissionDecision } from "../src/query/types.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";
import { createMessage } from "../src/types/messages.js";
import type { CanUseToolFn } from "../src/Tools/types.js";

test("Plan switches between plan and default mode", async () => {
  const state = createState();
  const runtime = createTestRuntime([new Plan()]);
  const tool = new Plan();

  const entered = await tool.call(
    {
      action: "enter",
      plan: "Inspect files, then propose the patch.",
    },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(entered.oldMode, "default");
  assert.equal(entered.newMode, "plan");
  assert.equal(state.mode, "plan");
  assert.equal(
    runtime.toolUseContext.getAppState().toolPermissionContext.mode,
    "plan",
  );

  const exited = await tool.call(
    { action: "exit" },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(exited.oldMode, "plan");
  assert.equal(exited.newMode, "default");
  assert.equal(state.mode, "default");
});

test("plan mode blocks write-like tools before custom permissions", async () => {
  const state = createState({ mode: "plan" });
  const runtime = createTestRuntime([new FileWrite()], {
    canUseToolCalled: () => {
      throw new Error("custom permission should not run for plan-mode denial");
    },
  });

  const result = await executeToolCall(
    {
      id: "call_write_in_plan",
      type: "function",
      function: {
        name: "Write",
        arguments: JSON.stringify({
          file_path: "example.txt",
          content: "hello",
        }),
      },
    },
    runtime.tools,
    runtime,
    state,
  );

  assert.equal(result.role, "tool");
  assert.match(result.content, /Permission denied for tool Write/);
  assert.match(result.content, /Current mode is plan/);

  const metadataResult = await executeToolCallWithMetadata(
    {
      id: "call_write_in_plan_metadata",
      type: "function",
      function: {
        name: "Write",
        arguments: JSON.stringify({
          file_path: "example.txt",
          content: "hello",
        }),
      },
    },
    runtime.tools,
    runtime,
    state,
  );

  assert.match(
    metadataResult.permissionDenied?.reason ?? "",
    /Current mode is plan/,
  );
});

test("query can approve a submitted plan and exit plan mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-plan-approve-"));
  const state = createState({
    mode: "plan",
    messages: [createMessage({ role: "user", content: "make a plan" })],
  });
  const client = createToolThenFinalClient({
    toolName: "Plan",
    toolArguments: {
      action: "request_approval",
      plan: "1. Inspect files\n2. Apply patch\n3. Run tests",
    },
  });
  const runtime = createTestRuntime([new Plan()], {
    cwd,
    deepSeekClient: client,
  });
  const events: QueryEvent[] = [];

  for await (
    const event of query(runtime, state, {
      maxTurns: 2,
      requestToolPermission: async () => ({ behavior: "allow" }),
    })
  ) {
    events.push(event);
  }

  assert.ok(events.some((event) => event.type === "tool_permission_request"));
  assert.equal(state.mode, "default");
  assert.ok(!events.some((event) => event.type === "tool_permission"));
});

test("query can deny a submitted plan and stay in plan mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-plan-deny-"));
  const state = createState({
    mode: "plan",
    messages: [createMessage({ role: "user", content: "make a plan" })],
  });
  const client = createToolThenFinalClient({
    toolName: "Plan",
    toolArguments: {
      action: "request_approval",
      plan: "1. Inspect files\n2. Apply patch\n3. Run tests",
    },
  });
  const runtime = createTestRuntime([new Plan()], {
    cwd,
    deepSeekClient: client,
  });
  const events: QueryEvent[] = [];

  for await (
    const event of query(runtime, state, {
      maxTurns: 2,
      requestToolPermission: async (): Promise<ToolPermissionDecision> => ({
        behavior: "deny",
        reason: "Denied in test.",
      }),
    })
  ) {
    events.push(event);
  }

  assert.ok(events.some((event) => event.type === "tool_permission_request"));
  assert.equal(state.mode, "plan");
  assert.ok(
    events.some((event) =>
      event.type === "tool_permission" && /Denied in test/.test(event.reason)
    ),
  );
  assert.ok(
    state.Messages.some((message) =>
      message.role === "tool" &&
      typeof message.content === "string" &&
      message.content.includes("Denied in test.")
    ),
  );
});

test("query blocks write-like tools in plan mode without requesting approval", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-plan-block-write-"));
  const state = createState({
    mode: "plan",
    messages: [createMessage({ role: "user", content: "write it" })],
  });
  const client = createToolThenFinalClient({
    toolName: "Write",
    toolArguments: {
      file_path: join(cwd, "blocked.txt"),
      content: "blocked",
    },
  });
  const runtime = createTestRuntime([new FileWrite()], {
    cwd,
    deepSeekClient: client,
  });
  const events: QueryEvent[] = [];

  for await (
    const event of query(runtime, state, {
      maxTurns: 2,
      requestToolPermission: async () => ({ behavior: "allow" }),
    })
  ) {
    events.push(event);
  }

  assert.ok(!events.some((event) => event.type === "tool_permission_request"));
  assert.ok(events.some((event) => event.type === "tool_permission"));
  assert.equal(state.mode, "plan");
});

function createTestRuntime(
  tools: Parameters<typeof createRuntime>[0]["tools"],
  options: {
    canUseToolCalled?: () => never;
    cwd?: string;
    deepSeekClient?: DeepSeekClient;
  } = {},
) {
  const canUseTool: CanUseToolFn | undefined = options.canUseToolCalled
    ? () => {
      options.canUseToolCalled!();
      return { behavior: "allow" };
    }
    : undefined;

  return createRuntime({
    sessionId: "session_plan_tool",
    cwd: options.cwd ?? process.cwd(),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 128,
    },
    MemoryConfig: {
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
    },
    transcriptStore: false,
    tools,
    deepSeekClient: options.deepSeekClient,
    ...(canUseTool ? { canUseTool } : {}),
  });
}

function createToolThenFinalClient(options: {
  toolName: string;
  toolArguments: unknown;
}): DeepSeekClient {
  let requestCount = 0;

  return {
    async create() {
      throw new Error("create should not be used");
    },
    async *stream(_input: DeepSeekStreamRequest) {
      requestCount++;
      if (requestCount === 1) {
        yield createToolCallChunk(options.toolName, options.toolArguments);
      } else {
        yield createAssistantTextChunk("done");
      }
      yield {
        chunk: null,
        raw: "[DONE]",
        done: true,
      };
    },
    async collectStream() {
      throw new Error("collectStream should not be used");
    },
  };
}

function createToolCallChunk(
  toolName: string,
  toolArguments: unknown,
): DeepSeekStreamEnvelope {
  return {
    raw: "tool",
    done: false,
    chunk: {
      id: "chunk_tool",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-flash",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "call_write",
            type: "function",
            function: {
              name: toolName,
              arguments: JSON.stringify(toolArguments),
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
    },
  };
}

function createAssistantTextChunk(text: string): DeepSeekStreamEnvelope {
  return {
    raw: text,
    done: false,
    chunk: {
      id: "chunk_text",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-flash",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          content: text,
        },
        finish_reason: "stop",
      }],
    },
  };
}
