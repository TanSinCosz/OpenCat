import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";

import type { DeepSeekClient } from "../src/deepseek/client.js";
import type {
  DeepSeekChatCompletionResponse,
  DeepSeekCreateRequest,
  DeepSeekStreamEnvelope,
  DeepSeekStreamRequest,
} from "../src/deepseek/types.js";
import { query } from "../src/query.js";
import type { Tool } from "../src/Tools/types.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("query runs consecutive concurrency-safe tools in parallel", async () => {
  const log: string[] = [];
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-tool-concurrency-safe-")),
    sessionId: "session_tool_concurrency_safe",
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: createToolCallClient([
      createToolCall(0, "call_safe_a", "SafeA"),
      createToolCall(1, "call_safe_b", "SafeB"),
    ]),
    MemoryConfig: createMemoryConfig(),
    tools: [
      createTimingTool("SafeA", true, log),
      createTimingTool("SafeB", true, log),
    ],
  });

  for await (const _event of query(runtime, createState(), { maxTurns: 1 })) {
    // Consume the stream.
  }

  assert.deepEqual(log, [
    "SafeA:start",
    "SafeB:start",
    "SafeA:end",
    "SafeB:end",
  ]);
});

test("query treats non-concurrency-safe tools as execution barriers", async () => {
  const log: string[] = [];
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-tool-concurrency-barrier-")),
    sessionId: "session_tool_concurrency_barrier",
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: createToolCallClient([
      createToolCall(0, "call_safe_a", "SafeA"),
      createToolCall(1, "call_unsafe", "Unsafe"),
      createToolCall(2, "call_safe_b", "SafeB"),
    ]),
    MemoryConfig: createMemoryConfig(),
    tools: [
      createTimingTool("SafeA", true, log),
      createTimingTool("Unsafe", false, log),
      createTimingTool("SafeB", true, log),
    ],
  });

  for await (const _event of query(runtime, createState(), { maxTurns: 1 })) {
    // Consume the stream.
  }

  assert.deepEqual(log, [
    "SafeA:start",
    "SafeA:end",
    "Unsafe:start",
    "Unsafe:end",
    "SafeB:start",
    "SafeB:end",
  ]);
});

function createTimingTool(
  name: string,
  concurrencySafe: boolean,
  log: string[],
): Tool {
  return {
    name,
    inputSchema: z.object({}),
    outputSchema: z.string(),
    async description() {
      return `${name} timing tool`;
    },
    async prompt() {
      return "";
    },
    isConcurrencySafe() {
      return concurrencySafe;
    },
    async call() {
      log.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      log.push(`${name}:end`);
      return `${name} done`;
    },
  };
}

function createToolCall(
  index: number,
  id: string,
  name: string,
): DeepSeekStreamEnvelope["chunk"] extends infer _Chunk
  ? NonNullable<NonNullable<DeepSeekStreamEnvelope["chunk"]>["choices"][number]["delta"]["tool_calls"]>[number]
  : never {
  return {
    index,
    id,
    type: "function",
    function: {
      name,
      arguments: "{}",
    },
  };
}

function createToolCallClient(
  toolCalls: NonNullable<NonNullable<DeepSeekStreamEnvelope["chunk"]>["choices"][number]["delta"]["tool_calls"]>,
): DeepSeekClient {
  return {
    async create(_input: DeepSeekCreateRequest): Promise<DeepSeekChatCompletionResponse> {
      throw new Error("create is not used in this test");
    },
    async *stream(_input: DeepSeekStreamRequest) {
      yield {
        raw: "tool_calls",
        done: false,
        chunk: {
          id: "assistant-tool-calls",
          object: "chat.completion.chunk",
          created: 0,
          model: "deepseek-v4-pro",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: toolCalls,
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      };
      yield {
        chunk: null,
        raw: "[DONE]",
        done: true,
      };
    },
    async collectStream(): Promise<never> {
      throw new Error("collectStream is not used in this test");
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
