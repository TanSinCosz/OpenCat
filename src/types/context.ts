import type { MessageId } from "./messages.js";

export type AutoCompressSummaryId = `autocompress_${string}`;

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
  readFileStateRestoredForSummaryId?: AutoCompressSummaryId;
}

export interface ContextProjectionState {
  recentMessageCount?: number;
}

export interface ToolResultBudgetState {
  seenIds: Set<string>;
  replacements: Map<string, string>;
}
