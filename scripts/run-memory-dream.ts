import { runMemoryDream } from "../src/Memory/auto-dream.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

if (!apiKey) {
  throw new Error("Missing DEEPSEEK_API_KEY environment variable.");
}

const runtime = createRuntime({
  cwd: process.cwd(),
  deepSeekRuntimeConfig: {
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    maxTokens: Number(process.env.DEEPSEEK_MAX_TOKENS ?? 8192),
  },
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
    enabled: true,
    autoInject: false,
    autoExtract: false,
  },
});

const recentSessionLimit = Number(
  process.env.OPENCAT_MEMORY_DREAM_RECENT_SESSIONS ?? 8,
);

const result = await runMemoryDream(runtime, createState(), {
  recentSessionLimit: Number.isFinite(recentSessionLimit)
    ? recentSessionLimit
    : undefined,
});
console.log(JSON.stringify(result, null, 2));
