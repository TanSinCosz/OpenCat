import type { RuntimeAgentRole } from "../types/runtime.js";

export type TelemetryAgentFields = {
  timestamp: number;
  sessionId: string;
  agentId: string;
  agentRole: RuntimeAgentRole;
  parentAgentId?: string;
  agentType?: string;
};

export type EvaluationEvent = TelemetryAgentFields & (
  | {
    type: "query_started";
    maxTurns: number;
    stateMessageCount: number;
  }
  | {
    type: "context_ready";
    turn: number;
    messageCount: number;
    estimatedTokens: number;
    hasLongTermMemory: boolean;
    hasSessionMemory: boolean;
    hasAutoCompressSummary: boolean;
    runtimeContextMessageCount: number;
    toolResultBudgetReplacementCount: number;
    bulkyToolCompactCount: number;
    historySnipCount: number;
    hardHistorySnipApplied: boolean;
    toolResultCharsBeforeBudget: number;
    toolResultCharsAfterBudget: number;
    toolResultCharsAfterCompact: number;
  }
  | {
    type: "model_stream_started";
    turn: number;
  }
  | {
    type: "model_usage";
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    promptCacheHitTokens: number;
    promptCacheMissTokens: number;
    sessionTotalTokens: number;
    sessionPromptCacheHitTokens: number;
    sessionPromptCacheMissTokens: number;
  }
  | {
    type: "assistant_message";
    turn: number;
    assistantTextChars: number;
    reasoningChars: number;
    toolCallCount: number;
    finishReason?: string;
  }
  | {
    type: "tool_call_started";
    turn: number;
    toolCallId: string;
    toolName: string;
    argsChars: number;
    argsPreview: string;
  }
  | {
    type: "tool_permission_requested";
    toolCallId: string;
    toolName: string;
    mode: "plan";
  }
  | {
    type: "tool_call_finished";
    turn: number;
    toolCallId: string;
    toolName: string;
    resultChars: number;
    durationMs: number;
    persistedToolResult: boolean;
    persistedToolResultPath?: string;
  }
  | {
    type: "turn_finished";
    turn: number;
    hasToolUse: boolean;
  }
  | {
    type: "query_finished";
    reason: "completed" | "max_turns";
    durationMs: number;
  }
  | {
    type: "session_memory_update_started";
    messageCount: number;
  }
  | {
    type: "session_memory_update_finished";
    status: "updated" | "skipped";
    messageCount: number;
    reason?: string;
    contentChars?: number;
    lastSummarizedMessageId?: string;
  }
  | {
    type: "session_memory_update_failed";
    error: string;
  }
  | {
    type: "query_failed";
    durationMs: number;
    error: string;
  }
  | {
    type: "workspace_patch_snapshot_saved";
    reason: "completed" | "max_turns" | "failed" | "manual" | "approved";
    patchPath: string;
    latestPath: string;
    bytes: number;
    sequence: number;
  }
  | {
    type: "workspace_patch_snapshot_failed";
    reason: "completed" | "max_turns" | "failed" | "manual" | "approved";
    error: string;
  }
  | {
    type: "auto_compress_started";
    messageCount: number;
    reason?: "context_size";
  }
  | {
    type: "auto_compress_finished";
    status: "compressed" | "skipped";
    reason?: string;
    beforeMessageCount: number;
    afterMessageCount: number;
    summaryId?: string;
    summaryChars?: number;
    summaryMessageCount?: number;
  }
  | {
    type: "long_term_memory_injected";
    queryChars: number;
    resultCount: number;
    injectedChars: number;
  }
  | {
    type: "long_term_memory_extracted";
    status: "extracted" | "skipped" | "failed";
    count?: number;
    source?: "state" | "transcript";
    reason?: string;
  }
  | {
    type: "agent_started";
    childAgentId: string;
    childAgentType: string;
    mode: string;
    isolation: string;
    allowedTools: string[];
    worktreePath?: string;
    worktreeBranch?: string;
  }
  | {
    type: "agent_finished";
    childAgentId: string;
    childAgentType: string;
    mode: string;
    durationMs: number;
    messageCount: number;
    changedFiles?: string[];
    worktreePath?: string;
    worktreeBranch?: string;
  }
  | {
    type: "agent_failed";
    childAgentId: string;
    childAgentType: string;
    mode: string;
    durationMs: number;
    error: string;
    changedFiles?: string[];
    worktreePath?: string;
    worktreeBranch?: string;
  }
  | {
    type: "agent_message_drained";
    childAgentId: string;
    messageCount: number;
  }
);
