import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  listRecentMemoryDreamTranscripts,
  runMemoryDream,
} from "../src/Memory/auto-dream.js";
import {
  getFileMemoryDailyLogPath,
  getFileMemoryDir,
  getFileMemoryLogsDir,
  loadFileMemoryEntrypoint,
  MAX_FILE_MEMORY_ENTRYPOINT_CHARS,
  MAX_FILE_MEMORY_ENTRYPOINT_LINES,
  saveFileMemory,
  scanFileMemoryHeaders,
  truncateFileMemoryEntrypoint,
} from "../src/Memory/file-memory.js";
import {
  buildFileMemoryExtractionPrompt,
  createLongTermMemoryContextMessage,
  drainPendingLongTermMemoryExtractions,
  extractLongTermMemoryForCompletedQuery,
} from "../src/query/long-term-memory.js";
import { recordTranscriptMessage } from "../src/transcript/persistence.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

const execFile = promisify(execFileCallback);

test("MemorySave stages an append-only daily-log signal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-save-"));
  const state = createState();
  const runtime = createRuntime({
    cwd,
    sessionId: "session_memory_save_metadata",
    modelRuntimeConfig: createDeepSeekConfig(),
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
  const dailyLog = await readFile(path, "utf8");
  assert.match(dailyLog, /type: feedback/);
  assert.match(dailyLog, /operation: save/);
  assert.match(
    dailyLog,
    /originSessionId: session_memory_save_metadata/,
  );
  assert.equal(
    saveOutput.results[0]?.metadata?.originSessionId,
    "session_memory_save_metadata",
  );
  assert.equal(saveOutput.results[0]?.metadata?.node_type, "memory");
  assert.equal(await loadFileMemoryEntrypoint(runtime), null);
  assert.deepEqual(await scanFileMemoryHeaders(runtime), []);
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
    modelRuntimeConfig: createDeepSeekConfig(),
    modelClient: createMemorySelectorClient([
      "user-prefers-repo-grounded-implementation-notes",
    ]),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd, {
      autoInject: true,
    }),
  });
  await saveFileMemory(runtime, {
    memory: "User prefers repo-grounded implementation notes.",
  });

  const contextMessage = await createLongTermMemoryContextMessage(
    runtime,
    state.Messages,
    state.longTermMemory,
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

test("recalled topic files use bounded content and stale-memory warnings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-topic-cap-"));
  const state = createState({
    messages: [
      createMessage({
        role: "user",
        content: "Recall the large durable memory.",
      }),
    ],
  });
  const runtime = createRuntime({
    cwd,
    modelRuntimeConfig: createDeepSeekConfig(),
    modelClient: createMemorySelectorClient(["large-durable-memory"]),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd, {
      autoInject: true,
    }),
  });
  const saved = await saveFileMemory(runtime, {
    memory: `Large durable memory.\n${"x".repeat(8_000)}`,
  });
  const path = saved.results[0]?.metadata.path;
  assert.ok(path);
  await utimes(
    path,
    new Date("2026-07-01T00:00:00.000Z"),
    new Date("2026-07-01T00:00:00.000Z"),
  );

  const context = await createLongTermMemoryContextMessage(
    runtime,
    state.Messages,
    state.longTermMemory,
  );

  assert.ok(context);
  assert.match(context.content ?? "", /Memory file truncated/);
  assert.match(context.content ?? "", /Freshness warning/);
  assert.ok(Buffer.byteLength(context.content ?? "", "utf8") < 6_000);
});

test("long-term memory recall stops at the 60 KiB session budget", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-session-cap-"));
  const state = createState({
    messages: [
      createMessage({ role: "user", content: "Recall the durable preference." }),
    ],
    longTermMemory: {
      surfacedFiles: {},
      surfacedBytes: 60 * 1_024,
    },
  });
  const runtime = createRuntime({
    cwd,
    modelRuntimeConfig: createDeepSeekConfig(),
    modelClient: createMemorySelectorClient(["durable-preference"]),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd, {
      autoInject: true,
    }),
  });
  await saveFileMemory(runtime, {
    memory: "Durable preference for bounded recall.",
  });

  assert.equal(
    await createLongTermMemoryContextMessage(
      runtime,
      state.Messages,
      state.longTermMemory,
    ),
    null,
  );
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
      createMessage({
        role: "user",
        content: "real current user query",
      }),
    ],
  });
  let selectorInput = "";
  const runtime = createRuntime({
    cwd,
    modelRuntimeConfig: createDeepSeekConfig(),
    modelClient: createMemorySelectorClient([], (input) => {
      selectorInput = input;
    }),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd, {
      autoInject: true,
    }),
  });
  await saveFileMemory(runtime, {
    memory: "User prefers concise Chinese explanations.",
  });

  const context = await createLongTermMemoryContextMessage(
    runtime,
    state.Messages,
  );
  assert.equal(context, null);
  assert.match(selectorInput, /Query:\nreal current user query/);
  assert.doesNotMatch(selectorInput, /synthetic long memory/);
});

test("MEMORY.md loading follows the 200-line and 25K entrypoint caps", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-cap-"));
  const runtime = createRuntime({
    cwd,
    modelRuntimeConfig: createDeepSeekConfig(),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd),
  });
  const memoryDir = getFileMemoryDir(runtime);
  await mkdir(memoryDir, { recursive: true });
  const lines = Array.from(
    { length: MAX_FILE_MEMORY_ENTRYPOINT_LINES + 10 },
    (_, index) => `- [Memory ${index}](memory-${index}.md) - ${"x".repeat(180)}`,
  );
  await writeFile(join(memoryDir, "MEMORY.md"), lines.join("\n"), "utf8");

  const loaded = await loadFileMemoryEntrypoint(runtime);

  assert.ok(loaded);
  assert.match(loaded.content, /MEMORY\.md was truncated/);
  assert.ok(loaded.content.includes("Memory 0"));
  assert.ok(!loaded.content.includes(`Memory ${MAX_FILE_MEMORY_ENTRYPOINT_LINES + 1}`));
  assert.ok(
    truncateFileMemoryEntrypoint("x".repeat(
      MAX_FILE_MEMORY_ENTRYPOINT_CHARS + 100,
    )).includes("MEMORY.md was truncated"),
  );
});

test("default memory scope is shared by worktrees of the same git repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencat-memory-worktree-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  await mkdir(repo, { recursive: true });
  await execFile("git", ["init"], { cwd: repo });
  await execFile("git", ["config", "user.email", "memory-test@example.com"], {
    cwd: repo,
  });
  await execFile("git", ["config", "user.name", "Memory Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "memory test\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: repo });
  await execFile("git", ["commit", "-m", "initial"], { cwd: repo });
  await execFile("git", ["worktree", "add", "-b", "memory-test", worktree], {
    cwd: repo,
  });

  const rootRuntime = createRuntime({
    cwd: repo,
    modelRuntimeConfig: createDeepSeekConfig(),
    longTermMemoryConfig: { userId: "user-1" },
  });
  const nestedRuntime = createRuntime({
    cwd: worktree,
    modelRuntimeConfig: createDeepSeekConfig(),
    longTermMemoryConfig: { userId: "user-1" },
  });

  assert.equal(getFileMemoryDir(rootRuntime), getFileMemoryDir(nestedRuntime));
});

test("background extraction prompt stages append-only daily-log entries", () => {
  const prompt = buildFileMemoryExtractionPrompt({
    memoryDir: "C:\\memory",
    dailyLogPath: "C:\\memory\\logs\\2026\\07\\2026-07-26.md",
    currentTimestamp: "2026-07-26T12:34:56.000Z",
    newMessageCount: 8,
    existingMemories: "- [feedback] feedback.md: Testing - Prefer real DB tests",
    originSessionId: "session_extract_metadata",
  });

  assert.match(prompt, /only use content from the last ~8 messages/i);
  assert.match(prompt, /append-only log/i);
  assert.match(prompt, /AutoDream later distills it/i);
  assert.match(prompt, /Never rewrite, reorganize, deduplicate, or delete/i);
  assert.match(prompt, /correction\/tombstone entry/i);
  assert.match(prompt, /originSessionId: session_extract_metadata/);
  assert.match(prompt, /Do not edit MEMORY\.md/i);
  assert.doesNotMatch(prompt, /Add one concise pointer to MEMORY\.md/i);
});

test("daily memory logs use the official year/month/date layout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-daily-path-"));
  const runtime = createRuntime({
    cwd,
    modelRuntimeConfig: createDeepSeekConfig(),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd),
  });

  assert.equal(
    getFileMemoryDailyLogPath(runtime, new Date(2026, 6, 26, 12, 0, 0)),
    join(
      getFileMemoryLogsDir(runtime),
      "2026",
      "07",
      "2026-07-26.md",
    ),
  );
});

test("long-term memory recall persists already-surfaced file versions", async () => {
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
    modelRuntimeConfig: createDeepSeekConfig(),
    modelClient: createMemorySelectorClient([
      "user-prefers-repo-grounded-implementation-notes",
    ]),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd, {
      autoInject: true,
    }),
  });
  await saveFileMemory(runtime, {
    memory: "User prefers repo-grounded implementation notes.",
  });
  const [header] = await scanFileMemoryHeaders(runtime);
  assert.ok(header);
  assert.deepEqual(header.metadata, {
    node_type: "memory",
    type: "user",
    originSessionId: runtime.sessionId,
  });
  const firstContext = await createLongTermMemoryContextMessage(
    runtime,
    state.Messages,
    state.longTermMemory,
  );
  const secondContext = await createLongTermMemoryContextMessage(
    runtime,
    state.Messages,
    state.longTermMemory,
  );

  assert.ok(firstContext);
  assert.equal(secondContext, null);
  assert.equal(
    state.longTermMemory.surfacedFiles[header.filename]?.modifiedAtMs,
    header.modifiedAtMs,
  );

  await utimes(
    header.path,
    new Date(header.modifiedAtMs + 2_000),
    new Date(header.modifiedAtMs + 2_000),
  );
  const changedContext = await createLongTermMemoryContextMessage(
    runtime,
    state.Messages,
    state.longTermMemory,
  );
  assert.ok(changedContext);
});

test("file memory scan excludes daily logs from ordinary recall", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-logs-"));
  const runtime = createRuntime({
    cwd,
    modelRuntimeConfig: createDeepSeekConfig(),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd),
  });
  await saveFileMemory(runtime, {
    memory: "User prefers durable topic memory files.",
  });

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
    modelRuntimeConfig: createDeepSeekConfig(),
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
    modelRuntimeConfig: createDeepSeekConfig(),
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
    modelRuntimeConfig: createDeepSeekConfig(),
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
    modelRuntimeConfig: createDeepSeekConfig(),
    modelClient: createBackgroundMemoryClient(),
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
  await drainPendingLongTermMemoryExtractions(runtime);
});

test("background extraction writes a staged daily log instead of formal memory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-stage-"));
  const sessionId = "session_daily_log_stage";
  let dailyLogPath = "";
  const user = createMessage({
    role: "user",
    content: "Remember that I prefer concise implementation summaries.",
  });
  const state = createState({
    messages: [
      user,
      createMessage({ role: "assistant", content: "Understood." }),
    ],
  });
  const runtime = createRuntime({
    cwd,
    sessionId,
    modelRuntimeConfig: createDeepSeekConfig(),
    longTermMemoryConfig: createLongTermMemoryConfig(cwd, {
      autoExtract: true,
    }),
  });
  dailyLogPath = getFileMemoryDailyLogPath(runtime);
  runtime.modelClient = createDailyLogWritingMemoryClient(
    () => dailyLogPath,
    sessionId,
  );

  await extractLongTermMemoryForCompletedQuery(runtime, state, {
    turnStartMessageId: user.id,
  });
  await drainPendingLongTermMemoryExtractions(runtime);

  const dailyLog = await readFile(dailyLogPath, "utf8");
  assert.match(dailyLog, /originSessionId: session_daily_log_stage/);
  assert.match(dailyLog, /concise implementation summaries/);
  assert.doesNotMatch(dailyLog, /overwrite prior entries/);
  assert.equal(await loadFileMemoryEntrypoint(runtime), null);
  assert.deepEqual(await scanFileMemoryHeaders(runtime), []);
});

test("completed query long-term memory extraction does not hydrate transcript in first file-memory version", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-long-memory-transcript-"));
  const runtime = createRuntime({
    cwd,
    sessionId: "long_memory_transcript_fallback",
    modelRuntimeConfig: createDeepSeekConfig(),
    modelClient: createBackgroundMemoryClient(),
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
    modelRuntimeConfig: createDeepSeekConfig(),
    modelClient: createBackgroundMemoryClient(),
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

test("background memory extraction serializes overlapping completed turns", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-queue-"));
  let streamCalls = 0;
  const client = createBackgroundMemoryClient({
    onStream: async () => {
      streamCalls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  });
  const firstUser = createMessage({ role: "user", content: "Remember preference one." });
  const firstAssistant = createMessage({ role: "assistant", content: "Understood." });
  const state = createState({ messages: [firstUser, firstAssistant] });
  const runtime = createRuntime({
    cwd,
    modelRuntimeConfig: createDeepSeekConfig(),
    modelClient: client,
    longTermMemoryConfig: createLongTermMemoryConfig(cwd, {
      autoExtract: true,
    }),
  });

  await extractLongTermMemoryForCompletedQuery(runtime, state, {
    turnStartMessageId: firstUser.id,
  });
  const secondUser = createMessage({ role: "user", content: "Remember preference two." });
  state.Messages.push(
    secondUser,
    createMessage({ role: "assistant", content: "Understood too." }),
  );
  await extractLongTermMemoryForCompletedQuery(runtime, state, {
    turnStartMessageId: secondUser.id,
  });

  await drainPendingLongTermMemoryExtractions(runtime);
  assert.equal(streamCalls, 2);
});

test("background extraction survives a cursor removed by auto-compression", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-memory-cursor-"));
  const prompts: string[] = [];
  const client = createBackgroundMemoryClient({
    onStream: (input) => {
      const messages = (input as {
        messages?: Array<{ content?: unknown }>;
      }).messages ?? [];
      prompts.push(messages
        .map((message) => typeof message.content === "string" ? message.content : "")
        .find((content) => content.includes("memory extraction subagent")) ?? "");
    },
  });
  const firstUser = createMessage({ role: "user", content: "Remember the first preference." });
  const state = createState({
    messages: [
      firstUser,
      createMessage({ role: "assistant", content: "Understood." }),
    ],
  });
  const runtime = createRuntime({
    cwd,
    modelRuntimeConfig: createDeepSeekConfig(),
    modelClient: client,
    longTermMemoryConfig: createLongTermMemoryConfig(cwd, {
      autoExtract: true,
    }),
  });

  await extractLongTermMemoryForCompletedQuery(runtime, state, {
    turnStartMessageId: firstUser.id,
  });
  await drainPendingLongTermMemoryExtractions(runtime);

  const secondUser = createMessage({ role: "user", content: "Remember the second preference." });
  state.Messages = [
    secondUser,
    createMessage({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_read",
        type: "function",
        function: {
          name: "Read",
          arguments: JSON.stringify({ file_path: "README.md" }),
        },
      }],
    }),
    createMessage({
      role: "tool",
      tool_call_id: "call_read",
      content: "README contents",
    }),
    createMessage({ role: "assistant", content: "Done." }),
  ];

  const result = await extractLongTermMemoryForCompletedQuery(runtime, state, {
    turnStartMessageId: secondUser.id,
  });
  await drainPendingLongTermMemoryExtractions(runtime);

  assert.deepEqual(result, {
    status: "skipped",
    reason: "file_memory_extract_launched",
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /most recent ~4 model-visible messages/i);
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

function createMemorySelectorClient(
  selectedPrefixes: string[],
  onInput?: (input: string) => void,
) {
  return {
    async create(input: any) {
      const userContent = input.messages?.find((message: any) =>
        message.role === "user"
      )?.content ?? "";
      onInput?.(String(userContent));
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

function createBackgroundMemoryClient(options: {
  onStream?: (input: unknown) => Promise<void> | void;
} = {}) {
  return {
    async create() {
      throw new Error("create not used");
    },
    async *stream(input: unknown) {
      await options.onStream?.(input);
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

function createDailyLogWritingMemoryClient(
  getDailyLogPath: () => string,
  originSessionId: string,
) {
  let streamCall = 0;
  return {
    async create() {
      throw new Error("create not used");
    },
    async *stream() {
      streamCall++;
      if (streamCall === 1) {
        yield {
          done: false,
          raw: "tool_call",
          chunk: {
            id: "background_memory_write",
            object: "chat.completion.chunk",
            created: 0,
            model: "deepseek-v4-pro",
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_write_daily_log",
                  type: "function",
                  function: {
                    name: "Write",
                    arguments: JSON.stringify({
                      file_path: getDailyLogPath(),
                      content: [
                        "# Memory log",
                        "",
                        `- 12:00 | type: feedback | originSessionId: ${originSessionId}`,
                        "  User prefers concise implementation summaries.",
                        "  **How to apply:** Keep future implementation summaries concise.",
                        "",
                      ].join("\n"),
                    }),
                  },
                }],
              },
              finish_reason: "tool_calls",
            }],
          },
        };
      } else if (streamCall === 2) {
        yield {
          done: false,
          raw: "tool_call",
          chunk: {
            id: "background_memory_overwrite",
            object: "chat.completion.chunk",
            created: 0,
            model: "deepseek-v4-pro",
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_overwrite_daily_log",
                  type: "function",
                  function: {
                    name: "Write",
                    arguments: JSON.stringify({
                      file_path: getDailyLogPath(),
                      content:
                        `- 12:01 | type: feedback | originSessionId: ${originSessionId}\n  overwrite prior entries\n`,
                    }),
                  },
                }],
              },
              finish_reason: "tool_calls",
            }],
          },
        };
      } else {
        yield {
          done: false,
          raw: "{}",
          chunk: {
            id: "background_memory_done",
            object: "chat.completion.chunk",
            created: 0,
            model: "deepseek-v4-pro",
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                content: "Staged one durable signal.",
              },
              finish_reason: "stop",
            }],
          },
        };
      }
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
    const match = /^- (?:\[[^\]]+\] )?(\S+\.md) \(/.exec(line.trim());
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
