import http from "node:http";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  getSweWorkspaceStatus,
  prepareSweWorkspace,
  type SweInstance,
  type SweWorkspaceOptions,
  type SweWorkspaceStatus,
} from "./swe/workspace.js";

type JsonRecord = Record<string, unknown>;

type RunListItem = {
  name: string;
  path: string;
  updatedAt: string;
  version: string;
  summary?: JsonRecord;
  datasetOnly?: boolean;
};

type CaseSummary = {
  caseId: string;
  status?: string;
  repo?: string;
  durationMs?: number;
  eventCount: number;
  contextReadyCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  toolFinishedCount: number;
  autoCompressCount: number;
  historySnipCount: number;
  hardHistorySnipCount: number;
  bulkyToolCompactCount: number;
  toolResultBudgetReplacementCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cacheHitRate: number;
  maxPromptTokens: number;
  maxEstimatedTokens: number;
  maxMessageCount: number;
  toolResultCharsBeforeBudget: number;
  toolResultCharsAfterBudget: number;
  toolResultCharsAfterCompact: number;
  hasLongTermMemory: boolean;
  hasSessionMemory: boolean;
  hasAutoCompressSummary: boolean;
  toolCounts: Record<string, number>;
  finishedReason?: string;
  errorCount: number;
  lastError?: string;
};

type RunDetail = {
  run: RunListItem;
  version: string;
  cases: CaseSummary[];
  datasetItems: DatasetItemSummary[];
  config?: JsonRecord;
  totals: CaseSummary;
  rootSummary?: JsonRecord;
};

type DatasetItemSummary = {
  instanceId: string;
  repo?: string;
  baseCommit?: string;
  problemPreview: string;
  problemStatement?: string;
  hintsText?: string;
  testPatch?: string;
  tested: boolean;
  status?: string;
  cacheHitRate?: number;
  totalTokens?: number;
  maxEstimatedTokens?: number;
  workspace: SweWorkspaceStatus;
};

type ConversationMessage = {
  role: string;
  source?: string;
  agentId?: string;
  createdAt?: number;
  content: string;
  reasoning?: string;
  toolName?: string;
  toolCallCount?: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    cacheHitRate: number;
  };
};

const workspaceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evalRoot = path.resolve(
  process.env.OPENCAT_SWE_EVAL_DIR?.trim() ||
    path.join(workspaceRoot, ".opencat/evals/swe-verified-cache"),
);
const DATASET_ONLY_RUN_NAME = "__dataset__";
const webChatUrl = (process.env.OPENCAT_WEB_URL?.trim() || "http://localhost:5177")
  .replace(/\/+$/, "");
const port = readPort();
const MAX_PATCH_BYTES = 50 * 1024 * 1024;
const execFileAsync = promisify(execFile);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (url.pathname === "/") {
      sendHtml(response, renderDashboardHtml());
      return;
    }

    if (url.pathname === "/api/runs") {
      sendJson(response, await listRuns());
      return;
    }

    if (url.pathname === "/api/run") {
      const run = await findRun(url.searchParams.get("name") ?? "");
      sendJson(response, await loadRunDetail(run));
      return;
    }

    if (url.pathname === "/api/events") {
      const run = await findRun(url.searchParams.get("run") ?? "");
      const caseId = sanitizeSegment(url.searchParams.get("case") ?? "");
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 80)));
      sendJson(response, await loadCaseEvents(run, caseId, limit));
      return;
    }

    if (url.pathname === "/api/conversation") {
      const run = await findRun(url.searchParams.get("run") ?? "");
      const caseId = sanitizeSegment(url.searchParams.get("case") ?? "");
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 160)));
      sendJson(response, await loadCaseConversation(run, caseId, limit));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/prepare-repo") {
      const body = await readJsonBody(request);
      const instanceId = stringValue(body.instanceId) ?? "";
      const instance = await findDatasetInstance(instanceId);
      if (!instance) {
        sendJson(response, { error: "SWE item not found." }, 404);
        return;
      }

      sendJson(response, await prepareRepoWorkspace(instance));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/prepare-all-repos") {
      const records = await loadDashboardDatasetRecords();
      const results = [];
      for (const record of records) {
        results.push(await prepareRepoWorkspace(record));
      }
      sendJson(response, { results });
      return;
    }

    if (url.pathname === "/api/patch") {
      const instanceId = url.searchParams.get("instanceId") ?? "";
      const instance = await findDatasetInstance(instanceId);
      if (!instance) {
        sendJson(response, { ok: false, error: "SWE item not found." }, 404);
        return;
      }

      sendJson(response, await exportRepoPatch(instance));
      return;
    }

    sendText(response, 404, "Not found");
  } catch (error) {
    sendJson(response, { error: stringifyError(error) }, 500);
  }
});

listenOnAvailablePort(server, port);

async function listRuns(): Promise<RunListItem[]> {
  const entries = await readdir(evalRoot, { withFileTypes: true }).catch(() => []);
  const runs = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("swe_verified_cache_"))
    .map(async (entry) => {
      const runPath = path.join(evalRoot, entry.name);
      const info = await stat(runPath);
      const summary = await readJson(path.join(runPath, "summary.json"));
      const config = await readJson(path.join(runPath, "config.json")) ??
        await readJson(path.join(evalRoot, "config.json"));
      return {
        name: entry.name,
        path: runPath,
        updatedAt: info.mtime.toISOString(),
        version: resolveEvalVersion(summary, config),
        summary,
      };
    }));

  const sortedRuns = runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (sortedRuns.length > 0) {
    return sortedRuns;
  }

  const config = await readJson(path.join(evalRoot, "config.json"));
  return [await createDatasetOnlyRun(config)];
}

async function findRun(name: string): Promise<RunListItem> {
  const runs = await listRuns();
  const run = runs.find((item) => item.name === name) ?? runs[0];
  if (!run) {
    throw new Error(`No SWE eval runs found under ${evalRoot}`);
  }
  return run;
}

async function loadRunDetail(run: RunListItem): Promise<RunDetail> {
  if (run.datasetOnly) {
    const config = await readEvalConfig(run);
    const datasetItems = await loadDatasetItems(run, [], config);
    return {
      run,
      version: resolveEvalVersion(run.summary, config),
      rootSummary: run.summary,
      cases: [],
      datasetItems,
      config,
      totals: summarizeTotals([]),
    };
  }

  const entries = await readdir(run.path, { withFileTypes: true }).catch(() => []);
  const cases = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const caseId = entry.name;
      const caseDir = path.join(run.path, caseId);
      const events = await readJsonl(path.join(caseDir, "events.jsonl"));
      const summary = await readJson(path.join(caseDir, "summary.json"));
      return summarizeCase(caseId, events, summary);
    }));

  const rootSummary = run.summary;
  const config = await readEvalConfig(run);
  const datasetItems = await loadDatasetItems(run, cases, config);
  return {
    run,
    version: resolveEvalVersion(rootSummary, config),
    rootSummary,
    cases: cases.sort((a, b) => a.caseId.localeCompare(b.caseId)),
    datasetItems,
    config,
    totals: summarizeTotals(cases),
  };
}

async function createDatasetOnlyRun(
  config?: JsonRecord,
): Promise<RunListItem> {
  const info = await stat(evalRoot).catch(() => undefined);
  return {
    name: DATASET_ONLY_RUN_NAME,
    path: evalRoot,
    updatedAt: (info?.mtime ?? new Date()).toISOString(),
    version: resolveEvalVersion(undefined, config),
    summary: {},
    datasetOnly: true,
  };
}

function resolveEvalVersion(
  summary?: JsonRecord,
  config?: JsonRecord,
): string {
  return stringValue(summary?.version) ??
    stringValue(summary?.evalVersion) ??
    stringValue(config?.version) ??
    stringValue(config?.evalVersion) ??
    "v1";
}

async function readEvalConfig(run: RunListItem): Promise<JsonRecord | undefined> {
  return await readJson(path.join(run.path, "config.json")) ??
    await readJson(path.join(evalRoot, "config.json"));
}

async function loadDatasetItems(
  run: RunListItem,
  cases: readonly CaseSummary[],
  config?: JsonRecord,
): Promise<DatasetItemSummary[]> {
  const datasetPath = await resolveDatasetPathForRun(run, config);
  const records = await readDatasetRecords(datasetPath);
  const byCaseId = new Map(cases.map((item) => [item.caseId, item]));

  const items = await Promise.all(records.map(async (record) => {
    const instanceId = stringValue(record.instance_id) ?? "";
    const result = byCaseId.get(instanceId);
    return {
      instanceId,
      repo: stringValue(record.repo),
      baseCommit: stringValue(record.base_commit),
      problemPreview: firstLine(stringValue(record.problem_statement) ?? ""),
      problemStatement: stringValue(record.problem_statement),
      hintsText: stringValue(record.hints_text),
      testPatch: stringValue(record.test_patch),
      tested: result !== undefined,
      status: result?.status ?? result?.finishedReason,
      cacheHitRate: result?.cacheHitRate,
      totalTokens: result?.totalTokens,
      maxEstimatedTokens: result?.maxEstimatedTokens,
      workspace: await getRepoWorkspaceStatus(record),
    };
  }));

  return items.filter((item) => item.instanceId);
}

async function resolveDatasetPathForRun(
  run: RunListItem,
  config?: JsonRecord,
): Promise<string> {
  const candidates = [
    path.join(run.path, "dataset.jsonl"),
    stringValue(config?.datasetPath),
    path.join(evalRoot, "dataset.jsonl"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(workspaceRoot, candidate);
    try {
      if ((await stat(resolved)).isFile()) {
        return resolved;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return path.resolve(evalRoot, "dataset.jsonl");
}

async function readDatasetRecords(filePath: string): Promise<JsonRecord[]> {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed)
        ? parsed.filter(isRecord)
        : [];
    } catch {
      return [];
    }
  }

  return await readJsonl(filePath);
}

async function loadDashboardConfig(): Promise<JsonRecord | undefined> {
  return await readJson(path.join(evalRoot, "config.json"));
}

async function resolveDashboardDatasetPath(
  config?: JsonRecord,
): Promise<string> {
  const configuredPath = stringValue(config?.datasetPath);
  const candidates = [
    configuredPath,
    path.join(evalRoot, "dataset.jsonl"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(workspaceRoot, candidate);
    try {
      if ((await stat(resolved)).isFile()) {
        return resolved;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return path.join(evalRoot, "dataset.jsonl");
}

async function loadDashboardDatasetRecords(): Promise<JsonRecord[]> {
  const config = await loadDashboardConfig();
  const datasetPath = await resolveDashboardDatasetPath(config);
  return await readDatasetRecords(datasetPath);
}

async function findDatasetInstance(
  instanceId: string,
): Promise<JsonRecord | undefined> {
  return (await loadDashboardDatasetRecords())
    .find((record) => stringValue(record.instance_id) === instanceId);
}

async function getRepoWorkspaceStatus(
  instance: JsonRecord,
): Promise<SweWorkspaceStatus> {
  return await getSweWorkspaceStatus(
    toSweInstance(instance),
    await createSweWorkspaceOptions(),
  );
}

async function prepareRepoWorkspace(
  instance: JsonRecord,
): Promise<SweWorkspaceStatus> {
  return await prepareSweWorkspace(
    toSweInstance(instance),
    await createSweWorkspaceOptions(),
  );
}

async function exportRepoPatch(
  instance: JsonRecord,
): Promise<{
  ok: true;
  instanceId: string;
  fileName: string;
  patch: string;
  empty: boolean;
  savedPath?: string;
  workspacePath: string;
} | {
  ok: false;
  error: string;
}> {
  const workspace = await getRepoWorkspaceStatus(instance);
  if (!isUsableSweWorkspaceStatus(workspace.status)) {
    return {
      ok: false,
      error: `SWE workspace is not ready: ${workspace.status}.`,
    };
  }

  const { stdout } = await execFileAsync("git", [
    "-c",
    "safe.directory=*",
    "diff",
    "--binary",
  ], {
    cwd: workspace.path,
    maxBuffer: MAX_PATCH_BYTES,
    windowsHide: true,
  });
  const patch = String(stdout);
  const instanceId = stringValue(instance.instance_id) ?? "swe-item";
  const savedPath = patch.trim().length === 0
    ? undefined
    : await saveSwePatchFile(instanceId, patch);

  return {
    ok: true,
    instanceId,
    fileName: `${instanceId}.patch`,
    patch,
    empty: patch.trim().length === 0,
    savedPath,
    workspacePath: workspace.path,
  };
}

async function saveSwePatchFile(
  instanceId: string,
  patch: string,
): Promise<string> {
  const directory = resolveSwePatchDirectory();
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${sanitizePatchFileName(instanceId)}.patch`);
  await writeFile(filePath, patch, "utf8");
  return filePath;
}

function resolveSwePatchDirectory(): string {
  const configured = process.env.OPENCAT_SWE_PATCH_DIR?.trim();
  if (!configured) {
    return path.join(evalRoot, "patches");
  }

  return path.isAbsolute(configured) ? configured : path.resolve(workspaceRoot, configured);
}

function sanitizePatchFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function isUsableSweWorkspaceStatus(status: SweWorkspaceStatus["status"]): boolean {
  return status === "ready" || status === "dirty" || status === "wrong-head";
}

async function createSweWorkspaceOptions(): Promise<SweWorkspaceOptions> {
  const config = await loadDashboardConfig();
  const value = process.env.SWE_VERIFIED_ALLOW_NETWORK_CLONE ??
    config?.allowNetworkClone;
  return {
    projectRoot: workspaceRoot,
    reposDir: stringValue(config?.reposDir)?.trim(),
    allowNetworkClone: value === true || value === "true" || value === "1",
  };
}

function toSweInstance(instance: JsonRecord): SweInstance {
  return {
    instance_id: stringValue(instance.instance_id) ?? "unknown",
    repo: stringValue(instance.repo) ?? "",
    base_commit: stringValue(instance.base_commit) ?? "",
  };
}

async function loadCaseEvents(
  run: RunListItem,
  caseId: string,
  limit: number,
): Promise<{ caseId: string; events: JsonRecord[] }> {
  if (!caseId) {
    return { caseId, events: [] };
  }

  const caseDir = path.join(run.path, caseId);
  const resolved = path.resolve(caseDir);
  if (!resolved.startsWith(path.resolve(run.path) + path.sep)) {
    throw new Error("Invalid case path.");
  }

  const events = await readJsonl(path.join(caseDir, "events.jsonl"));
  return { caseId, events: events.slice(-limit) };
}

async function loadCaseConversation(
  run: RunListItem,
  caseId: string,
  limit: number,
): Promise<{
  caseId: string;
  sessionId?: string;
  transcriptPath?: string;
  messages: ConversationMessage[];
  fallbackEvents: JsonRecord[];
}> {
  if (!caseId) {
    return { caseId, messages: [], fallbackEvents: [] };
  }

  const caseDir = safeCaseDir(run, caseId);
  const events = await readJsonl(path.join(caseDir, "events.jsonl"));
  const sessionId = firstString(events, "sessionId");
  const transcriptPath = sessionId
    ? path.join(caseDir, "repo/.opencat/transcripts", `${sessionId}.jsonl`)
    : undefined;
  const transcriptEntries = transcriptPath ? await readJsonl(transcriptPath) : [];
  const messages = transcriptEntries
    .map(transcriptEntryToConversationMessage)
    .filter((message): message is ConversationMessage => message !== undefined)
    .slice(-limit);

  return {
    caseId,
    sessionId,
    transcriptPath: transcriptEntries.length > 0 ? transcriptPath : undefined,
    messages,
    fallbackEvents: transcriptEntries.length > 0 ? [] : events.slice(-limit),
  };
}

function safeCaseDir(run: RunListItem, caseId: string): string {
  const caseDir = path.join(run.path, caseId);
  const resolved = path.resolve(caseDir);
  if (!resolved.startsWith(path.resolve(run.path) + path.sep)) {
    throw new Error("Invalid case path.");
  }
  return caseDir;
}

function transcriptEntryToConversationMessage(
  entry: JsonRecord,
): ConversationMessage | undefined {
  if (entry.type !== "message" || !isRecord(entry.message)) {
    return undefined;
  }

  const message = entry.message;
  const usage = isRecord(message.usage)
    ? {
      promptTokens: numberValue(message.usage.prompt_tokens) ?? 0,
      completionTokens: numberValue(message.usage.completion_tokens) ?? 0,
      totalTokens: numberValue(message.usage.total_tokens) ?? 0,
      cacheHitTokens: numberValue(message.usage.prompt_cache_hit_tokens) ?? 0,
      cacheMissTokens: numberValue(message.usage.prompt_cache_miss_tokens) ?? 0,
      cacheHitRate: computeCacheHitRate(
        numberValue(message.usage.prompt_cache_hit_tokens) ?? 0,
        numberValue(message.usage.prompt_cache_miss_tokens) ?? 0,
      ),
    }
    : undefined;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  return {
    role: stringValue(message.role) ?? "unknown",
    source: stringValue(message.source),
    agentId: stringValue(entry.agentId),
    createdAt: numberValue(message.createdAt) ?? numberValue(entry.savedAt),
    content: messageContentToText(message.content),
    reasoning: stringValue(message.reasoning_content),
    toolName: stringValue(message.toolName),
    toolCallCount: toolCalls.length,
    usage,
  };
}

function summarizeCase(
  caseId: string,
  events: readonly JsonRecord[],
  summary?: JsonRecord,
): CaseSummary {
  const result = emptyCaseSummary(caseId);
  result.status = stringValue(summary?.status);
  result.repo = stringValue(summary?.repo);
  result.durationMs = numberValue(summary?.durationMs);

  for (const event of events) {
    result.eventCount++;
    const type = stringValue(event.type) ?? "unknown";

    if (type === "context_ready") {
      result.contextReadyCount++;
      result.maxEstimatedTokens = Math.max(
        result.maxEstimatedTokens,
        numberValue(event.estimatedTokens) ?? 0,
      );
      result.maxMessageCount = Math.max(
        result.maxMessageCount,
        numberValue(event.messageCount) ?? 0,
      );
      result.historySnipCount += numberValue(event.historySnipCount) ?? 0;
      result.hardHistorySnipCount += event.hardHistorySnipApplied ? 1 : 0;
      result.toolResultBudgetReplacementCount +=
        numberValue(event.toolResultBudgetReplacementCount) ?? 0;
      result.bulkyToolCompactCount += numberValue(event.bulkyToolCompactCount) ?? 0;
      result.toolResultCharsBeforeBudget +=
        numberValue(event.toolResultCharsBeforeBudget) ?? 0;
      result.toolResultCharsAfterBudget +=
        numberValue(event.toolResultCharsAfterBudget) ?? 0;
      result.toolResultCharsAfterCompact +=
        numberValue(event.toolResultCharsAfterCompact) ?? 0;
      result.hasLongTermMemory ||= Boolean(event.hasLongTermMemory);
      result.hasSessionMemory ||= Boolean(event.hasSessionMemory);
      result.hasAutoCompressSummary ||= Boolean(event.hasAutoCompressSummary);
      continue;
    }

    if (type === "model_usage") {
      result.promptTokens += numberValue(event.promptTokens) ?? 0;
      result.completionTokens += numberValue(event.completionTokens) ?? 0;
      result.totalTokens += numberValue(event.totalTokens) ?? 0;
      result.promptCacheHitTokens += numberValue(event.promptCacheHitTokens) ?? 0;
      result.promptCacheMissTokens += numberValue(event.promptCacheMissTokens) ?? 0;
      result.maxPromptTokens = Math.max(
        result.maxPromptTokens,
        numberValue(event.promptTokens) ?? 0,
      );
      continue;
    }

    if (type === "assistant_message") {
      result.assistantMessageCount++;
      continue;
    }

    if (type === "tool_call_started") {
      result.toolCallCount++;
      const toolName = stringValue(event.toolName) ?? "(unknown)";
      result.toolCounts[toolName] = (result.toolCounts[toolName] ?? 0) + 1;
      continue;
    }

    if (type === "tool_call_finished") {
      result.toolFinishedCount++;
      continue;
    }

    if (type === "auto_compress_finished" && event.status === "compressed") {
      result.autoCompressCount++;
      continue;
    }

    if (type === "query_finished") {
      result.finishedReason = stringValue(event.reason);
      continue;
    }

    if (type.endsWith("_failed") || type === "parse_error") {
      result.errorCount++;
      result.lastError = stringValue(event.error) ?? stringValue(event.raw);
    }
  }

  applySummaryFallbacks(result, summary);
  result.cacheHitRate = computeCacheHitRate(
    result.promptCacheHitTokens,
    result.promptCacheMissTokens,
  );
  return result;
}

function applySummaryFallbacks(result: CaseSummary, summary?: JsonRecord): void {
  if (!summary) {
    return;
  }

  result.status ??= stringValue(summary.status);
  result.finishedReason ??= stringValue(summary.status);
  result.toolCallCount ||= numberValue(summary.toolCallCount) ?? 0;
  result.contextReadyCount ||= numberValue(summary.contextReadyCount) ?? 0;
  result.promptTokens ||= numberValue(summary.promptTokens) ?? 0;
  result.completionTokens ||= numberValue(summary.completionTokens) ?? 0;
  result.totalTokens ||= numberValue(summary.totalTokens) ?? 0;
  result.promptCacheHitTokens ||= numberValue(summary.promptCacheHitTokens) ?? 0;
  result.promptCacheMissTokens ||= numberValue(summary.promptCacheMissTokens) ?? 0;
  result.maxPromptTokens ||= numberValue(summary.maxPromptTokens) ?? 0;
  result.maxEstimatedTokens ||= numberValue(summary.maxEstimatedTokens) ?? 0;
  result.autoCompressCount ||= numberValue(summary.autoCompressCount) ?? 0;
  result.historySnipCount ||= numberValue(summary.historySnipCount) ?? 0;
  result.hardHistorySnipCount ||= numberValue(summary.hardHistorySnipCount) ?? 0;
  result.toolResultBudgetReplacementCount ||=
    numberValue(summary.toolResultBudgetReplacementCount) ?? 0;
  result.bulkyToolCompactCount ||= numberValue(summary.bulkyToolCompactCount) ?? 0;
  result.toolResultCharsBeforeBudget ||=
    numberValue(summary.toolResultCharsBeforeBudget) ?? 0;
  result.toolResultCharsAfterBudget ||=
    numberValue(summary.toolResultCharsAfterBudget) ?? 0;
  result.toolResultCharsAfterCompact ||=
    numberValue(summary.toolResultCharsAfterCompact) ?? 0;

  const toolCounts = summary.toolCounts;
  if (isRecord(toolCounts) && Object.keys(result.toolCounts).length === 0) {
    result.toolCounts = Object.fromEntries(
      Object.entries(toolCounts).flatMap(([key, value]) => {
        const count = numberValue(value);
        return count === undefined ? [] : [[key, count]];
      }),
    );
  }
}

function summarizeTotals(cases: readonly CaseSummary[]): CaseSummary {
  const totals = emptyCaseSummary("TOTAL");
  for (const item of cases) {
    totals.eventCount += item.eventCount;
    totals.contextReadyCount += item.contextReadyCount;
    totals.assistantMessageCount += item.assistantMessageCount;
    totals.toolCallCount += item.toolCallCount;
    totals.toolFinishedCount += item.toolFinishedCount;
    totals.autoCompressCount += item.autoCompressCount;
    totals.historySnipCount += item.historySnipCount;
    totals.hardHistorySnipCount += item.hardHistorySnipCount;
    totals.bulkyToolCompactCount += item.bulkyToolCompactCount;
    totals.toolResultBudgetReplacementCount += item.toolResultBudgetReplacementCount;
    totals.promptTokens += item.promptTokens;
    totals.completionTokens += item.completionTokens;
    totals.totalTokens += item.totalTokens;
    totals.promptCacheHitTokens += item.promptCacheHitTokens;
    totals.promptCacheMissTokens += item.promptCacheMissTokens;
    totals.maxPromptTokens = Math.max(totals.maxPromptTokens, item.maxPromptTokens);
    totals.maxEstimatedTokens = Math.max(totals.maxEstimatedTokens, item.maxEstimatedTokens);
    totals.maxMessageCount = Math.max(totals.maxMessageCount, item.maxMessageCount);
    totals.toolResultCharsBeforeBudget += item.toolResultCharsBeforeBudget;
    totals.toolResultCharsAfterBudget += item.toolResultCharsAfterBudget;
    totals.toolResultCharsAfterCompact += item.toolResultCharsAfterCompact;
    totals.hasLongTermMemory ||= item.hasLongTermMemory;
    totals.hasSessionMemory ||= item.hasSessionMemory;
    totals.hasAutoCompressSummary ||= item.hasAutoCompressSummary;
    totals.errorCount += item.errorCount;

    for (const [toolName, count] of Object.entries(item.toolCounts)) {
      totals.toolCounts[toolName] = (totals.toolCounts[toolName] ?? 0) + count;
    }
  }

  totals.cacheHitRate = computeCacheHitRate(
    totals.promptCacheHitTokens,
    totals.promptCacheMissTokens,
  );
  return totals;
}

function emptyCaseSummary(caseId: string): CaseSummary {
  return {
    caseId,
    eventCount: 0,
    contextReadyCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    toolFinishedCount: 0,
    autoCompressCount: 0,
    historySnipCount: 0,
    hardHistorySnipCount: 0,
    bulkyToolCompactCount: 0,
    toolResultBudgetReplacementCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    cacheHitRate: 0,
    maxPromptTokens: 0,
    maxEstimatedTokens: 0,
    maxMessageCount: 0,
    toolResultCharsBeforeBudget: 0,
    toolResultCharsAfterBudget: 0,
    toolResultCharsAfterCompact: 0,
    hasLongTermMemory: false,
    hasSessionMemory: false,
    hasAutoCompressSummary: false,
    toolCounts: {},
    errorCount: 0,
  };
}

async function readJson(filePath: string): Promise<JsonRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readJsonl(filePath: string): Promise<JsonRecord[]> {
  let raw = "";
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }

  return raw.split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        return isRecord(parsed) ? parsed : { type: "unknown_json", value: parsed };
      } catch {
        return { type: "parse_error", raw: line.slice(0, 1000) };
      }
    });
}

function firstString(records: readonly JsonRecord[], key: string): string | undefined {
  for (const record of records) {
    const value = stringValue(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function messageContentToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map(messageContentToText).filter(Boolean).join("\n");
  }

  if (isRecord(value)) {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.content === "string") {
      return value.content;
    }
    return JSON.stringify(value);
  }

  return String(value);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenCat SWE Eval Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #151b23;
      --panel-2: #0f1620;
      --border: #2a3441;
      --text: #e6edf3;
      --muted: #8b949e;
      --good: #3fb950;
      --warn: #d29922;
      --bad: #f85149;
      --accent: #58a6ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: rgba(13, 17, 23, 0.96);
    }
    h1 { margin: 0; font-size: 16px; }
    select, button {
      color: var(--text);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 10px;
    }
    button { cursor: pointer; }
    main {
      display: grid;
      grid-template-columns: minmax(720px, 1fr) 420px;
      min-height: calc(100vh - 56px);
    }
    section { padding: 16px; }
    aside {
      border-left: 1px solid var(--border);
      background: var(--panel-2);
      min-width: 0;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(6, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .card {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 8px;
      padding: 10px;
      min-height: 72px;
    }
    .card .label { color: var(--muted); font-size: 12px; }
    .card .value { margin-top: 6px; font-size: 20px; font-weight: 700; }
    .card .sub { margin-top: 2px; color: var(--muted); font-size: 12px; }
    .version-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 34px;
      border: 1px solid rgba(88, 166, 255, 0.55);
      border-radius: 999px;
      padding: 3px 8px;
      color: var(--accent);
      background: rgba(88, 166, 255, 0.08);
      font-weight: 700;
    }
    .panel {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 8px;
      margin-bottom: 14px;
      overflow: hidden;
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: #111821;
    }
    .panel-title { font-weight: 700; }
    .item-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: #0f151d;
    }
    .config-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(160px, 1fr));
      gap: 10px;
      padding: 12px;
    }
    .config-item {
      min-width: 0;
    }
    .config-key {
      color: var(--muted);
      font-size: 12px;
    }
    .config-value {
      margin-top: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 12px;
    }
    .status-pill.tested {
      color: var(--good);
      border-color: rgba(63, 185, 80, 0.45);
      background: rgba(63, 185, 80, 0.08);
    }
    .status-pill.untested {
      color: var(--muted);
      border-color: var(--border);
    }
    .status-pill.ready {
      color: var(--good);
      border-color: rgba(63, 185, 80, 0.45);
      background: rgba(63, 185, 80, 0.08);
    }
    .status-pill.failed {
      color: var(--bad);
      border-color: rgba(248, 81, 73, 0.45);
      background: rgba(248, 81, 73, 0.08);
    }
    .status-pill.dirty {
      color: var(--warn);
      border-color: rgba(210, 153, 34, 0.45);
      background: rgba(210, 153, 34, 0.08);
    }
    .status-pill.wrong-head {
      color: var(--accent);
      border-color: rgba(88, 166, 255, 0.45);
      background: rgba(88, 166, 255, 0.08);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      border-bottom: 1px solid var(--border);
      padding: 8px 9px;
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      background: #111821;
    }
    tr[data-instance] { cursor: pointer; }
    tr[data-instance]:hover { background: #1b2430; }
    tr.selected { outline: 1px solid var(--accent); background: #142238; }
    .case-id { color: var(--accent); font-weight: 600; }
    .open-chat {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px 8px;
      background: #111821;
      color: var(--accent);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
    }
    .open-chat:hover { border-color: var(--accent); background: #142238; }
    .open-chat:disabled {
      cursor: progress;
      opacity: 0.65;
    }
    .problem-preview {
      max-width: 560px;
      white-space: normal;
      color: var(--muted);
    }
    .muted { color: var(--muted); }
    .good { color: var(--good); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .tools {
      max-width: 260px;
      white-space: normal;
      color: var(--muted);
    }
    .side-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
    }
    .view-tabs {
      display: flex;
      gap: 6px;
      margin-bottom: 10px;
    }
    .view-tabs button.active {
      border-color: var(--accent);
      background: #142238;
    }
    .chat {
      display: flex;
      flex-direction: column;
      gap: 10px;
      overflow: auto;
      max-height: calc(100vh - 164px);
      padding-right: 4px;
    }
    .bubble {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      background: var(--panel);
    }
    .bubble.user { border-color: #245a9f; background: #132033; }
    .bubble.assistant { border-color: #5d3fb0; }
    .bubble.tool { border-color: #2e7d45; background: #101b15; }
    .bubble.system { border-color: #755d24; background: #1b1710; }
    .bubble-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 7px;
      text-transform: uppercase;
    }
    .bubble-body {
      white-space: pre-wrap;
      word-break: break-word;
    }
    details.reasoning {
      margin-top: 8px;
      color: var(--muted);
      border-left: 2px solid var(--border);
      padding-left: 8px;
    }
    details.reasoning summary {
      cursor: pointer;
    }
    .usage-line {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    pre {
      margin: 0;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #090d13;
      overflow: auto;
      max-height: calc(100vh - 130px);
      white-space: pre-wrap;
      word-break: break-word;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    @media (max-width: 1100px) {
      main { grid-template-columns: 1fr; }
      aside { border-left: 0; border-top: 1px solid var(--border); }
      .cards { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .config-grid { grid-template-columns: repeat(2, minmax(160px, 1fr)); }
    }
  </style>
</head>
<body>
  <header>
    <h1>OpenCat SWE Eval</h1>
    <select id="runSelect"></select>
    <span id="versionBadge" class="version-badge">v1</span>
    <button id="refreshButton">Refresh</button>
    <span id="runMeta" class="muted"></span>
  </header>
  <main>
    <section>
      <div id="cards" class="cards"></div>
      <div class="panel">
        <div class="panel-head">
          <span class="panel-title">Eval Config</span>
          <span id="datasetMeta" class="muted"></span>
        </div>
        <div id="configGrid" class="config-grid"></div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <span class="panel-title">Dataset Items</span>
          <span>
            <button id="prepareAllButton" type="button">Prepare All</button>
            <span id="itemMeta" class="muted"></span>
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Repo</th>
              <th>Tested</th>
              <th>Status</th>
              <th>Cache</th>
              <th>Tokens</th>
              <th>Problem</th>
              <th>Chat</th>
            </tr>
          </thead>
          <tbody id="itemRows"></tbody>
        </table>
      </div>
    </section>
    <aside>
      <section>
        <div class="side-head">
          <strong id="sideTitle">Conversation</strong>
          <button id="loadEventsButton">Refresh</button>
        </div>
        <div class="view-tabs">
          <button id="conversationTab" class="active">Conversation</button>
          <button id="eventsTab">Events</button>
        </div>
        <div id="conversationBox" class="chat">Select a case to inspect the conversation.</div>
        <pre id="eventsBox" hidden>Select a case to inspect raw events.</pre>
      </section>
    </aside>
  </main>
  <script>
    const state = { runs: [], detail: null, selectedCase: "", sideView: "conversation" };
    const $ = (id) => document.getElementById(id);
    const fmt = new Intl.NumberFormat();
    const pct = (value) => Number.isFinite(value) ? Math.round(value * 1000) / 10 + "%" : "0%";
    const compact = (value) => {
      if (!Number.isFinite(value)) return "0";
      if (Math.abs(value) >= 1_000_000) return (value / 1_000_000).toFixed(1) + "m";
      if (Math.abs(value) >= 1_000) return (value / 1_000).toFixed(1) + "k";
      return String(value);
    };

    $("refreshButton").addEventListener("click", loadRuns);
    $("runSelect").addEventListener("change", () => loadRun($("runSelect").value));
    $("prepareAllButton").addEventListener("click", prepareAllRepos);
    $("loadEventsButton").addEventListener("click", loadEvents);
    $("conversationTab").addEventListener("click", async () => {
      state.sideView = "conversation";
      renderSideView();
      await loadConversation();
    });
    $("eventsTab").addEventListener("click", async () => {
      state.sideView = "events";
      renderSideView();
      await loadEvents();
    });

    loadRuns();

    async function loadRuns() {
      renderDashboardLoading("Loading SWE eval data...");
      try {
        state.runs = await fetchJson("/api/runs");
        $("runSelect").innerHTML = state.runs
          .map((run) => '<option value="' + escapeHtml(run.name) + '">[' + escapeHtml(run.version || "v1") + '] ' + escapeHtml(run.name) + '</option>')
          .join("");
        if (state.runs[0]) {
          await loadRun(state.runs[0].name);
        } else {
          renderDashboardError("No SWE eval runs or dataset found.");
        }
      } catch (error) {
        renderDashboardError(error.message || String(error));
      }
    }

    function openSweChatSession(instanceId) {
      if (!instanceId) return;
      window.location.href = ${JSON.stringify(webChatUrl)} +
        "/?swe=" + encodeURIComponent(instanceId) +
        "&draft=investigate";
    }

    async function copyPromptForItem(item, kind) {
      const prompt = buildSwePrompt(item, kind);
      try {
        await navigator.clipboard.writeText(prompt);
      } catch (error) {
        window.prompt("Copy this prompt:", prompt);
      }
    }

    function buildSwePrompt(item, kind) {
      if (kind === "investigate") {
        return buildSweInvestigatePrompt(item);
      }
      if (kind === "fix") {
        return buildSweFixPrompt(item);
      }

      const lines = [
        "You are working on a SWE-bench Verified issue in OpenCat.",
        "Modify the checked-out repository to fix the issue. Prefer minimal, well-tested changes.",
        "Use the available tools to inspect, edit, and verify the code.",
        "Do not fetch unrelated web content unless the repository itself requires it.",
        "Before editing, inspect the relevant files in the workspace. After editing, run the most relevant tests you can.",
        "",
        "<swe_task>",
        "<instance_id>" + (item.instanceId || "") + "</instance_id>",
        "<repo>" + (item.repo || "") + "</repo>",
        "",
        "<problem_statement>",
        item.problemStatement || item.problemPreview || "",
        "</problem_statement>",
        item.hintsText ? "\\n<hints_text>\\n" + item.hintsText + "\\n</hints_text>" : "",
        kind === "debug" && item.testPatch ? "\\n<debug_test_patch>\\n" + item.testPatch + "\\n</debug_test_patch>" : "",
        "</swe_task>",
      ];
      return lines.filter((line) => line !== "").join("\\n");
    }

    function buildSweInvestigatePrompt(item) {
      return [
        "You are working on a SWE-bench Verified issue in OpenCat.",
        "First investigate only. Do not modify files yet. Do not call Edit or Write.",
        "Read the issue, inspect the checked-out repository, identify the likely root cause, and explain the smallest code change you would make next.",
        "Use tools to inspect relevant files. Do not fetch unrelated web content unless the repository itself requires it.",
        "End with a concise investigation summary: root cause, relevant files/functions, proposed fix, and tests to run.",
        "",
        "<swe_task>",
        "<instance_id>" + (item.instanceId || "") + "</instance_id>",
        "<repo>" + (item.repo || "") + "</repo>",
        "",
        "<problem_statement>",
        item.problemStatement || item.problemPreview || "",
        "</problem_statement>",
        item.hintsText ? "\\n<hints_text>\\n" + item.hintsText + "\\n</hints_text>" : "",
        "</swe_task>",
      ].filter((line) => line !== "").join("\\n");
    }

    function buildSweFixPrompt(item) {
      return [
        "Based on the investigation from the previous turn, implement the smallest correct fix now.",
        "Modify only the checked-out SWE workspace for this item. Re-read any file you edit before changing it.",
        "After editing, run the most relevant tests you can. If tests cannot run, explain exactly why and what you verified instead.",
        "Finish with a concise summary of changed files, the behavior fixed, and verification results.",
        "",
        "<swe_task_followup>",
        "<instance_id>" + (item.instanceId || "") + "</instance_id>",
        "</swe_task_followup>",
      ].filter((line) => line !== "").join("\\n");
    }

    async function loadRun(name) {
      renderDashboardLoading("Loading " + name + "...");
      try {
        state.detail = await fetchJson("/api/run?name=" + encodeURIComponent(name));
        state.selectedCase = state.detail.datasetItems[0]?.instanceId || state.detail.cases[0]?.caseId || "";
        $("versionBadge").textContent = state.detail.version || "v1";
        $("runMeta").textContent = state.detail.run.path;
        renderCards(state.detail.totals, state.detail.cases.length, state.detail.version);
        renderConfig(state.detail.config || {}, state.detail.version);
        renderItems(state.detail.datasetItems || []);
        renderSelectedItemDetails();
      } catch (error) {
        renderDashboardError(error.message || String(error));
      }
    }

    function renderDashboardLoading(message) {
      $("cards").innerHTML = "";
      $("configGrid").innerHTML = '<div class="config-item"><div class="config-key">loading</div><div class="config-value">' + escapeHtml(message) + '</div></div>';
      $("datasetMeta").textContent = "";
      $("itemMeta").textContent = "";
      $("itemRows").innerHTML = '<tr><td colspan="8" class="muted">' + escapeHtml(message) + '</td></tr>';
    }

    function renderDashboardError(message) {
      $("cards").innerHTML = "";
      $("configGrid").innerHTML = '<div class="config-item"><div class="config-key">error</div><div class="config-value">' + escapeHtml(message) + '</div></div>';
      $("datasetMeta").textContent = "failed";
      $("itemMeta").textContent = "";
      $("itemRows").innerHTML = '<tr><td colspan="8" class="muted">' + escapeHtml(message) + '</td></tr>';
      $("conversationBox").innerHTML = '<div class="bubble system"><div class="bubble-head"><span>error</span></div><div class="bubble-body">' + escapeHtml(message) + '</div></div>';
    }

    function renderCards(totals, caseCount, version) {
      const cards = [
        ["Cases", caseCount, "instances"],
        ["Cache Hit", pct(totals.cacheHitRate), compact(totals.promptCacheMissTokens) + " miss"],
        ["Total Tokens", compact(totals.totalTokens), compact(totals.promptTokens) + " prompt"],
        ["Max Context", compact(totals.maxEstimatedTokens), "estimated tokens"],
        ["Tool Calls", compact(totals.toolCallCount), topTools(totals.toolCounts, 2)],
      ];
      $("cards").innerHTML = cards.map(([label, value, sub]) =>
        '<div class="card"><div class="label">' + escapeHtml(label) + '</div><div class="value">' +
        escapeHtml(String(value)) + '</div><div class="sub">' + escapeHtml(String(sub)) + '</div></div>'
      ).join("");
    }

    function renderConfig(config, version) {
      const keys = [
        "version",
        "datasetSource",
        "datasetPath",
        "datasetSplit",
        "limit",
        "userRounds",
        "model",
        "allowWebTools",
        "allowNetworkClone",
        "reposDir",
        "python",
      ];
      $("configGrid").innerHTML = keys.map((key) => {
        const value = key === "version" ? (version || config.version || config.evalVersion || "v1") : config[key];
        return '<div class="config-item"><div class="config-key">' + escapeHtml(key) + '</div><div class="config-value" title="' +
          escapeHtml(value ?? "") + '">' + escapeHtml(value ?? "-") + '</div></div>';
      }).join("");
    }

    function renderItems(items) {
      const testedCount = items.filter((item) => item.tested).length;
      $("datasetMeta").textContent = items.length ? items.length + " dataset items" : "no dataset loaded";
      $("itemMeta").textContent = testedCount + " tested / " + Math.max(0, items.length - testedCount) + " pending";
      $("itemRows").innerHTML = items.map((item) => {
        const cache = item.tested && Number.isFinite(item.cacheHitRate) ? pct(item.cacheHitRate) : "-";
        const tokenText = item.tested ? compact(item.totalTokens || 0) : "-";
        const workspaceStatus = item.workspace && item.workspace.status ? item.workspace.status : "missing";
        return '<tr data-instance="' + escapeHtml(item.instanceId) + '" class="' +
          (item.instanceId === state.selectedCase ? "selected" : "") + '">' +
          '<td><span class="case-id">' + escapeHtml(item.instanceId) + '</span><br><span class="muted">' + escapeHtml(item.repo || "") + '</span></td>' +
          '<td><span class="status-pill ' + repoStatusClass(workspaceStatus) + '">' + escapeHtml(workspaceStatus) + '</span><br>' +
          '<button type="button" class="open-chat" data-prepare-repo="' + escapeHtml(item.instanceId) + '">Prepare</button></td>' +
          '<td><span class="status-pill ' + (item.tested ? "tested" : "untested") + '">' + (item.tested ? "tested" : "untested") + '</span></td>' +
          '<td>' + escapeHtml(item.status || "-") + '</td>' +
          '<td>' + escapeHtml(cache) + '</td>' +
          '<td>' + escapeHtml(tokenText) + '</td>' +
          '<td class="problem-preview">' + escapeHtml(item.problemPreview || "-") + '</td>' +
          '<td><button type="button" class="open-chat" data-open-session="' + escapeHtml(item.instanceId) + '">Open</button></td>' +
          '</tr>';
      }).join("");

      document.querySelectorAll("button[data-prepare-repo]").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          await prepareRepo(button.getAttribute("data-prepare-repo"), button);
        });
      });

      document.querySelectorAll("button[data-open-session]").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          openSweChatSession(button.getAttribute("data-open-session"));
        });
      });

      document.querySelectorAll("tr[data-instance]").forEach((row) => {
        row.addEventListener("click", () => {
          const instanceId = row.getAttribute("data-instance");
          state.selectedCase = instanceId;
          renderItems(state.detail.datasetItems || []);
          renderSelectedItemDetails();
        });
      });
    }

    function renderSelectedItemDetails() {
      if (!state.detail || !state.selectedCase) return;
      const item = (state.detail.datasetItems || []).find((candidate) => candidate.instanceId === state.selectedCase);
      if (!item) {
        $("conversationBox").innerHTML = '<div class="bubble system"><div class="bubble-head"><span>item</span></div><div class="bubble-body">No dataset item selected.</div></div>';
        return;
      }

      state.sideView = "conversation";
      renderSideView();
      const sections = [
        ["instance_id", item.instanceId],
        ["repo", item.repo || ""],
        ["base_commit", item.baseCommit || ""],
        ["workspace_status", item.workspace ? item.workspace.status : "missing"],
        ["workspace_path", item.workspace ? item.workspace.path : ""],
        ["repo_cache_path", item.workspace && item.workspace.repoCachePath ? item.workspace.repoCachePath : ""],
        ["workspace_error", item.workspace && item.workspace.error ? item.workspace.error : ""],
        ["status", item.tested ? (item.status || "tested") : "untested"],
        ["problem_statement", item.problemStatement || item.problemPreview || ""],
        ["hints_text", item.hintsText || ""],
        ["test_patch", item.testPatch || ""],
      ].filter(([, value]) => value);

      $("conversationBox").innerHTML = '<article class="bubble system">' +
        '<div class="bubble-head"><span>dataset item</span><span>' + escapeHtml(item.instanceId) + '</span></div>' +
        '<div class="item-actions">' +
        '<button type="button" class="open-chat" id="copyPromptButton">Copy Prompt</button>' +
        '<button type="button" class="open-chat" id="copyInvestigatePromptButton">Copy Investigate Prompt</button>' +
        '<button type="button" class="open-chat" id="copyFixPromptButton">Copy Fix Prompt</button>' +
        '<button type="button" class="open-chat" id="copyDebugPromptButton">Copy Debug Prompt</button>' +
        '<button type="button" class="open-chat" id="exportPatchButton">Export Patch</button>' +
        '<button type="button" class="open-chat" id="openSelectedSweChatButton">Open Chat</button>' +
        '</div>' +
        sections.map(([label, value]) =>
          '<div class="bubble-body"><strong>' + escapeHtml(label) + '</strong><pre>' +
          escapeHtml(String(value)) + '</pre></div>'
        ).join("") +
        '</article>';
      $("copyPromptButton").addEventListener("click", () => copyPromptForItem(item, "standard"));
      $("copyInvestigatePromptButton").addEventListener("click", () => copyPromptForItem(item, "investigate"));
      $("copyFixPromptButton").addEventListener("click", () => copyPromptForItem(item, "fix"));
      $("copyDebugPromptButton").addEventListener("click", () => copyPromptForItem(item, "debug"));
      $("exportPatchButton").addEventListener("click", () => exportPatchForItem(item));
      $("openSelectedSweChatButton").addEventListener("click", () => openSweChatSession(item.instanceId));
    }

    function renderSideView() {
      const showingConversation = state.sideView === "conversation";
      $("conversationTab").classList.toggle("active", showingConversation);
      $("eventsTab").classList.toggle("active", !showingConversation);
      $("conversationBox").hidden = !showingConversation;
      $("eventsBox").hidden = showingConversation;
      $("sideTitle").textContent = showingConversation ? "Conversation: " + (state.selectedCase || "") : "Events: " + (state.selectedCase || "");
    }

    async function loadConversation() {
      if (!state.detail || !state.selectedCase) return;
      state.sideView = "conversation";
      renderSideView();
      const data = await fetchJson("/api/conversation?run=" + encodeURIComponent(state.detail.run.name) +
        "&case=" + encodeURIComponent(state.selectedCase) + "&limit=180");
      if (data.messages && data.messages.length) {
        $("conversationBox").innerHTML = data.messages.map(renderMessage).join("");
        return;
      }
      $("conversationBox").innerHTML = '<div class="bubble system"><div class="bubble-head"><span>fallback</span></div><div class="bubble-body">No transcript found. Showing event timeline in the Events tab.</div></div>';
      if (data.fallbackEvents && data.fallbackEvents.length) {
        $("eventsBox").textContent = data.fallbackEvents.map((event) => JSON.stringify(event, null, 2)).join("\\n\\n");
      }
    }

    async function loadEvents() {
      if (!state.detail || !state.selectedCase) return;
      state.sideView = "events";
      renderSideView();
      const data = await fetchJson("/api/events?run=" + encodeURIComponent(state.detail.run.name) +
        "&case=" + encodeURIComponent(state.selectedCase) + "&limit=120");
      $("eventsBox").textContent = data.events.map((event) => JSON.stringify(event, null, 2)).join("\\n\\n");
    }

    function renderMessage(message) {
      const role = String(message.role || "unknown").toLowerCase();
      const content = message.content || "";
      const meta = [
        message.toolName ? "tool: " + message.toolName : "",
        message.agentId && message.agentId !== "main" ? message.agentId : "",
        message.createdAt ? new Date(message.createdAt).toLocaleTimeString() : "",
      ].filter(Boolean).join(" · ");
      const usage = message.usage
        ? '<div class="usage-line">' + compact(message.usage.totalTokens) + ' tok · ' +
          compact(message.usage.promptTokens) + ' prompt · ' +
          pct(message.usage.cacheHitRate) + ' hit · ' +
          compact(message.usage.cacheMissTokens) + ' miss</div>'
        : "";
      const reasoning = message.reasoning
        ? '<details class="reasoning"><summary>' + compact(message.reasoning.length) + ' reasoning chars</summary><div class="bubble-body">' + escapeHtml(message.reasoning) + '</div></details>'
        : "";
      const toolCalls = message.toolCallCount
        ? '<div class="usage-line">tool calls: ' + message.toolCallCount + '</div>'
        : "";
      return '<article class="bubble ' + escapeHtml(role) + '">' +
        '<div class="bubble-head"><span>' + escapeHtml(role) + '</span><span>' + escapeHtml(meta) + '</span></div>' +
        '<div class="bubble-body">' + escapeHtml(content || "(empty)") + '</div>' +
        reasoning + toolCalls + usage +
        '</article>';
    }

    function topTools(toolCounts, limit) {
      return Object.entries(toolCounts || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([name, count]) => name + " " + count)
        .join(", ") || "-";
    }

    async function fetchJson(url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    async function prepareRepo(instanceId, button) {
      if (!instanceId) return;
      const previousSelection = state.selectedCase;
      if (button) {
        button.disabled = true;
        button.textContent = "Preparing";
      }
      try {
        const result = await postJson("/api/prepare-repo", { instanceId: instanceId });
        if (result && result.status === "failed") {
          alert("Prepare failed: " + (result.error || "unknown error"));
        }
        if (state.detail) {
          await loadRun(state.detail.run.name);
          state.selectedCase = previousSelection || instanceId;
          renderItems(state.detail.datasetItems || []);
          renderSelectedItemDetails();
        }
      } catch (error) {
        alert("Prepare failed: " + error.message);
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = "Prepare";
        }
      }
    }

    async function prepareAllRepos() {
      const button = $("prepareAllButton");
      const previousSelection = state.selectedCase;
      button.disabled = true;
      button.textContent = "Preparing...";
      try {
        const result = await postJson("/api/prepare-all-repos", {});
        const failures = (result.results || []).filter((item) => item && item.status === "failed");
        if (failures.length > 0) {
          alert("Prepare all completed with " + failures.length + " failure(s). First error: " + (failures[0].error || "unknown error"));
        }
        if (state.detail) {
          await loadRun(state.detail.run.name);
          state.selectedCase = previousSelection;
          renderItems(state.detail.datasetItems || []);
          renderSelectedItemDetails();
        }
      } catch (error) {
        alert("Prepare all failed: " + error.message);
      } finally {
        button.disabled = false;
        button.textContent = "Prepare All";
      }
    }

    async function exportPatchForItem(item) {
      if (!item || !item.instanceId) return;
      const button = $("exportPatchButton");
      const previousText = button ? button.textContent : "";
      if (button) {
        button.disabled = true;
        button.textContent = "Exporting";
      }
      try {
        const payload = await fetchJson("/api/patch?instanceId=" + encodeURIComponent(item.instanceId));
        if (!payload.ok) {
          alert(payload.error || "Export patch failed.");
          return;
        }
        if (payload.empty) {
          alert("No changes to export.");
          return;
        }
        if (payload.savedPath) {
          alert("Patch saved to:\\n" + payload.savedPath);
        } else {
          alert("Patch exported.");
        }
      } catch (error) {
        alert("Export patch failed: " + error.message);
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = previousText || "Export Patch";
        }
      }
    }

    function repoStatusClass(status) {
      if (status === "ready" || status === "failed" || status === "dirty" || status === "wrong-head") {
        return status;
      }
      return "untested";
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[ch]));
    }
  </script>
</body>
</html>`;
}

function computeCacheHitRate(hit: number, miss: number): number {
  const denominator = hit + miss;
  return denominator === 0 ? 0 : hit / denominator;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[\\/]/g, "");
}

function sanitizePath(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function readPort(): number {
  const value = Number(process.env.OPENCAT_SWE_DASHBOARD_PORT ?? 5188);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 5188;
}

function listenOnAvailablePort(
  server: http.Server,
  preferredPort: number,
): void {
  const maxPort = Math.min(preferredPort + 20, 65535);

  function tryListen(candidatePort: number): void {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE" && candidatePort < maxPort) {
        console.warn(
          `Port ${candidatePort} is already in use. Trying ${candidatePort + 1}...`,
        );
        tryListen(candidatePort + 1);
        return;
      }

      console.error(`Failed to start SWE eval dashboard: ${error.message}`);
      process.exitCode = 1;
    };

    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      const actualPort = typeof address === "object" && address
        ? address.port
        : candidatePort;
      console.log(`OpenCat SWE eval dashboard: http://localhost:${actualPort}`);
      console.log(`Reading eval data from: ${evalRoot}`);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(candidatePort);
  }

  tryListen(preferredPort);
}

function sendHtml(response: http.ServerResponse, html: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendJson(
  response: http.ServerResponse,
  value: unknown,
  statusCode = 200,
): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function sendText(
  response: http.ServerResponse,
  statusCode: number,
  text: string,
): void {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}

async function readJsonBody(request: http.IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1024) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return isRecord(parsed) ? parsed : {};
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
