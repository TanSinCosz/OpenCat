import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Script } from "node:vm";
import { parseAppConfig } from "../src/config/load-config.js";
import { renderHtml } from "../src/interfaces/web/page.js";
import { createWebRequestHandler } from "../src/interfaces/web/routes.js";
import { WebSessionManager } from "../src/interfaces/web/session-manager.js";
import {
  createToolPermissionRequestForSession,
  denyAllPendingToolApprovalsForSession,
} from "../src/interfaces/web/tool-permissions.js";
import type { WebCliSession } from "../src/interfaces/web/types.js";
import type { OpenAICompatibleClient } from "../src/openai-compatible/model-client.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

const config = parseAppConfig({
  model: { apiKey: "test-key", model: "deepseek-v4-flash" },
  memory: { enabled: false, autoInject: false, autoExtract: false },
});

async function createSession(t: TestContext): Promise<WebCliSession> {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-web-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const modelClient: OpenAICompatibleClient = {
    async create() { throw new Error("Unexpected non-streaming model request"); },
    async collectStream() { throw new Error("Unexpected collectStream request"); },
    async *stream() {
      yield {
        raw: "",
        done: false,
        chunk: {
          id: "web-test-response",
          object: "chat.completion.chunk",
          created: 0,
          model: config.model.model,
          choices: [{ index: 0, delta: { role: "assistant", content: "Local test response" }, finish_reason: "stop" }],
        },
      };
      yield { raw: "[DONE]", done: true, chunk: null };
    },
  };
  return {
    runtime: createRuntime({
      cwd,
      sessionId: "session_web_test",
      appConfig: config,
      modelRuntimeConfig: config.model,
      modelClient,
      longTermMemoryConfig: config.memory,
      transcriptStore: false,
      tools: [],
    }),
    state: createState(),
    sweDatasetDir: cwd,
    busy: false,
    clientAttached: false,
    pendingToolApprovals: new Map(),
    loadInfo: { restored: false, hydrate: "auto", messageCount: 0 },
  };
}

async function serve(t: TestContext, session: WebCliSession) {
  // 显式传入本地会话，不读取开发者的 transcript，也不启动 MCP。
  const sessions = new WebSessionManager(session);
  const server = createServer(createWebRequestHandler(sessions));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { sessions, baseUrl: `http://127.0.0.1:${address.port}` };
}

const approvalRequest = {
  approvalId: "approval-test",
  toolCall: { id: "tool-call-test", type: "function" as const, function: { name: "Bash", arguments: '{"command":"echo test"}' } },
  mode: "plan" as const,
  reason: "Approval required",
};

test("page resources keep matching nonces and produce valid browser JavaScript", () => {
  const html = renderHtml();
  const style = html.match(/<style nonce="([^"]+)">/);
  const script = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert.ok(style && script);
  assert.equal(style[1], script[1]);
  assert.doesNotThrow(() => new Script(script[2]!));
  assert.match(html, /id="session-list"/);
  assert.match(html, /id="patch-modal"/);
});

test("HTTP session history hides runtime context and follows the selected session", async (t) => {
  const first = await createSession(t);
  first.state.Messages.push(
    createMessage({ role: "system", content: "hidden system prompt" }),
    createMessage({ role: "user", content: "hidden context" }, { source: "runtime" }),
    createMessage({ role: "user", content: "visible question" }),
  );
  const { baseUrl, sessions } = await serve(t, first);
  const history = await (await fetch(`${baseUrl}/api/session/messages`)).json() as any;
  assert.equal(history.total, 3);
  assert.deepEqual(history.messages, [{ role: "user", content: "visible question" }]);

  const second = await createSession(t);
  second.runtime.sessionId = "session_second";
  sessions.current = second;
  const info = await (await fetch(`${baseUrl}/api/session`)).json() as any;
  assert.equal(info.sessionId, "session_second");
  assert.equal(info.messageCount, 0);
});

test("query route rejects empty and concurrent requests", async (t) => {
  const session = await createSession(t);
  const { baseUrl } = await serve(t, session);
  const empty = await fetch(`${baseUrl}/api/query`, { method: "POST", body: '{"prompt":" "}' });
  assert.equal(empty.status, 400);
  session.busy = true;
  const concurrent = await fetch(`${baseUrl}/api/query`, { method: "POST", body: '{"prompt":"hello"}' });
  assert.equal(concurrent.status, 409);
});

test("query route streams model events and restores the session execution state", async (t) => {
  const session = await createSession(t);
  const originalController = session.runtime.toolUseContext.abortController;
  const { baseUrl } = await serve(t, session);
  const response = await fetch(`${baseUrl}/api/query`, {
    method: "POST",
    body: JSON.stringify({ prompt: "hello" }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /application\/x-ndjson/);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events[0].type, "user_message");
  assert.ok(events.some((event) => event.type === "assistant_message" && event.message.content === "Local test response"));
  assert.equal(session.busy, false);
  assert.equal(session.clientAttached, false);
  assert.equal(session.activeQueryAbortController, undefined);
  assert.equal(session.runtime.toolUseContext.abortController, originalController);
  assert.equal(session.state.Messages.at(-1)?.content, "Local test response");
});

test("permission responses are scoped to the current session", async (t) => {
  const first = await createSession(t);
  first.clientAttached = true;
  const pending = createToolPermissionRequestForSession(first, approvalRequest);
  t.after(() => denyAllPendingToolApprovalsForSession(first, "test cleanup"));
  const { baseUrl, sessions } = await serve(t, first);
  sessions.current = await createSession(t);
  const missing = await fetch(`${baseUrl}/api/tool-permission`, {
    method: "POST", body: JSON.stringify({ approvalId: approvalRequest.approvalId, decision: "allow" }),
  });
  assert.equal(missing.status, 404);
  assert.equal(first.pendingToolApprovals.size, 1);

  sessions.current = first;
  const allowed = await fetch(`${baseUrl}/api/tool-permission`, {
    method: "POST", body: JSON.stringify({ approvalId: approvalRequest.approvalId, decision: "allow" }),
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await pending, { behavior: "allow" });
  assert.equal(first.pendingToolApprovals.size, 0);
});

test("switching sessions during a query preserves ownership and closes old connections", async (t) => {
  const first = await createSession(t);
  const second = await createSession(t);
  let releaseStream!: () => void;
  let signalStreamStarted!: () => void;
  const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
  const streamStarted = new Promise<void>((resolve) => { signalStreamStarted = resolve; });
  const originalClient = first.runtime.modelClient;
  first.runtime.modelClient = {
    ...originalClient,
    async *stream(input) {
      signalStreamStarted();
      await streamGate;
      yield* originalClient.stream(input);
    },
  };
  let closeCount = 0;
  first.runtime.mcpConnections = [{
    tools: [],
    client: {
      serverName: "local-test",
      async listTools() { return { tools: [] }; },
      async callTool() { throw new Error("Unexpected MCP tool call"); },
      close() { closeCount++; },
    },
  }];
  t.after(releaseStream);
  const { baseUrl, sessions } = await serve(t, first);
  const responseTask = fetch(`${baseUrl}/api/query`, {
    method: "POST", body: JSON.stringify({ prompt: "continue in the original session" }),
  });
  await streamStarted;
  assert.equal(first.busy, true);
  sessions.current = second;
  assert.equal(closeCount, 0);
  releaseStream();
  const response = await responseTask;
  await response.text();
  assert.equal(first.state.Messages.at(-1)?.content, "Local test response");
  assert.equal(second.state.Messages.length, 0);
  assert.equal(first.busy, false);
  assert.equal(closeCount, 1);
});

test("detached clients and query cleanup settle pending permissions", async (t) => {
  const session = await createSession(t);
  const detached = await createToolPermissionRequestForSession(session, approvalRequest);
  assert.equal(detached.behavior, "deny");
  session.clientAttached = true;
  const pending = createToolPermissionRequestForSession(session, approvalRequest);
  denyAllPendingToolApprovalsForSession(session, "client detached");
  assert.deepEqual(await pending, { behavior: "deny", reason: "client detached" });
  assert.equal(session.pendingToolApprovals.size, 0);
});

test("stop route aborts the active query and settles approvals", async (t) => {
  const session = await createSession(t);
  session.busy = true;
  session.clientAttached = true;
  session.activeQueryAbortController = new AbortController();
  const pending = createToolPermissionRequestForSession(session, approvalRequest);
  t.after(() => denyAllPendingToolApprovalsForSession(session, "test cleanup"));
  const { baseUrl } = await serve(t, session);
  const response = await fetch(`${baseUrl}/api/query/stop`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(session.activeQueryAbortController.signal.aborted, true);
  assert.equal((await pending).behavior, "deny");
});

test("unknown routes return a text 404", async (t) => {
  const { baseUrl } = await serve(t, await createSession(t));
  const response = await fetch(`${baseUrl}/unknown`);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
});
