import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Script } from "node:vm";
import { parseAppConfig } from "../src/config/load-config.js";
import { loadCaseConversation, loadCaseEvents } from "../src/evaluation/conversation.js";
import { summarizeCase, summarizeTotals } from "../src/evaluation/metrics.js";
import { resolveEvalRoot } from "../src/evaluation/paths.js";
import { readDatasetRecords, readJsonl } from "../src/evaluation/records.js";
import { createEvaluationService, type EvaluationService } from "../src/evaluation/service.js";
import type { JsonRecord, RunListItem } from "../src/evaluation/types.js";
import { createDashboardOptions, type DashboardOptions } from "../src/interfaces/evaluation/options.js";
import { renderDashboardHtml } from "../src/interfaces/evaluation/page.js";
import { createDashboardRequestHandler } from "../src/interfaces/evaluation/routes.js";
import { listenOnAvailablePort } from "../src/interfaces/evaluation/server.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value));
}

async function writeJsonl(filePath: string, values: unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, values.map((value) => JSON.stringify(value)).join("\n"));
}

async function fixture(t: TestContext) {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "opencat-evaluation-test-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const evalRoot = path.join(workspaceRoot, ".opencat/evals/swe-lite");
  await mkdir(evalRoot, { recursive: true });
  const config = parseAppConfig({
    model: { apiKey: "test-key", model: "deepseek-v4-flash" },
    evaluation: {
      directory: evalRoot,
      verified: { autoPrepareDataset: false, allowNetworkClone: false },
    },
    workspace: {
      sweWorkspaceDir: path.join(workspaceRoot, "workspaces"),
      sweRepoCacheDir: path.join(workspaceRoot, "repo-cache"),
    },
  });
  const options = createDashboardOptions(workspaceRoot, config, []);
  const service = createEvaluationService(options);
  return { workspaceRoot, evalRoot, options, service };
}

function runAt(evalRoot: string, name = "swe_current"): RunListItem {
  return {
    name,
    path: path.join(evalRoot, name),
    evalRoot,
    updatedAt: "2026-01-02T00:00:00.000Z",
    version: "v1",
  };
}

async function serve(t: TestContext, options: DashboardOptions, service: EvaluationService) {
  const server = createServer(createDashboardRequestHandler(options, service));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("dashboard options keep YAML priority, CLI selection and default dataset roots", () => {
  const workspaceRoot = path.resolve("test-project");
  const yaml = parseAppConfig({
    evaluation: { directory: path.join(workspaceRoot, "configured"), dashboardPort: 6000 },
    web: { url: "http://localhost:9000///" },
  });
  const configured = createDashboardOptions(workspaceRoot, yaml, ["--dataset", "ignored"]);
  assert.equal(configured.evalRoot, path.join(workspaceRoot, "configured"));
  assert.deepEqual(configured.evalRoots, [configured.evalRoot]);
  assert.equal(configured.webChatUrl, "http://localhost:9000");
  assert.equal(configured.port, 6000);
  const defaults = parseAppConfig({});
  const cli = createDashboardOptions(workspaceRoot, defaults, ["--dataset", path.join(workspaceRoot, "cli")]);
  assert.equal(cli.evalRoot, path.join(workspaceRoot, "cli"));
  assert.equal(createDashboardOptions(workspaceRoot, defaults, []).evalRoots.length, 3);
  assert.equal(resolveEvalRoot(configured, "outside"), configured.evalRoot);
});

test("event metrics take priority over summaries and totals use weighted cache hit rates", () => {
  const first = summarizeCase("a", [
    { type: "model_usage", promptTokens: 100, completionTokens: 10, totalTokens: 110, promptCacheHitTokens: 80, promptCacheMissTokens: 20 },
    { type: "tool_call_started", toolName: "Read" },
    { type: "tool_call_finished" },
    { type: "context_ready", estimatedTokens: 200, messageCount: 5, hasSessionMemory: true },
    { type: "auto_compress_finished", status: "compressed" },
    { type: "query_finished", reason: "completed" },
  ], { totalTokens: 999, promptTokens: 999 });
  const second = summarizeCase("b", [
    { type: "model_usage", promptTokens: 900, completionTokens: 20, totalTokens: 920, promptCacheHitTokens: 90, promptCacheMissTokens: 810 },
    { type: "parse_error", raw: "broken line" },
  ]);
  assert.equal(first.totalTokens, 110);
  assert.equal(first.toolCallCount, 1);
  assert.equal(first.autoCompressCount, 1);
  assert.equal(first.finishedReason, "completed");
  const totals = summarizeTotals([first, second]);
  assert.equal(totals.totalTokens, 1030);
  assert.equal(totals.cacheHitRate, 0.17);
  assert.equal(totals.maxEstimatedTokens, 200);
  assert.equal(totals.hasSessionMemory, true);
  assert.equal(totals.errorCount, 1);
  assert.equal(summarizeTotals([]).cacheHitRate, 0);
});

test("dataset reader supports arrays and keeps JSONL parse diagnostics", async (t) => {
  const { evalRoot } = await fixture(t);
  const arrayPath = path.join(evalRoot, "array.json");
  await writeJson(arrayPath, [{ instance_id: "case-a" }, null, 2]);
  assert.deepEqual(await readDatasetRecords(arrayPath), [{ instance_id: "case-a" }]);
  const jsonlPath = path.join(evalRoot, "events.jsonl");
  await writeFile(jsonlPath, '{"type":"query_started"}\ninvalid-json\n42\n');
  const records = await readJsonl(jsonlPath);
  assert.equal(records.length, 3);
  assert.equal(records[1]?.type, "parse_error");
  assert.equal(records[2]?.type, "unknown_json");
});

test("runs reuse historical metrics for skipped cases without replacing current metrics", async (t) => {
  const { evalRoot, service } = await fixture(t);
  const older = runAt(evalRoot, "swe_older");
  const current = runAt(evalRoot);
  await writeJson(path.join(older.path, "summary.json"), {
    results: [
      { instanceId: "case-a", status: "completed", promptTokens: 500, totalTokens: 500, promptCacheHitTokens: 400, promptCacheMissTokens: 100 },
      { instanceId: "case-b", status: "completed", totalTokens: 999 },
    ],
  });
  await writeJson(path.join(current.path, "summary.json"), {
    version: "v3",
    results: [
      { instanceId: "case-a", status: "skipped" },
      { instanceId: "case-b", status: "completed", promptTokens: 300, totalTokens: 300, promptCacheHitTokens: 0, promptCacheMissTokens: 300 },
    ],
  });
  await writeJsonl(path.join(evalRoot, "dataset.jsonl"), [
    { instance_id: "case-a", repo: "example/a", base_commit: "abc", problem_statement: "Issue A" },
    { instance_id: "case-b", repo: "example/b", base_commit: "def", problem_statement: "Issue B" },
  ]);
  await utimes(older.path, new Date("2026-01-01"), new Date("2026-01-01"));
  await utimes(current.path, new Date("2026-01-02"), new Date("2026-01-02"));
  const runs = await service.listRuns();
  assert.equal(runs[0]?.name, current.name);
  const detail = await service.loadRunDetail(await service.findRun(current.name));
  assert.equal(detail.version, "v3");
  assert.equal(detail.cases[0]?.totalTokens, 500);
  assert.equal(detail.cases[1]?.totalTokens, 300);
  assert.equal(detail.totals.totalTokens, 800);
  assert.equal(detail.totals.cacheHitRate, 0.5);
  assert.equal(detail.datasetItems.length, 2);
  assert.equal(detail.datasetItems[0]?.tested, true);
});

test("dataset-only roots remain visible before any evaluation has run", async (t) => {
  const { evalRoot, service } = await fixture(t);
  await writeJsonl(path.join(evalRoot, "dataset.jsonl"), [
    { instance_id: "case-a", repo: "example/a", base_commit: "abc", problem_statement: "Issue A" },
  ]);
  const runs = await service.listRuns();
  assert.equal(runs[0]?.datasetOnly, true);
  const detail = await service.loadRunDetail(runs[0]!);
  assert.equal(detail.cases.length, 0);
  assert.equal(detail.datasetItems[0]?.tested, false);
  assert.equal(detail.totals.totalTokens, 0);
});

test("evaluation services keep workspace defaults in their own configuration scopes", async (t) => {
  const { options, service } = await fixture(t);
  const otherWorkspaceRoot = path.join(options.workspaceRoot, "other-workspaces");
  const otherConfig = parseAppConfig({
    workspace: { sweWorkspaceDir: otherWorkspaceRoot },
  });
  const otherService = createEvaluationService({ ...options, appConfig: otherConfig });
  const instance = { instance_id: "case-a", repo: "example/a", base_commit: "abc" };
  const [first, second] = await Promise.all([
    service.getRepoWorkspaceStatus(instance),
    otherService.getRepoWorkspaceStatus(instance),
  ]);
  assert.equal(first.status, "missing");
  assert.equal(second.status, "missing");
  assert.ok(first.path.startsWith(options.appConfig.workspace.sweWorkspaceDir! + path.sep));
  assert.ok(second.path.startsWith(otherWorkspaceRoot + path.sep));
});

test("conversation uses transcript messages and normalizes compatible cache usage", async (t) => {
  const { evalRoot } = await fixture(t);
  const run = runAt(evalRoot);
  await writeJsonl(path.join(run.path, "case-a/events.jsonl"), [{ type: "query_started", sessionId: "session_test" }]);
  await writeJsonl(path.join(run.path, "case-a/repo/.opencat/transcripts/session_test.jsonl"), [
    { type: "state_snapshot", state: {} },
    { type: "message", agentId: "main", message: {
      role: "assistant", content: [{ text: "First" }, { text: "Second" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 60 } },
    } },
  ]);
  const conversation = await loadCaseConversation(run, "case-a", 20);
  assert.equal(conversation.sessionId, "session_test");
  assert.equal(conversation.messages[0]?.content, "First\nSecond");
  assert.equal(conversation.messages[0]?.usage?.cacheHitRate, 0.6);
  assert.equal(conversation.messages[0]?.usage?.cacheMissTokens, 40);
  assert.deepEqual(conversation.fallbackEvents, []);
});

test("conversation falls back to recent events and rejects paths outside the run", async (t) => {
  const { evalRoot } = await fixture(t);
  const run = runAt(evalRoot);
  await writeJsonl(path.join(run.path, "case-a/events.jsonl"), [{ type: "query_started" }, { type: "query_finished" }]);
  const conversation = await loadCaseConversation(run, "case-a", 1);
  assert.deepEqual(conversation.messages, []);
  assert.equal(conversation.fallbackEvents[0]?.type, "query_finished");
  assert.equal((await loadCaseEvents(run, "case-a", 1)).events[0]?.type, "query_finished");
  await assert.rejects(loadCaseEvents(run, "..", 10), /Invalid case path/);
  await assert.rejects(loadCaseConversation(run, "../outside", 10), /Invalid case path/);
});

test("dashboard page renders valid browser JavaScript with its configured dataset and chat URL", async (t) => {
  const { options } = await fixture(t);
  const html = renderDashboardHtml(options);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  assert.match(script, /const dashboardDatasetDir = "\.opencat\/evals\/swe-lite"/);
  assert.match(script, /http:\/\/localhost:5177/);
});

test("dashboard routes expose run details, recent events, missing items and errors", async (t) => {
  const { evalRoot, options, service } = await fixture(t);
  const run = runAt(evalRoot);
  await writeJson(path.join(run.path, "summary.json"), { results: [] });
  await writeJsonl(path.join(run.path, "case-a/events.jsonl"), [{ type: "query_started" }, { type: "query_finished" }]);
  const baseUrl = await serve(t, options, service);
  const response = await fetch(`${baseUrl}/api/runs`);
  assert.equal(response.status, 200);
  const runs = await response.json() as RunListItem[];
  assert.equal(runs[0]?.name, run.name);
  const detail = await (await fetch(`${baseUrl}/api/run?name=${run.name}`)).json() as JsonRecord;
  assert.equal(detail.version, "v1");
  const events = await (await fetch(`${baseUrl}/api/events?run=${run.name}&case=case-a&limit=1`)).json() as { events: JsonRecord[] };
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0]?.type, "query_finished");
  assert.equal((await fetch(`${baseUrl}/api/events?case=..`)).status, 500);
  assert.equal((await fetch(`${baseUrl}/api/patch?instanceId=missing`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/prepare-repo`, { method: "POST", body: "{}" })).status, 404);
  assert.equal((await fetch(`${baseUrl}/unknown`)).status, 404);
  const page = await fetch(baseUrl);
  assert.equal(await page.text(), renderDashboardHtml(options));
});

test("prepare-all route loads the selected dataset and preserves its order", async (t) => {
  const { options, service } = await fixture(t);
  const calls: string[] = [];
  const localService: EvaluationService = {
    ...service,
    async loadDashboardDatasetRecords(directory) {
      assert.equal(directory, "selected");
      return [{ instance_id: "first" }, { instance_id: "second" }];
    },
    async prepareRepoWorkspace(instance) {
      calls.push(String(instance.instance_id));
      return { status: "ready", path: "local-test-workspace" };
    },
  };
  const baseUrl = await serve(t, options, localService);
  const response = await fetch(`${baseUrl}/api/prepare-all-repos?datasetDir=selected`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(((await response.json()) as { results: unknown[] }).results.length, 2);
});

test("busy preferred ports fall back to another port", async (t) => {
  const occupied = createServer();
  occupied.listen(0);
  await once(occupied, "listening");
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  const server = createServer();
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  // EADDRINUSE 是预期的重试信号，不能让 once(listening) 将它当成测试失败。
  const listening = new Promise<void>((resolve) => server.once("listening", resolve));
  listenOnAvailablePort(server, address.port, "local-test-evaluations");
  await listening;
  const fallback = server.address();
  assert.ok(fallback && typeof fallback !== "string");
  assert.notEqual(fallback.port, address.port);
});
