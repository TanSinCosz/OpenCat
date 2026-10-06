import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Plan } from "../src/Tools/Plan/Plan.js";
import {
  createPlanFileContextMessages,
  loadUnclaimedAgentTaskContextAfterAutoCompress,
} from "../src/query/runtime-context.js";
import { getPlanFilePath, restorePlan } from "../src/plan/persistence.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

function createTestRuntime(cwd: string) {
  return createRuntime({
    sessionId: "session_post_compact_context",
    cwd,
    modelRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 128,
    },
    transcriptStore: false,
  });
}

test("Plan persists and can be restored as a post-compact attachment", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-plan-restore-"));
  const runtime = createTestRuntime(cwd);
  const state = createState();
  const planContent = "1. Inspect the parser\n2. Add the regression test";

  await new Plan().call(
    { action: "enter", plan: planContent },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(await readFile(getPlanFilePath(runtime), "utf8"), planContent);

  const restoredState = createState();
  await restorePlan(runtime, restoredState);
  const messages = createPlanFileContextMessages(restoredState);

  assert.equal(messages.length, 1);
  assert.ok(String(messages[0]!.content).includes(planContent));
  assert.ok(String(messages[0]!.content).includes(getPlanFilePath(runtime)));
});

test("post-compact agent context keeps running and unclaimed task results", async () => {
  const runtime = createTestRuntime(await mkdtemp(join(tmpdir(), "opencat-agent-restore-")));
  const state = createState({
    agentTasks: {
      running_task: {
        id: "running_task",
        agentType: "worker",
        description: "inspect the repository",
        prompt: "inspect",
        mode: "async",
        status: "running",
        createdAt: 1,
        updatedAt: 2,
        pendingMessages: [],
      },
      completed_task: {
        id: "completed_task",
        agentType: "worker",
        description: "run verification",
        prompt: "verify",
        mode: "async",
        status: "completed",
        createdAt: 1,
        updatedAt: 3,
        pendingMessages: [],
        result: "Tests passed",
      },
    },
  });

  assert.equal(loadUnclaimedAgentTaskContextAfterAutoCompress(runtime, state), 1);
  const content = String(state.runtimeContextMessages[0]!.content);
  assert.match(content, /running_task/);
  assert.match(content, /Tests passed/);
});
