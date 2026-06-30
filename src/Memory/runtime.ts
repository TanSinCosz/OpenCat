import { MemoryTool } from "./Memory.js";
import type {
  MemoryConfig,
  SearchFilters,
  SearchMemoryOptions,
  SearchResult,
} from "./type.js";

export type LongTermMemoryScope = "user" | "agent" | "run";

export interface LongTermMemoryRuntimeConfig {
  enabled: boolean;
  autoInject: boolean;
  autoExtract: boolean;
  autoInjectTopK: number;
  searchThreshold: number;
  maxInjectedChars: number;
  userId: string;
  agentId: string;
  runId: string;
}

export type CreateLongTermMemoryRuntimeConfigOptions =
  Partial<LongTermMemoryRuntimeConfig>;

export type LongTermMemoryHost = {
  MemoryConfig: MemoryConfig;
  longTermMemory?: MemoryTool;
  longTermMemoryConfig: LongTermMemoryRuntimeConfig;
};

export function createLongTermMemoryRuntimeConfig(
  options: CreateLongTermMemoryRuntimeConfigOptions | undefined,
  identity: { sessionId: string; agentId: string },
): LongTermMemoryRuntimeConfig {
  return {
    enabled: options?.enabled ?? true,
    autoInject: options?.autoInject ?? false,
    autoExtract: options?.autoExtract ?? false,
    autoInjectTopK: options?.autoInjectTopK ?? 6,
    searchThreshold: options?.searchThreshold ?? 0.1,
    maxInjectedChars: options?.maxInjectedChars ?? 8_000,
    userId: options?.userId ?? process.env.OPENCAT_MEMORY_USER_ID ?? "default-user",
    agentId: options?.agentId ?? identity.agentId,
    runId: options?.runId ?? identity.sessionId,
  };
}

/**
 * Runtime owns the memory service lazily so ordinary query setup does not open
 * SQLite files or create OpenAI clients unless memory is actually used.
 */
export function getOrCreateLongTermMemory(
  runtime: LongTermMemoryHost,
): MemoryTool | null {
  if (!runtime.longTermMemoryConfig.enabled) {
    return null;
  }

  runtime.longTermMemory ??= new MemoryTool(runtime.MemoryConfig);
  return runtime.longTermMemory;
}

export function buildLongTermMemoryFilters(
  config: LongTermMemoryRuntimeConfig,
  scope: LongTermMemoryScope = "user",
): SearchFilters {
  switch (scope) {
    case "run":
      return { run_id: config.runId };
    case "agent":
      return { agent_id: config.agentId };
    case "user":
      return { user_id: config.userId };
  }
}

export async function searchLongTermMemory(
  runtime: LongTermMemoryHost,
  query: string,
  options: SearchMemoryOptions & { scope?: LongTermMemoryScope } = {},
): Promise<SearchResult> {
  const memory = getOrCreateLongTermMemory(runtime);
  if (!memory) {
    return { results: [] };
  }

  return memory.search(query, {
    topK: options.topK,
    threshold: options.threshold ?? runtime.longTermMemoryConfig.searchThreshold,
    explain: options.explain,
    filters: {
      ...buildLongTermMemoryFilters(
        runtime.longTermMemoryConfig,
        options.scope ?? "user",
      ),
      ...options.filters,
    },
  });
}
