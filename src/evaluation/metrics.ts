/** 纯指标计算与摘要合并；事件指标优先，旧摘要补齐缺失信息。 */
import type { CaseSummary, JsonRecord } from "./types.js";
import { isRecord, stringValue, numberValue } from "./records.js";

export function indexRootSummaryResults(
  summary?: JsonRecord,
): Map<string, JsonRecord> {
  const results = summary?.results;
  if (!Array.isArray(results)) {
    return new Map();
  }

  return new Map(
    results.flatMap((value) => {
      if (!isRecord(value)) {
        return [];
      }
      const instanceId = stringValue(value.instanceId);
      return instanceId ? [[instanceId, value] as const] : [];
    }),
  );
}

export function mergeCaseSummaryWithRunResult(
  summary: CaseSummary,
  runResult?: JsonRecord,
): CaseSummary {
  if (!runResult) {
    return summary;
  }

  applySummaryFallbacks(summary, runResult);
  summary.repo ??= stringValue(runResult.repo);
  summary.durationMs ??= numberValue(runResult.durationMs);
  summary.errorCount ||= stringValue(runResult.error) ? 1 : 0;
  summary.lastError ??= stringValue(runResult.error);
  summary.cacheHitRate = computeCacheHitRate(
    summary.promptCacheHitTokens,
    summary.promptCacheMissTokens,
  );
  return summary;
}

export function caseSummaryFromRunResult(result: JsonRecord): CaseSummary | undefined {
  const caseId = stringValue(result.instanceId);
  if (!caseId) {
    return undefined;
  }

  const summary = emptyCaseSummary(caseId);
  mergeCaseSummaryWithRunResult(summary, result);
  return summary;
}

export function hasMetricData(summary: CaseSummary): boolean {
  return summary.totalTokens > 0 ||
    summary.promptTokens > 0 ||
    summary.completionTokens > 0 ||
    summary.promptCacheHitTokens > 0 ||
    summary.promptCacheMissTokens > 0;
}

export function summarizeCase(
  caseId: string,
  events: readonly JsonRecord[],
  summary?: JsonRecord,
): CaseSummary {
  const result = emptyCaseSummary(caseId);
  result.status = stringValue(summary?.status);
  result.repo = stringValue(summary?.repo);
  result.durationMs = numberValue(summary?.durationMs);

  for (const event of events) {
    result.eventCount++;
    const type = stringValue(event.type) ?? "unknown";

    if (type === "context_ready") {
      result.contextReadyCount++;
      result.maxEstimatedTokens = Math.max(
        result.maxEstimatedTokens,
        numberValue(event.estimatedTokens) ?? 0,
      );
      result.maxMessageCount = Math.max(
        result.maxMessageCount,
        numberValue(event.messageCount) ?? 0,
      );
      result.historySnipCount += numberValue(event.historySnipCount) ?? 0;
      result.hardHistorySnipCount += event.hardHistorySnipApplied ? 1 : 0;
      result.toolResultBudgetReplacementCount +=
        numberValue(event.toolResultBudgetReplacementCount) ?? 0;
      result.bulkyToolCompactCount = Math.max(
        result.bulkyToolCompactCount,
        numberValue(event.bulkyToolCompactCount) ?? 0,
      );
      result.toolResultCharsBeforeBudget +=
        numberValue(event.toolResultCharsBeforeBudget) ?? 0;
      result.toolResultCharsAfterBudget +=
        numberValue(event.toolResultCharsAfterBudget) ?? 0;
      result.toolResultCharsAfterCompact +=
        numberValue(event.toolResultCharsAfterCompact) ?? 0;
      result.hasLongTermMemory ||= Boolean(event.hasLongTermMemory);
      result.hasSessionMemory ||= Boolean(event.hasSessionMemory);
      result.hasAutoCompressSummary ||= Boolean(event.hasAutoCompressSummary);
      continue;
    }

    if (type === "model_usage") {
      result.promptTokens += numberValue(event.promptTokens) ?? 0;
      result.completionTokens += numberValue(event.completionTokens) ?? 0;
      result.totalTokens += numberValue(event.totalTokens) ?? 0;
      result.promptCacheHitTokens += numberValue(event.promptCacheHitTokens) ?? 0;
      result.promptCacheMissTokens += numberValue(event.promptCacheMissTokens) ?? 0;
      result.maxPromptTokens = Math.max(
        result.maxPromptTokens,
        numberValue(event.promptTokens) ?? 0,
      );
      continue;
    }

    if (type === "assistant_message") {
      result.assistantMessageCount++;
      continue;
    }

    if (type === "tool_call_started") {
      result.toolCallCount++;
      const toolName = stringValue(event.toolName) ?? "(unknown)";
      result.toolCounts[toolName] = (result.toolCounts[toolName] ?? 0) + 1;
      continue;
    }

    if (type === "tool_call_finished") {
      result.toolFinishedCount++;
      continue;
    }

    if (type === "auto_compress_finished" && event.status === "compressed") {
      result.autoCompressCount++;
      continue;
    }

    if (type === "query_finished") {
      result.finishedReason = stringValue(event.reason);
      continue;
    }

    if (type.endsWith("_failed") || type === "parse_error") {
      result.errorCount++;
      result.lastError = stringValue(event.error) ?? stringValue(event.raw);
    }
  }

  applySummaryFallbacks(result, summary);
  result.cacheHitRate = computeCacheHitRate(
    result.promptCacheHitTokens,
    result.promptCacheMissTokens,
  );
  return result;
}

function applySummaryFallbacks(result: CaseSummary, summary?: JsonRecord): void {
  if (!summary) {
    return;
  }

  result.status ??= stringValue(summary.status);
  result.finishedReason ??= stringValue(summary.status);
  result.toolCallCount ||= numberValue(summary.toolCallCount) ?? 0;
  result.contextReadyCount ||= numberValue(summary.contextReadyCount) ?? 0;
  result.promptTokens ||= numberValue(summary.promptTokens) ?? 0;
  result.completionTokens ||= numberValue(summary.completionTokens) ?? 0;
  result.totalTokens ||= numberValue(summary.totalTokens) ?? 0;
  result.promptCacheHitTokens ||= numberValue(summary.promptCacheHitTokens) ?? 0;
  result.promptCacheMissTokens ||= numberValue(summary.promptCacheMissTokens) ?? 0;
  result.maxPromptTokens ||= numberValue(summary.maxPromptTokens) ?? 0;
  result.maxEstimatedTokens ||= numberValue(summary.maxEstimatedTokens) ?? 0;
  result.autoCompressCount ||= numberValue(summary.autoCompressCount) ?? 0;
  result.historySnipCount ||= numberValue(summary.historySnipCount) ?? 0;
  result.hardHistorySnipCount ||= numberValue(summary.hardHistorySnipCount) ?? 0;
  result.toolResultBudgetReplacementCount ||=
    numberValue(summary.toolResultBudgetReplacementCount) ?? 0;
  result.bulkyToolCompactCount ||= numberValue(summary.bulkyToolCompactCount) ?? 0;
  result.toolResultCharsBeforeBudget ||=
    numberValue(summary.toolResultCharsBeforeBudget) ?? 0;
  result.toolResultCharsAfterBudget ||=
    numberValue(summary.toolResultCharsAfterBudget) ?? 0;
  result.toolResultCharsAfterCompact ||=
    numberValue(summary.toolResultCharsAfterCompact) ?? 0;

  const toolCounts = summary.toolCounts;
  if (isRecord(toolCounts) && Object.keys(result.toolCounts).length === 0) {
    result.toolCounts = Object.fromEntries(
      Object.entries(toolCounts).flatMap(([key, value]) => {
        const count = numberValue(value);
        return count === undefined ? [] : [[key, count]];
      }),
    );
  }
}

export function summarizeTotals(cases: readonly CaseSummary[]): CaseSummary {
  const totals = emptyCaseSummary("TOTAL");
  for (const item of cases) {
    totals.eventCount += item.eventCount;
    totals.contextReadyCount += item.contextReadyCount;
    totals.assistantMessageCount += item.assistantMessageCount;
    totals.toolCallCount += item.toolCallCount;
    totals.toolFinishedCount += item.toolFinishedCount;
    totals.autoCompressCount += item.autoCompressCount;
    totals.historySnipCount += item.historySnipCount;
    totals.hardHistorySnipCount += item.hardHistorySnipCount;
    totals.bulkyToolCompactCount += item.bulkyToolCompactCount;
    totals.toolResultBudgetReplacementCount += item.toolResultBudgetReplacementCount;
    totals.promptTokens += item.promptTokens;
    totals.completionTokens += item.completionTokens;
    totals.totalTokens += item.totalTokens;
    totals.promptCacheHitTokens += item.promptCacheHitTokens;
    totals.promptCacheMissTokens += item.promptCacheMissTokens;
    totals.maxPromptTokens = Math.max(totals.maxPromptTokens, item.maxPromptTokens);
    totals.maxEstimatedTokens = Math.max(totals.maxEstimatedTokens, item.maxEstimatedTokens);
    totals.maxMessageCount = Math.max(totals.maxMessageCount, item.maxMessageCount);
    totals.toolResultCharsBeforeBudget += item.toolResultCharsBeforeBudget;
    totals.toolResultCharsAfterBudget += item.toolResultCharsAfterBudget;
    totals.toolResultCharsAfterCompact += item.toolResultCharsAfterCompact;
    totals.hasLongTermMemory ||= item.hasLongTermMemory;
    totals.hasSessionMemory ||= item.hasSessionMemory;
    totals.hasAutoCompressSummary ||= item.hasAutoCompressSummary;
    totals.errorCount += item.errorCount;

    for (const [toolName, count] of Object.entries(item.toolCounts)) {
      totals.toolCounts[toolName] = (totals.toolCounts[toolName] ?? 0) + count;
    }
  }

  // 总命中率按 token 加权，不能直接平均各案例的百分比。
  totals.cacheHitRate = computeCacheHitRate(
    totals.promptCacheHitTokens,
    totals.promptCacheMissTokens,
  );
  return totals;
}

function emptyCaseSummary(caseId: string): CaseSummary {
  return {
    caseId,
    eventCount: 0,
    contextReadyCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    toolFinishedCount: 0,
    autoCompressCount: 0,
    historySnipCount: 0,
    hardHistorySnipCount: 0,
    bulkyToolCompactCount: 0,
    toolResultBudgetReplacementCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    cacheHitRate: 0,
    maxPromptTokens: 0,
    maxEstimatedTokens: 0,
    maxMessageCount: 0,
    toolResultCharsBeforeBudget: 0,
    toolResultCharsAfterBudget: 0,
    toolResultCharsAfterCompact: 0,
    hasLongTermMemory: false,
    hasSessionMemory: false,
    hasAutoCompressSummary: false,
    toolCounts: {},
    errorCount: 0,
  };
}

export function computeCacheHitRate(hit: number, miss: number): number {
  const denominator = hit + miss;
  return denominator === 0 ? 0 : hit / denominator;
}

export function resolveEvalVersion(
  summary?: JsonRecord,
  config?: JsonRecord,
): string {
  return stringValue(summary?.version) ??
    stringValue(summary?.evalVersion) ??
    stringValue(config?.version) ??
    stringValue(config?.evalVersion) ??
    "v1";
}
