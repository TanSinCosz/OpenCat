import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "../src/system-prompt.js";
import { createMemoryConfig } from "../src/Memory/config.js";
import { createRuntime } from "../src/types/runtime.js";

test("system prompt documents projected context tags", async () => {
  const runtime = createRuntime({
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
    tools: [],
  });

  const prompt = await buildSystemPrompt(runtime);

  assert.match(prompt, /# Projected Context Tags/);
  assert.match(prompt, /<long_term_memory>/);
  assert.match(prompt, /Main agents and subagents use this same tag/);
  assert.match(prompt, /<tool-result-budget>/);
  assert.match(prompt, /<tool-result-compact>/);
  assert.match(prompt, /\[History snipped: \.\.\.\]/);
  assert.match(prompt, /<opencat_context>/);
});
