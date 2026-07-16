import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { createTwoFilesPatch, diffLines } from "diff";

import type { Runtime } from "../types/runtime.js";

const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 50 * 1024 * 1024;

export type WorkspacePatchSnapshotReason =
  | "completed"
  | "max_turns"
  | "failed"
  | "manual"
  | "approved";

export type WorkspacePatchDiffResult =
  | {
    status: "ok";
    cwd: string;
    patch: string;
    empty: boolean;
    bytes: number;
  }
  | { status: "not_git"; cwd: string }
  | { status: "failed"; cwd: string; error: string };

export type WorkspacePatchSnapshotResult =
  | {
    status: "saved";
    cwd: string;
    sequence: number;
    patchPath: string;
    latestPath: string;
    bytes: number;
  }
  | { status: "empty"; cwd: string }
  | { status: "not_git"; cwd: string }
  | { status: "failed"; cwd: string; error: string };

export type WorkspacePatchApprovalResult =
  | {
    status: "approved";
    cwd: string;
    patchPath: string;
    approvedPath: string;
    bytes: number;
    sequence: number;
  }
  | { status: "empty"; cwd: string }
  | { status: "not_git"; cwd: string }
  | { status: "failed"; cwd: string; error: string };

export type WorkspacePatchApplySource = "latest" | "approved";

export type WorkspacePatchApplyResult =
  | {
    status: "applied";
    cwd: string;
    source: WorkspacePatchApplySource;
    patchPath: string;
    bytes: number;
  }
  | { status: "dirty"; cwd: string }
  | { status: "missing"; cwd: string; source: WorkspacePatchApplySource }
  | { status: "not_git"; cwd: string }
  | { status: "failed"; cwd: string; error: string };

export type WorkspacePatchRevertResult =
  | {
    status: "reverted";
    cwd: string;
    bytes: number;
  }
  | { status: "empty"; cwd: string }
  | { status: "not_git"; cwd: string }
  | { status: "failed"; cwd: string; error: string };

export type WorkspacePatchSummaryResult =
  | {
    status: "ok";
    cwd: string;
    fileCount: number;
    additions: number;
    deletions: number;
    files: WorkspacePatchFileSummary[];
  }
  | { status: "empty"; cwd: string }
  | { status: "not_git"; cwd: string }
  | { status: "failed"; cwd: string; error: string };

export type WorkspacePatchBaseline =
  | {
    status: "ok";
    cwd: string;
    capturedAt: number;
    files: Record<string, WorkspacePatchBaselineFile>;
  }
  | { status: "not_git"; cwd: string }
  | { status: "failed"; cwd: string; error: string };

type WorkspacePatchBaselineFile = {
  content: string | null;
};

export type WorkspacePatchDeltaDiffResult =
  | {
    status: "ok";
    cwd: string;
    patch: string;
    empty: boolean;
    bytes: number;
    baselineCapturedAt: number;
  }
  | { status: "empty"; cwd: string; baselineCapturedAt: number }
  | { status: "missing_baseline"; cwd: string }
  | { status: "not_git"; cwd: string }
  | { status: "failed"; cwd: string; error: string };

export type WorkspacePatchDeltaSummaryResult =
  | {
    status: "ok";
    cwd: string;
    fileCount: number;
    additions: number;
    deletions: number;
    files: WorkspacePatchFileSummary[];
    baselineCapturedAt: number;
  }
  | { status: "empty"; cwd: string; baselineCapturedAt: number }
  | { status: "missing_baseline"; cwd: string }
  | { status: "not_git"; cwd: string }
  | { status: "failed"; cwd: string; error: string };

export type WorkspacePatchFileSummary = {
  path: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};

export async function getWorkspacePatchDiff(
  runtime: Runtime,
): Promise<WorkspacePatchDiffResult> {
  const cwd = runtime.cwd;

  if (!await isGitWorkspace(cwd)) {
    return { status: "not_git", cwd };
  }

  try {
    const patch = await readCurrentPatch(cwd);
    return {
      status: "ok",
      cwd,
      patch,
      empty: patch.trim().length === 0,
      bytes: Buffer.byteLength(patch),
    };
  } catch (error) {
    return {
      status: "failed",
      cwd,
      error: stringifyError(error),
    };
  }
}

export async function captureWorkspacePatchBaseline(
  runtime: Runtime,
): Promise<WorkspacePatchBaseline> {
  const cwd = runtime.cwd;

  if (!await isGitWorkspace(cwd)) {
    return { status: "not_git", cwd };
  }

  try {
    const files: Record<string, WorkspacePatchBaselineFile> = {};
    for (const path of await readCurrentDiffPaths(cwd)) {
      files[path] = {
        content: await readWorkingTreeFile(cwd, path),
      };
    }

    return {
      status: "ok",
      cwd,
      capturedAt: Date.now(),
      files,
    };
  } catch (error) {
    return {
      status: "failed",
      cwd,
      error: stringifyError(error),
    };
  }
}

export async function getWorkspacePatchDeltaDiff(
  runtime: Runtime,
  baseline: WorkspacePatchBaseline | undefined,
): Promise<WorkspacePatchDeltaDiffResult> {
  if (!baseline) {
    return { status: "missing_baseline", cwd: runtime.cwd };
  }

  if (baseline.status !== "ok") {
    return baseline;
  }

  const delta = await buildWorkspacePatchDelta(runtime.cwd, baseline);
  if (delta.status !== "ok") {
    return delta;
  }

  if (delta.patch.trim().length === 0) {
    return {
      status: "empty",
      cwd: delta.cwd,
      baselineCapturedAt: baseline.capturedAt,
    };
  }

  return {
    status: "ok",
    cwd: delta.cwd,
    patch: delta.patch,
    empty: false,
    bytes: Buffer.byteLength(delta.patch),
    baselineCapturedAt: baseline.capturedAt,
  };
}

export async function getWorkspacePatchDeltaSummary(
  runtime: Runtime,
  baseline: WorkspacePatchBaseline | undefined,
): Promise<WorkspacePatchDeltaSummaryResult> {
  if (!baseline) {
    return { status: "missing_baseline", cwd: runtime.cwd };
  }

  if (baseline.status !== "ok") {
    return baseline;
  }

  const delta = await buildWorkspacePatchDelta(runtime.cwd, baseline);
  if (delta.status !== "ok") {
    return delta;
  }

  if (delta.files.length === 0) {
    return {
      status: "empty",
      cwd: delta.cwd,
      baselineCapturedAt: baseline.capturedAt,
    };
  }

  return {
    status: "ok",
    cwd: delta.cwd,
    fileCount: delta.files.length,
    additions: delta.files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: delta.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    files: delta.files,
    baselineCapturedAt: baseline.capturedAt,
  };
}

export async function saveWorkspacePatchSnapshot(
  runtime: Runtime,
  reason: WorkspacePatchSnapshotReason,
): Promise<WorkspacePatchSnapshotResult> {
  const cwd = runtime.cwd;

  if (!await isGitWorkspace(cwd)) {
    return { status: "not_git", cwd };
  }

  try {
    const patch = await readCurrentPatch(cwd);

    if (patch.trim().length === 0) {
      return { status: "empty", cwd };
    }

    const directory = resolvePatchSnapshotDirectory(runtime);
    await mkdir(directory, { recursive: true });
    const sequence = await nextPatchSequence(directory);
    const fileName = `${String(sequence).padStart(4, "0")}-${reason}.patch`;
    const patchPath = join(directory, fileName);
    const latestPath = join(directory, "latest.patch");
    const metadata = {
      sessionId: runtime.sessionId,
      agentId: runtime.agentId,
      agentRole: runtime.agentRole,
      parentAgentId: runtime.parentAgentId,
      agentType: runtime.agentType,
      cwd,
      reason,
      sequence,
      patchPath,
      latestPath,
      bytes: Buffer.byteLength(patch),
      savedAt: Date.now(),
    };

    await writeFile(patchPath, patch, "utf8");
    await writeFile(latestPath, patch, "utf8");
    await writeFile(
      patchPath.replace(/\.patch$/, ".json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(directory, "latest.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );

    return {
      status: "saved",
      cwd,
      sequence,
      patchPath,
      latestPath,
      bytes: metadata.bytes,
    };
  } catch (error) {
    return {
      status: "failed",
      cwd,
      error: stringifyError(error),
    };
  }
}

export async function approveWorkspacePatchSnapshot(
  runtime: Runtime,
): Promise<WorkspacePatchApprovalResult> {
  const saved = await saveWorkspacePatchSnapshot(runtime, "approved");

  if (saved.status !== "saved") {
    return saved;
  }

  try {
    const directory = resolvePatchSnapshotDirectory(runtime);
    const approvedPath = join(directory, "approved.patch");
    await copyFile(saved.patchPath, approvedPath);
    await writeFile(
      join(directory, "approved.json"),
      `${JSON.stringify({
        sessionId: runtime.sessionId,
        agentId: runtime.agentId,
        agentRole: runtime.agentRole,
        parentAgentId: runtime.parentAgentId,
        agentType: runtime.agentType,
        cwd: runtime.cwd,
        patchPath: saved.patchPath,
        approvedPath,
        bytes: saved.bytes,
        sequence: saved.sequence,
        approvedAt: Date.now(),
      }, null, 2)}\n`,
      "utf8",
    );

    return {
      status: "approved",
      cwd: saved.cwd,
      patchPath: saved.patchPath,
      approvedPath,
      bytes: saved.bytes,
      sequence: saved.sequence,
    };
  } catch (error) {
    return {
      status: "failed",
      cwd: runtime.cwd,
      error: stringifyError(error),
    };
  }
}

export async function applyWorkspacePatchSnapshot(
  runtime: Runtime,
  source: WorkspacePatchApplySource = "latest",
): Promise<WorkspacePatchApplyResult> {
  const cwd = runtime.cwd;

  if (!await isGitWorkspace(cwd)) {
    return { status: "not_git", cwd };
  }

  try {
    const currentPatch = await readCurrentPatch(cwd);
    if (currentPatch.trim().length > 0) {
      return { status: "dirty", cwd };
    }

    const patchPath = resolvePatchSnapshotFile(runtime, source);
    const patch = await readFile(patchPath, "utf8").catch(() => null);

    if (!patch || patch.trim().length === 0) {
      return { status: "missing", cwd, source };
    }

    await applyPatch(cwd, patch, false);

    return {
      status: "applied",
      cwd,
      source,
      patchPath,
      bytes: Buffer.byteLength(patch),
    };
  } catch (error) {
    return {
      status: "failed",
      cwd,
      error: stringifyError(error),
    };
  }
}

export async function revertWorkspacePatch(
  runtime: Runtime,
): Promise<WorkspacePatchRevertResult> {
  const cwd = runtime.cwd;

  if (!await isGitWorkspace(cwd)) {
    return { status: "not_git", cwd };
  }

  try {
    const patch = await readCurrentPatch(cwd);

    if (patch.trim().length === 0) {
      return { status: "empty", cwd };
    }

    await applyPatch(cwd, patch, true);

    return {
      status: "reverted",
      cwd,
      bytes: Buffer.byteLength(patch),
    };
  } catch (error) {
    return {
      status: "failed",
      cwd,
      error: stringifyError(error),
    };
  }
}

export async function getWorkspacePatchSummary(
  runtime: Runtime,
): Promise<WorkspacePatchSummaryResult> {
  const cwd = runtime.cwd;

  if (!await isGitWorkspace(cwd)) {
    return { status: "not_git", cwd };
  }

  try {
    const { stdout } = await execFileAsync("git", [
      "-c",
      "safe.directory=*",
      "diff",
      "--numstat",
    ], {
      cwd,
      windowsHide: true,
    });
    const files = parseNumstat(stdout);

    if (files.length === 0) {
      return { status: "empty", cwd };
    }

    return {
      status: "ok",
      cwd,
      fileCount: files.length,
      additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      files,
    };
  } catch (error) {
    return {
      status: "failed",
      cwd,
      error: stringifyError(error),
    };
  }
}

async function readCurrentPatch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-c",
    "safe.directory=*",
    "diff",
    "--binary",
  ], {
    cwd,
    maxBuffer: MAX_PATCH_BYTES,
    windowsHide: true,
  });

  return String(stdout);
}

async function buildWorkspacePatchDelta(
  cwd: string,
  baseline: Extract<WorkspacePatchBaseline, { status: "ok" }>,
): Promise<
  | {
    status: "ok";
    cwd: string;
    patch: string;
    files: WorkspacePatchFileSummary[];
  }
  | { status: "not_git"; cwd: string }
  | { status: "failed"; cwd: string; error: string }
> {
  if (!await isGitWorkspace(cwd)) {
    return { status: "not_git", cwd };
  }

  if (baseline.cwd !== cwd) {
    return {
      status: "failed",
      cwd,
      error: `Patch baseline belongs to a different workspace: ${baseline.cwd}`,
    };
  }

  try {
    const currentPaths = await readCurrentDiffPaths(cwd);
    const paths = [...new Set([
      ...Object.keys(baseline.files),
      ...currentPaths,
    ])].sort();
    const patches: string[] = [];
    const files: WorkspacePatchFileSummary[] = [];

    for (const path of paths) {
      const before = Object.hasOwn(baseline.files, path)
        ? baseline.files[path]!.content
        : await readHeadFile(cwd, path);
      const after = await readWorkingTreeFile(cwd, path);

      if (before === after) {
        continue;
      }

      files.push(summarizeTextDelta(path, before, after));
      patches.push(createTwoFilesPatch(
        `a/${path}`,
        `b/${path}`,
        before ?? "",
        after ?? "",
        "",
        "",
        { context: 3 },
      ));
    }

    return {
      status: "ok",
      cwd,
      patch: patches.join("\n"),
      files,
    };
  } catch (error) {
    return {
      status: "failed",
      cwd,
      error: stringifyError(error),
    };
  }
}

async function readCurrentDiffPaths(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", [
    "-c",
    "safe.directory=*",
    "diff",
    "--name-only",
    "-z",
  ], {
    cwd,
    maxBuffer: MAX_PATCH_BYTES,
    windowsHide: true,
  });

  return String(stdout).split("\0").filter(Boolean);
}

async function readWorkingTreeFile(
  cwd: string,
  path: string,
): Promise<string | null> {
  return readFile(join(cwd, path), "utf8").catch(() => null);
}

async function readHeadFile(
  cwd: string,
  path: string,
): Promise<string | null> {
  const { stdout } = await execFileAsync("git", [
    "-c",
    "safe.directory=*",
    "show",
    `HEAD:${path}`,
  ], {
    cwd,
    maxBuffer: MAX_PATCH_BYTES,
    windowsHide: true,
  }).catch(() => ({ stdout: null }));

  return stdout === null ? null : String(stdout);
}

function summarizeTextDelta(
  path: string,
  before: string | null,
  after: string | null,
): WorkspacePatchFileSummary {
  const parts = diffLines(before ?? "", after ?? "");

  return {
    path,
    additions: parts.reduce(
      (sum, part) => sum + (part.added ? countLines(part.value) : 0),
      0,
    ),
    deletions: parts.reduce(
      (sum, part) => sum + (part.removed ? countLines(part.value) : 0),
      0,
    ),
    binary: false,
  };
}

function countLines(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  return value.endsWith("\n")
    ? value.split("\n").length - 1
    : value.split("\n").length;
}

async function applyPatch(
  cwd: string,
  patch: string,
  reverse: boolean,
): Promise<void> {
  const args = [
    "-c",
    "safe.directory=*",
    "apply",
    "--whitespace=nowarn",
  ];

  if (reverse) {
    args.push("--reverse");
  }

  await runGitWithStdin(cwd, args, patch);
}

function runGitWithStdin(
  cwd: string,
  args: string[],
  input: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error((stderr || stdout || `git exited with ${code}`).trim()));
    });

    child.stdin.end(input);
  });
}

function parseNumstat(raw: string): WorkspacePatchFileSummary[] {
  return raw.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [additions, deletions, ...pathParts] = line.split(/\t/);
      const binary = additions === "-" || deletions === "-";

      return {
        path: pathParts.join("\t"),
        additions: binary ? null : Number(additions),
        deletions: binary ? null : Number(deletions),
        binary,
      };
    });
}

async function isGitWorkspace(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-c",
      "safe.directory=*",
      "rev-parse",
      "--is-inside-work-tree",
    ], {
      cwd,
      windowsHide: true,
    });

    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function resolvePatchSnapshotDirectory(runtime: Runtime): string {
  const configured = process.env.OPENCAT_PATCH_SNAPSHOT_DIR?.trim();
  const root = configured
    ? (isAbsolute(configured) ? configured : join(runtime.cwd, configured))
    : join(runtime.cwd, ".opencat", "patches");

  return join(root, sanitizePathSegment(runtime.sessionId));
}

function resolvePatchSnapshotFile(
  runtime: Runtime,
  source: WorkspacePatchApplySource,
): string {
  return join(resolvePatchSnapshotDirectory(runtime), `${source}.patch`);
}

async function nextPatchSequence(directory: string): Promise<number> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const maxExisting = entries.reduce((max, entry) => {
      if (!entry.isFile()) {
        return max;
      }

      const match = /^(\d+)-.*\.patch$/.exec(entry.name);
      if (!match) {
        return max;
      }

      return Math.max(max, Number(match[1]));
    }, 0);

    return maxExisting + 1;
  } catch {
    return 1;
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
