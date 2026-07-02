import type { DeepSeekUsage } from "../deepseek/types.js";
import type { Runtime, RuntimeUsageStats } from "../types/runtime.js";

export function recordModelUsage(
  runtime: Runtime,
  usage: DeepSeekUsage,
): RuntimeUsageStats {
  runtime.usage.promptTokens += usage.prompt_tokens ?? 0;
  runtime.usage.completionTokens += usage.completion_tokens ?? 0;
  runtime.usage.totalTokens += usage.total_tokens ?? 0;
  runtime.usage.promptCacheHitTokens += usage.prompt_cache_hit_tokens ?? 0;
  runtime.usage.promptCacheMissTokens += usage.prompt_cache_miss_tokens ?? 0;

  return snapshotRuntimeUsage(runtime);
}

export function snapshotRuntimeUsage(runtime: Runtime): RuntimeUsageStats {
  return { ...runtime.usage };
}
