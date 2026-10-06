/** SWE 会话状态与补丁导出；会话由调用方显式传入。 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { getConfigValue } from "../../config/load-config.js";
import {
  getSweWorkspaceStatus,
  parseSweBenchSessionId,
  type SweWorkspaceStatusValue,
} from "../../swe/workspace.js";
import {
  findSweBenchInstance,
  createSweWorkspaceOptions,
  isUsableSweWorkspaceStatus,
  resolveSweEvalDirectory,
} from "./swe-dataset.js";
import type { WebCliSession } from "./types.js";

const MAX_PATCH_BYTES = 50 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export async function getCurrentSweSessionInfo(session: WebCliSession): Promise<{
  instanceId: string;
  workspaceReady: boolean;
  workspaceStatus: SweWorkspaceStatusValue;
  workspacePath?: string;
} | null> {
  const instanceId = parseSweBenchSessionId(session.runtime.sessionId);
  if (!instanceId) {
    return null;
  }

  const instance = await findSweBenchInstance(
    process.cwd(),
    instanceId,
    session.sweDatasetDir,
  );
  if (!instance) {
    return {
      instanceId,
      workspaceReady: false,
      workspaceStatus: "missing",
    };
  }

  const workspace = await getSweWorkspaceStatus(
    instance,
    await createSweWorkspaceOptions(process.cwd()),
  );
  return {
    instanceId,
    workspaceReady: isUsableSweWorkspaceStatus(workspace.status),
    workspaceStatus: workspace.status,
    workspacePath: workspace.path,
  };
}

export async function exportCurrentSwePatch(session: WebCliSession): Promise<{
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
  const swe = await getCurrentSweSessionInfo(session);
  if (!swe) {
    return { ok: false, error: "Current session is not a SWE session." };
  }

  if (!swe.workspaceReady || !swe.workspacePath) {
    return {
      ok: false,
      error: `SWE workspace is not ready: ${swe.workspaceStatus}.`,
    };
  }

  const { stdout } = await execFileAsync("git", [
    "-c",
    "safe.directory=*",
    "diff",
    "--binary",
  ], {
    cwd: swe.workspacePath,
    maxBuffer: MAX_PATCH_BYTES,
    windowsHide: true,
  });
  const patch = String(stdout);
  const savedPath = patch.trim().length === 0
    ? undefined
    : await saveSwePatchFile(swe.instanceId, patch, session.sweDatasetDir);

  return {
    ok: true,
    instanceId: swe.instanceId,
    fileName: `${swe.instanceId}.patch`,
    patch,
    empty: patch.trim().length === 0,
    savedPath,
    workspacePath: swe.workspacePath,
  };
}

async function saveSwePatchFile(
  instanceId: string,
  patch: string,
  datasetDir?: string,
): Promise<string> {
  const directory = resolveSwePatchDirectory(datasetDir);
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, `${sanitizePatchFileName(instanceId)}.patch`);
  await writeFile(filePath, patch, "utf8");
  return filePath;
}

function resolveSwePatchDirectory(datasetDir?: string): string {
  const configured = getConfigValue("evaluation.patchDirectory")?.trim();
  if (!configured) {
    return join(
      resolveSweEvalDirectory(process.cwd(), datasetDir),
      "patches",
    );
  }

  return isAbsolute(configured) ? configured : join(process.cwd(), configured);
}

function sanitizePatchFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
