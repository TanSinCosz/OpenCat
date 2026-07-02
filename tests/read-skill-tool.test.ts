import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { restoreInvokedSkillsAfterAutoCompress } from "../src/auto-compress/invoked-skill-restore.js";
import { ReadSkill } from "../src/Tools/ReadSkill/ReadSkill.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("ReadSkill reads only discovered skills and records invoked skill state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-read-skill-"));
  const state = createState();
  const runtime = createRuntime({
    cwd,
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: createUnusedClient(),
    MemoryConfig: createMemoryConfig(),
    messages: state.Messages,
  });
  runtime.toolUseContext.skillRuntime.dynamicSkills.set("repo-style", {
    name: "repo-style",
    description: "Repository style rules",
    content: "Keep changes scoped.\nUse targeted tests.",
    paths: ["src/**"],
    skillDir: join(cwd, ".claude", "skills", "repo-style"),
    skillPath: join(cwd, ".claude", "skills", "repo-style", "SKILL.md"),
  });

  const output = new ReadSkill().call(
    { name: "repo-style" },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(output.name, "repo-style");
  assert.match(output.content, /Base directory for this skill:/);
  assert.match(output.content, /Keep changes scoped/);
  assert.equal(output.truncated, false);
  assert.equal(state.invokedSkills.length, 1);
  assert.equal(state.invokedSkills[0]?.name, "repo-style");
  assert.equal(state.invokedSkills[0]?.agentId, "main");

  assert.throws(
    () =>
      new ReadSkill().call(
        { path: join(cwd, "other", "SKILL.md") },
        runtime.toolUseContext,
        runtime,
        state,
      ),
    /already discovered/,
  );
});

test("post auto-compress restore reattaches invoked skills once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-skill-restore-"));
  const state = createState({
    autoCompress: {
      summaries: [],
      sessionMemoryUpdated: false,
    },
    invokedSkills: [
      {
        name: "repo-style",
        description: "Repository style rules",
        content: "Base directory for this skill: /repo-style\n\nKeep changes scoped.",
        invokedAt: 2,
        agentId: "main",
        skillDir: join(cwd, ".claude", "skills", "repo-style"),
        skillPath: join(cwd, ".claude", "skills", "repo-style", "SKILL.md"),
      },
    ],
  });
  const runtime = createRuntime({
    cwd,
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: createUnusedClient(),
    MemoryConfig: createMemoryConfig(),
    messages: state.Messages,
  });

  const result = restoreInvokedSkillsAfterAutoCompress(
    runtime,
    state,
    "autocompress_test",
    [],
  );

  assert.equal(result.candidateCount, 1);
  assert.equal(result.restoredCount, 1);
  assert.equal(state.runtimeContextMessages.length, 1);
  assert.equal(state.runtimeContextMessages[0]?.source, "dynamic_skill");
  assert.match(
    state.runtimeContextMessages[0]?.content ?? "",
    /<post-compact-invoked-skills>/,
  );
  assert.match(state.runtimeContextMessages[0]?.content ?? "", /repo-style/);
  assert.match(state.runtimeContextMessages[0]?.content ?? "", /Keep changes scoped/);

  const repeated = restoreInvokedSkillsAfterAutoCompress(
    runtime,
    state,
    "autocompress_test",
    [],
  );

  assert.equal(repeated.restoredCount, 0);
  assert.equal(state.runtimeContextMessages.length, 1);
});

function createUnusedClient() {
  return {
    async create(): Promise<never> {
      throw new Error("unused");
    },
    async *stream(): AsyncGenerator<never> {
      throw new Error("unused");
    },
    async collectStream(): Promise<never> {
      throw new Error("unused");
    },
  };
}

function createMemoryConfig() {
  return {
    embedder: {
      provider: "test",
      config: {},
    },
    vectorStore: {
      provider: "test",
      config: {},
    },
    llm: {
      provider: "test",
      config: {},
    },
  };
}
