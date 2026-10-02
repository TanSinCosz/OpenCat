import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { getAppConfig, getEvaluationConfig, stripConfigCliOptions } from "../src/config/load-config.js";

type JsonRecord = Record<string, unknown>;

type ToolCallStart = {
  caseId: string;
  toolCallId: string;
  toolName: string;
  turn?: number;
  argsChars?: number;
  argsPreview?: string;
  startedAt: number;
};

type ToolStat = {
  caseId: string;
  toolName: string;
  started: number;
  finished: number;
  totalDurationMs: number;
  maxDurationMs: number;
  totalResultChars: number;
  maxResultChars: number;
  totalArgsChars: number;
  persistedCount: number;
  testLikeCount: number;
};

type CaseRecord = {
  caseId: string;
  repo?: string;
  status?: string;
  phases?: string;
  durationMs: number;
  turnCount: number;
  toolCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cacheHitRate: number;
  maxPromptTokens: number;
  maxEstimatedTokens: number;
  contextReadyCount: number;
  autoCompressCount: number;
  historySnipCount: number;
  hardHistorySnipCount: number;
  bulkyToolCompactCount: number;
  toolResultBudgetReplacementCount: number;
  changedFileCount: number;
  changedFiles: string;
  errorCount: number;
  error?: string;
};

const workspaceRoot = process.cwd();
const exportArgs = stripConfigCliOptions(process.argv.slice(2));
const requestedRun = exportArgs[0]?.trim();
const requestedOutput = exportArgs[1]?.trim();

const runPath = await resolveRunPath(requestedRun);
const rootSummary = await readJson(path.join(runPath, "summary.json"));
const caseDirectories = await findCaseDirectories(runPath);
const caseSummaries = asArray(rootSummary?.results);
const caseRows: CaseRecord[] = [];
const toolRows: JsonRecord[] = [];
const contextRows: JsonRecord[] = [];
const timelineRows: JsonRecord[] = [];
const validationRows: JsonRecord[] = [];
const configRows = await readConfigRows();

for (const caseDirectory of caseDirectories) {
  const caseId = path.basename(caseDirectory);
  const events = await readJsonl(path.join(caseDirectory, "events.jsonl"));
  const summary = caseSummaries.find((value) =>
    stringValue(value.instanceId) === caseId ||
    stringValue(value.caseId) === caseId,
  );
  const derived = deriveCaseData(caseId, events);
  caseRows.push(mergeCaseSummary(caseId, summary, derived));
  toolRows.push(...deriveToolRows(caseId, events));
  contextRows.push(...deriveContextRows(caseId, events));
  timelineRows.push(...deriveTimelineRows(caseId, events));
  validationRows.push(...readValidationHints(caseId, summary));
}

for (const summary of caseSummaries) {
  const caseId = stringValue(summary.instanceId) ?? stringValue(summary.caseId);
  if (!caseId || caseRows.some((row) => row.caseId === caseId)) {
    continue;
  }

  caseRows.push(mergeCaseSummary(caseId, summary, deriveCaseData(caseId, [])));
  validationRows.push(...readValidationHints(caseId, summary));
}

caseRows.sort((left, right) => left.caseId.localeCompare(right.caseId));
toolRows.sort((left, right) =>
  `${left.caseId}:${left.toolName}`.localeCompare(`${right.caseId}:${right.toolName}`),
);
contextRows.sort((left, right) => numberValue(left.timestamp) - numberValue(right.timestamp));
timelineRows.sort((left, right) => numberValue(left.timestamp) - numberValue(right.timestamp));

const outputPath = path.resolve(
  requestedOutput || path.join(runPath, `${path.basename(runPath)}.xlsx`),
);
const workbook = XLSX.utils.book_new();

appendSheet(workbook, "Overview", createOverviewRows(rootSummary, runPath, caseRows));
appendSheet(workbook, "Cases", caseRows);
appendSheet(workbook, "Tool Stats", toolRows);
appendSheet(workbook, "Context", contextRows);
appendSheet(workbook, "Timeline", timelineRows);
appendSheet(workbook, "Config", configRows);
appendSheet(workbook, "Validation", validationRows.length > 0
  ? validationRows
  : [{
    metric: "validation_data",
    status: "not_collected",
    note: "No validation.json or test exit-code events were found in this run.",
  }]);
appendSheet(workbook, "Gaps", [
  {
    metric: "test_exit_code",
    status: "not_collected",
    source: "events.jsonl",
    note: "tool_call_finished currently records duration/result size, but not the process exit code.",
  },
  {
    metric: "important_fact_recall",
    status: "not_collected",
    source: "evaluation harness",
    note: "Requires a gold-fact manifest and fixed recall probes.",
  },
  {
    metric: "patch_correctness",
    status: "partial",
    source: "patch.diff + workspace",
    note: "Changed files and patch are exported; independent test validation is still required.",
  },
  {
    metric: "stage_token_snapshots",
    status: "partial",
    source: "context_ready",
    note: "Current events contain final estimated tokens and character totals, not every projection stage token.",
  },
]);

for (const sheet of workbook.SheetNames) {
  formatSheet(workbook.Sheets[sheet]);
}

XLSX.writeFile(workbook, outputPath, {
  bookType: "xlsx",
  compression: true,
});

console.log(`Exported ${caseRows.length} cases and ${timelineRows.length} events.`);
console.log(outputPath);

async function resolveRunPath(requested?: string): Promise<string> {
  if (requested) {
    const resolved = path.resolve(requested);
    const metadata = await stat(resolved);
    return metadata.isFile() ? path.dirname(resolved) : resolved;
  }

  const roots = [
    path.resolve(".opencat/evals/swe-serial"),
    path.resolve(".opencat/evals/swe-verified-cache"),
  ];
  const candidates: Array<{ path: string; updatedAt: number }> = [];

  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const candidate = path.join(root, entry.name);
      try {
        const summary = await stat(path.join(candidate, "summary.json"));
        candidates.push({ path: candidate, updatedAt: summary.mtimeMs });
      } catch {
        // Ignore incomplete run directories.
      }
    }
  }

  const newest = candidates.sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (!newest) {
    throw new Error("No SWE eval run with summary.json was found.");
  }

  return newest.path;
}

async function findCaseDirectories(runDirectory: string): Promise<string[]> {
  const entries = await readdir(runDirectory, { withFileTypes: true });
  const directories: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const directory = path.join(runDirectory, entry.name);
    try {
      const events = await stat(path.join(directory, "events.jsonl"));
      if (events.isFile()) {
        directories.push(directory);
      }
    } catch {
      // Summary-only cases are merged below from summary.json.
    }
  }
  return directories;
}

async function readConfigRows(): Promise<JsonRecord[]> {
  const config = getAppConfig();
  // This sheet describes the currently selected YAML, not a historical run snapshot.
  // Never export model keys, profiles, MCP tokens, or request headers.
  const parameters = {
    evaluation: getEvaluationConfig(config),
    compression: config.compression,
    reasoning: config.reasoning,
    model: { provider: config.model.provider, model: config.model.model, maxTokens: config.model.maxTokens },
  };
  return Object.entries(parameters).map(([parameter, value]) => ({
    source: config.configPath ?? "built-in defaults",
    parameter: `current YAML: ${parameter}`,
    value: JSON.stringify(value),
  }));
}

async function readJson(filePath: string): Promise<JsonRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readJsonl(filePath: string): Promise<JsonRecord[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line);
          return isRecord(value) ? [value] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function deriveCaseData(caseId: string, events: JsonRecord[]): JsonRecord {
  const usage = events.filter((event) => event.type === "model_usage");
  const context = events.filter((event) => event.type === "context_ready");
  const toolStarts = events.filter((event) => event.type === "tool_call_started");
  const finished = events.filter((event) => event.type === "query_finished").at(-1);
  const errors = events.filter((event) =>
    stringValue(event.type)?.endsWith("_failed") || event.type === "parse_error",
  );

  return {
    caseId,
    status: stringValue(finished?.reason) ?? (errors.length > 0 ? "failed" : undefined),
    durationMs: numberValue(finished?.durationMs),
    turnCount: Math.max(0, ...events.map((event) => numberValue(event.turn))),
    toolCallCount: toolStarts.length,
    promptTokens: sum(usage, "promptTokens"),
    completionTokens: sum(usage, "completionTokens"),
    totalTokens: sum(usage, "totalTokens"),
    promptCacheHitTokens: sum(usage, "promptCacheHitTokens"),
    promptCacheMissTokens: sum(usage, "promptCacheMissTokens"),
    maxPromptTokens: Math.max(0, ...usage.map((event) => numberValue(event.promptTokens))),
    maxEstimatedTokens: Math.max(0, ...context.map((event) => numberValue(event.estimatedTokens))),
    contextReadyCount: context.length,
    autoCompressCount: events.filter((event) =>
      event.type === "auto_compress_finished" && event.status === "compressed",
    ).length,
    historySnipCount: sum(context, "historySnipCount"),
    hardHistorySnipCount: context.filter((event) => event.hardHistorySnipApplied).length,
    bulkyToolCompactCount: Math.max(
      0,
      ...context.map((event) => numberValue(event.bulkyToolCompactCount)),
    ),
    toolResultBudgetReplacementCount: sum(context, "toolResultBudgetReplacementCount"),
    changedFileCount: 0,
    changedFiles: "",
    errorCount: errors.length,
    error: stringValue(errors.at(-1)?.error),
  };
}

function mergeCaseSummary(
  caseId: string,
  summary: JsonRecord | undefined,
  derived: JsonRecord,
): CaseRecord {
  const value = (key: string): unknown => summary?.[key] ?? derived[key];
  const changedFiles = arrayValue(value("changedFiles"));
  const hit = numberValue(value("promptCacheHitTokens"));
  const miss = numberValue(value("promptCacheMissTokens"));

  return {
    caseId,
    repo: stringValue(value("repo")),
    status: stringValue(value("status")),
    phases: arrayValue(value("phases")).join(", "),
    durationMs: numberValue(value("durationMs")),
    turnCount: numberValue(value("turnCount")),
    toolCallCount: numberValue(value("toolCallCount")),
    promptTokens: numberValue(value("promptTokens")),
    completionTokens: numberValue(value("completionTokens")),
    totalTokens: numberValue(value("totalTokens")),
    promptCacheHitTokens: hit,
    promptCacheMissTokens: miss,
    cacheHitRate: hit + miss === 0 ? 0 : hit / (hit + miss),
    maxPromptTokens: numberValue(value("maxPromptTokens")),
    maxEstimatedTokens: numberValue(value("maxEstimatedTokens")),
    contextReadyCount: numberValue(value("contextReadyCount")),
    autoCompressCount: numberValue(value("autoCompressCount")),
    historySnipCount: numberValue(value("historySnipCount")),
    hardHistorySnipCount: numberValue(value("hardHistorySnipCount")),
    bulkyToolCompactCount: numberValue(value("bulkyToolCompactCount")),
    toolResultBudgetReplacementCount: numberValue(value("toolResultBudgetReplacementCount")),
    changedFileCount: changedFiles.length,
    changedFiles: changedFiles.join("\n"),
    errorCount: numberValue(value("errorCount")),
    error: stringValue(value("error")),
  };
}

function deriveToolRows(caseId: string, events: JsonRecord[]): JsonRecord[] {
  const starts = new Map<string, ToolCallStart>();
  const stats = new Map<string, ToolStat>();

  for (const event of events) {
    if (event.type === "tool_call_started") {
      const toolName = stringValue(event.toolName) ?? "unknown";
      const toolCallId = stringValue(event.toolCallId) ?? `${toolName}:${starts.size}`;
      starts.set(toolCallId, {
        caseId,
        toolCallId,
        toolName,
        turn: numberValue(event.turn),
        argsChars: numberValue(event.argsChars),
        argsPreview: stringValue(event.argsPreview),
        startedAt: numberValue(event.timestamp),
      });
      continue;
    }

    if (event.type !== "tool_call_finished") {
      continue;
    }

    const toolCallId = stringValue(event.toolCallId) ?? "";
    const start = starts.get(toolCallId);
    const toolName = stringValue(event.toolName) ?? start?.toolName ?? "unknown";
    const row = stats.get(toolName) ?? {
      caseId,
      toolName,
      started: 0,
      finished: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      totalResultChars: 0,
      maxResultChars: 0,
      totalArgsChars: 0,
      persistedCount: 0,
      testLikeCount: 0,
    };
    const durationMs = numberValue(event.durationMs);
    const resultChars = numberValue(event.resultChars);
    row.finished++;
    row.totalDurationMs += durationMs;
    row.maxDurationMs = Math.max(row.maxDurationMs, durationMs);
    row.totalResultChars += resultChars;
    row.maxResultChars = Math.max(row.maxResultChars, resultChars);
    row.totalArgsChars += start?.argsChars ?? 0;
    row.persistedCount += event.persistedToolResult ? 1 : 0;
    row.testLikeCount += isTestLike(start?.toolName, event, start) ? 1 : 0;
    stats.set(toolName, row);
  }

  for (const start of starts.values()) {
    const row = stats.get(start.toolName) ?? {
      caseId,
      toolName: start.toolName,
      started: 0,
      finished: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      totalResultChars: 0,
      maxResultChars: 0,
      totalArgsChars: 0,
      persistedCount: 0,
      testLikeCount: 0,
    };
    row.started++;
    stats.set(start.toolName, row);
  }

  return [...stats.values()].map((row) => ({
    caseId: row.caseId,
    toolName: row.toolName,
    started: row.started,
    finished: row.finished,
    unfinished: row.started - row.finished,
    totalDurationMs: row.totalDurationMs,
    avgDurationMs: row.finished === 0 ? 0 : row.totalDurationMs / row.finished,
    maxDurationMs: row.maxDurationMs,
    totalResultChars: row.totalResultChars,
    avgResultChars: row.finished === 0 ? 0 : row.totalResultChars / row.finished,
    maxResultChars: row.maxResultChars,
    totalArgsChars: row.totalArgsChars,
    persistedCount: row.persistedCount,
    testLikeCount: row.testLikeCount,
  }));
}

function deriveContextRows(caseId: string, events: JsonRecord[]): JsonRecord[] {
  return events
    .filter((event) => event.type === "context_ready")
    .map((event) => ({
      caseId,
      timestamp: new Date(numberValue(event.timestamp)).toISOString(),
      turn: numberValue(event.turn),
      messageCount: numberValue(event.messageCount),
      estimatedTokens: numberValue(event.estimatedTokens),
      hasLongTermMemory: Boolean(event.hasLongTermMemory),
      hasSessionMemory: Boolean(event.hasSessionMemory),
      hasAutoCompressSummary: Boolean(event.hasAutoCompressSummary),
      runtimeContextMessageCount: numberValue(event.runtimeContextMessageCount),
      toolResultBudgetReplacementCount: numberValue(event.toolResultBudgetReplacementCount),
      bulkyToolCompactCount: numberValue(event.bulkyToolCompactCount),
      historySnipCount: numberValue(event.historySnipCount),
      hardHistorySnipApplied: Boolean(event.hardHistorySnipApplied),
      toolResultCharsBeforeBudget: numberValue(event.toolResultCharsBeforeBudget),
      toolResultCharsAfterBudget: numberValue(event.toolResultCharsAfterBudget),
      toolResultCharsAfterCompact: numberValue(event.toolResultCharsAfterCompact),
    }));
}

function deriveTimelineRows(caseId: string, events: JsonRecord[]): JsonRecord[] {
  return events.map((event) => ({
    caseId,
    timestamp: new Date(numberValue(event.timestamp)).toISOString(),
    type: stringValue(event.type),
    agentRole: stringValue(event.agentRole),
    agentId: stringValue(event.agentId),
    turn: numberValue(event.turn),
    toolName: stringValue(event.toolName),
    toolCallId: stringValue(event.toolCallId),
    durationMs: numberValue(event.durationMs),
    messageCount: numberValue(event.messageCount),
    estimatedTokens: numberValue(event.estimatedTokens),
    promptTokens: numberValue(event.promptTokens),
    completionTokens: numberValue(event.completionTokens),
    totalTokens: numberValue(event.totalTokens),
    cacheHitTokens: numberValue(event.promptCacheHitTokens),
    cacheMissTokens: numberValue(event.promptCacheMissTokens),
    argsChars: numberValue(event.argsChars),
    resultChars: numberValue(event.resultChars),
    status: stringValue(event.status) ?? stringValue(event.reason),
    error: stringValue(event.error),
    details: compactDetails(event),
  }));
}

function readValidationHints(caseId: string, summary?: JsonRecord): JsonRecord[] {
  const validation = summary?.validation;
  if (!isRecord(validation)) {
    return [];
  }

  return Object.entries(validation).map(([metric, value]) => ({
    caseId,
    metric,
    value: typeof value === "object" ? JSON.stringify(value) : value,
    status: "collected",
  }));
}

function createOverviewRows(
  summary: JsonRecord | undefined,
  runDirectory: string,
  cases: readonly CaseRecord[],
): JsonRecord[] {
  const totalPrompt = sum(cases, "promptTokens");
  const totalCompletion = sum(cases, "completionTokens");
  const totalTokens = sum(cases, "totalTokens");
  const totalHit = sum(cases, "promptCacheHitTokens");
  const totalMiss = sum(cases, "promptCacheMissTokens");

  return [
    { parameter: "runPath", value: runDirectory },
    { parameter: "runId", value: stringValue(summary?.runId) },
    { parameter: "version", value: stringValue(summary?.version) ?? stringValue(summary?.evalVersion) },
    { parameter: "model", value: stringValue(summary?.model) },
    { parameter: "startedAt", value: stringValue(summary?.startedAt) },
    { parameter: "finishedAt", value: stringValue(summary?.finishedAt) },
    { parameter: "caseCount", value: cases.length },
    { parameter: "completedCases", value: cases.filter((row) => row.status === "completed").length },
    { parameter: "failedCases", value: cases.filter((row) => row.status === "failed").length },
    { parameter: "skippedCases", value: cases.filter((row) => row.status === "skipped").length },
    { parameter: "promptTokens", value: totalPrompt },
    { parameter: "completionTokens", value: totalCompletion },
    { parameter: "totalTokens", value: totalTokens },
    { parameter: "promptCacheHitTokens", value: totalHit },
    { parameter: "promptCacheMissTokens", value: totalMiss },
    { parameter: "cacheHitRate", value: totalHit + totalMiss === 0 ? 0 : totalHit / (totalHit + totalMiss) },
    { parameter: "maxPromptTokens", value: Math.max(0, ...cases.map((row) => row.maxPromptTokens)) },
    { parameter: "maxEstimatedTokens", value: Math.max(0, ...cases.map((row) => row.maxEstimatedTokens)) },
    { parameter: "totalDurationMs", value: sum(cases, "durationMs") },
    { parameter: "totalToolCalls", value: sum(cases, "toolCallCount") },
    { parameter: "totalAutoCompress", value: sum(cases, "autoCompressCount") },
    { parameter: "totalHistorySnip", value: sum(cases, "historySnipCount") },
    { parameter: "totalBulkyCompact", value: sum(cases, "bulkyToolCompactCount") },
  ];
}

function appendSheet(workbook: XLSX.WorkBook, name: string, rows: readonly JsonRecord[]): void {
  const sheet = XLSX.utils.json_to_sheet(rows.length > 0 ? [...rows] : [{ note: "No data" }]);
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function formatSheet(sheet: XLSX.WorkSheet): void {
  const range = sheet["!ref"];
  if (!range) {
    return;
  }

  const decoded = XLSX.utils.decode_range(range);
  sheet["!autofilter"] = { ref: range };
  sheet["!freeze"] = { xSplit: 0, ySplit: 1 };
  sheet["!cols"] = Array.from({ length: decoded.e.c + 1 }, () => ({ wch: 18 }));
  if (sheet["A1"]) {
    sheet["A1"].s = { font: { bold: true } };
  }
}

function compactDetails(event: JsonRecord): string {
  const details: JsonRecord = {};
  for (const key of ["reason", "status", "summaryId", "finishReason", "persistedToolResult", "hasToolUse"]) {
    if (event[key] !== undefined) {
      details[key] = event[key];
    }
  }
  return Object.keys(details).length > 0 ? JSON.stringify(details) : "";
}

function isTestLike(toolName: string | undefined, event: JsonRecord, start?: ToolCallStart): boolean {
  if (toolName !== "Bash") {
    return false;
  }
  const text = `${event.toolName ?? ""} ${start?.toolName ?? ""} ${start?.argsPreview ?? ""}`.toLowerCase();
  return /test|pytest|unittest|npm\s+(run\s+)?test|cargo\s+test|go\s+test|mvn\s+test/.test(text);
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function arrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function sum(rows: readonly unknown[], key: string): number {
  let total = 0;
  for (const row of rows) {
    total += numberValue(isRecord(row) ? row[key] : undefined);
  }
  return total;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
