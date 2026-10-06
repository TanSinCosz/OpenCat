import { inputSchema as bashInputSchema } from "../src/Tools/Bash/type.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  killBackgroundTasksForAgent,
} from "../src/Tools/Bash/background.js";
import { Bash } from "../src/Tools/Bash/Bash.js";
import {
  markRestoredBackgroundTasksDetached,
} from "../src/Tools/Bash/state.js";
import { TaskStop } from "../src/Tools/TaskStop/TaskStop.js";
import {
  loadRuntimeContextForQuery,
} from "../src/query/runtime-context.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("background Bash persists output and emits a completion notification", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "opencat-background-bash-"));
  const state = createState();
  const runtime = createTestRuntime(cwd);
  const output = await new Bash().call(
    {
      command: createNodeCommand(
        "setTimeout(function(){console.log('background-ok')}, 40)",
      ),
      description: "Print a delayed message",
      run_in_background: true,
    },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.ok(output.backgroundTaskId);
  assert.ok(output.backgroundOutputPath);
  assert.equal(output.backgroundTaskStatus, "running");

  const task = await waitForTaskToFinish(state, output.backgroundTaskId);
  assert.equal(task.status, "completed");
  assert.equal(task.exitCode, 0);
  assert.match(await readFile(task.outputFile, "utf8"), /background-ok/);

  const loaded = await loadRuntimeContextForQuery(runtime, state);
  assert.equal(loaded, 1);
  assert.equal(state.backgroundTaskNotifications.length, 0);
  assert.equal(state.runtimeContextMessages.at(-1)?.source, "task_notification");
  assert.match(
    String(state.runtimeContextMessages.at(-1)?.content),
    /status: completed/,
  );
});

test("TaskStop kills a managed background Bash task", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "opencat-task-stop-"));
  const state = createState();
  const runtime = createTestRuntime(cwd);
  const output = await new Bash().call(
    {
      command: createNodeCommand(
        "setInterval(function(){console.log('still-running')}, 25)",
      ),
      description: "Run until stopped",
      run_in_background: true,
    },
    runtime.toolUseContext,
    runtime,
    state,
  );
  const taskId = output.backgroundTaskId!;
  assert.equal(await loadRuntimeContextForQuery(runtime, state), 1);
  assert.equal(
    state.runtimeContextMessages.at(-1)?.source,
    "background_task_status",
  );
  assert.match(
    String(state.runtimeContextMessages.at(-1)?.content),
    new RegExp(taskId),
  );

  const result = await new TaskStop().call(
    { task_id: taskId },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(result.stopped, true);
  const task = await waitForTaskToFinish(state, taskId);
  assert.equal(task.status, "killed");
  assert.equal(state.backgroundTaskNotifications.length, 0);
});

test("background Bash tasks are scoped to their owning Agent", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "opencat-agent-bash-"));
  const state = createState();
  const runtime = createTestRuntime(cwd, "agent_background_test");
  const output = await new Bash().call(
    {
      command: createNodeCommand(
        "setInterval(function(){console.log('agent-running')}, 25)",
      ),
      description: "Run for the child Agent",
      run_in_background: true,
    },
    runtime.toolUseContext,
    runtime,
    state,
  );
  const taskId = output.backgroundTaskId!;

  const killed = await killBackgroundTasksForAgent(
    runtime.sessionId,
    runtime.agentId,
  );

  assert.equal(killed, 1);
  const task = await waitForTaskToFinish(state, taskId);
  assert.equal(task.status, "killed");
  assert.equal(task.error, "The owning Agent exited.");
});

test("Bash exposes the managed background flag to the model schema", () => {
  assert.equal(
    bashInputSchema().safeParse({
      command: "npm run dev",
      run_in_background: true,
    }).success,
    true,
  );
});

test("restored running task records are marked as detached failures", () => {
  const now = Date.now();
  const restored = markRestoredBackgroundTasksDetached({
    bash_restore: {
      id: "bash_restore",
      type: "bash",
      sessionId: "session_restore",
      ownerAgentId: "main",
      command: "npm run dev",
      description: "Run dev server",
      cwd: "C:\\repo",
      outputFile: "C:\\temp\\bash_restore.output",
      status: "running",
      createdAt: now,
      updatedAt: now,
      outputBytes: 42,
    },
  });

  assert.equal(restored.bash_restore?.status, "failed");
  assert.match(restored.bash_restore?.error ?? "", /host process ended/);
  assert.ok(restored.bash_restore?.finishedAt);
});

function createTestRuntime(
  cwd: string,
  agentId: "main" | `agent_${string}` = "main",
) {
  return createRuntime({
    cwd,
    agentId,
    agentRole: agentId === "main" ? "main" : "subagent",
    modelRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 128,
    },
    transcriptStore: false,
  });
}

function createNodeCommand(script: string): string {
  return `"${process.execPath}" -e "${script}"`;
}

async function waitForTaskToFinish(
  state: ReturnType<typeof createState>,
  taskId: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const task = state.backgroundTasks[taskId];
    if (task && task.status !== "running") {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for background task ${taskId}.`);
}
