import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { restoreReadFileStateAfterAutoCompress } from "../src/auto-compress/read-file-restore.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("post auto-compress restore clears and reattaches read file state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-read-restore-"));
  const filePath = join(cwd, "example.ts");
  await writeFile(filePath, "export const answer = 42;\n", "utf8");

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

  runtime.toolUseContext.readFileState.set(filePath, {
    content: "stale cache content",
    timestamp: Date.now() - 1000,
    offset: 1,
    limit: undefined,
  });

  const result = await restoreReadFileStateAfterAutoCompress(
    runtime,
    state,
    "autocompress_test",
    [],
  );

  assert.equal(result.candidateCount, 1);
  assert.equal(result.restoredCount, 1);
  assert.equal(runtime.toolUseContext.readFileState.size, 1);

  const restoredState = runtime.toolUseContext.readFileState.get(filePath);
  assert.equal(restoredState?.content, "export const answer = 42;\n");
  assert.equal(restoredState?.offset, 1);
  assert.equal(restoredState?.limit, undefined);
  assert.equal(restoredState?.isPartialView, false);

  assert.equal(state.Messages.length, 0);
  assert.equal(state.runtimeContextMessages.length, 1);
  assert.equal(state.runtimeContextMessages[0]?.role, "user");
  assert.equal(state.runtimeContextMessages[0]?.source, "file_restore");
  assert.match(
    state.runtimeContextMessages[0]?.content ?? "",
    /<post-compact-file-restore>/,
  );
  assert.match(state.runtimeContextMessages[0]?.content ?? "", /example\.ts/);
  assert.match(
    state.runtimeContextMessages[0]?.content ?? "",
    /1\texport const answer = 42;/,
  );
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
