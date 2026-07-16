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
import { createRuntimeContextMessage } from "../src/query/runtime-context.js";
import { applyAutoCompressSummary } from "../src/auto-compress/index.js";
import {
  loadStateFromTranscript,
  recordTranscriptMessage,
  recordTranscriptStateSnapshot,
} from "../src/transcript/persistence.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("transcript store restores messages and latest state snapshot", async () => {
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-transcript-")),
    sessionId: "session_restore_test",
    deepSeekRuntimeConfig: createRuntimeConfig(),
    deepSeekClient: createNoopClient(),
    MemoryConfig: createMemoryConfig(),
  });
  const state = createState({ mode: "plan" });
  const userMessage = createMessage({
    role: "user",
    content: "remember this user prompt",
  });

  state.Messages.push(userMessage);
  state.sessionMemory.status = "ready";
  state.sessionMemory.content = "# Session Title\nPersisted transcript";

  await recordTranscriptMessage(runtime, userMessage);
  await recordTranscriptStateSnapshot(runtime, state, "manual");

  const restored = await loadStateFromTranscript(runtime.transcriptStore!);

  assert.ok(restored);
  assert.equal(restored.Messages.length, 1);
  assert.equal(restored.Messages[0]?.id, userMessage.id);
  assert.equal(restored.Messages[0]?.source, "user");
  assert.equal(restored.mode, "plan");
  assert.equal(restored.sessionMemory.status, "ready");
  assert.match(restored.sessionMemory.content, /Persisted transcript/);
});

test("query appends assistant messages to transcript", async () => {
  const createRequests: DeepSeekCreateRequest[] = [];
  const streamRequests: DeepSeekStreamRequest[] = [];
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-query-transcript-")),
    sessionId: "session_query_test",
    deepSeekRuntimeConfig: createRuntimeConfig(),
    deepSeekClient: {
      async create(input) {
        createRequests.push(input);
        throw new Error("create is not used in this test");
      },
      async *stream(input) {
        streamRequests.push(input);
        yield createAssistantChunk("OK");
        yield {
          chunk: null,
          raw: "[DONE]",
          done: true,
        };
      },
      async collectStream() {
        throw new Error("collectStream is not used in this test");
      },
    },
    MemoryConfig: createMemoryConfig(),
  });
  const state = createState();
  const userMessage = createMessage({
    role: "user",
    content: "say ok",
  });

  state.Messages.push(userMessage);
  await recordTranscriptMessage(runtime, userMessage);

  for await (const _event of query(runtime, state, { maxTurns: 1 })) {
    // Drain the query stream so the assistant message is finalized and recorded.
  }

  const entries = await runtime.transcriptStore!.load();
  const messageEntries = entries.filter((entry) => entry.type === "message");

  assert.equal(createRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(messageEntries.length, 2);
  assert.equal(messageEntries[0]?.message.role, "user");
  assert.equal(messageEntries[0]?.message.source, "user");
  assert.equal(messageEntries[1]?.message.role, "assistant");
  assert.equal(messageEntries[1]?.message.source, "assistant");
  assert.equal(messageEntries[1]?.message.content, "OK");
});

test("subagent transcript store uses the concrete agent id", async () => {
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-subagent-transcript-")),
    sessionId: "session_with_subagents",
    agentId: "agent_child_1",
    agentRole: "subagent",
    parentAgentId: "main",
    agentType: "worker",
    deepSeekRuntimeConfig: createRuntimeConfig(),
    deepSeekClient: createNoopClient(),
    MemoryConfig: createMemoryConfig(),
  });
  const message = createMessage({
    role: "user",
    content: "child prompt",
  });

  await recordTranscriptMessage(runtime, message);

  assert.match(runtime.transcriptStore!.path, /session_with_subagents/);
  assert.match(runtime.transcriptStore!.path, /subagents/);
  assert.match(runtime.transcriptStore!.path, /agent-agent_child_1\.jsonl$/);

  const raw = await readFile(runtime.transcriptStore!.path, "utf8");
  const entry = JSON.parse(raw.trim());

  assert.equal(entry.agentId, "agent_child_1");
  assert.equal(entry.agentRole, "subagent");
  assert.equal(entry.parentAgentId, "main");
  assert.equal(entry.agentType, "worker");
});

test("session transcript store uses the session-agent role", async () => {
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-session-agent-transcript-")),
    sessionId: "session_with_session_agents",
    agentId: "agent_session_memory_1",
    agentRole: "session",
    parentAgentId: "main",
    agentType: "session_memory",
    deepSeekRuntimeConfig: createRuntimeConfig(),
    deepSeekClient: createNoopClient(),
    MemoryConfig: createMemoryConfig(),
  });
  const message = createMessage({
    role: "user",
    content: "session memory prompt",
  });

  await recordTranscriptMessage(runtime, message);

  assert.match(runtime.transcriptStore!.path, /session_with_session_agents/);
  assert.match(runtime.transcriptStore!.path, /session-agents/);
  assert.match(
    runtime.transcriptStore!.path,
    /agent-agent_session_memory_1\.jsonl$/,
  );

  const raw = await readFile(runtime.transcriptStore!.path, "utf8");
  const entry = JSON.parse(raw.trim());

  assert.equal(entry.agentId, "agent_session_memory_1");
  assert.equal(entry.agentRole, "session");
  assert.equal(entry.parentAgentId, "main");
  assert.equal(entry.agentType, "session_memory");
});

test("transcript restore hydrates only post auto-compress messages by default", async () => {
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-compact-transcript-")),
    sessionId: "session_compact_restore_test",
    deepSeekRuntimeConfig: createRuntimeConfig(),
    deepSeekClient: createNoopClient(),
    MemoryConfig: createMemoryConfig(),
  });
  const first = createMessage({ role: "user", content: "old context 1" });
  const second = createMessage({ role: "assistant", content: "old context 2" });
  const third = createMessage({ role: "user", content: "recent tail" });
  const state = createState({
    messages: [first, second],
    autoCompress: {
      summaries: [
        {
          id: "autocompress_test_summary",
          content: "compressed earlier conversation",
          fromMessageId: first.id,
          throughMessageId: second.id,
          messageCount: 2,
          createdAt: 1,
        },
      ],
      sessionMemoryUpdated: true,
    },
  });

  await recordTranscriptMessage(runtime, first);
  await recordTranscriptMessage(runtime, second);
  await recordTranscriptStateSnapshot(runtime, state, "auto_compress");
  await recordTranscriptMessage(runtime, third);

  const restored = await loadStateFromTranscript(runtime.transcriptStore!);
  const full = await loadStateFromTranscript(runtime.transcriptStore!, {
    hydrate: "full",
  });

  assert.ok(restored);
  assert.equal(restored.Messages.length, 1);
  assert.equal(restored.Messages[0]?.id, third.id);
  assert.equal(restored.autoCompress.summaries.at(-1)?.id, "autocompress_test_summary");

  const messages = applyAutoCompressSummary(restored);
  assert.equal(messages.length, 2);
  assert.match(messages[0]?.content ?? "", /compressed earlier conversation/);
  assert.equal(messages[1]?.id, third.id);

  assert.ok(full);
  assert.equal(full.Messages.length, 3);
});

test("transcript restore keeps pending agent notifications from snapshots", async () => {
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-agent-notification-transcript-")),
    sessionId: "session_agent_notification_restore",
    deepSeekRuntimeConfig: createRuntimeConfig(),
    deepSeekClient: createNoopClient(),
    MemoryConfig: createMemoryConfig(),
  });
  const state = createState({
    agentNotifications: [
      {
        id: "agent_notification_restore",
        agentTaskId: "agent_restore",
        agentType: "worker",
        description: "restore notification",
        status: "completed",
        createdAt: 1,
        message: "<task-notification>restored</task-notification>",
      },
    ],
  });

  await recordTranscriptStateSnapshot(runtime, state, "agent_notification");

  const restored = await loadStateFromTranscript(runtime.transcriptStore!);

  assert.ok(restored);
  assert.equal(restored.agentNotifications.length, 1);
  assert.equal(restored.agentNotifications[0]?.id, "agent_notification_restore");
});

test("transcript snapshots omit volatile runtime context messages", async () => {
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-runtime-context-transcript-")),
    sessionId: "session_runtime_context_restore",
    deepSeekRuntimeConfig: createRuntimeConfig(),
    deepSeekClient: createNoopClient(),
    MemoryConfig: createMemoryConfig(),
  });
  const state = createState({
    messages: [
      createMessage({
        role: "user",
        content: "real user prompt",
      }),
    ],
    runtimeContextMessages: [
      createRuntimeContextMessage({
        source: "agent_notification",
        content: "<task-notification>runtime only</task-notification>",
      }),
    ],
  });

  await recordTranscriptMessage(runtime, state.Messages[0]!);
  await recordTranscriptStateSnapshot(runtime, state, "runtime_context");

  const restored = await loadStateFromTranscript(runtime.transcriptStore!);
  const raw = await readFile(runtime.transcriptStore!.path, "utf8");

  assert.ok(restored);
  assert.equal(restored.Messages.length, 1);
  assert.equal(restored.Messages[0]?.content, "real user prompt");
  assert.equal(restored.runtimeContextMessages.length, 0);
  assert.doesNotMatch(raw, /runtime only/);
});

test("transcript restore strips stale dynamic skill context blocks", async () => {
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-projection-context-transcript-")),
    sessionId: "session_projection_context_restore",
    deepSeekRuntimeConfig: createRuntimeConfig(),
    deepSeekClient: createNoopClient(),
    MemoryConfig: createMemoryConfig(),
  });
  const userMessage = createMessage({
    role: "user",
    content: "real user prompt",
  });
  const contextMessage = createMessage({
    role: "user",
    name: "opencat_context",
    content: [
      "<opencat_context>",
      "<context_block source=\"long_term_memory\">",
      "<long_term_memory>keep me</long_term_memory>",
      "</context_block>",
      "<context_block source=\"dynamic_skill\">",
      "<dynamic_skills>old</dynamic_skills>",
      "</context_block>",
      "</opencat_context>",
    ].join("\n"),
  }, { source: "runtime" });
  const assistantMessage = createMessage({
    role: "assistant",
    content: "real assistant response",
  });

  await recordTranscriptMessage(runtime, userMessage);
  await recordTranscriptMessage(runtime, contextMessage);
  await recordTranscriptMessage(runtime, assistantMessage);

  const restored = await loadStateFromTranscript(runtime.transcriptStore!, {
    hydrate: "full",
  });

  assert.ok(restored);
  assert.equal(restored.Messages.length, 3);
  assert.equal(restored.Messages[0]?.content, "real user prompt");
  assert.match(String(restored.Messages[1]?.content), /keep me/);
  assert.doesNotMatch(String(restored.Messages[1]?.content), /dynamic_skills/);
  assert.equal(restored.Messages[2]?.content, "real assistant response");
});

test("transcript restore keeps history snip boundaries from snapshots", async () => {
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-history-snip-transcript-")),
    sessionId: "session_history_snip_restore",
    deepSeekRuntimeConfig: createRuntimeConfig(),
    deepSeekClient: createNoopClient(),
    MemoryConfig: createMemoryConfig(),
  });
  const oldMessage = createMessage({
    role: "user",
    content: "old snipped message",
  });
  const recentMessage = createMessage({
    role: "user",
    content: "recent message",
  });
  const state = createState({
    messages: [oldMessage, recentMessage],
    historySnips: [
      {
        id: "history_snip_restore",
        removedMessageIds: [oldMessage.id],
        createdAtMessageId: recentMessage.id,
        reason: "prompt_budget",
        createdAt: 1,
      },
    ],
  });

  await recordTranscriptMessage(runtime, oldMessage);
  await recordTranscriptMessage(runtime, recentMessage);
  await recordTranscriptStateSnapshot(runtime, state, "history_snip");

  const restored = await loadStateFromTranscript(runtime.transcriptStore!);

  assert.ok(restored);
  assert.equal(restored.historySnips.length, 1);
  assert.equal(restored.historySnips[0]?.id, "history_snip_restore");
  assert.deepEqual(restored.historySnips[0]?.removedMessageIds, [oldMessage.id]);
});

test("transcript restore keeps tool result projection replacement state", async () => {
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-tool-budget-transcript-")),
    sessionId: "session_tool_budget_restore",
    deepSeekRuntimeConfig: createRuntimeConfig(),
    deepSeekClient: createNoopClient(),
    MemoryConfig: createMemoryConfig(),
  });
  const state = createState();
  state.toolResultBudgetState.seenIds.add("tool_result:seen");
  state.toolResultBudgetState.replacements.set(
    "bulky_tool_result:message_1",
    "<tool-result-compact>preview</tool-result-compact>",
  );

  await recordTranscriptStateSnapshot(runtime, state, "projection");

  const restored = await loadStateFromTranscript(runtime.transcriptStore!);

  assert.ok(restored);
  assert.ok(restored.toolResultBudgetState.seenIds.has("tool_result:seen"));
  assert.equal(
    restored.toolResultBudgetState.replacements.get("bulky_tool_result:message_1"),
    "<tool-result-compact>preview</tool-result-compact>",
  );
});

test("transcript merges lean state snapshots without repeating projection state", async () => {
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-lean-state-transcript-")),
    sessionId: "session_lean_state_restore",
    deepSeekRuntimeConfig: createRuntimeConfig(),
    deepSeekClient: createNoopClient(),
    MemoryConfig: createMemoryConfig(),
  });
  const state = createState();
  const marker = "very-large-tool-budget-marker";

  state.toolResultBudgetState.seenIds.add("tool_result:seen");
  state.toolResultBudgetState.replacements.set(
    "bulky_tool_result:message_1",
    `<tool-result-compact>${marker}</tool-result-compact>`,
  );

  await recordTranscriptStateSnapshot(runtime, state, "projection");

  state.agentNotifications.push({
    id: "agent_notification_restore",
    agentTaskId: "agent_1",
    agentType: "worker",
    status: "completed",
    description: "Agent completed",
    message: "runtime notification",
    createdAt: 1,
  });
  await recordTranscriptStateSnapshot(runtime, state, "runtime_context");

  const restored = await loadStateFromTranscript(runtime.transcriptStore!);
  const raw = await readFile(runtime.transcriptStore!.path, "utf8");

  assert.ok(restored);
  assert.ok(restored.toolResultBudgetState.seenIds.has("tool_result:seen"));
  assert.match(
    restored.toolResultBudgetState.replacements.get("bulky_tool_result:message_1") ?? "",
    new RegExp(marker),
  );
  assert.equal(restored.agentNotifications.length, 1);
  assert.equal(raw.match(new RegExp(marker, "g"))?.length, 1);
});

test("transcript restore recovers reasoning-only assistant messages", async () => {
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-reasoning-only-transcript-")),
    sessionId: "session_reasoning_only_restore",
    deepSeekRuntimeConfig: createRuntimeConfig(),
    deepSeekClient: createNoopClient(),
    MemoryConfig: createMemoryConfig(),
  });
  const message = createMessage({
    role: "assistant",
    content: "",
    reasoning_content: "unfinished reasoning that exhausted output budget",
  });

  await recordTranscriptMessage(runtime, message);

  const restored = await loadStateFromTranscript(runtime.transcriptStore!, {
    hydrate: "full",
  });

  assert.ok(restored);
  assert.equal(restored.Messages.length, 1);
  assert.match(
    restored.Messages[0]?.content ?? "",
    /recovered so the session can continue/,
  );
  assert.equal(
    restored.Messages[0]?.role === "assistant"
      ? restored.Messages[0].reasoning_content
      : "",
    "unfinished reasoning that exhausted output budget",
  );
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
      throw new Error("create is not used in this test");
    },
    async *stream() {
      throw new Error("stream is not used in this test");
    },
    async collectStream() {
      throw new Error("collectStream is not used in this test");
    },
  };
}

function createRuntimeConfig() {
  return {
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    maxTokens: 1024,
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
