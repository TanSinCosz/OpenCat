/** 数据集发现与准备；文件与配置路径解析不依赖 HTTP 路由。 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getEvaluationConfig } from "../config/load-config.js";
import type { EvaluationOptions, JsonRecord, RunListItem } from "./types.js";
import { numberValue, stringValue, readDatasetRecords, stringifyError } from "./records.js";
import { resolveEvalRoot as resolveEvaluationRoot } from "./paths.js";

const execFileAsync = promisify(execFile);

export function createDatasetRepository(options: EvaluationOptions) {
  const { workspaceRoot, evalRoot, evalRoots, appConfig } = options;
  const resolveEvalRoot = (datasetDir?: string) => resolveEvaluationRoot(options, datasetDir);
  // 同一应用中相同目录共享准备任务，避免并发请求重复启动 Python 加载器。
  const datasetPreparation = new Map<string, Promise<void>>();

  async function ensureDatasetAvailable(
    root: string,
    config?: JsonRecord,
  ): Promise<void> {
    if (config?.autoPrepareDataset !== true) {
      return;
    }

    const datasetPath = resolveConfiguredDatasetPath(config, root);
    const expectedCount = numberValue(config.limit);
    if (await isFile(datasetPath) &&
      (expectedCount === undefined ||
        (await readDatasetRecords(datasetPath)).length >= Math.max(1, Math.floor(expectedCount)))) {
      return;
    }

    const existing = datasetPreparation.get(root);
    if (existing) {
      await existing;
      return;
    }

    const preparation = prepareDataset(root, config).catch((error) => {
      console.warn(`Unable to auto-prepare SWE dataset at ${root}: ${stringifyError(error)}`);
    });
    datasetPreparation.set(root, preparation);
    await preparation;
  }

  async function prepareDataset(
    root: string,
    config: JsonRecord,
  ): Promise<void> {
    const source = stringValue(config.datasetSource);
    if (!source) {
      throw new Error("datasetSource is missing from the SWE config.");
    }

    const split = stringValue(config.datasetSplit) ?? "test";
    const output = resolveConfiguredDatasetPath(config, root);
    const limit = numberValue(config.limit) ?? 5;
    const loaderPath = path.resolve(workspaceRoot, "scripts/load_swe_verified_dataset.py");
    const configuredPython = stringValue(config.python)?.trim();
    const candidates = configuredPython
      ? [{ command: configuredPython, prefix: [] as string[] }]
      : [
        { command: "python", prefix: [] as string[] },
        { command: "py", prefix: ["-3"] },
      ];
    const errors: string[] = [];

    for (const candidate of candidates) {
      try {
        await execFileAsync(
          candidate.command,
          [
            ...candidate.prefix,
            loaderPath,
            "--source",
            source,
            "--split",
            split,
            "--output",
            output,
            "--limit",
            String(Math.max(1, Math.floor(limit))),
          ],
          {
            cwd: workspaceRoot,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
          },
        );
        const actualCount = (await readDatasetRecords(output)).length;
        if (actualCount < Math.max(1, Math.floor(limit))) {
          throw new Error(
            `Dataset loader produced ${actualCount} records; expected at least ${Math.floor(limit)}.`,
          );
        }
        return;
      } catch (error) {
        errors.push(`${candidate.command}: ${stringifyError(error)}`);
      }
    }

    throw new Error(errors.join("\n"));
  }

  function resolveConfiguredDatasetPath(
    config: JsonRecord | undefined,
    root: string,
  ): string {
    const configured = stringValue(config?.datasetPath);
    return configured
      ? (path.isAbsolute(configured)
        ? configured
        : path.resolve(workspaceRoot, configured))
      : path.join(root, "dataset.jsonl");
  }

  async function isFile(filePath: string): Promise<boolean> {
    try {
      return (await stat(filePath)).isFile();
    } catch {
      return false;
    }
  }

  async function resolveDatasetPathForRun(
    run: RunListItem,
    config?: JsonRecord,
  ): Promise<string> {
    const candidates = [
      path.join(run.path, "dataset.jsonl"),
      stringValue(config?.datasetPath),
      path.join(run.evalRoot, "dataset.jsonl"),
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

    return path.resolve(run.evalRoot, "dataset.jsonl");
  }

  async function resolveDashboardDatasetPath(
    config?: JsonRecord,
    root: string = evalRoot,
  ): Promise<string> {
    const configuredPath = stringValue(config?.datasetPath);
    const candidates = [
      configuredPath,
      path.join(root, "dataset.jsonl"),
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

    return path.join(root, "dataset.jsonl");
  }

  async function loadDashboardDatasetRecords(
    datasetDir?: string,
  ): Promise<JsonRecord[]> {
    const root = resolveEvalRoot(datasetDir);
    const config = getEvaluationConfig(appConfig);
    const datasetPath = await resolveDashboardDatasetPath(config, root);
    return await readDatasetRecords(datasetPath);
  }

  async function findDatasetInstance(
    instanceId: string,
    datasetDir?: string,
  ): Promise<JsonRecord | undefined> {
    const roots = datasetDir ? [resolveEvalRoot(datasetDir)] : evalRoots;
    for (const root of roots) {
      const instance = (await loadDashboardDatasetRecords(root))
        .find((record) => stringValue(record.instance_id) === instanceId);
      if (instance) {
        return instance;
      }
    }

    return undefined;
  }

  return { ensureDatasetAvailable, resolveDatasetPathForRun, loadDashboardDatasetRecords, findDatasetInstance };
}

export type DatasetRepository = ReturnType<typeof createDatasetRepository>;
