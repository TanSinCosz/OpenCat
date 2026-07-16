import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  listRecentMemoryDreamTranscripts,
  runMemoryDream,
} from "../src/Memory/auto-dream.js";
import {
  getFileMemoryDir,
  getFileMemoryLogsDir,
  scanFileMemoryHeaders,
} from "../src/Memory/file-memory.js";
import {
  createLongTermMemoryContextMessage,
  extractLongTermMemoryForCompletedQuery,
} from "../src/query/long-term-memory.js";
import { recordTranscriptMessage } from "../src/transcript/persistence.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("only MemorySave is exposed as a long-term memory tool", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-save-"));
  const state = createState();
  const runtime = createRuntime({
    cwd,
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    MemoryConfig: createMemoryConfig(),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd),
  });

  const searchTool = runtime.tools.find((tool) => tool.name === "MemorySearch");
  const saveTool = runtime.tools.find((tool) => tool.name === "MemorySave");
  assert.equal(searchTool, undefined);
  assert.ok(saveTool);

  const saveOutput = await saveTool.call(
    {
      memory: "User prefers compact architecture notes.",
      memoryType: "feedback",
    },
    runtime.toolUseContext,
    runtime,
    state,
  ) as { results: Array<{ memory: string; metadata?: { path?: string } }> };

  assert.equal(saveOutput.results[0]?.memory, "User prefers compact architecture notes.");
  const path = saveOutput.results[0]?.metadata?.path;
  assert.ok(path);
  assert.match(await readFile(path, "utf8"), /type: feedback/);
  assert.match(
    await readFile(join(cwd, ".opencat", "memory", "MEMORY.md"), "utf8"),
    /compact architecture notes/,
  );
});

test("long-term memory context can be materialized before request build", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-context-"));
  const state = createState({
    messages: [
      createMessage({
        role: "user",
        content: "What conventions should I follow in this repo?",
      }),
    ],
  });
  const runtime = createRuntime({
    cwd,
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    deepSeekClient: createMemorySelectorClient([
      "user-prefers-repo-grounded-implementation-notes",
    ]),
    MemoryConfig: createMemoryConfig(),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd, {
      autoInject: true,
    }),
  });
  const saveTool = runtime.tools.find((tool) => tool.name === "MemorySave");
  assert.ok(saveTool);
  await saveTool.call(
    { memory: "User prefers repo-grounded implementation notes." },
    runtime.toolUseContext,
    runtime,
    state,
  );

  const contextMessage = await createLongTermMemoryContextMessage(
    runtime,
    state.Messages,
  );

  assert.equal(state.Messages.length, 1);
  assert.ok(contextMessage);
  assert.equal(contextMessage.role, "user");
  assert.match(contextMessage.content ?? "", /<long_term_memory>/);
  assert.match(
    contextMessage.content ?? "",
    /repo-grounded implementation notes/,
  );
  assert.match(contextMessage.content ?? "", /<memory_file path=/);
});

test("long-term memory recall query ignores synthetic projection messages", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-synthetic-"));
  const state = createState({
    messages: [
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
    cwd,
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    MemoryConfig: createMemoryConfig(),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd, {
      autoInject: true,
    }),
  });
  const saveTool = runtime.tools.find((tool) => tool.name === "MemorySave");
  assert.ok(saveTool);
  await saveTool.call(
    { memory: "User prefers concise Chinese explanations." },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(await createLongTermMemoryContextMessage(runtime, state.Messages), null);
});

test("long-term memory recall skips files already visible in projected context", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-surfaced-"));
  const state = createState({
    messages: [
      createMessage({
        role: "user",
        content: "What conventions should I follow in this repo?",
      }),
    ],
  });
  const runtime = createRuntime({
    cwd,
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    deepSeekClient: createMemorySelectorClient([
      "user-prefers-repo-grounded-implementation-notes",
    ]),
    MemoryConfig: createMemoryConfig(),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd, {
      autoInject: true,
    }),
  });
  const saveTool = runtime.tools.find((tool) => tool.name === "MemorySave");
  assert.ok(saveTool);
  await saveTool.call(
    { memory: "User prefers repo-grounded implementation notes." },
    runtime.toolUseContext,
    runtime,
    state,
  );
  const [header] = await scanFileMemoryHeaders(runtime);
  assert.ok(header);
  const surfacedMemory = createMessage({
    role: "user",
    content: [
      "<long_term_memory>",
      "<memory_files>",
      `<memory_file path="${header.filename}">`,
      "User prefers repo-grounded implementation notes.",
      "</memory_file>",
      "</memory_files>",
      "</long_term_memory>",
    ].join("\n"),
  }, { source: "long_term_memory" });

  const contextMessage = await createLongTermMemoryContextMessage(
    runtime,
    [surfacedMemory, ...state.Messages],
  );

  assert.ok(contextMessage);
  assert.doesNotMatch(contextMessage.content ?? "", /<memory_files>/);
});

test("file memory scan excludes daily logs from ordinary recall", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-logs-"));
  const runtime = createRuntime({
    cwd,
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    MemoryConfig: createMemoryConfig(),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd),
  });
  const saveTool = runtime.tools.find((tool) => tool.name === "MemorySave");
  assert.ok(saveTool);
  await saveTool.call(
    { memory: "User prefers durable topic memory files." },
    runtime.toolUseContext,
    runtime,
    createState(),
  );

  const logsDir = join(getFileMemoryLogsDir(runtime), "2026", "07");
  await mkdir(logsDir, { recursive: true });
  await writeFile(
    join(logsDir, "2026-07-13.md"),
    "- 09:00 Raw daily log signal that is not formal memory yet.\n",
    "utf8",
  );

  const headers = await scanFileMemoryHeaders(runtime);

  assert.ok(headers.some((header) =>
    header.filename.includes("durable-topic-memory-files")
  ));
  assert.equal(headers.some((header) => header.filename.startsWith("logs/")), false);
});

test("manual memory dream skips when another dream lock exists", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-memory-dream-lock-"));
  const runtime = createRuntime({
    cwd,
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    MemoryConfig: createMemoryConfig(),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd),
  });
  const memoryDir = getFileMemoryDir(runtime);
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, ".dream.lock"), "locked", "utf8");

  assert.deepEqual(await runMemoryDream(runtime, createState()), {
    status: "skipped",
    reason: "locked",
  });
});

test("manual memory dream lists recent session transcripts for cross-session consolidation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-memory-dream-sessions-"));
  const runtime = createRuntime({
    cwd,
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    MemoryConfig: createMemoryConfig(),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd),
  });
  const transcriptDir = join(cwd, ".opencat", "transcripts");
  await mkdir(transcriptDir, { recursive: true });
  const oldTranscript = join(transcriptDir, "session_old.jsonl");
  const newTranscript = join(transcriptDir, "session_new.jsonl");
  await writeFile(oldTranscript, "{\"type\":\"message\"}\n", "utf8");
  await writeFile(newTranscript, "{\"type\":\"message\"}\n", "utf8");
  await mkdir(join(transcriptDir, "session_new"), { recursive: true });
  await writeFile(
    join(transcriptDir, "session_new", "agent.jsonl"),
    "{\"type\":\"message\"}\n",
    "utf8",
  );
  await utimes(
    oldTranscript,
    new Date("2026-07-10T00:00:00.000Z"),
    new Date("2026-07-10T00:00:00.000Z"),
  );
  await utimes(
    newTranscript,
    new Date("2026-07-11T00:00:00.000Z"),
    new Date("2026-07-11T00:00:00.000Z"),
  );

  const transcripts = await listRecentMemoryDreamTranscripts(runtime, 1);

  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0]?.filename, "session_new.jsonl");
});

test("file memory defaults to a user-level project directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-default-"));
  const runtime = createRuntime({
    cwd,
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    MemoryConfig: createMemoryConfig(),
    longTermMemoryConfig: {
      userId: "user-1",
    },
  });

  assert.match(
    getFileMemoryDir(runtime),
    /[\\\/]\.opencat[\\\/]memory[\\\/]projects[\\\/]/,
  );
});

test("completed query long-term memory extraction is deferred for file memory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-extract-"));
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
    cwd,
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    deepSeekClient: createBackgroundMemoryClient(),
    MemoryConfig: createMemoryConfig(),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd, {
      autoExtract: true,
    }),
  });

  const result = await extractLongTermMemoryForCompletedQuery(runtime, state, {
    turnStartMessageId: currentUser.id,
    turnStartedAt: Date.UTC(2026, 5, 30),
  });

  assert.deepEqual(result, {
    status: "skipped",
    reason: "file_memory_extract_launched",
  });
});

test("completed query long-term memory extraction does not hydrate transcript in first file-memory version", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-long-memory-transcript-"));
  const runtime = createRuntime({
    cwd,
    sessionId: "long_memory_transcript_fallback",
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    deepSeekClient: createBackgroundMemoryClient(),
    MemoryConfig: createMemoryConfig(),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd, {
      autoExtract: true,
    }),
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
    status: "skipped",
    reason: "no_extractable_messages",
  });
});

test("completed query long-term memory extraction skips when main agent saved memory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-main-save-"));
  const user = createMessage({ role: "user", content: "Please remember my preference." });
  const assistant = createMessage({
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "call_memory",
      type: "function",
      function: {
        name: "MemorySave",
        arguments: JSON.stringify({ memory: "User prefers terse replies." }),
      },
    }],
  });
  const finalAssistant = createMessage({
    role: "assistant",
    content: "Remembered.",
  });
  const state = createState({
    messages: [user, assistant, finalAssistant],
  });
  const runtime = createRuntime({
    cwd,
    deepSeekRuntimeConfig: createDeepSeekConfig(),
    deepSeekClient: createBackgroundMemoryClient(),
    MemoryConfig: createMemoryConfig(),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd, {
      autoExtract: true,
    }),
  });

  const result = await extractLongTermMemoryForCompletedQuery(runtime, state, {
    turnStartMessageId: user.id,
  });

  assert.deepEqual(result, {
    status: "skipped",
    reason: "memory_saved_by_main_agent",
  });
});

function createDeepSeekConfig() {
  return {
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    maxTokens: 1024,
  } as const;
}

function createLongTermMemoryConfig(
  cwd: string,
  options: Record<string, unknown> = {},
) {
  return {
    userId: "user-1",
    fileMemoryDirectory: join(cwd, ".opencat", "memory"),
    ...options,
  };
}

function createMemorySelectorClient(selectedPrefixes: string[]) {
  return {
    async create(input: any) {
      const userContent = input.messages?.find((message: any) =>
        message.role === "user"
      )?.content ?? "";
      const selectedFiles = selectMemoryFilenamesFromManifest(
        String(userContent),
        selectedPrefixes,
      );
      return {
        id: "memory_selector",
        object: "chat.completion",
        created: 0,
        model: "deepseek-v4-pro",
        choices: [{
          index: 0,
          finish_reason: "stop",
          logprobs: null,
          message: {
            role: "assistant",
            content: JSON.stringify({
              selected_files: selectedFiles,
            }),
          },
        }],
      };
    },
    async *stream() {
      throw new Error("stream not used");
    },
    async collectStream() {
      throw new Error("collectStream not used");
    },
  } as any;
}

function createBackgroundMemoryClient() {
  return {
    async create() {
      throw new Error("create not used");
    },
    async *stream() {
      yield {
        done: false,
        raw: "{}",
        chunk: {
          id: "background_memory",
          object: "chat.completion.chunk",
          created: 0,
          model: "deepseek-v4-pro",
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              content: "No durable memory was needed.",
            },
            finish_reason: "stop",
          }],
        },
      };
      yield {
        done: true,
        raw: "[DONE]",
        chunk: null,
      };
    },
    async collectStream() {
      throw new Error("collectStream not used");
    },
  } as any;
}

function selectMemoryFilenamesFromManifest(
  manifestPrompt: string,
  prefixes: readonly string[],
): string[] {
  const selected: string[] = [];
  for (const line of manifestPrompt.split(/\r?\n/)) {
    const match = /^- (?:\[[^\]]+\] )?([^:]+):/.exec(line.trim());
    if (!match) {
      continue;
    }

    const filename = match[1];
    if (prefixes.some((prefix) => filename.startsWith(prefix))) {
      selected.push(filename);
    }
  }

  return selected;
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
