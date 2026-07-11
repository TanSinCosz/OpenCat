import type { MessageId } from "./messages.js";

export interface SessionMemoryConfig {
  minimumMessageTokensToInit: number;
  minimumTokensBetweenUpdate: number;
  toolCallsBetweenUpdates: number;
}

export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10_000,
  minimumTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
};

export type SessionMemoryStatus = "idle" | "ready" | "failed";

export interface SessionMemoryState {
  content: string;
  initialized: boolean;
  status: SessionMemoryStatus;
  tokensAtLastUpdateAttempt: number;
  tokensAtLastExtraction: number;
  lastUpdateMessageId?: MessageId;
  lastSummarizedMessageId?: MessageId;
  lastUpdatedAt?: number;
  lastFailedAt?: number;
  lastFailureReason?: string;
  config: SessionMemoryConfig;
}

export function createSessionMemoryState(
  config: Partial<SessionMemoryConfig> = {},
): SessionMemoryState {
  return {
    content: "",
    initialized: false,
    status: "idle",
    tokensAtLastUpdateAttempt: 0,
    tokensAtLastExtraction: 0,
    config: {
      ...DEFAULT_SESSION_MEMORY_CONFIG,
      ...config,
    },
  };
}
