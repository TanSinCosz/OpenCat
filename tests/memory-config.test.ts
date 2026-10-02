import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { parseAppConfig } from "../src/config/load-config.js";
import { createMemoryConfig } from "../src/Memory/config.js";

test("legacy memory adapts explicit YAML settings and preserves zero environment dependence", () => {
  const config = parseAppConfig({
    model: { provider: "deepseek", apiKey: "chat-key", model: "chat-model" },
    memory: {
      embedding: { apiKey: "embedding-key", baseUrl: "https://embed.example/v1", model: "custom-embedding", dimensions: 1024 },
      llm: { apiKey: "memory-key", baseUrl: "https://memory.example/v1", model: "memory-model" },
      vectorStore: { dbPath: "data/vector.db" },
    },
  });
  const memory = createMemoryConfig({ cwd: "/tmp/repo", config });
  assert.equal(memory.embedder.config.apiKey, "embedding-key");
  assert.equal(memory.embedder.config.embeddingDims, 1024);
  assert.equal(memory.llm.config.apiKey, "memory-key");
  assert.equal(memory.llm.config.model, "memory-model");
  assert.equal(memory.vectorStore.config.dbPath, path.resolve("/tmp/repo/data/vector.db"));
  assert.equal(memory.vectorStore.config.dimension, 1024);
});

test("memory LLM inherits selected YAML profile while embedding credentials stay independent", () => {
  const config = parseAppConfig({ model: { apiKey: "chat-key", model: "chat-model" } });
  const memory = createMemoryConfig({ cwd: "/tmp/repo", config });
  assert.equal(memory.embedder.config.apiKey, undefined);
  assert.equal(memory.llm.config.apiKey, "chat-key");
  assert.equal(memory.llm.config.baseURL, "https://api.deepseek.com");
  assert.equal(memory.llm.config.model, "chat-model");
});

test("embedding dimension defaults remain model-dependent", () => {
  const config = parseAppConfig({ memory: { embedding: { model: "text-embedding-v4" } } });
  assert.equal(createMemoryConfig({ config }).vectorStore.config.dimension, 1024);
});
