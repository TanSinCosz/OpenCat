/** 单案例事件与 transcript 展示；记录缺失时退回事件，限制读取在运行目录内。 */
import path from "node:path";
import type { ConversationMessage, JsonRecord, RunListItem } from "./types.js";
import {
  readJsonl,
  firstString,
  stringValue,
  numberValue,
  isRecord,
  messageContentToText,
} from "./records.js";
import { computeCacheHitRate } from "./metrics.js";

export async function loadCaseEvents(
  run: RunListItem,
  caseId: string,
  limit: number,
): Promise<{ caseId: string; events: JsonRecord[] }> {
  if (!caseId) {
    return { caseId, events: [] };
  }

  const caseDir = safeCaseDir(run, caseId);
  const events = await readJsonl(path.join(caseDir, "events.jsonl"));
  return { caseId, events: events.slice(-limit) };
}

export async function loadCaseConversation(
  run: RunListItem,
  caseId: string,
  limit: number,
): Promise<{
  caseId: string;
  sessionId?: string;
  transcriptPath?: string;
  messages: ConversationMessage[];
  fallbackEvents: JsonRecord[];
}> {
  if (!caseId) {
    return { caseId, messages: [], fallbackEvents: [] };
  }

  const caseDir = safeCaseDir(run, caseId);
  const events = await readJsonl(path.join(caseDir, "events.jsonl"));
  const sessionId = firstString(events, "sessionId");
  const transcriptPath = sessionId
    ? path.join(caseDir, "repo/.opencat/transcripts", `${sessionId}.jsonl`)
    : undefined;
  const transcriptEntries = transcriptPath ? await readJsonl(transcriptPath) : [];
  // 优先展示持久化的真实会话；旧评测若没有 transcript，仍可通过事件回顾执行。
  const messages = transcriptEntries
    .map(transcriptEntryToConversationMessage)
    .filter((message): message is ConversationMessage => message !== undefined)
    .slice(-limit);

  return {
    caseId,
    sessionId,
    transcriptPath: transcriptEntries.length > 0 ? transcriptPath : undefined,
    messages,
    fallbackEvents: transcriptEntries.length > 0 ? [] : events.slice(-limit),
  };
}

function safeCaseDir(run: RunListItem, caseId: string): string {
  const caseDir = path.join(run.path, caseId);
  const resolved = path.resolve(caseDir);
  // caseId 来自请求或旧产物，必须在拼接后验证目录边界。
  if (!resolved.startsWith(path.resolve(run.path) + path.sep)) {
    throw new Error("Invalid case path.");
  }
  return caseDir;
}

function transcriptEntryToConversationMessage(
  entry: JsonRecord,
): ConversationMessage | undefined {
  if (entry.type !== "message" || !isRecord(entry.message)) {
    return undefined;
  }

  const message = entry.message;
  const usageRecord = isRecord(message.usage) ? message.usage : undefined;
  const promptDetails = usageRecord && isRecord(usageRecord.prompt_tokens_details)
    ? usageRecord.prompt_tokens_details
    : undefined;
  const promptTokens = usageRecord
    ? numberValue(usageRecord.prompt_tokens) ?? 0
    : 0;
  const cacheHitTokens = usageRecord
    ? numberValue(usageRecord.prompt_cache_hit_tokens) ??
      numberValue(promptDetails?.cached_tokens) ??
      0
    : 0;
  const cacheMissTokens = usageRecord
    ? numberValue(usageRecord.prompt_cache_miss_tokens) ??
      Math.max(0, promptTokens - cacheHitTokens)
    : 0;
  const usage = usageRecord
    ? {
      promptTokens,
      completionTokens: numberValue(usageRecord.completion_tokens) ?? 0,
      totalTokens: numberValue(usageRecord.total_tokens) ?? 0,
      cacheHitTokens,
      cacheMissTokens,
      cacheHitRate: computeCacheHitRate(cacheHitTokens, cacheMissTokens),
    }
    : undefined;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  return {
    role: stringValue(message.role) ?? "unknown",
    source: stringValue(message.source),
    agentId: stringValue(entry.agentId),
    createdAt: numberValue(message.createdAt) ?? numberValue(entry.savedAt),
    content: messageContentToText(message.content),
    reasoning: stringValue(message.reasoning_content),
    toolName: stringValue(message.toolName),
    toolCallCount: toolCalls.length,
    usage,
  };
}
