import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";
import type { Tool } from "../src/Tools/types.js";

test("large tool results stay inline until group budget selects them", async () => {
  const largeOutput = `header\n${"x".repeat(4_096)}\nfooter`;
  const streamRequests: DeepSeekStreamRequest[] = [];
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-tool-result-store-")),
    sessionId: "session_tool_result_store_test",
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: createToolCallClient(streamRequests),
    MemoryConfig: createMemoryConfig(),
    tools: [createLargeOutputTool(largeOutput)],
  });
  const state = createState();
  const events = [];

  for await (const event of query(runtime, state, { maxTurns: 2 })) {
    events.push(event);
  }

  const toolMessage = state.Messages.find(
    (message) => message.role === "tool",
  );

  assert.ok(toolMessage);
  assert.equal(toolMessage.persistedToolResult, undefined);
  assert.equal(toolMessage.content, largeOutput);

  const transcriptRaw = await readFile(runtime.transcriptStore!.path, "utf8");
  assert.match(transcriptRaw, /footer/);
  assert.equal(streamRequests.length, 2);
  assert.equal(events.at(-1)?.type, "done");
});

function createLargeOutputTool(
  output: string,
  maxResultSizeChars?: number,
): Tool {
  return {
    name: "LargeOutput",
    inputSchema: z.object({}),
    outputSchema: z.string(),
    ...(maxResultSizeChars !== undefined ? { maxResultSizeChars } : {}),
    async description() {
      return "Return a large output";
    },
    async prompt() {
      return "";
    },
    call() {
      return output;
    },
  };
}

function createToolCallClient(
  streamRequests: DeepSeekStreamRequest[],
): DeepSeekClient {
  let streamCount = 0;

  return {
    async create(_input: DeepSeekCreateRequest): Promise<DeepSeekChatCompletionResponse> {
      throw new Error("create is not used in this test");
    },
    async *stream(input: DeepSeekStreamRequest) {
      streamRequests.push(input);
      streamCount++;

      if (streamCount === 1) {
        yield toolCallChunk("tool_call_large", "LargeOutput", {});
        yield doneChunk();
        return;
      }

      yield textChunk("done");
      yield doneChunk();
    },
    async collectStream(): Promise<never> {
      throw new Error("collectStream is not used in this test");
    },
  };
}

function toolCallChunk(
  id: string,
  name: string,
  input: Record<string, unknown>,
): DeepSeekStreamEnvelope {
  return {
    raw: "tool_call",
    done: false,
    chunk: {
      id: "assistant-tool-call",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-pro",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify(input),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  };
}

function textChunk(text: string): DeepSeekStreamEnvelope {
  return {
    raw: text,
    done: false,
    chunk: {
      id: "assistant-chunk",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-pro",
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

function doneChunk(): DeepSeekStreamEnvelope {
  return {
    chunk: null,
    raw: "[DONE]",
    done: true,
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
