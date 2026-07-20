import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  DeepSeekChatCompletionResponse,
  DeepSeekCreateRequest,
  DeepSeekStreamEnvelope,
  DeepSeekStreamRequest,
} from "../src/deepseek/types.js";
import type { DeepSeekClient } from "../src/deepseek/client.js";
import { restoreInvokedSkillsAfterAutoCompress } from "../src/auto-compress/invoked-skill-restore.js";
import { ReadSkill } from "../src/Tools/ReadSkill/ReadSkill.js";
import { addSkillDirectories } from "../src/Tools/utils/discoverSkillsForReadPath.js";
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
  });
  runtime.toolUseContext.skillRuntime.dynamicSkills.set("repo-style", {
    name: "repo-style",
    description: "Repository style rules",
    content: "Keep changes scoped.\nUse targeted tests.",
    paths: ["src/**"],
    skillDir: join(cwd, ".claude", "skills", "repo-style"),
    skillPath: join(cwd, ".claude", "skills", "repo-style", "SKILL.md"),
  });

  const output = await new ReadSkill().call(
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

  await assert.rejects(
    async () =>
      await new ReadSkill().call(
        { path: join(cwd, "other", "SKILL.md") },
        runtime.toolUseContext,
        runtime,
        state,
      ),
    /already discovered/,
  );
});

test("ReadSkill activates allowed-tools as temporary command allow rules", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-read-skill-allowed-"));
  const skillRoot = join(cwd, ".claude", "skills");
  const skillDir = join(skillRoot, "repo-style");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "description: Repository style rules",
      "allowed-tools: Read, Grep, Bash(git status:*)",
      "---",
      "Keep changes scoped.",
    ].join("\n"),
    "utf8",
  );

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
  });
  await addSkillDirectories([skillRoot], runtime.toolUseContext.skillRuntime);

  const output = await new ReadSkill().call(
    { name: "repo-style" },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.deepEqual(output.allowedTools, [
    "Read",
    "Grep",
    "Bash(git status:*)",
  ]);
  assert.doesNotMatch(
    new ReadSkill().formatResult({ output }),
    /Allowed tools for this skill/,
  );
  assert.deepEqual(
    runtime.toolUseContext
      .getAppState()
      .toolPermissionContext
      .alwaysAllowRules
      .command,
    ["Read", "Grep", "Bash(git status:*)"],
  );
});

test("ReadSkill executes context: fork skills in a forked agent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-read-skill-fork-"));
  const skillRoot = join(cwd, ".claude", "skills");
  const skillDir = join(skillRoot, "repo-style");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "description: Repository style rules",
      "allowed-tools: Read, Grep",
      "context: fork",
      "---",
      "Inspect the repository and report a concise answer.",
    ].join("\n"),
    "utf8",
  );

  const state = createState();
  const streamRequests: DeepSeekStreamRequest[] = [];
  const runtime = createRuntime({
    cwd,
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: createTextClient("fork skill done", streamRequests),
    MemoryConfig: createMemoryConfig(),
  });
  await addSkillDirectories([skillRoot], runtime.toolUseContext.skillRuntime);

  const output = await new ReadSkill().call(
    { name: "repo-style", args: "Find the risky file." },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(output.status, "forked");
  assert.match(output.content, /fork skill done/);
  assert.equal(state.invokedSkills.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(
    (streamRequests[0]?.tools ?? []).map((tool) => tool.function.name),
    ["Read", "Grep"],
  );
  assert.match(
    streamRequests[0]?.messages.at(-1)?.content ?? "",
    /Inspect the repository and report a concise answer/,
  );
  assert.match(
    streamRequests[0]?.messages.at(-1)?.content ?? "",
    /Find the risky file/,
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

function createTextClient(
  text: string,
  streamRequests: DeepSeekStreamRequest[],
): DeepSeekClient {
  return {
    async create(_input: DeepSeekCreateRequest): Promise<DeepSeekChatCompletionResponse> {
      throw new Error("create is not used in this test");
    },
    async *stream(input: DeepSeekStreamRequest): AsyncGenerator<DeepSeekStreamEnvelope> {
      streamRequests.push(input);
      yield {
        raw: text,
        done: false,
        chunk: {
          id: "assistant-chunk",
          object: "chat.completion.chunk",
          created: 0,
          model: "deepseek-v4-flash",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: text,
              },
              finish_reason: "stop",
            },
          ],
        },
      };
      yield {
        chunk: null,
        raw: "[DONE]",
        done: true,
      };
    },
    async collectStream(): Promise<never> {
      throw new Error("collectStream is not used in this test");
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
