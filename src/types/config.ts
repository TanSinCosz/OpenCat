
import {
  resolveModelProvider,
  type ModelProvider,
} from "../openai-compatible/provider.js";

/** @deprecated Use ModelRuntimeSettings from the unified YAML configuration. */
export type AgentConfig = ModelRuntimeSettings;

export interface ModelRuntimeSettings {
  /** Named profile selected from ~/.opencat/config.yaml, when configured. */
  profileName?: string;
  /** Selects the provider adapter used to filter non-standard API fields. */
  provider?: ModelProvider;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** DeepSeek business user identity used for scheduling and KV-cache isolation. */
  userId?: string;
  model: string;
  maxTokens: number;
  systemPrompt?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export function normalizeModelRuntimeSettings(
  settings: ModelRuntimeSettings,
): ModelRuntimeSettings {
  const provider = resolveModelProvider(settings);
  return {
    ...settings,
    provider,
  };
}
