import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { getAppConfig, parseAppConfig } from "../src/config/load-config.js";
import type { OpenAICompatibleClient } from "../src/openai-compatible/model-client.js";
import type { ModelMessage, ModelStreamEnvelope, ModelToolCall } from "../src/openai-compatible/types.js";
import { query } from "../src/query.js";
import type { QueryEvent } from "../src/query/types.js";
import type { EvaluationEvent } from "../src/telemetry/events.js";
import type { Tool } from "../src/Tools/types.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime, type Runtime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

function textChunk(content: string): ModelStreamEnvelope {
  return {
    raw: "",
    done: false,
    chunk: {
      id: "query-test-response", object: "chat.completion.chunk", created: 0, model: "test-model",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }],
    },
  };
}

function clientFor(stream: OpenAICompatibleClient["stream"]): OpenAICompatibleClient {
  return {
    stream,
    async create() { throw new Error("Unexpected non-streaming request"); },
    async collectStream() { throw new Error("Unexpected collectStream request"); },
  };
}

async function fixture(t: TestContext, client: OpenAICompatibleClient, tools: Tool[] = [], model = "test-model") {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-query-lifecycle-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const appConfig = parseAppConfig({
    model: { provider: "openai-compatible", apiKey: "test-key", model },
    memory: { enabled: false, autoInject: false, autoExtract: false },
  });
  const telemetry: EvaluationEvent[] = [];
  const runtime = createRuntime({
    cwd,
    appConfig,
    modelRuntimeConfig: appConfig.model,
    modelClient: client,
    longTermMemoryConfig: appConfig.memory,
    tools,
    observer: { emit(event) { telemetry.push(event); } },
  });
  const state = createState({ messages: [createMessage({ role: "user", content: "hello" })] });
  return { runtime, state, telemetry };
}

function grantTemporaryCommand(runtime: Runtime): void {
  runtime.toolUseContext.permissionContext = {
    ...runtime.toolUseContext.permissionContext,
    alwaysAllowRules: { command: ["Bash(echo test)"], session: ["Read"] },
  };
}

test("zero-turn queries do not sample and clear only temporary command rules", async (t) => {
  const { runtime, state, telemetry } = await fixture(t, clientFor(async function* () {
    throw new Error("A zero-turn query must not call the model");
  }));
  grantTemporaryCommand(runtime);
  const events: QueryEvent[] = [];
  for await (const event of query(runtime, state, { maxTurns: 0 })) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["done"]);
  assert.equal((events[0] as Extract<QueryEvent, { type: "done" }>).reason, "max_turns");
  assert.deepEqual(telemetry.map((event) => event.type), ["query_started", "query_finished"]);
  assert.deepEqual(runtime.toolUseContext.permissionContext.alwaysAllowRules, { session: ["Read"] });
});

test("returning the query iterator early clears temporary permissions without claiming completion", async (t) => {
  const { runtime, state, telemetry } = await fixture(t, clientFor(async function* () {
    throw new Error("The model must not run before context is consumed");
  }));
  const iterator = query(runtime, state);
  assert.equal((await iterator.next()).value?.type, "context_ready");
  grantTemporaryCommand(runtime);
  await iterator.return();
  assert.deepEqual(runtime.toolUseContext.permissionContext.alwaysAllowRules, { session: ["Read"] });
  assert.equal(telemetry.some((event) => event.type === "query_finished"), false);
  assert.equal(telemetry.some((event) => event.type === "query_failed"), false);
});

test("model failures keep their error identity and emit failure before cleaning query permissions", async (t) => {
  const failure = new Error("local stream failed");
  const { runtime, state, telemetry } = await fixture(t, clientFor(async function* () {
    grantTemporaryCommand(runtime);
    throw failure;
  }));
  const events: QueryEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of query(runtime, state)) events.push(event);
  }, (error) => error === failure);
  assert.equal(telemetry.at(-1)?.type, "query_failed");
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.equal(state.Messages.some((message) => message.role === "assistant"), false);
  assert.equal(runtime.toolUseContext.permissionContext.alwaysAllowRules.command, undefined);
});

test("already aborted queries never prepare context or call the model", async (t) => {
  const { runtime, state, telemetry } = await fixture(t, clientFor(async function* () {
    throw new Error("Aborted queries must not call the model");
  }));
  const reason = new Error("stopped before query");
  runtime.toolUseContext.abortController.abort(reason);
  await assert.rejects(async () => {
    for await (const _event of query(runtime, state)) {}
  }, (error) => error === reason);
  assert.deepEqual(telemetry.map((event) => event.type), ["query_started", "query_failed"]);
});

test("interleaved query generators sample inside their owning configuration scope", async (t) => {
  const callerConfig = getAppConfig();
  const sampledModels: string[] = [];
  const client = clientFor(async function* () {
    sampledModels.push(getAppConfig().model.model);
    yield textChunk("OK");
  });
  const first = await fixture(t, client, [], "model-a");
  const second = await fixture(t, client, [], "model-b");
  const queries = [query(first.runtime, first.state), query(second.runtime, second.state)];
  t.after(async () => { for (const iterator of queries) await iterator.return(); });
  for (const iterator of queries) assert.equal((await iterator.next()).value?.type, "context_ready");
  for (const iterator of queries) assert.equal((await iterator.next()).value?.type, "model_stream_start");
  for (const iterator of queries) await iterator.next();
  assert.deepEqual(sampledModels, ["model-a", "model-b"]);
  assert.equal(getAppConfig(), callerConfig);
});

test("cache-safe forks keep the inherited first-request prefix without compression or rematerialization", async (t) => {
  let requestedMessages: ModelMessage[] = [];
  const { runtime, state, telemetry } = await fixture(t, clientFor(async function* (request) {
    requestedMessages = request.messages;
    yield textChunk("OK");
  }));
  const inherited: ModelMessage[] = [
    { role: "user", content: "parent question" },
    { role: "assistant", content: "", tool_calls: [{ id: "parent-call", type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "parent-call", content: "parent file contents" },
  ];
  state.Messages = inherited.map((message) => createMessage(message));
  const inheritedState = state.Messages.map((message) => ({ ...message }));
  runtime.systemPrompt = "fixed-parent-system";
  runtime.contextCompressionConfig = { autoCompressTriggerTokens: 1 };
  for await (const _event of query(runtime, state, {
    usePreprojectedMessagesOnFirstTurn: true,
    skipRequestContextMaterialization: true,
  })) {}
  assert.deepEqual(requestedMessages[0], { role: "system", content: "fixed-parent-system" });
  // 请求头仍有项目 / 日期提醒；继承的业务前缀必须保持原来的内容和顺序。
  assert.deepEqual(requestedMessages.slice(-inherited.length), inherited);
  assert.deepEqual(runtime.lastModelRequestContextMessages, inheritedState);
  assert.equal(telemetry.some((event) => event.type === "auto_compress_started"), false);
});

test("parallel tool completion preserves model order in events, State and transcript", async (t) => {
  const calls: ModelToolCall[] = ["Slow", "Fast"].map((name) => ({
    id: `call-${name}`, type: "function", function: { name, arguments: "{}" },
  }));
  const completed: string[] = [];
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const tools = calls.map((call): Tool => ({
    name: call.function.name,
    inputSchema: z.object({}), outputSchema: z.string(),
    description: () => "Local ordering test", prompt: () => "",
    isConcurrencySafe: () => true,
    async call() {
      if (call.function.name === "Slow") await slowGate;
      completed.push(call.function.name);
      if (call.function.name === "Fast") releaseSlow();
      return call.function.name;
    },
  }));
  const client = clientFor(async function* () {
    yield {
      raw: "", done: false,
      chunk: {
        id: "tool-response", object: "chat.completion.chunk", created: 0, model: "test-model",
        choices: [{ index: 0, delta: {
          role: "assistant", tool_calls: calls.map((call, index) => ({ ...call, index })),
        }, finish_reason: "tool_calls" }],
      },
    };
  });
  const { runtime, state } = await fixture(t, client, tools);
  const events: QueryEvent[] = [];
  for await (const event of query(runtime, state, { maxTurns: 1 })) events.push(event);
  assert.deepEqual(completed, ["Fast", "Slow"]);
  assert.deepEqual(events.filter((event) => event.type === "tool_result").map((event) => event.toolCall.id), ["call-Slow", "call-Fast"]);
  assert.deepEqual(state.Messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id), ["call-Slow", "call-Fast"]);
  const transcript = (await readFile(runtime.transcriptStore!.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(transcript.filter((entry) => entry.type === "message" && entry.message.role === "tool").map((entry) => entry.message.tool_call_id), ["call-Slow", "call-Fast"]);
});
