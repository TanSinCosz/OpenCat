import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { loadConfig } from "../src/config/load-config.js";
import { createMemoryConfig } from "../src/Memory/config.js";
import { createDefaultTools } from "../src/Tools/index.js";
import type { Tools } from "../src/Tools/types.js";
import type { EvaluationEvent } from "../src/telemetry/events.js";
import { JsonlRunObserver } from "../src/telemetry/jsonl.js";
import { query } from "../src/query.js";
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

type EvalConfig = {
  runId?: string;
  datasetPath?: string;
  datasetSource?: string;
  datasetSplit?: string;
  outputDir?: string;
  reposDir?: string;
  limit?: number;
  userRounds?: number;
  model?: string;
  allowWebTools?: boolean;
  allowNetworkClone?: boolean;
  python?: string;
};

type EvalSummary = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  model: string;
  userRounds: number;
  instanceLimit: number;
  results: InstanceSummary[];
  totals: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    promptCacheHitTokens: number;
    promptCacheMissTokens: number;
    cacheHitRate: number;
  };
};

type InstanceSummary = {
  instanceId: string;
  repo: string;
  baseCommit: string;
  status: "completed" | "max_turns" | "failed";
  durationMs: number;
  userRounds: number;
  worktreePath: string;
  eventsPath: string;
  summaryPath: string;
  patchPath: string;
  changedFiles: string[];
  turnCount: number;
  toolCallCount: number;
  toolCounts: Record<string, number>;
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
  toolResultBudgetReplacementCount: number;
  bulkyToolCompactCount: number;
  toolResultCharsBeforeBudget: number;
  toolResultCharsAfterBudget: number;
  toolResultCharsAfterCompact: number;
  error?: string;
};

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) {
  throw new Error("Set DEEPSEEK_API_KEY before running SWE-bench eval.");
}
const deepSeekApiKey = apiKey;

const configPath = path.resolve(
  process.env.SWE_VERIFIED_CONFIG?.trim() ??
    ".opencat/evals/swe-verified-cache/config.json",
);
const evalConfig = await loadEvalConfig(configPath);
const runId = process.env.SWE_VERIFIED_RUN_ID?.trim() ||
  stringSetting(evalConfig.runId) ||
  `swe_verified_cache_${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outputRoot = path.resolve(
  process.env.SWE_VERIFIED_OUTPUT_DIR ??
    stringSetting(evalConfig.outputDir) ??
    ".opencat/evals/swe-verified-cache",
  runId,
);
const reposDirSetting = process.env.SWE_VERIFIED_REPOS_DIR ??
  stringSetting(evalConfig.reposDir);
const reposDir = reposDirSetting
  ? path.resolve(reposDirSetting)
  : undefined;
const limit = readPositiveIntegerSetting("SWE_VERIFIED_LIMIT", evalConfig.limit, 5);
const userRounds = readPositiveIntegerSetting(
  "SWE_VERIFIED_USER_ROUNDS",
  evalConfig.userRounds,
  1,
);
const model = process.env.DEEPSEEK_MODEL ??
  stringSetting(evalConfig.model) ??
  "deepseek-v4-pro";
const allowNetworkClone = readBooleanSetting(
  "SWE_VERIFIED_ALLOW_NETWORK_CLONE",
  evalConfig.allowNetworkClone,
  false,
);
const allowWebTools = readBooleanSetting(
  "SWE_VERIFIED_ALLOW_WEB_TOOLS",
  evalConfig.allowWebTools,
  false,
);

await mkdir(outputRoot, { recursive: true });
const datasetPath = await resolveDatasetPath();
const instances = (await loadInstances(datasetPath)).slice(0, limit);
const startedAt = new Date();
const results: InstanceSummary[] = [];

for (const instance of instances) {
  results.push(await runInstance(instance));
}

const summary: EvalSummary = {
  runId,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  model,
  userRounds,
  instanceLimit: limit,
  results,
  totals: summarizeTotals(results),
};

await writeJson(path.join(outputRoot, "summary.json"), summary);
console.log(JSON.stringify(summary, null, 2));

async function runInstance(instance: SweBenchInstance): Promise<InstanceSummary> {
  const instanceStartedAt = Date.now();
  const instanceDir = path.join(outputRoot, sanitizePath(instance.instance_id));
  const worktreePath = path.join(instanceDir, "repo");
  const eventsPath = path.join(instanceDir, "events.jsonl");
  const summaryPath = path.join(instanceDir, "summary.json");
  const patchPath = path.join(instanceDir, "patch.diff");

  await rm(instanceDir, { recursive: true, force: true });
  await mkdir(instanceDir, { recursive: true });

  const baseSummary = createEmptySummary({
    instance,
    worktreePath,
    eventsPath,
    summaryPath,
    patchPath,
    startedAt: instanceStartedAt,
  });

  try {
    await prepareRepository(instance, worktreePath);
    const events: EvaluationEvent[] = [];
    const observer = new JsonlRunObserver(eventsPath);
    const runtime = createRuntime({
      cwd: worktreePath,
      sessionId: `session_${hashShort(`${runId}:${instance.instance_id}`)}`,
      deepSeekRuntimeConfig: {
        ...loadConfig(),
        apiKey: deepSeekApiKey,
        baseUrl: process.env.DEEPSEEK_BASE_URL,
        model,
        reasoningEffort: "max",
      },
      MemoryConfig: createMemoryConfig({ cwd: worktreePath }),
      observer: {
        async emit(event) {
          events.push(event);
          await observer.emit(event);
        },
      },
      tools: createSweEvalTools(),
    });
    const state = createState();

    let status: InstanceSummary["status"] = "max_turns";
    for (const prompt of renderSweBenchRoundPrompts(instance, userRounds)) {
      state.Messages.push(createMessage({ role: "user", content: prompt }));
      for await (const event of query(runtime, state)) {
        if (event.type === "done") {
          status = event.reason;
        }
      }
    }

    await writeText(patchPath, await git(["diff", "--binary"], worktreePath));
    const changedFiles = parseChangedFiles(
      await git(["status", "--short"], worktreePath),
    );
    const summary = summarizeEvents({
      ...baseSummary,
      status,
      durationMs: Date.now() - instanceStartedAt,
      changedFiles,
    }, events);
    await writeJson(summaryPath, summary);
    return summary;
  } catch (error) {
    const summary = {
      ...baseSummary,
      status: "failed" as const,
      durationMs: Date.now() - instanceStartedAt,
      error: stringifyError(error),
    };
    await writeJson(summaryPath, summary);
    return summary;
  }
}

function createSweEvalTools(): Tools {
  const tools = createDefaultTools();
  if (allowWebTools) {
    return tools;
  }

  return tools.filter((tool) =>
    tool.name !== "WebSearch" && tool.name !== "WebFetch"
  );
}

async function prepareRepository(
  instance: SweBenchInstance,
  worktreePath: string,
): Promise<void> {
  const localRepo = await findLocalRepo(instance.repo);

  if (localRepo) {
    await git(["clone", "--no-hardlinks", localRepo, worktreePath]);
  } else if (allowNetworkClone) {
    await git(["clone", `https://github.com/${instance.repo}.git`, worktreePath]);
  } else {
    throw new Error(
      `Missing local repo for ${instance.repo}. Set SWE_VERIFIED_REPOS_DIR or SWE_VERIFIED_ALLOW_NETWORK_CLONE=1.`,
    );
  }

  await git(["checkout", instance.base_commit], worktreePath);
}

async function findLocalRepo(repo: string): Promise<string | undefined> {
  if (!reposDir) {
    return undefined;
  }

  const candidates = [
    repo.replace("/", "__"),
    repo.split("/").at(-1) ?? repo,
    repo,
  ].map((name) => path.join(reposDir, name));

  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

function renderSweBenchPrompt(instance: SweBenchInstance): string {
  return [
    "You are evaluating OpenCat on a SWE-bench Verified issue.",
    "Modify the checked-out repository to fix the issue. Prefer minimal, well-tested changes.",
    "Use the available tools to inspect, edit, and verify the code.",
    "Do not fetch unrelated web content unless the repository itself requires it.",
    "",
    `<instance_id>${instance.instance_id}</instance_id>`,
    `<repo>${instance.repo}</repo>`,
    `<base_commit>${instance.base_commit}</base_commit>`,
    "",
    "<problem_statement>",
    instance.problem_statement,
    "</problem_statement>",
    instance.hints_text
      ? ["", "<hints_text>", instance.hints_text, "</hints_text>"].join("\n")
      : "",
  ].filter(Boolean).join("\n");
}

function renderSweBenchRoundPrompts(
  instance: SweBenchInstance,
  rounds: number,
): string[] {
  if (rounds <= 1) {
    return [renderSweBenchPrompt(instance)];
  }

  const prompts = [
    [
      renderSweBenchPrompt(instance),
      "",
      "Round 1 goal: investigate only.",
      "Read the relevant code and tests, identify the likely root cause, and produce a concise implementation plan.",
      "Avoid editing files in this round unless a tiny diagnostic edit is truly necessary.",
    ].join("\n"),
    [
      "Round 2 goal: implement the fix.",
      "Use the investigation from the previous round. Make the smallest code change that addresses the SWE-bench issue.",
      "Keep the patch focused and avoid unrelated cleanup.",
    ].join("\n"),
    [
      "Round 3 goal: verify the fix.",
      "Run the most relevant tests or checks available in this repository.",
      "If a failure is caused by your change, fix it. If the environment prevents verification, explain the blocker briefly.",
    ].join("\n"),
  ];

  while (prompts.length < rounds) {
    prompts.push([
      `Round ${prompts.length + 1} goal: continue verification and cleanup.`,
      "Use the existing session context. Inspect remaining failures, make only necessary follow-up edits, and keep the final state ready for review.",
    ].join("\n"));
  }

  return prompts.slice(0, rounds);
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
    throw new Error("SWE_VERIFIED_DATASET must be a JSON array or JSONL file.");
  }

  return parsed.map(normalizeInstance);
}

async function resolveDatasetPath(): Promise<string> {
  const providedPath = process.env.SWE_VERIFIED_DATASET?.trim() ||
    stringSetting(evalConfig.datasetPath);
  if (providedPath) {
    return path.resolve(providedPath);
  }

  const generatedPath = path.join(outputRoot, "dataset.jsonl");
  const loaderPath = path.resolve("scripts/load_swe_verified_dataset.py");
  const args = [
    loaderPath,
    "--output",
    generatedPath,
    "--limit",
    String(limit),
  ];

  const source = process.env.SWE_VERIFIED_DATASET_SOURCE?.trim() ||
    stringSetting(evalConfig.datasetSource);
  if (source) {
    args.push("--source", source);
  }

  const split = process.env.SWE_VERIFIED_DATASET_SPLIT?.trim() ||
    stringSetting(evalConfig.datasetSplit);
  if (split) {
    args.push("--split", split);
  }

  const stdout = await runPythonDatasetLoader(args);
  console.log(stdout.trim());
  return generatedPath;
}

async function runPythonDatasetLoader(args: string[]): Promise<string> {
  const configuredPython = process.env.SWE_VERIFIED_PYTHON?.trim() ||
    stringSetting(evalConfig.python);
  const candidates = configuredPython
    ? [{ command: configuredPython, argsPrefix: [] as string[] }]
    : [
      { command: "python", argsPrefix: [] as string[] },
      { command: "py", argsPrefix: ["-3"] },
    ];
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(
        candidate.command,
        [...candidate.argsPrefix, ...args],
        {
          cwd: process.cwd(),
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      return stdout;
    } catch (error) {
      errors.push(`${candidate.command}: ${stringifyError(error)}`);
    }
  }

  throw new Error(`Failed to run Python SWE-bench loader.\n${errors.join("\n")}`);
}

function normalizeInstance(value: unknown): SweBenchInstance {
  const record = value as Record<string, unknown>;
  const instance = {
    instance_id: stringField(record, "instance_id"),
    repo: stringField(record, "repo"),
    base_commit: stringField(record, "base_commit"),
    problem_statement: stringField(record, "problem_statement"),
    hints_text: optionalStringField(record, "hints_text"),
    test_patch: optionalStringField(record, "test_patch"),
  };

  for (const [key, fieldValue] of Object.entries(instance)) {
    if (
      key !== "hints_text" &&
      key !== "test_patch" &&
      typeof fieldValue !== "string"
    ) {
      throw new Error(`Invalid SWE-bench instance: missing ${key}`);
    }
  }

  return instance as SweBenchInstance;
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
  let contextReadyCount = 0;
  let turnCount = 0;
  let toolCallCount = 0;
  let autoCompressCount = 0;
  let historySnipCount = 0;
  let hardHistorySnipCount = 0;
  let toolResultBudgetReplacementCount = 0;
  let bulkyToolCompactCount = 0;
  let toolResultCharsBeforeBudget = 0;
  let toolResultCharsAfterBudget = 0;
  let toolResultCharsAfterCompact = 0;

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
      contextReadyCount++;
      maxEstimatedTokens = Math.max(maxEstimatedTokens, event.estimatedTokens);
      historySnipCount += event.historySnipCount;
      hardHistorySnipCount += event.hardHistorySnipApplied ? 1 : 0;
      toolResultBudgetReplacementCount +=
        event.toolResultBudgetReplacementCount;
      bulkyToolCompactCount += event.bulkyToolCompactCount;
      toolResultCharsBeforeBudget += event.toolResultCharsBeforeBudget;
      toolResultCharsAfterBudget += event.toolResultCharsAfterBudget;
      toolResultCharsAfterCompact += event.toolResultCharsAfterCompact;
      continue;
    }

    if (event.type === "tool_call_started") {
      toolCallCount++;
      toolCounts[event.toolName] = (toolCounts[event.toolName] ?? 0) + 1;
      continue;
    }

    if (event.type === "turn_finished") {
      turnCount = Math.max(turnCount, event.turn);
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
    turnCount,
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
    contextReadyCount,
    autoCompressCount,
    historySnipCount,
    hardHistorySnipCount,
    toolResultBudgetReplacementCount,
    bulkyToolCompactCount,
    toolResultCharsBeforeBudget,
    toolResultCharsAfterBudget,
    toolResultCharsAfterCompact,
  };
}

function createEmptySummary(options: {
  instance: SweBenchInstance;
  worktreePath: string;
  eventsPath: string;
  summaryPath: string;
  patchPath: string;
  startedAt: number;
}): InstanceSummary {
  return {
    instanceId: options.instance.instance_id,
    repo: options.instance.repo,
    baseCommit: options.instance.base_commit,
    status: "failed",
    durationMs: Date.now() - options.startedAt,
    userRounds,
    worktreePath: options.worktreePath,
    eventsPath: options.eventsPath,
    summaryPath: options.summaryPath,
    patchPath: options.patchPath,
    changedFiles: [],
    turnCount: 0,
    toolCallCount: 0,
    toolCounts: {},
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    cacheHitRate: 0,
    maxPromptTokens: 0,
    maxEstimatedTokens: 0,
    contextReadyCount: 0,
    autoCompressCount: 0,
    historySnipCount: 0,
    hardHistorySnipCount: 0,
    toolResultBudgetReplacementCount: 0,
    bulkyToolCompactCount: 0,
    toolResultCharsBeforeBudget: 0,
    toolResultCharsAfterBudget: 0,
    toolResultCharsAfterCompact: 0,
  };
}

function summarizeTotals(results: readonly InstanceSummary[]): EvalSummary["totals"] {
  const totals = results.reduce(
    (sum, result) => ({
      promptTokens: sum.promptTokens + result.promptTokens,
      completionTokens: sum.completionTokens + result.completionTokens,
      totalTokens: sum.totalTokens + result.totalTokens,
      promptCacheHitTokens:
        sum.promptCacheHitTokens + result.promptCacheHitTokens,
      promptCacheMissTokens:
        sum.promptCacheMissTokens + result.promptCacheMissTokens,
    }),
    {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
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

function computeCacheHitRate(hit: number, miss: number): number {
  const denominator = hit + miss;
  return denominator === 0 ? 0 : hit / denominator;
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
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

async function loadEvalConfig(filePath: string): Promise<EvalConfig> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("SWE eval config must be a JSON object.");
    }
    return parsed as EvalConfig;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {};
    }
    throw error;
  }
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
    return isTruthy(envValue);
  }
  return configValue ?? fallback;
}

function stringSetting(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function sanitizePath(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128) || "instance";
}

function hashShort(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}
