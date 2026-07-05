import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
import { DEFAULT_SESSION_MEMORY_TEMPLATE } from "../src/session-memory/prompts.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";
import { createMessage } from "../src/types/messages.js";

test("query auto-compresses oversized projections with session memory before model request", async () => {
  const createRequests: DeepSeekCreateRequest[] = [];
  const streamRequests: DeepSeekStreamRequest[] = [];
  const client: DeepSeekClient = {
    async create(input) {
      createRequests.push(input);
      throw new Error("session memory should run through forked agent stream");
    },
    async *stream(input) {
      streamRequests.push(input);
      if (isSessionMemoryForkRequest(input)) {
        if (hasSessionMemoryEditResult(input)) {
          yield createAssistantChunk("Session memory updated.");
        } else {
          yield createSessionMemoryEditChunk(input);
        }
        yield {
          chunk: null,
          raw: "[DONE]",
          done: true,
        };
        return;
      }

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
  });

  const events = [];
  for await (const event of query(runtime, state, { maxTurns: 1 })) {
    events.push(event);
  }

  assert.equal(createRequests.length, 0);
  assert.equal(streamRequests.length, 3);
  assert.deepEqual(getRequestToolNames(streamRequests[0]), ["Edit"]);
  assert.match(
    JSON.stringify(streamRequests[0]!.messages),
    /Available tools: Edit/,
  );
  assert.match(
    JSON.stringify(streamRequests[0]!.messages),
    /Unavailable tools: .*Agent/,
  );
  assert.equal(state.sessionMemory.status, "ready");
  assert.equal(state.autoCompress.summaries.length, 1);
  assert.ok(state.autoCompress.summaries.at(-1));

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

  const requestMessages = streamRequests.at(-1)!.messages;
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
      throw new Error("session memory should run through forked agent stream");
    },
    async *stream(input) {
      streamRequests.push(input);
      if (isSessionMemoryForkRequest(input)) {
        if (hasSessionMemoryEditResult(input)) {
          yield createAssistantChunk("Session memory updated.");
        } else {
          yield createSessionMemoryEditChunk(input);
        }
        yield {
          chunk: null,
          raw: "[DONE]",
          done: true,
        };
        return;
      }

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
  });

  for await (const _event of query(runtime, state, { maxTurns: 1 })) {
    // Drain the query stream.
  }

  assert.equal(createRequests.length, 0);
  assert.equal(streamRequests.length, 3);
  assert.equal(state.agentNotifications.length, 0);
  assert.equal(state.runtimeContextMessages.length, 0);

  const sessionMemoryRequestText = JSON.stringify(streamRequests[0]!.messages);
  const mainRequestText = JSON.stringify(streamRequests.at(-1)!.messages);

  assert.doesNotMatch(sessionMemoryRequestText, /agent finished after compact/);
  assert.match(mainRequestText, /agent finished after compact/);
});

test("session runtime does not trigger nested auto-compression", async () => {
  const createRequests: DeepSeekCreateRequest[] = [];
  const streamRequests: DeepSeekStreamRequest[] = [];
  const client: DeepSeekClient = {
    async create(input) {
      createRequests.push(input);
      throw new Error("session runtime should not update session memory");
    },
    async *stream(input) {
      streamRequests.push(input);
      yield createAssistantChunk("session done");
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
    cwd: await mkdtemp(join(tmpdir(), "opencat-session-runtime-")),
    sessionId: "session_runtime_no_nested_compact",
    agentId: "agent_session_memory_test",
    agentRole: "session",
    parentAgentId: "main",
    agentType: "session_memory",
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: client,
    MemoryConfig: createMemoryConfig(),
  });

  for await (const _event of query(runtime, state, { maxTurns: 1 })) {
    // Drain the query stream.
  }

  assert.equal(createRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(state.autoCompress.summaries.length, 0);
  assert.notEqual(state.sessionMemory.status, "ready");
});

test("subagent auto-compresses with a local compact summary", async () => {
  const createRequests: DeepSeekCreateRequest[] = [];
  const streamRequests: DeepSeekStreamRequest[] = [];
  const client: DeepSeekClient = {
    async create(input) {
      createRequests.push(input);
      return {
        id: "local-compact-response",
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
                "# Objective",
                "Continue a forked subagent task after compacting older context.",
                "",
                "# Current State",
                "The older subagent transcript was locally summarized.",
              ].join("\n"),
            },
          },
        ],
      };
    },
    async *stream(input) {
      streamRequests.push(input);
      yield createAssistantChunk("subagent continued");
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
    cwd: await mkdtemp(join(tmpdir(), "opencat-subagent-local-compact-")),
    sessionId: "session_subagent_local_compact",
    agentId: "agent_worker_local_compact",
    parentAgentId: "main",
    agentRole: "subagent",
    agentType: "worker",
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: client,
    MemoryConfig: createMemoryConfig(),
  });

  for await (const _event of query(runtime, state, { maxTurns: 1 })) {
    // Drain the query stream.
  }

  assert.equal(createRequests.length, 1);
  assert.equal(streamRequests.length, 1);
  assert.equal(state.autoCompress.summaries.length, 1);
  assert.notEqual(state.sessionMemory.status, "ready");

  const summary = state.autoCompress.summaries.at(-1);
  assert.ok(summary);
  assert.match(summary.content, /<local_compact_summary>/);
  assert.doesNotMatch(summary.content, /<session_memory>/);

  const requestMessages = streamRequests[0]!.messages;
  const summaryMessage = requestMessages.find(
    (message) =>
      message.role === "user" &&
      message.content.includes("<local_compact_summary>"),
  );
  assert.ok(summaryMessage);
  assert.ok(requestMessages.length < state.Messages.length);

  const compactPrompt = JSON.stringify(createRequests[0]!.messages);
  assert.match(compactPrompt, /older_conversation_transcript/);
  assert.doesNotMatch(compactPrompt, /session notes file/);
});

function createLargeConversation() {
  return Array.from({ length: 220 }, (_, index) =>
    createMessage({
      role: "user",
      content: `message ${index}\n${"large context block ".repeat(260)}`,
    })
  );
}

function isSessionMemoryForkRequest(input: DeepSeekStreamRequest): boolean {
  return JSON.stringify(input.messages).includes("session notes file");
}

function hasSessionMemoryEditResult(input: DeepSeekStreamRequest): boolean {
  return input.messages.some((message) =>
    message.role === "tool" && message.tool_call_id === "call_session_memory_edit"
  );
}

function createSessionMemoryEditChunk(input: DeepSeekStreamRequest): DeepSeekStreamEnvelope {
  const sessionMemoryPath = extractSessionMemoryPath(input);

  return {
    raw: "session-memory-edit",
    done: false,
    chunk: {
      id: "session-memory-edit-chunk",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-flash",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_session_memory_edit",
                type: "function",
                function: {
                  name: "Edit",
                  arguments: JSON.stringify({
                    file_path: sessionMemoryPath,
                    old_string: `${DEFAULT_SESSION_MEMORY_TEMPLATE}\n`,
                    new_string: `${createSessionMemoryContent()}\n`,
                  }),
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

function extractSessionMemoryPath(input: DeepSeekStreamRequest): string {
  const text = JSON.stringify(input.messages);
  const match = text.match(/[A-Z]:\\\\[^"]+?\.md/);
  assert.ok(match, "session memory prompt should include a markdown path");
  return match[0]!.replaceAll("\\\\", "\\");
}

function createSessionMemoryContent(): string {
  return DEFAULT_SESSION_MEMORY_TEMPLATE
    .replace(
      "# Session Title\n_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_",
      [
        "# Session Title",
        "_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_",
        "Auto-compress test",
      ].join("\n"),
    )
    .replace(
      "# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._",
      [
        "# Current State",
        "_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._",
        "The oversized conversation has been summarized for continuation.",
      ].join("\n"),
    )
    .replace(
      "# Task specification\n_What did the user ask to build? Any design decisions or other explanatory context_",
      [
        "# Task specification",
        "_What did the user ask to build? Any design decisions or other explanatory context_",
        "Verify the query loop uses session memory before the main request.",
      ].join("\n"),
    );
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

function getRequestToolNames(request: DeepSeekStreamRequest | undefined): string[] {
  assert.ok(request);
  return (request.tools ?? []).map((tool) => tool.function.name);
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
