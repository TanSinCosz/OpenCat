import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DeepSeekClient } from "../src/deepseek/client.js";
import type {
  DeepSeekCreateRequest,
  DeepSeekStreamEnvelope,
  DeepSeekStreamRequest,
} from "../src/deepseek/types.js";
import { query } from "../src/query.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("query continues reasoning through beta prefix before forcing final answer", async () => {
  const previousRounds = process.env.OPENCAT_REASONING_CONTINUATION_ROUNDS;
  process.env.OPENCAT_REASONING_CONTINUATION_ROUNDS = "2";

  try {
    const streamRequests: DeepSeekStreamRequest[] = [];
    const client: DeepSeekClient = {
      async create(_input: DeepSeekCreateRequest) {
        throw new Error("create is not used in this test");
      },
      async *stream(input) {
        streamRequests.push(input);

        if (streamRequests.length <= 3) {
          yield createReasoningLengthChunk(`reasoning-${streamRequests.length}`);
        } else {
          yield createContentChunk("final solution");
        }

        yield {
          raw: "[DONE]",
          done: true,
          chunk: null,
        };
      },
      async collectStream() {
        throw new Error("collectStream is not used in this test");
      },
    };
    const state = createState({
      messages: [
        createMessage({
          role: "user",
          content: "solve a hard combinatorics problem",
        }),
      ],
    });
    const runtime = createRuntime({
      cwd: await mkdtemp(join(tmpdir(), "opencat-reasoning-continuation-")),
      deepSeekRuntimeConfig: {
        apiKey: "test-key",
        baseUrl: "https://api.deepseek.com/beta",
        model: "deepseek-v4-pro",
        maxTokens: 1024,
        reasoningEffort: "max",
      },
      deepSeekClient: client,
      MemoryConfig: createMemoryConfig(),
      tools: [],
    });

    const continuationEvents = [];
    for await (const event of query(runtime, state, { maxTurns: 1 })) {
      if (event.type === "reasoning_continuation") {
        continuationEvents.push(event);
      }
    }

    assert.equal(streamRequests.length, 4);
    const firstContinuationPrefix = lastAssistantRequestMessage(
      streamRequests[1]!,
    );
    const secondContinuationPrefix = lastAssistantRequestMessage(
      streamRequests[2]!,
    );
    const finalAnswerPrefix = lastAssistantRequestMessage(streamRequests[3]!);

    assert.equal(firstContinuationPrefix.prefix, true);
    assert.equal(
      firstContinuationPrefix.reasoning_content,
      "reasoning-1",
    );
    assert.equal(
      secondContinuationPrefix.reasoning_content,
      "reasoning-1\n\nreasoning-2",
    );
    assert.equal(finalAnswerPrefix.content, "Final answer:\n");
    assert.equal(
      finalAnswerPrefix.reasoning_content,
      "reasoning-1\n\nreasoning-2\n\nreasoning-3",
    );
    assert.deepEqual(
      continuationEvents.map((event) => event.phase),
      ["continue_reasoning", "continue_reasoning", "force_final_answer"],
    );
    const finalMessage = state.Messages.at(-1);
    assert.ok(finalMessage);
    assert.equal(finalMessage.role, "assistant");
    assert.equal(finalMessage.content, "final solution");
    assert.equal(
      finalMessage.reasoning_content,
      "reasoning-1\n\nreasoning-2\n\nreasoning-3",
    );
  } finally {
    if (previousRounds === undefined) {
      delete process.env.OPENCAT_REASONING_CONTINUATION_ROUNDS;
    } else {
      process.env.OPENCAT_REASONING_CONTINUATION_ROUNDS = previousRounds;
    }
  }
});

function lastAssistantRequestMessage(request: DeepSeekStreamRequest) {
  const message = request.messages.at(-1);
  assert.ok(message);
  if (message.role !== "assistant") {
    throw new Error(`Expected assistant message, got ${message.role}`);
  }
  return message;
}

function createReasoningLengthChunk(reasoning: string): DeepSeekStreamEnvelope {
  return {
    raw: reasoning,
    done: false,
    chunk: {
      id: "reasoning-length",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-pro",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_content: reasoning,
          },
          finish_reason: "length",
        },
      ],
    },
  };
}

function createContentChunk(content: string): DeepSeekStreamEnvelope {
  return {
    raw: content,
    done: false,
    chunk: {
      id: "assistant-content",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-pro",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        },
      ],
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
