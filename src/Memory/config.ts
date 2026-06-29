import path from "node:path";

import type { MemoryConfig } from "./type.js";

export interface CreateMemoryConfigOptions {
  cwd?: string;
}

export function createMemoryConfig(
  options: CreateMemoryConfigOptions = {},
): MemoryConfig {
  const cwd = options.cwd ?? process.cwd();
  const embeddingModel = envFirst(
    "OPENCAT_MEMORY_EMBEDDING_MODEL",
    "OPENCAT_EMBEDDING_MODEL",
  ) ?? "text-embedding-3-small";
  const embeddingDims = envNumberFirst(
    "OPENCAT_MEMORY_EMBEDDING_DIMS",
    "OPENCAT_MEMORY_EMBEDDING_DIMENSIONS",
    "OPENCAT_EMBEDDING_DIMS",
    "OPENCAT_EMBEDDING_DIMENSIONS",
  );
  const embeddingBaseURL = envFirst(
    "OPENCAT_MEMORY_EMBEDDING_BASE_URL",
    "OPENCAT_EMBEDDING_BASE_URL",
    "OPENAI_BASE_URL",
  );
  const embeddingApiKey = envFirst(
    "OPENCAT_MEMORY_EMBEDDING_API_KEY",
    "OPENCAT_EMBEDDING_API_KEY",
    "DASHSCOPE_API_KEY",
    "OPENAI_API_KEY",
  ) ?? (embeddingBaseURL ? "not-needed" : undefined);
  const llmApiKey = envFirst(
    "OPENCAT_MEMORY_LLM_API_KEY",
    "OPENCAT_LLM_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
  );
  const llmBaseURL = envFirst(
    "OPENCAT_MEMORY_LLM_BASE_URL",
    "OPENCAT_LLM_BASE_URL",
  ) ?? (process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : process.env.OPENAI_BASE_URL);

  return {
    embedder: {
      provider: "openai-compatible",
      config: {
        apiKey: embeddingApiKey,
        baseURL: embeddingBaseURL,
        model: embeddingModel,
        embeddingDims,
      },
    },
    vectorStore: {
      provider: "sqlite",
      config: {
        dbPath: resolveConfigPath(
          cwd,
          envFirst("OPENCAT_MEMORY_VECTOR_DB_PATH"),
          ".opencat/memory/vector_store.db",
        ),
        dimension: embeddingDims ?? envNumberFirst(
          "OPENCAT_MEMORY_VECTOR_DIMENSION",
          "OPENCAT_MEMORY_VECTOR_DIMS",
        ) ?? inferDefaultEmbeddingDimension(embeddingModel),
      },
    },
    llm: {
      provider: "openai-compatible",
      config: {
        apiKey: llmApiKey,
        baseURL: llmBaseURL,
        model: envFirst("OPENCAT_MEMORY_LLM_MODEL", "OPENCAT_LLM_MODEL") ??
          (process.env.DEEPSEEK_API_KEY ? "deepseek-chat" : "gpt-5-mini"),
      },
    },
    historyDbPath: resolveConfigPath(
      cwd,
      envFirst("OPENCAT_MEMORY_HISTORY_DB_PATH"),
      ".opencat/memory/history.db",
    ),
  };
}

function envFirst(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function envNumberFirst(...names: string[]): number | undefined {
  const value = envFirst(...names);
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveConfigPath(
  cwd: string,
  configured: string | undefined,
  fallback: string,
): string {
  return path.resolve(cwd, configured ?? fallback);
}

function inferDefaultEmbeddingDimension(model: string): number {
  if (model === "text-embedding-v4") {
    return 1024;
  }

  return 1536;
}
