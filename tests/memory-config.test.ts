import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";

import { createMemoryConfig } from "../src/Memory/config.js";

const MEMORY_ENV_KEYS = [
  "OPENCAT_MEMORY_EMBEDDING_API_KEY",
  "OPENCAT_EMBEDDING_API_KEY",
  "DASHSCOPE_API_KEY",
  "OPENCAT_MEMORY_EMBEDDING_BASE_URL",
  "OPENCAT_EMBEDDING_BASE_URL",
  "OPENCAT_MEMORY_EMBEDDING_MODEL",
  "OPENCAT_EMBEDDING_MODEL",
  "OPENCAT_MEMORY_EMBEDDING_DIMS",
  "OPENCAT_MEMORY_EMBEDDING_DIMENSIONS",
  "OPENCAT_EMBEDDING_DIMS",
  "OPENCAT_EMBEDDING_DIMENSIONS",
  "OPENCAT_MEMORY_VECTOR_DB_PATH",
  "OPENCAT_MEMORY_VECTOR_DIMENSION",
  "OPENCAT_MEMORY_VECTOR_DIMS",
  "OPENCAT_MEMORY_HISTORY_DB_PATH",
  "OPENCAT_MEMORY_LLM_API_KEY",
  "OPENCAT_LLM_API_KEY",
  "OPENCAT_MEMORY_LLM_BASE_URL",
  "OPENCAT_LLM_BASE_URL",
  "OPENCAT_MEMORY_LLM_MODEL",
  "OPENCAT_LLM_MODEL",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

test("createMemoryConfig uses project-local memory databases by default", () => {
  withCleanEnv(() => {
    const config = createMemoryConfig({ cwd: "C:/repo" });

    assert.equal(config.embedder.provider, "openai-compatible");
    assert.equal(config.embedder.config.model, "text-embedding-3-small");
    assert.equal(
      config.vectorStore.config.dbPath,
      path.resolve("C:/repo", ".opencat/memory/vector_store.db"),
    );
    assert.equal(
      config.historyDbPath,
      path.resolve("C:/repo", ".opencat/memory/history.db"),
    );
  });
});

test("createMemoryConfig reads explicit embedding settings", () => {
  withCleanEnv(() => {
    process.env.OPENCAT_MEMORY_EMBEDDING_API_KEY = "embedding-key";
    process.env.OPENCAT_MEMORY_EMBEDDING_BASE_URL = "https://embed.example/v1";
    process.env.OPENCAT_MEMORY_EMBEDDING_MODEL = "custom-embedding";
    process.env.OPENCAT_MEMORY_EMBEDDING_DIMS = "1024";

    const config = createMemoryConfig({ cwd: "C:/repo" });

    assert.equal(config.embedder.config.apiKey, "embedding-key");
    assert.equal(config.embedder.config.baseURL, "https://embed.example/v1");
    assert.equal(config.embedder.config.model, "custom-embedding");
    assert.equal(config.embedder.config.embeddingDims, 1024);
    assert.equal(config.vectorStore.config.dimension, 1024);
  });
});

test("createMemoryConfig keeps DeepSeek credentials on memory LLM only", () => {
  withCleanEnv(() => {
    process.env.DEEPSEEK_API_KEY = "deepseek-key";

    const config = createMemoryConfig({ cwd: "C:/repo" });

    assert.equal(config.embedder.config.apiKey, undefined);
    assert.equal(config.llm.config.apiKey, "deepseek-key");
    assert.equal(config.llm.config.baseURL, "https://api.deepseek.com");
    assert.equal(config.llm.config.model, "deepseek-chat");
  });
});

test("createMemoryConfig accepts DashScope as an embedding key fallback", () => {
  withCleanEnv(() => {
    process.env.DASHSCOPE_API_KEY = "dashscope-key";
    process.env.OPENCAT_MEMORY_EMBEDDING_MODEL = "text-embedding-v4";

    const config = createMemoryConfig({ cwd: "C:/repo" });

    assert.equal(config.embedder.config.apiKey, "dashscope-key");
    assert.equal(config.vectorStore.config.dimension, 1024);
  });
});

function withCleanEnv(fn: () => void): void {
  const snapshot = new Map<string, string | undefined>();
  for (const key of MEMORY_ENV_KEYS) {
    snapshot.set(key, process.env[key]);
    delete process.env[key];
  }

  try {
    fn();
  } finally {
    for (const [key, value] of snapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
