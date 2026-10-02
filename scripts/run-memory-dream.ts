import { getAppConfig, getConfigValue } from "../src/config/load-config.js";
import { runMemoryDream } from "../src/Memory/auto-dream.js";
import { loadConfig } from "../src/config/load-config.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

const modelRuntimeConfig = loadConfig();

if (!modelRuntimeConfig.apiKey.trim()) {
  throw new Error("Missing API key for the selected model provider.");
}

const runtime = createRuntime({
  cwd: process.cwd(),
  modelRuntimeConfig,
  MemoryConfig: {
    embedder: {
      provider: "manual-memory-dream",
      config: {},
    },
    vectorStore: {
      provider: "manual-memory-dream",
      config: {},
    },
    llm: {
      provider: "manual-memory-dream",
      config: {},
    },
  },
  longTermMemoryConfig: {
    ...getAppConfig().memory,
    fileMemoryDirectory: getAppConfig().memory.directory,
    enabled: true,
    autoInject: false,
    autoExtract: false,
  },
});

const recentSessionLimit = Number(
  getConfigValue("memory.dreamRecentSessions") ?? 8,
);

const result = await runMemoryDream(runtime, createState(), {
  recentSessionLimit: Number.isFinite(recentSessionLimit)
    ? recentSessionLimit
    : undefined,
});
console.log(JSON.stringify(result, null, 2));
