/** 评测工作区查询、准备与补丁导出；复用 SWE 工作区服务。 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getConfigValue, getEvaluationConfig, withAppConfig } from "../config/load-config.js";
import {
  getSweWorkspaceStatus,
  prepareSweWorkspace,
  type SweInstance,
  type SweWorkspaceOptions,
  type SweWorkspaceStatus,
} from "../swe/workspace.js";
import type { EvaluationOptions, JsonRecord } from "./types.js";
import { stringValue } from "./records.js";
import { resolveEvalRoot as resolveEvaluationRoot } from "./paths.js";

const MAX_PATCH_BYTES = 50 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export function createEvaluationWorkspace(options: EvaluationOptions) {
  const { workspaceRoot, appConfig } = options;
  const resolveEvalRoot = (datasetDir?: string) => resolveEvaluationRoot(options, datasetDir);

  async function getRepoWorkspaceStatus(
    instance: JsonRecord,
  ): Promise<SweWorkspaceStatus> {
    // 底层 SWE 服务仍通过配置作用域读取默认目录，须沿用本实例的配置快照。
    return await withAppConfig(appConfig, async () => getSweWorkspaceStatus(
      toSweInstance(instance),
      await createSweWorkspaceOptions(),
    ));
  }

  async function prepareRepoWorkspace(
    instance: JsonRecord,
  ): Promise<SweWorkspaceStatus> {
    return await withAppConfig(appConfig, async () => prepareSweWorkspace(
      toSweInstance(instance),
      await createSweWorkspaceOptions(),
    ));
  }

  async function exportRepoPatch(
    instance: JsonRecord,
    datasetDir?: string,
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
      : await saveSwePatchFile(instanceId, patch, datasetDir);

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
    datasetDir?: string,
  ): Promise<string> {
    const directory = resolveSwePatchDirectory(datasetDir);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${sanitizePatchFileName(instanceId)}.patch`);
    await writeFile(filePath, patch, "utf8");
    return filePath;
  }

  function resolveSwePatchDirectory(datasetDir?: string): string {
    const configured = getConfigValue("evaluation.patchDirectory", appConfig)?.trim();
    if (!configured) {
      return path.join(resolveEvalRoot(datasetDir), "patches");
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
    const config = getEvaluationConfig(appConfig);
    const value = config.allowNetworkClone;
    return {
      projectRoot: workspaceRoot,
      reposDir: stringValue(config?.reposDir)?.trim(),
      allowNetworkClone: value === true,
      workspaceNamespace: stringValue(config?.workspaceNamespace)?.trim(),
    };
  }

  function toSweInstance(instance: JsonRecord): SweInstance {
    return {
      instance_id: stringValue(instance.instance_id) ?? "unknown",
      repo: stringValue(instance.repo) ?? "",
      base_commit: stringValue(instance.base_commit) ?? "",
    };
  }

  return { getRepoWorkspaceStatus, prepareRepoWorkspace, exportRepoPatch };
}

export type EvaluationWorkspace = ReturnType<typeof createEvaluationWorkspace>;
