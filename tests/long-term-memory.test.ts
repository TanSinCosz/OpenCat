import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { MemoryTool } from "../src/Memory/Memory.js";
import { extractLongTermMemoryForCompletedQuery } from "../src/query/long-term-memory.js";
import { buildMessagesForQuery } from "../src/query/messages.js";
import { recordTranscriptMessage } from "../src/transcript/persistence.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("only MemorySave is exposed as a long-term memory tool", async () => {
  const fakeMemory = createFakeMemory();
  const state = createState();
  const runtime = createRuntime({
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    MemoryConfig: createMemoryConfig(),
    longTermMemory: fakeMemory as unknown as MemoryTool,
    longTermMemoryConfig: {
      userId: "user-1",
    },
  });

  const searchTool = runtime.tools.find((tool) => tool.name === "MemorySearch");
  const saveTool = runtime.tools.find((tool) => tool.name === "MemorySave");
  assert.equal(searchTool, undefined);
  assert.ok(saveTool);

  const saveOutput = await saveTool.call(
    { memory: "User prefers compact architecture notes." },
    runtime.toolUseContext,
    runtime,
    state,
  ) as { results: Array<{ memory: string }> };

  assert.equal(saveOutput.results[0]?.memory, "User prefers compact architecture notes.");
  assert.equal(fakeMemory.searchCalls.length, 0);
  assert.equal(fakeMemory.addCalls[0]?.config.filters?.user_id, "user-1");
  assert.equal(fakeMemory.addCalls[0]?.config.infer, true);
});

test("buildMessagesForQuery injects long-term memory as projection only", async () => {
  const fakeMemory = createFakeMemory();
  const state = createState({
    messages: [
      createMessage({
        role: "user",
        content: "What conventions should I follow in this repo?",
      }),
    ],
  });
  const runtime = createRuntime({
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    MemoryConfig: createMemoryConfig(),
    longTermMemory: fakeMemory as unknown as MemoryTool,
    longTermMemoryConfig: {
      autoInject: true,
      userId: "user-1",
    },
    messages: state.Messages,
  });

  const projection = await buildMessagesForQuery(runtime, state);

  assert.equal(state.Messages.length, 1);
  assert.equal(projection.messages[0]?.role, "system");
  assert.equal(projection.messages[1]?.role, "user");
  assert.equal(
    projection.messages[1]?.content,
    "What conventions should I follow in this repo?",
  );
  assert.equal(projection.messages[2]?.role, "user");
  assert.match(projection.messages[2]?.content ?? "", /<opencat_context>/);
  assert.match(projection.messages[2]?.content ?? "", /<long_term_memory>/);
  assert.match(
    projection.messages[2]?.content ?? "",
    /repo-grounded implementation notes/,
  );
});

test("long-term memory recall query ignores synthetic projection messages", async () => {
  const fakeMemory = createFakeMemory();
  const state = createState({
    messages: [
      createMessage({
        role: "user",
        content: "Please remember that I prefer concise Chinese explanations.",
      }),
      createMessage({
        role: "assistant",
        content: "Understood, I will keep explanations concise.",
      }),
      createMessage({
        role: "user",
        content: "synthetic long memory should not become recall query",
      }, { source: "long_term_memory" }),
      createMessage({
        role: "user",
        content: "auto compress summary should not become recall query",
      }, { source: "auto_compress" }),
      createMessage({
        role: "user",
        content: "runtime notification should not become recall query",
      }, { source: "runtime" }),
      createMessage({
        role: "user",
        content: "agent notification should not become recall query",
      }, { source: "agent_notification" }),
      createMessage({
        role: "user",
        content: "file restore attachment should not become recall query",
      }, { source: "file_restore" }),
      createMessage({
        role: "user",
        content: "dynamic skill attachment should not become recall query",
      }, { source: "dynamic_skill" }),
    ],
  });
  const runtime = createRuntime({
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    MemoryConfig: createMemoryConfig(),
    longTermMemory: fakeMemory as unknown as MemoryTool,
    longTermMemoryConfig: {
      autoInject: true,
      userId: "user-1",
    },
    messages: state.Messages,
  });

  await buildMessagesForQuery(runtime, state);

  const query = fakeMemory.searchCalls[0]?.query ?? "";
  assert.match(query, /prefer concise Chinese explanations/);
  assert.match(query, /keep explanations concise/);
  assert.doesNotMatch(query, /synthetic long memory/);
  assert.doesNotMatch(query, /auto compress summary/);
  assert.doesNotMatch(query, /runtime notification/);
  assert.doesNotMatch(query, /agent notification/);
  assert.doesNotMatch(query, /file restore attachment/);
  assert.doesNotMatch(query, /dynamic skill attachment/);
});

test("completed query long-term memory extraction uses explicit turn messages", async () => {
  const fakeMemory = createFakeMemory();
  const previousUser = createMessage({ role: "user", content: "Earlier context" });
  const currentUser = createMessage({
    role: "user",
    content: "以后解释架构时请紧凑一点，并且引用代码依据。",
  });
  const assistant = createMessage({
    role: "assistant",
    content: "好的，我会用紧凑并带代码依据的方式解释架构。",
  });
  const state = createState({
    messages: [previousUser, currentUser, assistant],
  });
  const runtime = createRuntime({
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    MemoryConfig: createMemoryConfig(),
    longTermMemory: fakeMemory as unknown as MemoryTool,
    longTermMemoryConfig: {
      autoExtract: true,
      userId: "user-1",
    },
    messages: state.Messages,
  });

  const result = await extractLongTermMemoryForCompletedQuery(runtime, state, {
    turnStartMessageId: currentUser.id,
    turnStartedAt: Date.UTC(2026, 5, 30),
  });

  assert.deepEqual(result, {
    status: "extracted",
    count: 1,
    source: "state",
  });
  assert.equal(fakeMemory.addCalls.length, 1);
  assert.deepEqual(fakeMemory.addCalls[0]?.messages, [
    { role: "user", content: currentUser.content },
    { role: "assistant", content: assistant.content },
  ]);
  assert.deepEqual(fakeMemory.addCalls[0]?.config.contextMessages, [
    { role: "user", content: previousUser.content },
  ]);
});

test("completed query long-term memory extraction falls back to full transcript", async () => {
  const fakeMemory = createFakeMemory();
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-long-memory-transcript-")),
    sessionId: "long_memory_transcript_fallback",
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    MemoryConfig: createMemoryConfig(),
    longTermMemory: fakeMemory as unknown as MemoryTool,
    longTermMemoryConfig: {
      autoExtract: true,
      userId: "user-1",
    },
  });
  const previous = createMessage({ role: "user", content: "之前我们在设计长期记忆。" });
  const current = createMessage({
    role: "user",
    content: "以后长期记忆抽取时，先用内存消息，不完整再读 transcript。",
  });
  const assistant = createMessage({
    role: "assistant",
    content: "好的，长期记忆抽取会优先使用 state，必要时从 transcript full hydrate 兜底。",
  });
  const state = createState({
    messages: [],
  });

  await recordTranscriptMessage(runtime, previous);
  await recordTranscriptMessage(runtime, current);
  await recordTranscriptMessage(runtime, assistant);

  const result = await extractLongTermMemoryForCompletedQuery(runtime, state, {
    turnStartMessageId: current.id,
    turnStartedAt: Date.UTC(2026, 5, 30),
  });

  assert.deepEqual(result, {
    status: "extracted",
    count: 1,
    source: "transcript",
  });
  assert.deepEqual(fakeMemory.addCalls[0]?.messages, [
    { role: "user", content: current.content },
    { role: "assistant", content: assistant.content },
  ]);
  assert.deepEqual(fakeMemory.addCalls[0]?.config.contextMessages, [
    { role: "user", content: previous.content },
  ]);
});

function createFakeMemory() {
  const fakeMemory = {
    searchCalls: [] as Array<{ query: string; config: any }>,
    addCalls: [] as Array<{ messages: unknown; config: any }>,
    async search(query: string, config: any) {
      this.searchCalls.push({ query, config });
      return {
        results: [
          {
            id: "mem_1",
            memory: "User prefers repo-grounded implementation notes.",
            score: 0.9,
          },
        ],
      };
    },
    async add(messages: unknown, config: any) {
      this.addCalls.push({ messages, config });
      return {
        results: [
          {
            id: "mem_saved",
            memory: String(messages),
            metadata: { event: "ADD" },
          },
        ],
      };
    },
  };

  return fakeMemory;
}

function createDeepSeekConfig() {
  return {
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    maxTokens: 1024,
  } as const;
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
