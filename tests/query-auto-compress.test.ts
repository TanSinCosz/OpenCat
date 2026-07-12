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
import { applyAutoCompression } from "../src/auto-compress/index.js";
import { query } from "../src/query.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";
import { createMessage } from "../src/types/messages.js";

process.env.OPENCAT_AUTO_COMPRESS_TRIGGER_TOKENS = "100";

test("query auto-compresses oversized projections with existing session memory before model request", async () => {
  const createRequests: DeepSeekCreateRequest[] = [];
  const streamRequests: DeepSeekStreamRequest[] = [];
  const client: DeepSeekClient = {
    async create(input) {
      createRequests.push(input);
      throw new Error("create should not be used in this test");
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
    sessionMemory: createReadySessionMemory(
      "Existing session memory should be reused without updating.",
    ),
  });
  state.sessionMemory.lastSummarizedMessageId = state.Messages[180]!.id;
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
  state.historySnips.push({
    id: "history_snip_stale_projection",
    removedMessageIds: [state.Messages[1]!.id],
    createdAtMessageId: state.Messages.at(-1)!.id,
    reason: "prompt_budget",
    createdAt: Date.now(),
  });
  state.toolResultBudgetState.seenIds.add("stale_tool_result");
  state.toolResultBudgetState.replacements.set(
    "stale_budget_key",
    "<tool-result-compact>stale</tool-result-compact>",
  );
  runtime.toolResultBudgetState = state.toolResultBudgetState;

  const events = [];
  for await (const event of query(runtime, state, { maxTurns: 1 })) {
    events.push(event);
  }

  assert.equal(createRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(state.sessionMemory.status, "ready");
  assert.equal(state.autoCompress.summaries.length, 1);
  assert.ok(state.autoCompress.summaries.at(-1));
  assert.equal(state.historySnips.length, 1);
  assert.equal(state.toolResultBudgetState.seenIds.size, 0);
  assert.equal(state.toolResultBudgetState.replacements.size, 0);
  assert.equal(runtime.toolResultBudgetState, state.toolResultBudgetState);

  const transcriptEntries = await runtime.transcriptStore!.load();
  assert.equal(
    transcriptEntries.some((entry) =>
      entry.type === "state_snapshot" && entry.reason === "session_memory"
    ),
    false,
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

test("auto-compress clears bulky compact state but preserves recent group budget decisions", async () => {
  const messages = Array.from({ length: 40 }, (_, index) =>
    createMessage({
      role: "user",
      content: `message ${index}\n${"large context block ".repeat(700)}`,
    })
  );
  const oldMessage = messages[0]!;
  const recentMessage = messages.at(-1)!;
  const state = createState({
    messages,
    sessionMemory: {
      content: [
        "# Session Title",
        "Projection state preservation",
        "# Current State",
        "The older range has been summarized.",
      ].join("\n"),
      initialized: true,
      status: "ready",
      tokensAtLastUpdateAttempt: 0,
      tokensAtLastExtraction: 0,
      lastSummarizedMessageId: recentMessage.id,
      config: {
        minimumMessageTokensToInit: 10_000,
        minimumTokensBetweenUpdate: 5_000,
        toolCallsBetweenUpdates: 3,
      },
    },
  });
  const oldBudgetKey = `bulky_tool_result:${oldMessage.id}`;
  const recentBudgetKey = `bulky_tool_result:${recentMessage.id}`;
  const recentGroupBudgetKey = recentMessage.id;
  state.historySnips.push({
    id: "history_snip_before_auto_compress",
    removedMessageIds: [oldMessage.id],
    createdAtMessageId: recentMessage.id,
    reason: "prompt_budget",
    createdAt: Date.now(),
  });
  state.toolResultBudgetState.seenIds.add(oldBudgetKey);
  state.toolResultBudgetState.seenIds.add(recentBudgetKey);
  state.toolResultBudgetState.seenIds.add(recentGroupBudgetKey);
  state.toolResultBudgetState.replacements.set(
    oldBudgetKey,
    "<tool-result-compact>old</tool-result-compact>",
  );
  state.toolResultBudgetState.replacements.set(
    recentBudgetKey,
    "<tool-result-compact>recent</tool-result-compact>",
  );
  state.toolResultBudgetState.replacements.set(
    recentGroupBudgetKey,
    "<tool-result-budget>recent</tool-result-budget>",
  );
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-auto-compress-projection-")),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: {
      async create() {
        throw new Error("session memory should already be ready");
      },
      async *stream() {
        throw new Error("session memory should already be ready");
      },
      async collectStream() {
        throw new Error("session memory should already be ready");
      },
    },
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
  });

  const result = await applyAutoCompression(runtime, state);

  assert.equal(result.status, "compressed");
  assert.equal(state.historySnips.length, 1);
  assert.equal(state.toolResultBudgetState.seenIds.has(oldBudgetKey), false);
  assert.equal(
    state.toolResultBudgetState.replacements.has(oldBudgetKey),
    false,
  );
  assert.equal(state.toolResultBudgetState.seenIds.has(recentBudgetKey), false);
  assert.equal(
    state.toolResultBudgetState.replacements.has(recentBudgetKey),
    false,
  );
  assert.equal(
    state.toolResultBudgetState.seenIds.has(recentGroupBudgetKey),
    true,
  );
  assert.equal(
    state.toolResultBudgetState.replacements.get(recentGroupBudgetKey),
    "<tool-result-budget>recent</tool-result-budget>",
  );
  assert.equal(runtime.toolResultBudgetState, state.toolResultBudgetState);
});

test("query compacts visible snip content-only history after session memory covers it", async () => {
  const originalAutoCompressTrigger =
    process.env.OPENCAT_AUTO_COMPRESS_TRIGGER_TOKENS;
  const originalSnippedContentTrigger =
    process.env.OPENCAT_SNIPPED_CONTENT_AUTO_COMPRESS_TRIGGER_TOKENS;
  const streamRequests: DeepSeekStreamRequest[] = [];
  const client: DeepSeekClient = {
    async create() {
      throw new Error("session memory should already be ready");
    },
    async *stream(input) {
      streamRequests.push(input);
      yield createAssistantChunk("snipped content covered");
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
  const oldUser = createMessage({
    role: "user",
    content: `OLD_CONTENT_ONLY_USER\n${"old user text ".repeat(300)}`,
  });
  const oldAssistant = createMessage({
    role: "assistant",
    content: `OLD_CONTENT_ONLY_ASSISTANT\n${"old assistant text ".repeat(300)}`,
  });
  const recentMessages = Array.from({ length: 8 }, (_, index) =>
    createMessage({
      role: "user",
      content: `recent user ${index}`,
    })
  );
  const state = createState({
    messages: [
      oldUser,
      oldAssistant,
      ...recentMessages,
    ],
    sessionMemory: {
      ...createReadySessionMemory("The old content-only range has been summarized."),
      lastSummarizedMessageId: oldAssistant.id,
    },
  });
  state.historySnips.push({
    id: "history_snip_content_only_for_compact",
    removedMessageIds: [],
    contentOnlyMessageIds: [oldUser.id, oldAssistant.id],
    createdAtMessageId: state.Messages.at(-1)!.id,
    reason: "prompt_budget",
    createdAt: Date.now(),
  });
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-snip-content-compact-")),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: client,
    MemoryConfig: createMemoryConfig(),
  });

  try {
    process.env.OPENCAT_AUTO_COMPRESS_TRIGGER_TOKENS = "999999";
    process.env.OPENCAT_SNIPPED_CONTENT_AUTO_COMPRESS_TRIGGER_TOKENS = "10";

    for await (const _event of query(runtime, state, { maxTurns: 1 })) {
      // Drain the query stream.
    }
  } finally {
    restoreEnv("OPENCAT_AUTO_COMPRESS_TRIGGER_TOKENS", originalAutoCompressTrigger);
    restoreEnv(
      "OPENCAT_SNIPPED_CONTENT_AUTO_COMPRESS_TRIGGER_TOKENS",
      originalSnippedContentTrigger,
    );
  }

  assert.equal(state.autoCompress.summaries.length, 1);
  assert.equal(
    state.autoCompress.snippedContentCompactedThroughMessageId,
    oldAssistant.id,
  );
  assert.equal(state.historySnips.length, 1);
  assert.equal(streamRequests.length, 1);

  const requestText = JSON.stringify(streamRequests[0]!.messages);
  assert.match(requestText, /<session_memory>/);
  assert.doesNotMatch(requestText, /OLD_CONTENT_ONLY_USER/);
  assert.doesNotMatch(requestText, /OLD_CONTENT_ONLY_ASSISTANT/);
});

test("auto-compress skips snip compaction when session memory does not cover it", async () => {
  const oldMessage = createMessage({
    role: "user",
    content: "covered by session memory",
  });
  const uncoveredMessage = createMessage({
    role: "assistant",
    content: "not yet covered by session memory",
  });
  const state = createState({
    messages: [
      oldMessage,
      uncoveredMessage,
    ],
    sessionMemory: {
      ...createReadySessionMemory("Only the first message has been summarized."),
      lastSummarizedMessageId: oldMessage.id,
    },
  });
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-snip-content-uncovered-")),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: {
      async create() {
        throw new Error("session memory should already be ready");
      },
      async *stream() {
        throw new Error("stream should not be used");
      },
      async collectStream() {
        throw new Error("collectStream is not used in this test");
      },
    },
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
  });

  const result = await applyAutoCompression(runtime, state, {
    snippedContentThroughMessageId: uncoveredMessage.id,
  });

  assert.equal(result.status, "skipped");
  assert.equal(
    result.status === "skipped" ? result.reason : "",
    "session_memory_does_not_cover_snipped_content",
  );
  assert.equal(state.autoCompress.summaries.length, 0);
  assert.equal(
    state.autoCompress.snippedContentCompactedThroughMessageId,
    undefined,
  );
});

test("query flushes agent notifications after auto-compression", async () => {
  const notificationText = "<task-notification>agent finished after compact</task-notification>";
  const createRequests: DeepSeekCreateRequest[] = [];
  const streamRequests: DeepSeekStreamRequest[] = [];
  const client: DeepSeekClient = {
    async create(input) {
      createRequests.push(input);
      throw new Error("create should not be used in this test");
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
    sessionMemory: createReadySessionMemory(
      "The oversized conversation has already been summarized.",
    ),
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
  state.sessionMemory.lastSummarizedMessageId = state.Messages[180]!.id;
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
  assert.equal(streamRequests.length, 1);
  assert.equal(state.agentNotifications.length, 0);
  assert.equal(state.runtimeContextMessages.length, 0);

  const mainRequestText = JSON.stringify(streamRequests[0]!.messages);

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

function createReadySessionMemory(currentState: string) {
  return {
    content: [
      "# Session Title",
      "Auto-compress test",
      "# Current State",
      currentState,
    ].join("\n"),
    initialized: true,
    status: "ready" as const,
    tokensAtLastUpdateAttempt: 0,
    tokensAtLastExtraction: 0,
    lastSummarizedMessageId: undefined,
    config: {
      minimumMessageTokensToInit: 10_000,
      minimumTokensBetweenUpdate: 5_000,
      toolCallsBetweenUpdates: 3,
    },
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
