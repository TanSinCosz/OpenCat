import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { loadConfig } from "../src/config/load-config.js";
import { createMemoryConfig } from "../src/Memory/config.js";
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

type SerialEvalConfig = {
  runId?: string;
  datasetPath?: string;
  outputDir?: string;
  reposDir?: string;
  workspaceRoot?: string;
  repoCacheRoot?: string;
  limit?: number;
  model?: string;
  allowNetworkClone?: boolean;
  allowWebTools?: boolean;
  allowDirtyWorkspaces?: boolean;
  phases?: Array<"investigate" | "fix">;
};

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

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) {
  throw new Error("Set DEEPSEEK_API_KEY before running SWE serial eval.");
}

const config = await loadSerialConfig(
  path.resolve(
    process.env.SWE_SERIAL_CONFIG?.trim() ??
      ".opencat/evals/swe-serial/config.json",
  ),
);
const runId = process.env.SWE_SERIAL_RUN_ID?.trim() ||
  config.runId?.trim() ||
  `swe_serial_${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outputRoot = path.resolve(
  process.env.SWE_SERIAL_OUTPUT_DIR?.trim() ||
    config.outputDir?.trim() ||
    ".opencat/evals/swe-serial",
  runId,
);
const limit = readPositiveIntegerSetting("SWE_SERIAL_LIMIT", config.limit, 100);
const model = process.env.DEEPSEEK_MODEL?.trim() ||
  config.model?.trim() ||
  "deepseek-v4-pro";
const allowNetworkClone = readBooleanSetting(
  "SWE_SERIAL_ALLOW_NETWORK_CLONE",
  config.allowNetworkClone,
  false,
);
const allowWebTools = readBooleanSetting(
  "SWE_SERIAL_ALLOW_WEB_TOOLS",
  config.allowWebTools,
  false,
);
const allowDirtyWorkspaces = readBooleanSetting(
  "SWE_SERIAL_ALLOW_DIRTY_WORKSPACES",
  config.allowDirtyWorkspaces,
  false,
);
const phases = parsePhases(process.env.SWE_SERIAL_PHASES, config.phases);
const workspaceOptions: SweWorkspaceOptions = {
  reposDir: process.env.SWE_SERIAL_REPOS_DIR?.trim() || config.reposDir,
  workspaceRoot: process.env.OPENCAT_SWE_WORKSPACE_DIR?.trim() ||
    config.workspaceRoot,
  repoCacheRoot: process.env.OPENCAT_SWE_REPO_CACHE_DIR?.trim() ||
    config.repoCacheRoot,
  allowNetworkClone,
  projectRoot: process.cwd(),
};

await mkdir(outputRoot, { recursive: true });
const datasetPath = await resolveDatasetPath(config);
const instances = (await loadInstances(datasetPath)).slice(0, limit);
const startedAt = new Date();
const results: InstanceSummary[] = [];

for (const instance of instances) {
  const result = await runInstance(instance);
  results.push(result);
  await writeJson(path.join(outputRoot, "summary.json"), createSummary());
  console.log(
    `[${results.length}/${instances.length}] ${instance.instance_id}: ${result.status}`,
  );
}

await writeJson(path.join(outputRoot, "summary.json"), createSummary());
console.log(JSON.stringify(createSummary(), null, 2));

function createSummary() {
  return {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    model,
    phases,
    instanceLimit: limit,
    datasetPath,
    outputRoot,
    results,
    totals: summarizeTotals(results),
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
      deepSeekRuntimeConfig: {
        ...loadConfig(),
        apiKey,
        baseUrl: process.env.DEEPSEEK_BASE_URL,
        model,
        reasoningEffort: "max",
      },
      MemoryConfig: createMemoryConfig({ cwd: workspace.path }),
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
  const configured = process.env.SWE_SERIAL_DATASET?.trim() ||
    config.datasetPath?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  const candidates = [
    ".opencat/evals/swe-verified-cache/swe_verified_full.jsonl",
    ".opencat/evals/swe-verified-cache/dataset.jsonl",
  ].map((candidate) => path.resolve(candidate));

  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Missing SWE dataset. Set SWE_SERIAL_DATASET or generate .opencat/evals/swe-verified-cache/swe_verified_full.jsonl first.",
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
      bulkyToolCompactCount += event.bulkyToolCompactCount;
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

async function loadSerialConfig(filePath: string): Promise<SerialEvalConfig> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as SerialEvalConfig
      : {};
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {};
    }
    throw error;
  }
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

function parsePhases(
  envValue: string | undefined,
  configValue: SerialEvalConfig["phases"],
): PhaseName[] {
  const raw = envValue
    ? envValue.split(",").map((value) => value.trim())
    : configValue;
  const phases = (raw && raw.length > 0 ? raw : ["investigate", "fix"])
    .filter((value): value is PhaseName =>
      value === "investigate" || value === "fix"
    );
  return phases.length > 0 ? phases : ["investigate", "fix"];
}

function readPositiveIntegerSetting(
  envName: string,
  configValue: number | undefined,
  fallback: number,
): number {
  const envValue = Number(process.env[envName]);
  if (Number.isInteger(envValue) && envValue > 0) {
    return envValue;
  }
  return typeof configValue === "number" &&
      Number.isInteger(configValue) &&
      configValue > 0
    ? configValue
    : fallback;
}

function readBooleanSetting(
  envName: string,
  configValue: boolean | undefined,
  fallback: boolean,
): boolean {
  const envValue = process.env[envName];
  if (envValue !== undefined) {
    return envValue === "1" || envValue.toLowerCase() === "true";
  }
  return configValue ?? fallback;
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

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function sanitizePath(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128) || "instance";
}

function hashShort(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
