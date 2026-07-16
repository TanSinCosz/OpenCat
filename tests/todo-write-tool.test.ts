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
import { TodoWrite } from "../src/Tools/TodoWrite/TodoWrite.js";
import { query } from "../src/query.js";
import { createProjectionContextStateMessage } from "../src/query/runtime-context.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";
import { createMessage } from "../src/types/messages.js";

test("TodoWrite stores the current agent todo list", async () => {
  const state = createState();
  const runtime = createRuntime({
    sessionId: "session_todo_write",
    agentId: "main",
    cwd: await mkdtemp(join(tmpdir(), "opencat-todo-write-")),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: createNoopClient(),
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
  });
  const tool = new TodoWrite();

  const output = await tool.call({
    todos: [
      {
        content: "Inspect relevant files",
        activeForm: "Inspecting relevant files",
        status: "in_progress",
      },
      {
        content: "Run focused tests",
        activeForm: "Running focused tests",
        status: "pending",
      },
    ],
  }, runtime.toolUseContext, runtime, state);

  assert.deepEqual(output.oldTodos, []);
  assert.equal(output.newTodos.length, 2);
  assert.equal(state.todos.main?.[0]?.status, "in_progress");
  assert.match(tool.formatResult({ output }), /Todo list updated: 2 items/);
});

test("query projects todo list context and replaces stale todo blocks", async () => {
  const streamRequests: DeepSeekStreamRequest[] = [];
  const client: DeepSeekClient = {
    async create() {
      throw new Error("create should not be used");
    },
    async *stream(input) {
      streamRequests.push(input);
      yield createAssistantChunk("done");
      yield {
        chunk: null,
        raw: "[DONE]",
        done: true,
      };
    },
    async collectStream() {
      throw new Error("collectStream is not used");
    },
  };
  const oldTodoContext = createProjectionContextStateMessage([
    {
      source: "todo_list",
      content: "<todo_list>\nOLD_STALE_TODO\n</todo_list>",
    },
  ]);
  assert.ok(oldTodoContext);

  const state = createState({
    messages: [
      createMessage({ role: "user", content: "continue the task" }),
      oldTodoContext,
    ],
    todos: {
      main: [
        {
          content: "Implement TodoWrite",
          activeForm: "Implementing TodoWrite",
          status: "in_progress",
        },
      ],
    },
  });
  const runtime = createRuntime({
    sessionId: "session_todo_projection",
    agentId: "main",
    cwd: await mkdtemp(join(tmpdir(), "opencat-todo-projection-")),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: client,
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
  });

  for await (const _event of query(runtime, state, { maxTurns: 1 })) {
    // Drain query events.
  }

  assert.equal(streamRequests.length, 1);
  const requestText = streamRequests[0]!.messages
    .map((message) => typeof message.content === "string" ? message.content : "")
    .join("\n");
  assert.match(requestText, /<context_block source="todo_list">/);
  assert.match(requestText, /Implement TodoWrite/);
  assert.doesNotMatch(requestText, /OLD_STALE_TODO/);
});

function createAssistantChunk(text: string): DeepSeekStreamEnvelope {
  return {
    raw: text,
    done: false,
    chunk: {
      id: "assistant-chunk",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-flash",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: text,
          },
          finish_reason: "stop",
        },
      ],
    },
  };
}

function createNoopClient(): DeepSeekClient {
  return {
    async create() {
      throw new Error("create should not be used");
    },
    async *stream() {
      throw new Error("stream should not be used");
    },
    async collectStream() {
      throw new Error("collectStream should not be used");
    },
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
