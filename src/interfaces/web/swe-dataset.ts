/** SWE 数据集发现、目录解析与工作区状态查询；不切换当前会话。 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getConfigValue, getEvaluationConfig } from "../../config/load-config.js";
import {
  createSweBenchSessionId,
  getSweWorkspaceStatus,
  parseSweBenchSessionInfo,
  type SweWorkspaceOptions,
  type SweWorkspaceStatusValue,
} from "../../swe/workspace.js";
import { listMainTranscriptSessions } from "./transcript-index.js";
import type { SweBenchItem, SweBenchInstance } from "./types.js";

const SWE_EVAL_DIR = ".opencat/evals/swe-verified-cache";

export async function listSweBenchItems(
  cwd: string,
  sweDatasetDir?: string,
): Promise<SweBenchItem[]> {
  const datasetDirectory = resolveSweDatasetDirectoryForSession(
    cwd,
    "",
    sweDatasetDir,
  );
  const workspaceOptions = await createSweWorkspaceOptions(cwd);
  const instances = await loadSweBenchInstances(cwd, datasetDirectory);
  const sessions = new Set(
    (await listMainTranscriptSessions(cwd)).map((item) => item.sessionId),
  );

  return await Promise.all(instances.map(async (instance) => {
    const sessionId = createSweBenchSessionId(
      instance.instance_id,
      workspaceOptions.workspaceNamespace,
    );
    const workspace = await getSweWorkspaceStatus(instance, workspaceOptions);
    return {
      instanceId: instance.instance_id,
      repo: instance.repo,
      baseCommit: instance.base_commit,
      problemPreview: firstLine(instance.problem_statement),
      sessionId,
      hasSession: sessions.has(sessionId),
      workspaceStatus: workspace.status,
    };
  }));
}

export async function findSweBenchInstance(
  cwd: string,
  instanceId: string,
  sweDatasetDir?: string,
): Promise<SweBenchInstance | undefined> {
  return (await loadSweBenchInstances(cwd, sweDatasetDir))
    .find((instance) => instance.instance_id === instanceId);
}

async function loadSweBenchInstances(
  cwd: string,
  sweDatasetDir?: string,
): Promise<SweBenchInstance[]> {
  const evalDirectory = resolveSweEvalDirectory(cwd, sweDatasetDir);
  const config = getEvaluationConfig();
  const configuredDatasetPath = typeof config?.datasetPath === "string"
    ? config.datasetPath
    : "";
  const datasetPath = configuredDatasetPath
    ? (isAbsolute(configuredDatasetPath)
      ? configuredDatasetPath
      : join(cwd, configuredDatasetPath))
    : join(evalDirectory, "dataset.jsonl");
  const records = await readJsonlOrArray<SweBenchInstance>(datasetPath);

  return records
    .filter(isSweBenchInstance);
}

export function resolveSweEvalDirectory(cwd: string, configured?: string): string {
  const requested = configured?.trim() ||
    getConfigValue("evaluation.directory")?.trim() ||
    SWE_EVAL_DIR;
  const resolved = isAbsolute(requested) ? requested : join(cwd, requested);
  const evalRoot = join(cwd, ".opencat", "evals");
  const normalized = resolved.replace(/[\\/]$/, "");
  return normalized === evalRoot || normalized.startsWith(evalRoot + "\\") ||
      normalized.startsWith(evalRoot + "/")
    ? normalized
    : join(cwd, SWE_EVAL_DIR);
}

export function resolveSweDatasetDirectoryForSession(
  cwd: string,
  sessionId: string,
  configured?: string,
): string {
  const sessionNamespace = parseSweBenchSessionInfo(sessionId)?.workspaceNamespace;
  return resolveSweEvalDirectory(cwd, configured ?? sessionNamespace);
}

export async function createSweWorkspaceOptions(
  cwd: string,
): Promise<SweWorkspaceOptions> {
  const config = getEvaluationConfig();
  return {
    projectRoot: cwd,
    reposDir: typeof config?.reposDir === "string" ? config.reposDir.trim() : undefined,
    allowNetworkClone: config.allowNetworkClone === true,
    workspaceNamespace: typeof config?.workspaceNamespace === "string"
      ? config.workspaceNamespace.trim() || undefined
      : undefined,
  };
}

async function readJsonlOrArray<T>(filePath: string): Promise<T[]> {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed as T[] : [];
  }

  return trimmed.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function isSweBenchInstance(value: unknown): value is SweBenchInstance {
  const record = value as Partial<SweBenchInstance>;
  return typeof record.instance_id === "string" &&
    typeof record.repo === "string" &&
    typeof record.base_commit === "string" &&
    typeof record.problem_statement === "string";
}

export function isUsableSweWorkspaceStatus(status: SweWorkspaceStatusValue): boolean {
  return status === "ready" || status === "dirty" || status === "wrong-head";
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}
