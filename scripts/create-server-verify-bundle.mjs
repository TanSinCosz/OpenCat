import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = path.join(root, ".opencat", "exports", `server-verify-${stamp}`);
const patchDir = path.join(out, "swe-patches");

mkdirSync(patchDir, { recursive: true });

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 200,
    });
  } catch (error) {
    return error.stdout?.toString() ?? "";
  }
}

function git(args, cwd) {
  return run("git", ["-c", "safe.directory=*", ...args], cwd);
}

function safePathSegment(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function readDataset() {
  const datasetPath = path.join(
    root,
    ".opencat",
    "evals",
    "swe-verified-cache",
    "swe_verified_full.jsonl",
  );
  const dataset = new Map();
  if (!existsSync(datasetPath)) {
    return dataset;
  }

  for (const line of readFileSync(datasetPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const item = JSON.parse(line);
      dataset.set(item.instance_id, item);
    } catch {
      // Ignore malformed local rows.
    }
  }
  return dataset;
}

function findSweRepoPath(instanceId) {
  const workspaceRoot = path.join(os.homedir(), ".opencat", "swe-workspaces");
  const base = path.join(workspaceRoot, instanceId);
  const candidates = [
    path.join(base, `repo-${safePathSegment(instanceId)}`),
    path.join(base, "repo"),
  ];

  return candidates.find((candidate) =>
    existsSync(candidate) && statSync(candidate).isDirectory()
  );
}

function collectLatestPatchCandidates(repoPath) {
  const patchRoot = path.join(repoPath, ".opencat", "patches");
  if (!existsSync(patchRoot)) {
    return [];
  }

  const patches = [];
  for (const session of readdirSync(patchRoot, { withFileTypes: true })) {
    if (!session.isDirectory()) {
      continue;
    }
    const latest = path.join(patchRoot, session.name, "latest.patch");
    if (existsSync(latest)) {
      patches.push(latest);
    }
  }
  return patches;
}

function collectSwePatches(dataset) {
  const workspaceRoot = path.join(os.homedir(), ".opencat", "swe-workspaces");
  if (!existsSync(workspaceRoot)) {
    return [];
  }

  const results = [];
  for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const instanceId = entry.name;
    const repoPath = findSweRepoPath(instanceId);
    if (!repoPath) {
      continue;
    }

    const status = git(["status", "--short"], repoPath).trim();
    const diff = git(["diff", "--binary"], repoPath);
    if (!status && !diff.trim()) {
      continue;
    }

    const patchName = `${safePathSegment(instanceId)}.patch`;
    const patchPath = path.join(patchDir, patchName);
    writeFileSync(patchPath, diff);

    const meta = dataset.get(instanceId) ?? {};
    results.push({
      instanceId,
      repo: meta.repo ?? "",
      baseCommit: meta.base_commit ?? "",
      problem: meta.problem_statement
        ? String(meta.problem_statement).split(/\r?\n/)[0]
        : "",
      repoPath,
      patchFile: `swe-patches/${patchName}`,
      patchBytes: Buffer.byteLength(diff),
      gitStatus: status.split(/\r?\n/).filter(Boolean),
      latestPatchCandidates: collectLatestPatchCandidates(repoPath),
    });
  }

  return results.sort((left, right) =>
    left.instanceId.localeCompare(right.instanceId)
  );
}

function collectSerialRuns() {
  const serialRoot = path.join(root, ".opencat", "evals", "swe-serial");
  if (!existsSync(serialRoot)) {
    return [];
  }

  const runs = [];
  for (const entry of readdirSync(serialRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const summaryPath = path.join(serialRoot, entry.name, "summary.json");
    if (!existsSync(summaryPath)) {
      continue;
    }
    try {
      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      runs.push({
        runId: summary.runId ?? entry.name,
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        model: summary.model,
        instanceLimit: summary.instanceLimit,
        resultCount: Array.isArray(summary.results) ? summary.results.length : 0,
      });
    } catch {
      // Ignore malformed summaries.
    }
  }

  return runs.sort((left, right) =>
    String(right.startedAt ?? "").localeCompare(String(left.startedAt ?? ""))
  );
}

const projectPatch = git(["diff", "--binary"], root);
const projectStatus = git(["status", "--short"], root);
writeFileSync(path.join(out, "opencat-project.patch"), projectPatch);
writeFileSync(path.join(out, "opencat-git-status.txt"), projectStatus);

const swePatches = collectSwePatches(readDataset());
const manifest = {
  createdAt: new Date().toISOString(),
  projectRoot: root,
  projectPatchBytes: Buffer.byteLength(projectPatch),
  projectStatus: projectStatus.split(/\r?\n/).filter(Boolean),
  swePatchCount: swePatches.length,
  swePatches,
  serialRuns: collectSerialRuns(),
};

writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));

writeFileSync(
  path.join(out, "VERIFY_PROMPT.md"),
  [
    "You are validating OpenCat SWE-bench results on a Linux server.",
    "",
    "The uploaded folder contains:",
    "- manifest.json: list of SWE instances and patch files",
    "- swe-patches/*.patch: git binary patches generated from each dirty SWE worktree",
    "- opencat-project.patch: patch for the OpenCat harness itself, for reference only unless explicitly requested",
    "",
    "Task:",
    "1. Read manifest.json.",
    "2. For each entry in manifest.swePatches, create or reuse a clean checkout of entry.repo at entry.baseCommit.",
    "3. Apply entry.patchFile with: git apply --index --whitespace=nowarn <patch>. If that fails, retry without --index and report the failure details.",
    "4. Run the relevant SWE-bench validation for that instance. Prefer the official SWE-bench harness if available; otherwise run the tests implied by the instance test_patch / problem context.",
    "5. Produce a table with instanceId, apply status, tests run, pass/fail, error summary, and any suspicious broad changes.",
    "6. Do not modify the patches unless asked; only validate them.",
    "",
    "Important constraints:",
    "- Validate patches against the exact baseCommit from manifest.json.",
    "- Do not use the OpenCat project patch as an SWE solution patch.",
    "- If dependencies are missing, report the exact setup command needed instead of guessing test results.",
    "- Keep logs concise, but save full raw logs under a validation-results directory.",
    "",
  ].join("\n"),
);

writeFileSync(
  path.join(out, "README.md"),
  [
    "# OpenCat Server Verification Bundle",
    "",
    `Created: ${manifest.createdAt}`,
    "",
    `SWE patches: ${swePatches.length}`,
    "",
    "Files:",
    "- `manifest.json` - machine-readable index",
    "- `swe-patches/*.patch` - solution patches to validate",
    "- `opencat-project.patch` - local OpenCat project changes for reference",
    "- `opencat-git-status.txt` - local project status",
    "- `VERIFY_PROMPT.md` - prompt to send to the server-side agent",
    "",
  ].join("\n"),
);

console.log(out);
console.log(JSON.stringify({
  swePatchCount: swePatches.length,
  projectPatchBytes: manifest.projectPatchBytes,
}, null, 2));
