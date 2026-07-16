import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const preparedRepoCaches = new Set<string>();

export type SweWorkspaceStatusValue =
  | "missing"
  | "ready"
  | "dirty"
  | "wrong-head"
  | "failed";

export interface SweInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
}

export interface SweWorkspaceOptions {
  workspaceRoot?: string;
  repoCacheRoot?: string;
  reposDir?: string;
  allowNetworkClone?: boolean;
  projectRoot?: string;
}

export interface SweWorkspaceStatus {
  status: SweWorkspaceStatusValue;
  path: string;
  repoCachePath?: string;
  error?: string;
}

export interface SweWorkspaceMeta {
  instanceId: string;
  repo: string;
  baseCommit: string;
  repoCachePath: string;
  worktreePath: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

export function createSweBenchSessionId(instanceId: string): string {
  return `session_swe_${instanceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function parseSweBenchSessionId(sessionId: string): string | undefined {
  return sessionId.startsWith("session_swe_")
    ? sessionId.slice("session_swe_".length)
    : undefined;
}

export function getSweWorkspacePath(
  instanceId: string,
  options: SweWorkspaceOptions = {},
): string {
  const safeInstanceId = sanitizePathSegment(instanceId);
  return path.join(
    resolveSweWorkspaceRoot(options),
    safeInstanceId,
    `repo-${safeInstanceId}`,
  );
}

export function getSweRepoCachePath(
  repo: string,
  options: SweWorkspaceOptions = {},
): string {
  return path.join(
    resolveSweRepoCacheRoot(options),
    `${sanitizePathSegment(repo)}.git`,
  );
}

export function resolveSweWorkspaceRoot(
  options: SweWorkspaceOptions = {},
): string {
  return path.resolve(
    options.workspaceRoot?.trim() ||
      process.env.OPENCAT_SWE_WORKSPACE_DIR?.trim() ||
      path.join(os.homedir(), ".opencat/swe-workspaces"),
  );
}

export function resolveSweRepoCacheRoot(
  options: SweWorkspaceOptions = {},
): string {
  return path.resolve(
    options.repoCacheRoot?.trim() ||
      process.env.OPENCAT_SWE_REPO_CACHE_DIR?.trim() ||
      path.join(os.homedir(), ".opencat/swe-repos"),
  );
}

export async function getSweWorkspaceStatus(
  instance: SweInstance,
  options: SweWorkspaceOptions = {},
): Promise<SweWorkspaceStatus> {
  const worktreePath = await resolveExistingSweWorkspacePath(
    instance.instance_id,
    options,
  );
  const repoCachePath = getSweRepoCachePath(instance.repo, options);

  try {
    if (!(await stat(worktreePath)).isDirectory()) {
      return { status: "missing", path: worktreePath, repoCachePath };
    }
  } catch {
    return { status: "missing", path: worktreePath, repoCachePath };
  }

  try {
    await git(["rev-parse", "--git-dir"], worktreePath);
    const head = (await git(["rev-parse", "HEAD"], worktreePath)).trim();
    const status = (await git(["status", "--short"], worktreePath)).trim();

    if (head !== instance.base_commit) {
      return {
        status: "wrong-head",
        path: worktreePath,
        repoCachePath,
        error: `HEAD is ${head.slice(0, 12)}, expected ${instance.base_commit.slice(0, 12)}`,
      };
    }

    return {
      status: status ? "dirty" : "ready",
      path: worktreePath,
      repoCachePath,
      error: status ? "Workspace has uncommitted changes." : undefined,
    };
  } catch (error) {
    return {
      status: "failed",
      path: worktreePath,
      repoCachePath,
      error: stringifyError(error),
    };
  }
}

async function resolveExistingSweWorkspacePath(
  instanceId: string,
  options: SweWorkspaceOptions,
): Promise<string> {
  const preferred = getSweWorkspacePath(instanceId, options);
  if (await isDirectory(preferred)) {
    return preferred;
  }

  const legacy = getLegacySweWorkspacePath(instanceId, options);
  return await isDirectory(legacy) ? legacy : preferred;
}

function getLegacySweWorkspacePath(
  instanceId: string,
  options: SweWorkspaceOptions,
): string {
  return path.join(
    resolveSweWorkspaceRoot(options),
    sanitizePathSegment(instanceId),
    "repo",
  );
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

export async function prepareSweWorkspace(
  instance: SweInstance,
  options: SweWorkspaceOptions = {},
): Promise<SweWorkspaceStatus> {
  const worktreePath = getSweWorkspacePath(instance.instance_id, options);
  const repoCachePath = getSweRepoCachePath(instance.repo, options);

  if (!instance.repo || !instance.base_commit) {
    return {
      status: "failed",
      path: worktreePath,
      repoCachePath,
      error: "Dataset item is missing repo or base_commit.",
    };
  }

  try {
    const existingStatus = await getSweWorkspaceStatus(instance, options);
    if (existingStatus.status !== "missing") {
      return existingStatus;
    }

    await ensureSweRepoCache(instance.repo, instance.base_commit, options);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await rm(worktreePath, { recursive: true, force: true });
    await git(["--git-dir", repoCachePath, "worktree", "prune"]);
    await git([
      "--git-dir",
      repoCachePath,
      "worktree",
      "add",
      "--force",
      "--detach",
      worktreePath,
      instance.base_commit,
    ]);
    await writeSweWorkspaceMeta(instance, repoCachePath, worktreePath);
    return await getSweWorkspaceStatus(instance, options);
  } catch (error) {
    return {
      status: "failed",
      path: worktreePath,
      repoCachePath,
      error: stringifyError(error),
    };
  }
}

async function ensureSweRepoCache(
  repo: string,
  baseCommit: string,
  options: SweWorkspaceOptions,
): Promise<string> {
  const repoCachePath = getSweRepoCachePath(repo, options);
  await mkdir(path.dirname(repoCachePath), { recursive: true });

  if (preparedRepoCaches.has(repoCachePath) && await isBareGitRepository(repoCachePath)) {
    return repoCachePath;
  }

  if (await isBareGitRepository(repoCachePath)) {
    if (await hasCommit(repoCachePath, baseCommit)) {
      preparedRepoCaches.add(repoCachePath);
      return repoCachePath;
    }

    await git(["--git-dir", repoCachePath, "fetch", "--all", "--prune"]);
    preparedRepoCaches.add(repoCachePath);
    return repoCachePath;
  }

  try {
    await rm(repoCachePath, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      `Repo cache exists but is not a valid bare Git repository and could not be removed: ${repoCachePath}. ${stringifyError(error)}`,
    );
  }
  const localRepo = await findLocalRepo(repo, options);
  if (localRepo) {
    await git(["clone", "--mirror", localRepo, repoCachePath]);
    preparedRepoCaches.add(repoCachePath);
    return repoCachePath;
  }

  if (options.allowNetworkClone) {
    await git(["clone", "--mirror", `https://github.com/${repo}.git`, repoCachePath]);
    preparedRepoCaches.add(repoCachePath);
    return repoCachePath;
  }

  throw new Error(
    `Missing local repo for ${repo}. Set reposDir or enable allowNetworkClone.`,
  );
}

async function findLocalRepo(
  repo: string,
  options: SweWorkspaceOptions,
): Promise<string | undefined> {
  const reposDir = options.reposDir?.trim();
  if (!reposDir) {
    return undefined;
  }

  const resolvedReposDir = path.isAbsolute(reposDir)
    ? reposDir
    : path.resolve(options.projectRoot ?? process.cwd(), reposDir);
  const candidates = [
    repo.replace("/", "__"),
    repo.split("/").at(-1) ?? repo,
    repo,
  ].map((name) => path.join(resolvedReposDir, name));

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

async function writeSweWorkspaceMeta(
  instance: SweInstance,
  repoCachePath: string,
  worktreePath: string,
): Promise<void> {
  const now = new Date().toISOString();
  const metaPath = path.join(path.dirname(worktreePath), "meta.json");
  const existing = await readJsonFile<Partial<SweWorkspaceMeta>>(metaPath);
  const meta: SweWorkspaceMeta = {
    instanceId: instance.instance_id,
    repo: instance.repo,
    baseCommit: instance.base_commit,
    repoCachePath,
    worktreePath,
    sessionId: createSweBenchSessionId(instance.instance_id),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--git-dir"], repoPath);
    return true;
  } catch {
    return false;
  }
}

async function isBareGitRepository(repoPath: string): Promise<boolean> {
  try {
    const result = await git([
      "--git-dir",
      repoPath,
      "rev-parse",
      "--is-bare-repository",
    ]);
    return result.trim() === "true";
  } catch {
    return false;
  }
}

async function hasCommit(
  repoCachePath: string,
  commit: string,
): Promise<boolean> {
  if (!commit) {
    return false;
  }

  try {
    await git([
      "--git-dir",
      repoCachePath,
      "cat-file",
      "-e",
      `${commit}^{commit}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-c",
    "safe.directory=*",
    ...args,
  ], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
