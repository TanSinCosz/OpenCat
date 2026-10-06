/** 评测数据契约：运行、案例指标、数据集条目和会话展示消息。 */
import type { AppConfig } from "../config/load-config.js";
import type { SweWorkspaceStatus } from "../swe/workspace.js";

export type JsonRecord = Record<string, unknown>;

export type RunListItem = {
  name: string;
  path: string;
  evalRoot: string;
  updatedAt: string;
  version: string;
  summary?: JsonRecord;
  datasetOnly?: boolean;
};

export type CaseSummary = {
  caseId: string;
  status?: string;
  repo?: string;
  durationMs?: number;
  eventCount: number;
  contextReadyCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  toolFinishedCount: number;
  autoCompressCount: number;
  historySnipCount: number;
  hardHistorySnipCount: number;
  bulkyToolCompactCount: number;
  toolResultBudgetReplacementCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cacheHitRate: number;
  maxPromptTokens: number;
  maxEstimatedTokens: number;
  maxMessageCount: number;
  toolResultCharsBeforeBudget: number;
  toolResultCharsAfterBudget: number;
  toolResultCharsAfterCompact: number;
  hasLongTermMemory: boolean;
  hasSessionMemory: boolean;
  hasAutoCompressSummary: boolean;
  toolCounts: Record<string, number>;
  finishedReason?: string;
  errorCount: number;
  lastError?: string;
};

export type RunDetail = {
  run: RunListItem;
  version: string;
  cases: CaseSummary[];
  datasetItems: DatasetItemSummary[];
  config?: JsonRecord;
  totals: CaseSummary;
  rootSummary?: JsonRecord;
};

export type DatasetItemSummary = {
  instanceId: string;
  repo?: string;
  baseCommit?: string;
  problemPreview: string;
  problemStatement?: string;
  hintsText?: string;
  testPatch?: string;
  tested: boolean;
  status?: string;
  cacheHitRate?: number;
  totalTokens?: number;
  maxEstimatedTokens?: number;
  workspace: SweWorkspaceStatus;
};

export type ConversationMessage = {
  role: string;
  source?: string;
  agentId?: string;
  createdAt?: number;
  content: string;
  reasoning?: string;
  toolName?: string;
  toolCallCount?: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    cacheHitRate: number;
  };
};

/** 核心评测服务需要的配置快照与目录；不包含 HTTP 或浏览器状态。 */
export interface EvaluationOptions {
  workspaceRoot: string;
  evalRoot: string;
  evalRoots: readonly string[];
  appConfig: AppConfig;
}
