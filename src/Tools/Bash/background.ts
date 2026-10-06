import { randomUUID } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import {
  createWriteStream,
  type WriteStream,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { recordTranscriptStateSnapshot } from "../../transcript/persistence.js";
import type { Runtime } from "../../types/runtime.js";
import type { State } from "../../types/state.js";
import type {
  BackgroundTask,
  BackgroundTaskStatus,
} from "./state.js";

const MAX_BACKGROUND_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_TERMINAL_TASKS_IN_MEMORY = 100;

type BackgroundTaskHandle = {
  taskId: string;
  sessionId: string;
  ownerAgentId: string;
  child: ChildProcess;
  output: WriteStream;
  state: State;
  runtime: Runtime;
  timeoutId?: NodeJS.Timeout;
  outputBytes: number;
  stopReason?: string;
  timedOut: boolean;
  failedStop: boolean;
  suppressNotification: boolean;
  settled: boolean;
};

export type StartBackgroundBashTaskOptions = {
  command: string;
  description?: string;
  timeout?: number;
  runtime: Runtime;
  state: State;
};

export type StopBackgroundTaskResult = {
  stopped: boolean;
  task?: BackgroundTask;
  message: string;
};

const handles = new Map<string, BackgroundTaskHandle>();
let exitCleanupRegistered = false;

export async function startBackgroundBashTask(
  options: StartBackgroundBashTaskOptions,
): Promise<BackgroundTask> {
  const taskId = `bash_${randomUUID()}`;
  const outputFile = getBackgroundTaskOutputPath(
    options.runtime.sessionId,
    taskId,
  );
  await mkdir(path.dirname(outputFile), { recursive: true });

  const output = createWriteStream(outputFile, {
    flags: "a",
    encoding: "utf8",
  });
  const child = spawn(options.command, {
    cwd: options.runtime.cwd,
    shell: true,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const now = Date.now();
  const task: BackgroundTask = {
    id: taskId,
    type: "bash",
    sessionId: options.runtime.sessionId,
    ownerAgentId: options.runtime.agentId,
    command: options.command,
    description: options.description?.trim() || options.command,
    cwd: options.runtime.cwd,
    outputFile,
    status: "running",
    createdAt: now,
    updatedAt: now,
    pid: child.pid,
    outputBytes: 0,
  };
  const handle: BackgroundTaskHandle = {
    taskId,
    sessionId: options.runtime.sessionId,
    ownerAgentId: options.runtime.agentId,
    child,
    output,
    state: options.state,
    runtime: options.runtime,
    outputBytes: 0,
    timedOut: false,
    failedStop: false,
    suppressNotification: false,
    settled: false,
  };

  options.state.backgroundTasks[taskId] = task;
  handles.set(taskId, handle);
  pruneTerminalTasks(options.state);
  registerExitCleanup();
  attachProcessListeners(handle);

  if (options.timeout !== undefined) {
    handle.timeoutId = setTimeout(() => {
      handle.timedOut = true;
      handle.stopReason = `Command timed out after ${options.timeout}ms.`;
      void terminateHandle(handle).catch(() => {});
    }, options.timeout);
    handle.timeoutId.unref();
  }

  await recordTranscriptStateSnapshot(
    options.runtime,
    options.state,
    "background_task",
  );
  return task;
}

export async function stopBackgroundTask(
  taskId: string,
  state: State,
  options: {
    reason?: string;
    suppressNotification?: boolean;
  } = {},
): Promise<StopBackgroundTaskResult> {
  const task = state.backgroundTasks[taskId];
  if (!task) {
    return {
      stopped: false,
      message: `No background task found with id ${taskId}.`,
    };
  }

  if (task.status !== "running") {
    return {
      stopped: false,
      task,
      message: `Background task ${taskId} is already ${task.status}.`,
    };
  }

  const handle = handles.get(taskId);
  if (!handle) {
    const now = Date.now();
    Object.assign(task, {
      status: "failed" as const,
      updatedAt: now,
      finishedAt: now,
      error: "The background process is no longer attached to this session.",
    });
    return {
      stopped: false,
      task,
      message: `Background task ${taskId} is no longer attached to a live process.`,
    };
  }

  handle.stopReason = options.reason ?? "Stopped by TaskStop.";
  handle.suppressNotification = options.suppressNotification ?? true;
  await terminateHandle(handle);
  return {
    stopped: true,
    task: state.backgroundTasks[taskId],
    message: `Stopped background task ${taskId}.`,
  };
}

export async function killBackgroundTasksForAgent(
  sessionId: string,
  ownerAgentId: string,
): Promise<number> {
  const ownedHandles = [...handles.values()].filter((handle) =>
    handle.sessionId === sessionId &&
    handle.ownerAgentId === ownerAgentId
  );

  await Promise.all(ownedHandles.map(async (handle) => {
    handle.stopReason = "The owning Agent exited.";
    handle.suppressNotification = true;
    await terminateHandle(handle);
  }));
  return ownedHandles.length;
}

export function getBackgroundTaskOutputPath(
  sessionId: string,
  taskId: string,
): string {
  return path.join(
    tmpdir(),
    "opencat-tasks",
    sanitizePathSegment(sessionId),
    `${sanitizePathSegment(taskId)}.output`,
  );
}

function attachProcessListeners(handle: BackgroundTaskHandle): void {
  const onOutput = (chunk: Buffer | string) => {
    handle.outputBytes += Buffer.byteLength(chunk);
    const task = handle.state.backgroundTasks[handle.taskId];
    if (task) {
      task.outputBytes = handle.outputBytes;
      task.updatedAt = Date.now();
    }

    if (handle.outputBytes > MAX_BACKGROUND_OUTPUT_BYTES) {
      handle.stopReason = "Background output exceeded the 5GB limit.";
      handle.failedStop = true;
      void terminateHandle(handle).catch(() => {});
    }
  };

  handle.child.stdout?.on("data", onOutput);
  handle.child.stderr?.on("data", onOutput);
  handle.child.stdout?.pipe(handle.output, { end: false });
  handle.child.stderr?.pipe(handle.output, { end: false });

  handle.child.once("error", (error) => {
    void finalizeHandle(handle, "failed", {
      error: error.message,
    }).catch(() => {});
  });
  handle.child.once("close", (code, signal) => {
    const status = resolveFinalStatus(handle, code);
    void finalizeHandle(handle, status, {
      exitCode: code ?? undefined,
      signal: signal ?? undefined,
      error: handle.stopReason,
    }).catch(() => {});
  });
  handle.output.once("error", (error) => {
    handle.stopReason = `Unable to persist background output: ${error.message}`;
    handle.failedStop = true;
    void terminateHandle(handle).catch(() => {});
  });
}

function resolveFinalStatus(
  handle: BackgroundTaskHandle,
  exitCode: number | null,
): BackgroundTaskStatus {
  if (handle.stopReason && !handle.timedOut) {
    return "killed";
  }
  if (handle.timedOut || handle.failedStop || exitCode !== 0) {
    return "failed";
  }
  return "completed";
}

async function finalizeHandle(
  handle: BackgroundTaskHandle,
  status: BackgroundTaskStatus,
  details: {
    exitCode?: number;
    signal?: string;
    error?: string;
  },
): Promise<void> {
  if (handle.settled) {
    return;
  }
  handle.settled = true;
  handles.delete(handle.taskId);
  if (handle.timeoutId) {
    clearTimeout(handle.timeoutId);
  }
  if (!handle.output.destroyed) {
    handle.child.stdout?.unpipe(handle.output);
    handle.child.stderr?.unpipe(handle.output);
    handle.child.stdout?.destroy();
    handle.child.stderr?.destroy();
    handle.output.end();
  }

  const task = handle.state.backgroundTasks[handle.taskId];
  if (!task) {
    return;
  }
  const now = Date.now();
  Object.assign(task, {
    status,
    updatedAt: now,
    finishedAt: now,
    outputBytes: handle.outputBytes,
    exitCode: details.exitCode,
    signal: details.signal,
    timedOut: handle.timedOut || undefined,
    error: details.error,
  });

  if (!handle.suppressNotification) {
    handle.state.backgroundTaskNotifications.push({
      id: `task_notification_${randomUUID()}`,
      taskId: task.id,
      ownerAgentId: task.ownerAgentId,
      createdAt: now,
      message: renderTaskNotification(task),
    });
  }

  await recordTranscriptStateSnapshot(
    handle.runtime,
    handle.state,
    "background_task",
  );
}

async function terminateHandle(handle: BackgroundTaskHandle): Promise<void> {
  if (handle.settled) {
    return;
  }

  const pid = handle.child.pid;
  if (!pid) {
    handle.child.kill();
    await finalizeStoppedHandleIfNeeded(handle);
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(pid), "/t", "/f"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", () => {
        handle.child.kill();
        resolve();
      });
      killer.once("close", () => resolve());
    });
    try {
      handle.child.kill();
    } catch {
      // taskkill may already have reaped the shell.
    }
    await finalizeStoppedHandleIfNeeded(handle);
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    handle.child.kill("SIGTERM");
  }
  await wait(500);
  if (!handle.settled) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      handle.child.kill("SIGKILL");
    }
  }
  await finalizeStoppedHandleIfNeeded(handle);
}

async function finalizeStoppedHandleIfNeeded(
  handle: BackgroundTaskHandle,
): Promise<void> {
  await wait(250);
  if (handle.settled) {
    return;
  }

  await finalizeHandle(
    handle,
    handle.timedOut || handle.failedStop ? "failed" : "killed",
    {
      signal: "SIGKILL",
      error: handle.stopReason,
    },
  );
}

function renderTaskNotification(task: BackgroundTask): string {
  return [
    "<task-notification>",
    `task_id: ${task.id}`,
    `task_type: ${task.type}`,
    `status: ${task.status}`,
    `description: ${task.description}`,
    `output_file: ${task.outputFile}`,
    task.exitCode === undefined ? "" : `exit_code: ${task.exitCode}`,
    task.error ? `error: ${task.error}` : "",
    "</task-notification>",
  ].filter(Boolean).join("\n");
}

function pruneTerminalTasks(state: State): void {
  const terminalTasks = Object.values(state.backgroundTasks)
    .filter((task) => task.status !== "running")
    .sort((left, right) => right.updatedAt - left.updatedAt);

  for (const task of terminalTasks.slice(MAX_TERMINAL_TASKS_IN_MEMORY)) {
    delete state.backgroundTasks[task.id];
  }
}

function registerExitCleanup(): void {
  if (exitCleanupRegistered) {
    return;
  }
  exitCleanupRegistered = true;
  process.once("exit", () => {
    for (const handle of handles.values()) {
      try {
        const pid = handle.child.pid;
        if (pid && process.platform === "win32") {
          spawnSync(
            "taskkill",
            ["/pid", String(pid), "/t", "/f"],
            { windowsHide: true, stdio: "ignore" },
          );
        } else if (pid) {
          process.kill(-pid, "SIGKILL");
        } else {
          handle.child.kill();
        }
      } catch {
        // The process has already exited.
      }
    }
  });
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
