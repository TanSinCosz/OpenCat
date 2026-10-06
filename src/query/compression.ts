/** 查询层压缩策略：判断投影是否超预算，调用压缩并记录运行事件；不拼装运行时上下文。 */
import { getConfigValue } from "../config/load-config.js";
import { applyAutoCompression } from "../auto-compress/index.js";
import { emitRunEvent } from "../telemetry/observer.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import type { MessagesForQuery } from "./types.js";
import { getVisibleSnippedContentOnlyStats, type SnippedContentOnlyStats } from "./messages.js";

const DEFAULT_AUTO_COMPRESS_TRIGGER_TOKENS = 180_000;

type AutoCompressionRequest = {
  reason: "context_size";
  snippedContentThroughMessageId?: SnippedContentOnlyStats["lastMessageId"];
};

export async function applyAutoCompressionWithTelemetry(
  runtime: Runtime,
  state: State,
  request: AutoCompressionRequest,
) {
  const beforeMessageCount = state.Messages.length;
  await emitRunEvent(runtime, {
    type: "auto_compress_started",
    messageCount: beforeMessageCount,
    reason: request.reason,
  });
  const result = await applyAutoCompression(runtime, state, {
    snippedContentThroughMessageId: request.snippedContentThroughMessageId,
  });
  await emitRunEvent(runtime, {
    type: "auto_compress_finished",
    status: result.status,
    reason: result.status === "skipped" ? result.reason : undefined,
    beforeMessageCount,
    afterMessageCount: state.Messages.length,
    summaryId: result.status === "compressed" ? result.summary.id : undefined,
    summaryChars: result.status === "compressed"
      ? result.summary.content.length
      : undefined,
    summaryMessageCount: result.status === "compressed"
      ? result.summary.messageCount
      : undefined,
  });

  return result;
}

export function getAutoCompressionRequest(
  runtime: Runtime,
  state: State,
  messagesForQuery: MessagesForQuery,
): AutoCompressionRequest | null {
  if (!canRuntimeAutoCompress(runtime)) {
    return null;
  }

  if (
    estimateMessagesForQueryTokens(messagesForQuery) <
    getAutoCompressTriggerTokens(runtime)
  ) {
    return null;
  }

  const snippedContent = getVisibleSnippedContentOnlyStats(state);
  return {
    reason: "context_size",
    snippedContentThroughMessageId: snippedContent.lastMessageId,
  };
}

function canRuntimeAutoCompress(runtime: Runtime): boolean {
  return runtime.agentRole !== "session" && runtime.agentType !== "session_memory";
}

export function estimateMessagesForQueryTokens(messagesForQuery: MessagesForQuery): number {
  return Math.ceil(JSON.stringify(messagesForQuery.messages).length / 4);
}

function getAutoCompressTriggerTokens(runtime: Runtime): number {
  const runtimeConfigured = runtime.contextCompressionConfig
    ?.autoCompressTriggerTokens;
  if (
    typeof runtimeConfigured === "number" &&
    Number.isFinite(runtimeConfigured) &&
    runtimeConfigured > 0
  ) {
    return runtimeConfigured;
  }

  const configured = Number(
    getConfigValue("compression.autoCompressTriggerTokens"),
  );

  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return DEFAULT_AUTO_COMPRESS_TRIGGER_TOKENS;
}
