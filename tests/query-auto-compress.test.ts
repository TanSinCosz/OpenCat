import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
import { createMessage } from "../src/types/messages.js";

test("query auto-compresses oversized projections with session memory before model request", async () => {
  const createRequests: DeepSeekCreateRequest[] = [];
  const streamRequests: DeepSeekStreamRequest[] = [];
  const client: DeepSeekClient = {
    async create(input) {
      createRequests.push(input);
      return createSessionMemoryResponse();
    },
    async *stream(input) {
      streamRequests.push(input);
      yield createAssistantChunk("compressed request accepted");
      yield {
        chunk: null,
        raw: "[DONE]",
        done: true,
      };
    },
    async collectStream() {
      throw new Error("collectStream is not used in this test");
    },
  };
  const state = createState({
    messages: createLargeConversation(),
  });
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-auto-compress-")),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: client,
    MemoryConfig: createMemoryConfig(),
    messages: state.Messages,
  });

  const events = [];
  for await (const event of query(runtime, state, { maxTurns: 1 })) {
    events.push(event);
  }

  assert.equal(createRequests.length, 1);
  assert.equal(streamRequests.length, 1);
  assert.equal(state.sessionMemory.status, "ready");
  assert.equal(state.autoCompress.summaries.length, 1);
  assert.ok(state.autoCompress.activeSummaryId);

  const sessionMemoryRaw = await readFile(
    join(runtime.cwd, ".opencat", "session-memory", `${runtime.sessionId}.json`),
    "utf8",
  );
  const persistedSessionMemory = JSON.parse(sessionMemoryRaw);
  assert.equal(persistedSessionMemory.sessionId, runtime.sessionId);
  assert.equal(persistedSessionMemory.state.status, "ready");
  assert.match(persistedSessionMemory.state.content, /Auto-compress test/);

  const transcriptEntries = await runtime.transcriptStore!.load();
  assert.ok(
    transcriptEntries.some((entry) =>
      entry.type === "state_snapshot" && entry.reason === "session_memory"
    ),
  );

  const requestMessages = streamRequests[0]!.messages;
  const summaryMessage = requestMessages.find(
    (message) =>
      message.role === "user" &&
      message.content.includes("<session_memory>"),
  );

  assert.ok(summaryMessage);
  assert.ok(requestMessages.length < state.Messages.length);
  assert.ok(
    JSON.stringify(requestMessages).length < JSON.stringify(state.Messages).length,
  );
  assert.equal(events.at(-1)?.type, "done");
});

test("query flushes agent notifications after auto-compression", async () => {
  const notificationText = "<task-notification>agent finished after compact</task-notification>";
  const createRequests: DeepSeekCreateRequest[] = [];
  const streamRequests: DeepSeekStreamRequest[] = [];
  const client: DeepSeekClient = {
    async create(input) {
      createRequests.push(input);
      return createSessionMemoryResponse();
    },
    async *stream(input) {
      streamRequests.push(input);
      yield createAssistantChunk("notification received");
      yield {
        chunk: null,
        raw: "[DONE]",
        done: true,
      };
    },
    async collectStream() {
      throw new Error("collectStream is not used in this test");
    },
  };
  const state = createState({
    messages: createLargeConversation(),
    agentNotifications: [
      {
        id: "agent_notification_after_compact",
        agentTaskId: "agent_task_after_compact",
        agentType: "worker",
        description: "finish isolated work",
        status: "completed",
        createdAt: 1,
        message: notificationText,
      },
    ],
  });
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-auto-compress-notification-")),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: client,
    MemoryConfig: createMemoryConfig(),
    messages: state.Messages,
  });

  for await (const _event of query(runtime, state, { maxTurns: 1 })) {
    // Drain the query stream.
  }

  assert.equal(createRequests.length, 1);
  assert.equal(streamRequests.length, 1);
  assert.equal(state.agentNotifications.length, 0);
  assert.equal(state.runtimeContextMessages.length, 0);

  const sessionMemoryRequestText = JSON.stringify(createRequests[0]!.messages);
  const mainRequestText = JSON.stringify(streamRequests[0]!.messages);

  assert.doesNotMatch(sessionMemoryRequestText, /agent finished after compact/);
  assert.match(mainRequestText, /agent finished after compact/);
});

function createLargeConversation() {
  return Array.from({ length: 220 }, (_, index) =>
    createMessage({
      role: "user",
      content: `message ${index}\n${"large context block ".repeat(260)}`,
    })
  );
}

function createSessionMemoryResponse(): DeepSeekChatCompletionResponse {
  return {
    id: "session-memory-response",
    object: "chat.completion",
    created: 0,
    model: "deepseek-v4-flash",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: [
            "# Session Title",
            "Auto-compress test",
            "",
            "# Current State",
            "The oversized conversation has been summarized for continuation.",
            "",
            "# Task specification",
            "Verify the query loop uses session memory before the main request.",
          ].join("\n"),
        },
      },
    ],
  };
}

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
