/** 每轮上下文准备：接收协作消息 → 投影与压缩 → 注入上下文 → 重建投影与保存快照。 */
import { drainAgentMessages } from "../Tools/Agent/state.js";
import { getModelUserContentText } from "../openai-compatible/content.js";
import { createMessage } from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import { recordTranscriptMessage, recordTranscriptStateSnapshot } from "../transcript/persistence.js";
import { emitRunEvent } from "../telemetry/observer.js";
import type { MessagesForQuery, QueryOptions } from "./types.js";
import { buildMessagesForQuery, buildPreprojectedMessagesForQuery } from "./messages.js";
import {
  getAutoCompressionRequest,
  applyAutoCompressionWithTelemetry,
  estimateMessagesForQueryTokens,
} from "./compression.js";
import { materializeRequestContext } from "./request-context.js";

export async function prepareMessagesForTurn(
  runtime: Runtime,
  state: State,
  options: QueryOptions,
  turn: number,
): Promise<MessagesForQuery> {
  // Phase A：父智能体发来的指令先写入业务历史，让投影和压缩都能处理它们。
  await drainPendingAgentMessagesForRuntime(runtime, state);

  // Phase B：先投影，再判断是否压缩 State。fork 首轮沿用已投影的输入，保留继承前缀。
  const usePreprojectedMessages =
    turn === 1 && options.usePreprojectedMessagesOnFirstTurn === true;
  const historySnipCountBeforeBuild = state.historySnips.length;
  let messagesForQuery = usePreprojectedMessages
    ? await buildPreprojectedMessagesForQuery(runtime, state.Messages)
    : await buildMessagesForQuery(runtime, state);
  await recordHistorySnipSnapshotIfNeeded(
    runtime,
    state,
    historySnipCountBeforeBuild,
  );

  const autoCompressRequest = usePreprojectedMessages
    ? null
    : getAutoCompressionRequest(
      runtime,
      state,
      messagesForQuery,
    );
  if (autoCompressRequest) {
    const autoCompressResult = await applyAutoCompressionWithTelemetry(
      runtime,
      state,
      autoCompressRequest,
    );

    if (autoCompressResult.status === "compressed") {
      await recordTranscriptStateSnapshot(runtime, state, "auto_compress");
    }
    // 即使压缩被跳过，也按原流程重新投影，读取最新 State。
    messagesForQuery = await buildMessagesForQuery(runtime, state);
  }

  // Phase C：压缩后才生成可变上下文，避免本轮记忆、技能和计划被压缩提示词吞掉。
  if (!options.skipRequestContextMaterialization) {
    await materializeRequestContext(runtime, state);
  }
  if (!usePreprojectedMessages) {
    const historySnipCountBeforeFinalBuild = state.historySnips.length;
    messagesForQuery = await buildMessagesForQuery(runtime, state);
    await recordHistorySnipSnapshotIfNeeded(
      runtime,
      state,
      historySnipCountBeforeFinalBuild,
    );
    await recordProjectionSnapshotIfNeeded(runtime, state, messagesForQuery);
  }

  await recordPreparedContext(runtime, state, messagesForQuery, turn);
  return messagesForQuery;
}

/** 记录最终模型输入的统计；不参与上下文构建或修改消息。 */
async function recordPreparedContext(
  runtime: Runtime,
  state: State,
  messagesForQuery: MessagesForQuery,
  turn: number,
): Promise<void> {
  await emitRunEvent(runtime, {
    type: "context_ready",
    turn,
    messageCount: messagesForQuery.messages.length,
    estimatedTokens: estimateMessagesForQueryTokens(messagesForQuery),
    hasLongTermMemory: hasTaggedMessage(messagesForQuery, "<long_term_memory>"),
    hasSessionMemory: hasTaggedMessage(messagesForQuery, "<session_memory>"),
    hasAutoCompressSummary: hasTaggedMessage(
      messagesForQuery,
      "<local_compact_summary>",
    ) || hasTaggedMessage(messagesForQuery, "<session_memory>"),
    runtimeContextMessageCount: state.runtimeContextMessages.length,
    toolResultBudgetReplacementCount:
      messagesForQuery.stats.toolResultBudgetReplacementCount,
    bulkyToolCompactCount: messagesForQuery.stats.bulkyToolCompactCount,
    historySnipCount: messagesForQuery.stats.historySnipCount,
    hardHistorySnipApplied: messagesForQuery.stats.historySnipCount > 0,
    toolResultCharsBeforeBudget:
      messagesForQuery.stats.toolResultCharsBeforeBudget,
    toolResultCharsAfterBudget:
      messagesForQuery.stats.toolResultCharsAfterBudget,
    toolResultCharsAfterCompact:
      messagesForQuery.stats.toolResultCharsAfterCompact,
  });
}

async function recordHistorySnipSnapshotIfNeeded(
  runtime: Runtime,
  state: State,
  historySnipCountBefore: number,
): Promise<void> {
  if (state.historySnips.length <= historySnipCountBefore) {
    return;
  }

  await recordTranscriptStateSnapshot(runtime, state, "history_snip");
}

async function recordProjectionSnapshotIfNeeded(
  runtime: Runtime,
  state: State,
  messagesForQuery: MessagesForQuery,
): Promise<void> {
  const stats = messagesForQuery.stats;
  if (
    stats.toolResultBudgetReplacementCount === 0 &&
    stats.bulkyToolCompactCount === 0
  ) {
    return;
  }

  await recordTranscriptStateSnapshot(runtime, state, "projection");
}

async function drainPendingAgentMessagesForRuntime(
  runtime: Runtime,
  state: State,
): Promise<number> {
  // 父到子的消息是持久指令；主智能体的任务通知由 runtime-context 作为一次性上下文处理。
  if (runtime.agentRole !== "subagent") {
    return 0;
  }

  const messages = drainAgentMessages(state.agentTasks, runtime.agentId);
  if (messages.length === 0) {
    return 0;
  }

  const message = createMessage({
    role: "user",
    content: renderPendingAgentMessages(messages),
  }, { source: "agent_message" });
  state.Messages.push(message);
  await recordTranscriptMessage(runtime, message);
  await emitRunEvent(runtime, {
    type: "agent_message_drained",
    childAgentId: runtime.agentId,
    messageCount: messages.length,
  });

  return messages.length;
}

function renderPendingAgentMessages(messages: readonly string[]): string {
  const renderedMessages = messages
    .map((message, index) => [
      `<message index="${index + 1}">`,
      message,
      `</message>`,
    ].join("\n"))
    .join("\n\n");

  return [
    `<agent-messages>`,
    `The parent agent sent the following queued message${messages.length === 1 ? "" : "s"}.`,
    `Use the newest instructions together with your original task.`,
    "",
    renderedMessages,
    `</agent-messages>`,
  ].join("\n");
}

function hasTaggedMessage(
  messagesForQuery: MessagesForQuery,
  tag: string,
): boolean {
  return messagesForQuery.messages.some((message) =>
    getModelMessageText(message).includes(tag)
  );
}

function getModelMessageText(
  message: MessagesForQuery["messages"][number],
): string {
  if (message.role === "assistant") {
    return typeof message.content === "string" ? message.content : "";
  }

  if (message.role === "user") {
    return getModelUserContentText(message.content);
  }

  return message.content;
}
