/** 记忆功能开关、预算与身份；旧向量服务仅由 MemorySearch 初始化。 */

export interface LongTermMemoryRuntimeConfig {
  enabled: boolean;
  autoInject: boolean;
  autoExtract: boolean;
  /** 仅用于旧 MemorySearch；文件记忆选择器保持现有选择逻辑。 */
  searchThreshold: number;
  maxInjectedChars: number;
  fileMemoryDirectory?: string;
  userId: string;
  agentId: string;
  runId: string;
}

export type CreateLongTermMemoryRuntimeConfigOptions =
  Partial<LongTermMemoryRuntimeConfig>;

export function createLongTermMemoryRuntimeConfig(
  options: CreateLongTermMemoryRuntimeConfigOptions | undefined,
  identity: { sessionId: string; agentId: string },
): LongTermMemoryRuntimeConfig {
  return {
    enabled: options?.enabled ?? true,
    autoInject: options?.autoInject ?? false,
    autoExtract: options?.autoExtract ?? false,
    searchThreshold: options?.searchThreshold ?? 0.1,
    // MEMORY.md alone may contain up to 25K characters. Leave room for the
    // selector to attach a small set of relevant topic files as well.
    maxInjectedChars: options?.maxInjectedChars ?? 40_000,
    fileMemoryDirectory: options?.fileMemoryDirectory,
    userId: options?.userId ?? "default-user",
    agentId: options?.agentId ?? identity.agentId,
    runId: options?.runId ?? identity.sessionId,
  };
}
