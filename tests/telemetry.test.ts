import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { OpenAICompatibleClient } from "../src/openai-compatible/model-client.js";
import type {
  ModelCreateRequest,
  ModelStreamEnvelope,
  ModelUsage,
} from "../src/openai-compatible/types.js";
import { query } from "../src/query.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";
import type { EvaluationEvent, RunObserver } from "../src/types/index.js";

test("query emits minimal telemetry events when an observer is configured", async () => {
  const events: EvaluationEvent[] = [];
  const observer: RunObserver = {
    emit(event) {
      events.push(event);
    },
  };
  const state = createState({
    messages: [
      createMessage({
        role: "user",
        content: "Say OK.",
      }),
    ],
  });
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-telemetry-")),
    modelRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      maxTokens: 1024,
    },
    modelClient: createTextClient("OK"),
    longTermMemoryConfig: {
      enabled: false,
    },
    tools: [],
    observer,
  });

  for await (const _event of query(runtime, state, { maxTurns: 1 })) {
    // Drain the query stream; assertions use the observer output.
  }

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "query_started",
      "context_ready",
      "model_stream_started",
      "model_usage",
      "assistant_message",
      "turn_finished",
      "session_memory_update_finished",
      "long_term_memory_extracted",
      "query_finished",
    ],
  );
  assert.ok(events.every((event) => event.sessionId === runtime.sessionId));
  assert.ok(events.every((event) => event.agentId === "main"));
  assert.equal(
    events.find((event) => event.type === "assistant_message")?.assistantTextChars,
    2,
  );
  assert.equal(
    events.find((event) => event.type === "context_ready")?.messageCount,
    3,
  );
  const usageEvent = events.find((event) => event.type === "model_usage");
  assert.equal(usageEvent?.promptTokens, 100);
  assert.equal(usageEvent?.promptCacheHitTokens, 70);
  assert.equal(usageEvent?.promptCacheMissTokens, 30);
  assert.equal(runtime.usage.totalTokens, 108);
  assert.equal(runtime.usage.promptCacheHitTokens, 70);
});

function createTextClient(content: string): OpenAICompatibleClient {
  return {
    async create(_input: ModelCreateRequest) {
      throw new Error("create is not used in this test");
    },
    async *stream() {
      yield createContentChunk(content);
      yield createUsageChunk({
        prompt_tokens: 100,
        completion_tokens: 8,
        total_tokens: 108,
        prompt_cache_hit_tokens: 70,
        prompt_cache_miss_tokens: 30,
      });
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
}

function createUsageChunk(usage: ModelUsage): ModelStreamEnvelope {
  return {
    raw: JSON.stringify({ usage }),
    done: false,
    chunk: {
      id: "assistant-usage",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-pro",
      choices: [],
      usage,
    },
  };
}

function createContentChunk(content: string): ModelStreamEnvelope {
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
