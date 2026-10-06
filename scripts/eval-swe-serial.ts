import { getAppConfig, type AppConfig } from "../src/config/load-config.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { query } from "../src/query.js";
import { prepareSweWorkspace } from "../src/swe/workspace.js";
import type { SweWorkspaceOptions } from "../src/swe/workspace.js";
import { createDefaultTools } from "../src/Tools/index.js";
import type { Tools } from "../src/Tools/types.js";
import type { EvaluationEvent } from "../src/telemetry/events.js";
import { JsonlRunObserver } from "../src/telemetry/jsonl.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

const execFileAsync = promisify(execFile);

type SweBenchInstance = {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hints_text?: string;
  test_patch?: string;
};

type SerialEvalConfig = AppConfig["evaluation"]["serial"];

type PhaseName = "investigate" | "fix";

type InstanceSummary = {
  instanceId: string;
  repo: string;
  baseCommit: string;
  status: "completed" | "max_turns" | "failed" | "skipped";
  phases: PhaseName[];
  durationMs: number;
  worktreePath: string;
  eventsPath: string;
  patchPath: string;
  changedFiles: string[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cacheHitRate: number;
  toolCallCount: number;
  toolCounts: Record<string, number>;
  maxPromptTokens: number;
  maxEstimatedTokens: number;
  autoCompressCount: number;
  historySnipCount: number;
  bulkyToolCompactCount: number;
  error?: string;
};

const appConfig = getAppConfig();
const modelRuntimeConfig = appConfig.model;
if (!modelRuntimeConfig.apiKey.trim()) {
  throw new Error(
    "Set the selected provider API key before running SWE serial eval.",
  );
}

const config: SerialEvalConfig = appConfig.evaluation.serial;
const runPrefix = config.runPrefix?.trim() || "swe_serial";
const runId = config.runId?.trim() ||
  `${runPrefix}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outputRoot = path.resolve(
  config.outputDir?.trim() ||
    ".opencat/evals/swe-serial",
  runId,
);
const limit = (config.limit ?? 100);
const model = config.model?.trim() || modelRuntimeConfig.model;
const allowNetworkClone = (config.allowNetworkClone ?? false);
const allowWebTools = (config.allowWebTools ?? false);
const allowDirtyWorkspaces = (config.allowDirtyWorkspaces ?? false);
const phases: PhaseName[] = config.phases?.length ? config.phases : ["investigate", "fix"];
const concurrency = (config.concurrency ?? 1);
const workspaceOptions: SweWorkspaceOptions = {
  reposDir: config.reposDir,
  workspaceRoot: config.workspaceRoot ?? appConfig.workspace.sweWorkspaceDir,
  repoCacheRoot: config.repoCacheRoot ?? appConfig.workspace.sweRepoCacheDir,
  allowNetworkClone,
  projectRoot: process.cwd(),
  workspaceNamespace: config.workspaceNamespace,
};

await mkdir(outputRoot, { recursive: true });
const datasetPath = await resolveDatasetPath(config);
const instances = (await loadInstances(datasetPath)).slice(0, limit);
const startedAt = new Date();
const results: Array<InstanceSummary | undefined> = Array(instances.length);
let nextInstanceIndex = 0;
let summaryWrite = Promise.resolve();

function queueSummaryWrite(): Promise<void> {
  const snapshot = createSummary();
  summaryWrite = summaryWrite
    .catch(() => undefined)
    .then(() => writeJson(path.join(outputRoot, "summary.json"), snapshot));
  return summaryWrite;
}

async function runWorker(workerIndex: number): Promise<void> {
  while (true) {
    const index = nextInstanceIndex++;
    const instance = instances[index];
    if (!instance) {
      return;
    }

    const result = await runInstance(instance);
    results[index] = result;
    await queueSummaryWrite();
    const completed = results.filter(Boolean).length;
    console.log(
      `[${completed}/${instances.length}] worker=${workerIndex} ${instance.instance_id}: ${result.status}`,
    );
  }
}

const workerCount = Math.min(concurrency, Math.max(1, instances.length));
await Promise.all(
  Array.from({ length: workerCount }, (_, index) => runWorker(index + 1)),
);
await summaryWrite;
const finalSummary = createSummary(true);
await writeJson(path.join(outputRoot, "summary.json"), finalSummary);
console.log(JSON.stringify(finalSummary, null, 2));

function createSummary(final = false) {
  const materializedResults = results.filter(
    (result): result is InstanceSummary => result !== undefined,
  );
  return {
    runId,
    startedAt: startedAt.toISOString(),
    updatedAt: new Date().toISOString(),
    ...(final ? { finishedAt: new Date().toISOString() } : {}),
    model,
    phases,
    concurrency,
    contextCompression: config.contextCompression ?? {},
    instanceLimit: limit,
    completedCount: materializedResults.length,
    datasetPath,
    outputRoot,
    results: materializedResults,
    totals: summarizeTotals(materializedResults),
  };
}

async function runInstance(instance: SweBenchInstance): Promise<InstanceSummary> {
  const started = Date.now();
  const instanceDir = path.join(outputRoot, sanitizePath(instance.instance_id));
  const eventsPath = path.join(instanceDir, "events.jsonl");
  const patchPath = path.join(instanceDir, "patch.diff");
  await mkdir(instanceDir, { recursive: true });

  try {
    const workspace = await prepareSweWorkspace(instance, workspaceOptions);
    const base = createEmptySummary({
      instance,
      worktreePath: workspace.path,
      eventsPath,
      patchPath,
      started,
    });

    if (
      workspace.status !== "ready" &&
      !(allowDirtyWorkspaces && workspace.status === "dirty")
    ) {
      return {
        ...base,
        status: "skipped",
        durationMs: Date.now() - started,
        error: `Workspace is ${workspace.status}: ${workspace.error ?? workspace.path}`,
      };
    }

    const events: EvaluationEvent[] = [];
    const observer = new JsonlRunObserver(eventsPath);
    const runtime = createRuntime({
      cwd: workspace.path,
      sessionId: `session_swe_serial_${hashShort(`${runId}:${instance.instance_id}`)}`,
      modelRuntimeConfig: {
        ...modelRuntimeConfig,
        userId: createEvalUserId(instance),
        model,
      },
      appConfig,
      contextCompressionConfig: config.contextCompression,
      observer: {
        async emit(event) {
          events.push(event);
          await observer.emit(event);
        },
      },
      tools: createSweEvalTools(),
    });
    const state = createState();
    let status: InstanceSummary["status"] = "completed";

    for (const phase of phases) {
      state.Messages.push(createMessage({
        role: "user",
        content: renderPrompt(instance, phase),
      }));

      for await (const event of query(runtime, state)) {
        if (event.type === "done") {
          status = event.reason;
        }
      }

      if (status !== "completed") {
        break;
      }
    }

    await writeText(patchPath, await git(["diff", "--binary"], workspace.path));
    const changedFiles = parseChangedFiles(
      await git(["status", "--short"], workspace.path),
    );
    return summarizeEvents({
      ...base,
      status,
      durationMs: Date.now() - started,
      changedFiles,
    }, events);
  } catch (error) {
    return {
      ...createEmptySummary({
        instance,
        worktreePath: "",
        eventsPath,
        patchPath,
        started,
      }),
      status: "failed",
      durationMs: Date.now() - started,
      error: stringifyError(error),
    };
  }
}

function createSweEvalTools(): Tools {
  const tools = createDefaultTools();
  return allowWebTools
    ? tools
    : tools.filter((tool) =>
      tool.name !== "WebSearch" && tool.name !== "WebFetch"
    );
}

function createEvalUserId(instance: SweBenchInstance): string {
  return `swe-${hashShort(`${runId}:${instance.instance_id}`)}-${sanitizeUserId(instance.instance_id)}`;
}

function renderPrompt(instance: SweBenchInstance, phase: PhaseName): string {
  if (phase === "fix") {
    return [
      "Based on the investigation from the previous turn, implement the smallest correct fix now.",
      "Modify only the checked-out SWE workspace for this item. Re-read any file you edit before changing it.",
      "After editing, run the most relevant tests you can. If tests cannot run, explain exactly why and what you verified instead.",
      "Finish with a concise summary of changed files, the behavior fixed, and verification results.",
      "",
      "<swe_task_followup>",
      `<instance_id>${instance.instance_id}</instance_id>`,
      "</swe_task_followup>",
    ].join("\n");
  }

  return [
    "You are working on a SWE-bench Verified issue in OpenCat.",
    "First investigate only. Do not modify files yet. Do not call Edit or Write.",
    "Read the issue, inspect the checked-out repository, identify the likely root cause, and explain the smallest code change you would make next.",
    "Use tools to inspect relevant files. Do not fetch unrelated web content unless the repository itself requires it.",
    "End with a concise investigation summary: root cause, relevant files/functions, proposed fix, and tests to run.",
    "",
    "<swe_task>",
    `<instance_id>${instance.instance_id}</instance_id>`,
    `<repo>${instance.repo}</repo>`,
    "",
    "<problem_statement>",
    instance.problem_statement,
    "</problem_statement>",
    instance.hints_text
      ? `\n<hints_text>\n${instance.hints_text}\n</hints_text>`
      : "",
    "</swe_task>",
  ].filter((line) => line !== "").join("\n");
}

async function resolveDatasetPath(config: SerialEvalConfig): Promise<string> {
  const configured = config.datasetPath?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  const candidates = [
    path.join(appConfig.evaluation.directory ?? config.outputDir ?? ".opencat/evals/swe-serial", "dataset.jsonl"),
    ".opencat/evals/swe-verified-cache/swe_verified_full.jsonl",
    ".opencat/evals/swe-verified-cache/dataset.jsonl",
  ].map((candidate) => path.resolve(candidate));

  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Missing SWE dataset. Set evaluation.serial.datasetPath in YAML or run npm run eval:swe:prepare first.",
  );
}

async function loadInstances(filePath: string): Promise<SweBenchInstance[]> {
  const raw = await readFile(filePath, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = trimmed.startsWith("[")
    ? JSON.parse(trimmed)
    : trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

  if (!Array.isArray(parsed)) {
    throw new Error("SWE dataset must be a JSON array or JSONL file.");
  }

  return parsed.map(normalizeInstance);
}

function normalizeInstance(value: unknown): SweBenchInstance {
  const record = value as Record<string, unknown>;
  return {
    instance_id: stringField(record, "instance_id"),
    repo: stringField(record, "repo"),
    base_commit: stringField(record, "base_commit"),
    problem_statement: stringField(record, "problem_statement"),
    hints_text: optionalStringField(record, "hints_text"),
    test_patch: optionalStringField(record, "test_patch"),
  };
}

function summarizeEvents(
  base: InstanceSummary,
  events: readonly EvaluationEvent[],
): InstanceSummary {
  const toolCounts: Record<string, number> = {};
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let promptCacheHitTokens = 0;
  let promptCacheMissTokens = 0;
  let maxPromptTokens = 0;
  let maxEstimatedTokens = 0;
  let toolCallCount = 0;
  let autoCompressCount = 0;
  let historySnipCount = 0;
  let bulkyToolCompactCount = 0;

  for (const event of events) {
    if (event.type === "model_usage") {
      promptTokens += event.promptTokens;
      completionTokens += event.completionTokens;
      totalTokens += event.totalTokens;
      promptCacheHitTokens += event.promptCacheHitTokens;
      promptCacheMissTokens += event.promptCacheMissTokens;
      maxPromptTokens = Math.max(maxPromptTokens, event.promptTokens);
      continue;
    }

    if (event.type === "context_ready") {
      maxEstimatedTokens = Math.max(maxEstimatedTokens, event.estimatedTokens);
      historySnipCount += event.historySnipCount;
      // This is the number of replacements active in this request, not a
      // cumulative operation count. The same replacements are reported again
      // on later context_ready events, so summing would overcount them.
      bulkyToolCompactCount = Math.max(
        bulkyToolCompactCount,
        event.bulkyToolCompactCount,
      );
      continue;
    }

    if (event.type === "tool_call_started") {
      toolCallCount++;
      toolCounts[event.toolName] = (toolCounts[event.toolName] ?? 0) + 1;
      continue;
    }

    if (
      event.type === "auto_compress_finished" &&
      event.status === "compressed"
    ) {
      autoCompressCount++;
    }
  }

  return {
    ...base,
    toolCallCount,
    toolCounts,
    promptTokens,
    completionTokens,
    totalTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    cacheHitRate: computeCacheHitRate(
      promptCacheHitTokens,
      promptCacheMissTokens,
    ),
    maxPromptTokens,
    maxEstimatedTokens,
    autoCompressCount,
    historySnipCount,
    bulkyToolCompactCount,
  };
}

function createEmptySummary(options: {
  instance: SweBenchInstance;
  worktreePath: string;
  eventsPath: string;
  patchPath: string;
  started: number;
}): InstanceSummary {
  return {
    instanceId: options.instance.instance_id,
    repo: options.instance.repo,
    baseCommit: options.instance.base_commit,
    status: "failed",
    phases,
    durationMs: Date.now() - options.started,
    worktreePath: options.worktreePath,
    eventsPath: options.eventsPath,
    patchPath: options.patchPath,
    changedFiles: [],
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    cacheHitRate: 0,
    toolCallCount: 0,
    toolCounts: {},
    maxPromptTokens: 0,
    maxEstimatedTokens: 0,
    autoCompressCount: 0,
    historySnipCount: 0,
    bulkyToolCompactCount: 0,
  };
}

function summarizeTotals(results: readonly InstanceSummary[]) {
  const totals = results.reduce(
    (sum, result) => ({
      promptTokens: sum.promptTokens + result.promptTokens,
      completionTokens: sum.completionTokens + result.completionTokens,
      totalTokens: sum.totalTokens + result.totalTokens,
      promptCacheHitTokens:
        sum.promptCacheHitTokens + result.promptCacheHitTokens,
      promptCacheMissTokens:
        sum.promptCacheMissTokens + result.promptCacheMissTokens,
      toolCallCount: sum.toolCallCount + result.toolCallCount,
    }),
    {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      toolCallCount: 0,
    },
  );

  return {
    ...totals,
    cacheHitRate: computeCacheHitRate(
      totals.promptCacheHitTokens,
      totals.promptCacheMissTokens,
    ),
  };
}

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-c",
    "safe.directory=*",
    ...args,
  ], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function parseChangedFiles(status: string): string[] {
  return status.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
}

function computeCacheHitRate(hit: number, miss: number): number {
  const denominator = hit + miss;
  return denominator === 0 ? 0 : hit / denominator;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing string field: ${key}`);
  }
  return value;
}

function optionalStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath: string, value: string): Promise<void> {
  await writeFile(filePath, value, "utf8");
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function sanitizePath(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128) || "instance";
}

function sanitizeUserId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 96) || "instance";
}

function hashShort(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
