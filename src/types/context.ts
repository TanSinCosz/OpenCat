import type { MessageId } from "./messages.js";

export type AutoCompressSummaryId = `autocompress_${string}`;
export type HistorySnipId = `history_snip_${string}`;

export interface AutoCompressSummary {
  id: AutoCompressSummaryId;
  content: string;
  fromMessageId?: MessageId;
  throughMessageId?: MessageId;
  messageCount: number;
  createdAt: number;
}

export interface AutoCompressState {
  summaries: AutoCompressSummary[];
  sessionMemoryUpdated: boolean;
  /**
   * Content-only history snips at or before this message are covered by an
   * auto-compress summary, so projection can hide them instead of keeping their
   * text in the request.
   */
  snippedContentCompactedThroughMessageId?: MessageId;
  readFileStateRestoredForSummaryId?: AutoCompressSummaryId;
  invokedSkillsRestoredForSummaryId?: AutoCompressSummaryId;
}

export interface HistorySnipBoundary {
  id: HistorySnipId;
  removedMessageIds: MessageId[];
  contentOnlyMessageIds?: MessageId[];
  createdAtMessageId?: MessageId;
  reason: "prompt_budget";
  createdAt: number;
}

export interface ContextProjectionState {
  recentMessageCount?: number;
}

export interface ToolResultBudgetState {
  // Keys are local tool message ids when query projection has them available.
  // `tool_call_id` is API-local and may repeat, so it must not be the state key.
  seenIds: Set<string>;
  replacements: Map<string, string>;
}
