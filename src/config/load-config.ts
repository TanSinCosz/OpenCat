import {
  forceDeepSeekRuntimeSettings,
  type DeepSeekRuntimeSettings,
} from "../types/config.js";

export function loadConfig(): DeepSeekRuntimeSettings {
  return forceDeepSeekRuntimeSettings({
    apiKey: process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? process.env.OPENCAT_API_BASE_URL,
    model: "deepseek-v4-pro",
    maxTokens: Number(process.env.OPENCAT_MAX_TOKENS ?? 32_768),
  });
}
