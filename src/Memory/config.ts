import path from "node:path";
import { getAppConfig, type AppConfig } from "../config/load-config.js";
import { getProviderBaseUrl } from "../openai-compatible/provider.js";
import type { MemoryConfig } from "./type.js";

export interface CreateMemoryConfigOptions { cwd?: string; config?: AppConfig }

/** Adapt the unified YAML snapshot to the legacy vector-memory interfaces. */
export function createMemoryConfig(options: CreateMemoryConfigOptions = {}): MemoryConfig {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? getAppConfig();
  const { embedding, llm, vectorStore } = config.memory;
  const embeddingModel = embedding.model ?? "text-embedding-3-small";
  return {
    embedder: {
      provider: "openai-compatible",
      config: {
        apiKey: embedding.apiKey ?? (embedding.baseUrl ? "not-needed" : undefined),
        baseURL: embedding.baseUrl,
        model: embeddingModel,
        embeddingDims: embedding.dimensions,
      },
    },
    vectorStore: {
      provider: "sqlite",
      config: {
        dbPath: path.resolve(cwd, vectorStore.dbPath ?? ".opencat/memory/vector_store.db"),
        dimension: embedding.dimensions ?? vectorStore.dimensions ?? (embeddingModel === "text-embedding-v4" ? 1024 : 1536),
      },
    },
    llm: {
      provider: "openai-compatible",
      config: {
        apiKey: llm.apiKey ?? config.model.apiKey,
        baseURL: llm.baseUrl ?? getProviderBaseUrl(config.model),
        model: llm.model ?? config.model.model,
      },
    },
  };
}
