import { randomUUID } from "node:crypto";
import {
  createPermissionDeniedToolCallResult,
  executeToolCallWithMetadata,
  getPlanModeToolDenialReason,
  type ToolCallExecutionResult,
} from "./Tools/executor.js";
import { PLAN_TOOL_NAME } from "./Tools/Plan/prompt.js";
import { drainAgentMessages } from "./Tools/Agent/state.js";
import type {
  DeepSeekAssistantMessage,
  DeepSeekToolCall,
} from "./deepseek/types.js";
import {
  createMessage,
  toDeepSeekMessage,
  type Message,
  type ToolMessage,
} from "./types/messages.js";
import type { Runtime } from "./types/runtime.js";
import type { State } from "./types/state.js";
import { streamAssistantWithReasoningContinuation } from "./query/reasoning-continuation.js";
import {
  buildMessagesForQuery,
  getVisibleSnippedContentOnlyStats,
  type SnippedContentOnlyStats,
} from "./query/messages.js";
import { createStreamRequest } from "./query/request.js";
import type {
  MessagesForQuery,
  QueryEvent,
  QueryOptions,
  ToolPermissionDecision,
} from "./query/types.js";
import { snapshotRuntimeUsage } from "./query/usage.js";
import {
  createLongTermMemoryContextMessage,
  extractLongTermMemoryForCompletedQuery,
  type LongTermMemoryExtractionResult,
} from "./query/long-term-memory.js";
import {
  shouldUpdateSessionMemory,
  updateSessionMemoryForAutoCompress,
  type SessionMemoryUpdateResult,
} from "./session-memory/index.js";
import {
  clearRuntimeContextAfterModelRequest,
  createProjectionContextStateMessage,
  loadDynamicSkillContextForQuery,
  loadRuntimeContextForQuery,
} from "./query/runtime-context.js";
import {
  applyAutoCompression,
} from "./auto-compress/index.js";
import {
  recordTranscriptMessage,
  recordTranscriptStateSnapshot,
} from "./transcript/persistence.js";
import {
  emitRunEvent,
  stringifyTelemetryError,
} from "./telemetry/observer.js";
import {
  saveWorkspacePatchSnapshot,
  type WorkspacePatchSnapshotReason,
} from "./workspace/patch-snapshot.js";

export type {
  MessagesForQuery,
  QueryEvent,
  QueryOptions,
} from "./query/types.js";
export { buildMessagesForQuery } from "./query/messages.js";
export { createStreamRequest } from "./query/request.js";
export { applyAutoCompression } from "./auto-compress/index.js";
export {
  appendRuntimeContextMessages,
  clearRuntimeContextAfterModelRequest,
  createRuntimeContextMessage,
  loadRuntimeContextForQuery,
} from "./query/runtime-context.js";

const DEFAULT_AUTO_COMPRESS_TRIGGER_TOKENS = 180_000;

export async function* query(
  runtime: Runtime,
  state: State,
  options: QueryOptions = {},
): AsyncGenerator<QueryEvent, void, void> {
  yield* _query(runtime, state, options);
}

export async function* _query(
  runtime: Runtime,
  state: State,
  options: QueryOptions = {},
): AsyncGenerator<QueryEvent, void, void> {
  clearTemporaryCommandAllowRules(runtime);
  const maxTurns = options.maxTurns ?? 100;
  const turnStartMessageId = state.Messages.at(-1)?.id;
  const turnStartedAt = Date.now();
  await emitRunEvent(runtime, {
    type: "query_started",
    maxTurns,
    stateMessageCount: state.Messages.length,
  });

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      throwIfQueryAborted(runtime);

      // Phase A: drain durable parent-to-child messages before building.
      await drainPendingAgentMessagesForRuntime(runtime, state);

      // Phase B: project first, then compact State only if the request is still too large.
      const historySnipCountBeforeBuild = state.historySnips.length;
      let messagesForQuery = await buildMessagesForQuery(runtime, state);
      await recordHistorySnipSnapshotIfNeeded(
        runtime,
        state,
        historySnipCountBeforeBuild,
      );

      const autoCompressRequest = getAutoCompressionRequest(
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
      }

      if (autoCompressRequest) {
        messagesForQuery = await buildMessagesForQuery(runtime, state);
      }

      // Phase C: append volatile/generated context after auto-compress so it is
      // visible to the model but not swallowed by the compaction prompt.
      await materializeRequestContext(
        runtime,
        state,
        messagesForQuery.forkContextMessages,
      );
      const historySnipCountBeforeFinalBuild = state.historySnips.length;
      messagesForQuery = await buildMessagesForQuery(runtime, state);
      await recordHistorySnipSnapshotIfNeeded(
        runtime,
        state,
        historySnipCountBeforeFinalBuild,
      );
      await recordProjectionSnapshotIfNeeded(runtime, state, messagesForQuery);

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
      yield {
        type: "context_ready",
        systemPrompt: messagesForQuery.systemPrompt,
        messages: messagesForQuery.messages,
        stats: messagesForQuery.stats,
      };

      const request = await createStreamRequest(runtime, messagesForQuery.messages);
      throwIfQueryAborted(runtime);
      await emitRunEvent(runtime, { type: "model_stream_started", turn });
      yield { type: "model_stream_start", turn };

      const assistantResult = yield* streamAssistantWithReasoningContinuation(
        runtime,
        request,
      );
      const assistantMessage = assistantResult.message;

      const persistedAssistantMessage = createMessage(assistantMessage, {
        usage: assistantResult.usage,
        contextTokenCount: assistantResult.contextTokenCount,
      });
      state.Messages.push(persistedAssistantMessage);
      await recordTranscriptMessage(runtime, persistedAssistantMessage);
      await emitRunEvent(runtime, {
        type: "assistant_message",
        turn,
        assistantTextChars: getAssistantTextChars(assistantMessage),
        reasoningChars: assistantMessage.reasoning_content?.length ?? 0,
        toolCallCount: assistantMessage.tool_calls?.length ?? 0,
      });
      yield {
        type: "assistant_message",
        message: assistantMessage,
        usage: assistantResult.usage,
      };
      await clearRuntimeContextAfterModelRequest(runtime, state);

      const toolCalls = assistantMessage.tool_calls ?? [];
      if (toolCalls.length === 0) {
        await emitRunEvent(runtime, {
          type: "turn_finished",
          turn,
          hasToolUse: false,
        });
        yield { type: "turn_end", turn, hasToolUse: false };
        await updateSessionMemoryAtSafeBoundary(
          runtime,
          state,
          [
            ...messagesForQuery.forkContextMessages,
            persistedAssistantMessage,
          ],
        );
        const extraction = await extractLongTermMemoryForCompletedQuery(runtime, state, {
          turnStartMessageId,
          turnStartedAt,
        });
        await emitLongTermMemoryExtractionEvent(runtime, extraction);
        await recordWorkspacePatchSnapshot(runtime, "completed");
        await emitRunEvent(runtime, {
          type: "query_finished",
          reason: "completed",
          durationMs: Date.now() - turnStartedAt,
        });
        yield {
          type: "done",
          reason: "completed",
          sessionUsage: snapshotRuntimeUsage(runtime),
        };
        return;
      }

      const persistedToolResultMessages: ToolMessage[] = [];
      for (const batch of partitionToolCallsForExecution(runtime, toolCalls)) {
        const batchToolResultMessages = yield* executeToolCallBatch(
          runtime,
          state,
          options,
          turn,
          batch,
        );
        persistedToolResultMessages.push(...batchToolResultMessages);
      }

      await emitRunEvent(runtime, {
        type: "turn_finished",
        turn,
        hasToolUse: true,
      });
      yield { type: "turn_end", turn, hasToolUse: true };
      await updateSessionMemoryAtSafeBoundary(
        runtime,
        state,
        [
          ...messagesForQuery.forkContextMessages,
          persistedAssistantMessage,
          ...persistedToolResultMessages,
        ],
      );
    }

    await recordWorkspacePatchSnapshot(runtime, "max_turns");
    await emitRunEvent(runtime, {
      type: "query_finished",
      reason: "max_turns",
      durationMs: Date.now() - turnStartedAt,
    });
    yield {
      type: "done",
      reason: "max_turns",
      sessionUsage: snapshotRuntimeUsage(runtime),
    };
  } catch (error) {
    await recordWorkspacePatchSnapshot(runtime, "failed");
    await emitRunEvent(runtime, {
      type: "query_failed",
      durationMs: Date.now() - turnStartedAt,
      error: stringifyTelemetryError(error),
    });
    throw error;
  } finally {
    clearTemporaryCommandAllowRules(runtime);
  }
}

function clearTemporaryCommandAllowRules(runtime: Runtime): void {
  runtime.toolUseContext.setAppState((previous) => {
    if (!previous.toolPermissionContext.alwaysAllowRules.command?.length) {
      return previous;
    }

    const { command: _command, ...remainingAllowRules } =
      previous.toolPermissionContext.alwaysAllowRules;
    return {
      ...previous,
      toolPermissionContext: {
        ...previous.toolPermissionContext,
        alwaysAllowRules: remainingAllowRules,
      },
    };
  });
}

async function updateSessionMemoryAtSafeBoundary(
  runtime: Runtime,
  state: State,
  forkContextMessages: readonly Message[],
): Promise<SessionMemoryUpdateResult> {
  if (!canRuntimeUpdateSessionMemory(runtime)) {
    return { status: "skipped", reason: "unsupported_runtime" };
  }

  const decision = shouldUpdateSessionMemory(state);
  if (decision.update === false) {
    await emitRunEvent(runtime, {
      type: "session_memory_update_finished",
      status: "skipped",
      reason: decision.reason,
      messageCount: state.Messages.length,
    });
    return { status: "skipped", reason: decision.reason };
  }

  await emitRunEvent(runtime, {
    type: "session_memory_update_started",
    messageCount: state.Messages.length,
  });
  const result = await updateSessionMemoryForAutoCompress(runtime, state, {
    forkContextMessages,
  });

  await emitRunEvent(runtime, {
    type: "session_memory_update_finished",
    status: result.status,
    reason: result.status === "skipped" ? result.reason : undefined,
    messageCount: state.Messages.length,
    contentChars: result.status === "updated" ? result.content.length : undefined,
    lastSummarizedMessageId: state.sessionMemory.lastSummarizedMessageId,
  });

  if (result.status === "skipped" && result.reason === "model_request_failed") {
    await emitRunEvent(runtime, {
      type: "session_memory_update_failed",
      error: state.sessionMemory.lastFailureReason ?? result.reason,
    });
  }

  return result;
}

function canRuntimeUpdateSessionMemory(runtime: Runtime): boolean {
  return runtime.agentRole === "main" && runtime.agentType !== "session_memory";
}

async function recordWorkspacePatchSnapshot(
  runtime: Runtime,
  reason: WorkspacePatchSnapshotReason,
): Promise<void> {
  if (runtime.agentRole === "session" || runtime.agentType === "session_memory") {
    return;
  }

  const result = await saveWorkspacePatchSnapshot(runtime, reason);
  if (result.status === "failed") {
    await emitRunEvent(runtime, {
      type: "workspace_patch_snapshot_failed",
      reason,
      error: result.error,
    });
    return;
  }

  if (result.status === "saved") {
    await emitRunEvent(runtime, {
      type: "workspace_patch_snapshot_saved",
      reason,
      patchPath: result.patchPath,
      latestPath: result.latestPath,
      bytes: result.bytes,
      sequence: result.sequence,
    });
  }
}

async function materializeRequestContext(
  runtime: Runtime,
  state: State,
  visibleMessages: readonly Message[],
): Promise<void> {
  await loadRuntimeContextForQuery(runtime, state);
  await loadDynamicSkillContextForQuery(runtime, state);
  await materializeContextForQuery(runtime, state, visibleMessages);
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

type PendingToolApproval = {
  requested: true;
  approvalId: string;
  reason: string;
  decision: Promise<ToolPermissionDecision>;
};

type ToolCallExecutionBatch = {
  concurrencySafe: boolean;
  toolCalls: DeepSeekToolCall[];
};

type PreparedToolCallExecution = {
  toolCall: DeepSeekToolCall;
  startedAt: number;
  permissionApproval: PendingToolApproval | null;
};

type CompletedToolCallExecution = {
  toolCall: DeepSeekToolCall;
  startedAt: number;
  finishedAt: number;
  execution: ToolCallExecutionResult;
};

function partitionToolCallsForExecution(
  runtime: Runtime,
  toolCalls: readonly DeepSeekToolCall[],
): ToolCallExecutionBatch[] {
  const batches: ToolCallExecutionBatch[] = [];

  for (const toolCall of toolCalls) {
    const concurrencySafe = isToolCallConcurrencySafe(runtime, toolCall);
    const previousBatch = batches.at(-1);

    if (concurrencySafe && previousBatch?.concurrencySafe) {
      previousBatch.toolCalls.push(toolCall);
      continue;
    }

    batches.push({
      concurrencySafe,
      toolCalls: [toolCall],
    });
  }

  return batches;
}

function isToolCallConcurrencySafe(
  runtime: Runtime,
  toolCall: DeepSeekToolCall,
): boolean {
  const tool = runtime.tools.find(
    (candidate) => candidate.name === toolCall.function.name,
  );
  if (!tool?.isConcurrencySafe) {
    return false;
  }

  try {
    return tool.isConcurrencySafe();
  } catch {
    return false;
  }
}

async function* executeToolCallBatch(
  runtime: Runtime,
  state: State,
  options: QueryOptions,
  turn: number,
  batch: ToolCallExecutionBatch,
): AsyncGenerator<QueryEvent, ToolMessage[], void> {
  const preparedExecutions: PreparedToolCallExecution[] = [];

  for (const toolCall of batch.toolCalls) {
    throwIfQueryAborted(runtime);
    yield { type: "tool_use", toolCall };

    const startedAt = Date.now();
    await emitRunEvent(runtime, {
      type: "tool_call_started",
      turn,
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      argsChars: toolCall.function.arguments.length,
      argsPreview: preview(toolCall.function.arguments, 500),
    });

    const permissionApproval = await requestToolApprovalIfNeeded(
      runtime,
      state,
      options,
      toolCall,
    );
    if (permissionApproval?.requested) {
      yield {
        type: "tool_permission_request",
        approvalId: permissionApproval.approvalId,
        toolCall,
        mode: "plan",
        reason: permissionApproval.reason,
      };
    }

    preparedExecutions.push({
      toolCall,
      startedAt,
      permissionApproval,
    });
  }

  const completedExecutions = batch.concurrencySafe
    ? await Promise.all(preparedExecutions.map((execution) =>
      executePreparedToolCall(runtime, state, execution)
    ))
    : await executePreparedToolCallsSerially(runtime, state, preparedExecutions);

  const persistedToolResultMessages: ToolMessage[] = [];

  // Preserve the API-visible order even when safe tools ran concurrently.
  for (const completed of completedExecutions) {
    const toolCall = completed.toolCall;
    const toolResultMessage = completed.execution.message;

    if (completed.execution.permissionDenied) {
      yield {
        type: "tool_permission",
        toolCall,
        behavior: "denied",
        reason: completed.execution.permissionDenied.reason,
      };
    }

    const stateToolResultMessage = {
      ...(createMessage(toolResultMessage) as ToolMessage),
      toolName: toolCall.function.name,
      ...(completed.execution.persistedToolResult
        ? { persistedToolResult: completed.execution.persistedToolResult }
        : {}),
    };
    await emitRunEvent(runtime, {
      type: "tool_call_finished",
      turn,
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      resultChars: stateToolResultMessage.content.length,
      durationMs: completed.finishedAt - completed.startedAt,
      persistedToolResult: completed.execution.persistedToolResult !== undefined,
      persistedToolResultPath: completed.execution.persistedToolResult?.path,
    });

    throwIfQueryAborted(runtime);
    state.Messages.push(stateToolResultMessage);
    persistedToolResultMessages.push(stateToolResultMessage);
    await recordTranscriptMessage(runtime, stateToolResultMessage);
    yield {
      type: "tool_result",
      toolCall,
      message: toDeepSeekMessage(stateToolResultMessage),
    };
  }

  return persistedToolResultMessages;
}

async function executePreparedToolCallsSerially(
  runtime: Runtime,
  state: State,
  preparedExecutions: readonly PreparedToolCallExecution[],
): Promise<CompletedToolCallExecution[]> {
  const completedExecutions: CompletedToolCallExecution[] = [];

  for (const preparedExecution of preparedExecutions) {
    throwIfQueryAborted(runtime);
    completedExecutions.push(
      await executePreparedToolCall(runtime, state, preparedExecution),
    );
  }

  return completedExecutions;
}

async function executePreparedToolCall(
  runtime: Runtime,
  state: State,
  preparedExecution: PreparedToolCallExecution,
): Promise<CompletedToolCallExecution> {
  const permissionDecision = preparedExecution.permissionApproval?.decision
    ? await preparedExecution.permissionApproval.decision
    : null;
  const execution = await executeToolAfterPermissionDecision(
    runtime,
    state,
    preparedExecution.toolCall,
    permissionDecision,
  );

  return {
    toolCall: preparedExecution.toolCall,
    startedAt: preparedExecution.startedAt,
    finishedAt: Date.now(),
    execution,
  };
}

async function requestToolApprovalIfNeeded(
  runtime: Runtime,
  state: State,
  options: QueryOptions,
  toolCall: DeepSeekToolCall,
): Promise<PendingToolApproval | null> {
  if (
    !isPlanApprovalToolCall(toolCall, state)
  ) {
    return null;
  }

  const approvalId = `tool_permission_${randomUUID()}`;
  const reason = getPlanApprovalRequestReason(toolCall);
  const decision = options.requestToolPermission
    ? options.requestToolPermission({
      approvalId,
      toolCall,
      mode: "plan",
      reason,
    }).catch((error): ToolPermissionDecision => ({
      behavior: "deny",
      reason: `Permission request failed: ${stringifyError(error)}`,
    }))
    : Promise.resolve({
      behavior: "deny",
      reason: "No interactive permission handler is available.",
    } satisfies ToolPermissionDecision);

  await emitRunEvent(runtime, {
    type: "tool_permission_requested",
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    mode: "plan",
  });

  return {
    requested: true,
    approvalId,
    reason,
    decision,
  };
}

function isPlanApprovalToolCall(
  toolCall: DeepSeekToolCall,
  state: State,
): boolean {
  if (state.mode !== "plan" || toolCall.function.name !== PLAN_TOOL_NAME) {
    return false;
  }

  return parsePlanToolAction(toolCall) === "request_approval";
}

function parsePlanToolAction(toolCall: DeepSeekToolCall): string | null {
  try {
    const input = JSON.parse(toolCall.function.arguments || "{}") as {
      action?: unknown;
    };
    return typeof input.action === "string" ? input.action : null;
  } catch {
    return null;
  }
}

function getPlanApprovalRequestReason(toolCall: DeepSeekToolCall): string {
  const fallback = "The agent has submitted a plan and is requesting approval to proceed.";

  try {
    const input = JSON.parse(toolCall.function.arguments || "{}") as {
      plan?: unknown;
    };
    const plan = typeof input.plan === "string" ? input.plan.trim() : "";
    if (!plan) {
      return fallback;
    }

    return [
      "The agent submitted the following plan and is requesting approval to proceed:",
      "",
      plan,
    ].join("\n");
  } catch {
    return fallback;
  }
}

async function executeToolAfterPermissionDecision(
  runtime: Runtime,
  state: State,
  toolCall: DeepSeekToolCall,
  decision: ToolPermissionDecision | null,
): Promise<ToolCallExecutionResult> {
  if (decision?.behavior === "allow") {
    return executeToolCallWithMetadata(
      toolCall,
      runtime.tools,
      runtime,
      state,
      { bypassPlanModePermission: true },
    );
  }

  if (decision?.behavior === "deny") {
    return createPermissionDeniedToolCallResult(
      toolCall,
      decision.reason ?? getPlanModeToolDenialReason(),
    );
  }

  return executeToolCallWithMetadata(
    toolCall,
    runtime.tools,
    runtime,
    state,
  );
}

async function materializeContextForQuery(
  runtime: Runtime,
  state: State,
  visibleMessages: readonly Message[],
): Promise<number> {
  removePreviousVolatileContextBlocks(state);

  const longTermMemoryMessage = shouldAttachLongTermMemory(state)
    ? await createLongTermMemoryContextMessage(runtime, visibleMessages)
    : null;
  const contextMessage = createProjectionContextStateMessage([
    ...createPlanModeContextBlocks(state),
    ...createTodoListContextBlocks(runtime, state),
    ...(longTermMemoryMessage
      ? [{
        source: "long_term_memory" as const,
        content: typeof longTermMemoryMessage.content === "string"
          ? longTermMemoryMessage.content
          : "",
      }]
      : []),
    ...state.runtimeContextMessages.map((message) => ({
      source: message.source,
      content: typeof message.content === "string" ? message.content : "",
    })),
  ]);

  if (!contextMessage) {
    return 0;
  }

  state.Messages.push(contextMessage);
  state.runtimeContextMessages = [];
  await recordTranscriptMessage(runtime, contextMessage);
  await recordTranscriptStateSnapshot(runtime, state, "runtime_context");
  return 1;
}

function createPlanModeContextBlocks(
  state: State,
): Array<{ source: "plan_mode"; content: string }> {
  if (state.mode !== "plan") {
    return [];
  }

  return [{
    source: "plan_mode",
    content: [
      "<plan_mode>",
      "The current agent is in plan mode. Inspect, reason, and update TodoWrite if useful, but do not modify files or run environment-changing tools until plan mode is exited.",
      "</plan_mode>",
    ].join("\n"),
  }];
}

function createTodoListContextBlocks(
  runtime: Runtime,
  state: State,
): Array<{ source: "todo_list"; content: string }> {
  const todos = state.todos[runtime.agentId] ?? [];
  if (todos.length === 0) {
    return [];
  }

  return [{
    source: "todo_list",
    content: renderTodoListContext(todos),
  }];
}

function renderTodoListContext(todos: State["todos"][string]): string {
  return [
    "<todo_list>",
    "Current task list for this agent. Use it as progress context; update it with TodoWrite when the plan changes.",
    ...todos.map((todo, index) =>
      `${index + 1}. [${todo.status}] ${todo.content} (${todo.activeForm})`
    ),
    "</todo_list>",
  ].join("\n");
}

function removePreviousVolatileContextBlocks(state: State): number {
  let changed = 0;
  state.Messages = state.Messages.flatMap((message) => {
    if (
      message.role !== "user" ||
      message.name !== "opencat_context" ||
      typeof message.content !== "string"
    ) {
      return [message];
    }

    const content = stripVolatileContextBlocks(message.content);
    if (content === message.content) {
      return [message];
    }

    changed++;
    if (!content.includes("<context_block source=")) {
      return [];
    }

    return [{ ...message, content }];
  });
  return changed;
}

function stripVolatileContextBlocks(content: string): string {
  return content
    .replace(
      /(?:\r?\n)?<context_block source="dynamic_skill">[\s\S]*?<\/context_block>(?:\r?\n)?/g,
      "\n",
    )
    .replace(
      /(?:\r?\n)?<context_block source="todo_list">[\s\S]*?<\/context_block>(?:\r?\n)?/g,
      "\n",
    )
    .replace(
      /(?:\r?\n)?<context_block source="plan_mode">[\s\S]*?<\/context_block>(?:\r?\n)?/g,
      "\n",
    )
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n<\/opencat_context>/, "\n</opencat_context>");
}

function shouldAttachLongTermMemory(state: State): boolean {
  const lastMessage = state.Messages.at(-1);
  return lastMessage?.role === "user" && lastMessage.source === "user";
}

type AutoCompressionRequest = {
  reason: "context_size";
  snippedContentThroughMessageId?: SnippedContentOnlyStats["lastMessageId"];
};

async function applyAutoCompressionWithTelemetry(
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

function getAutoCompressionRequest(
  runtime: Runtime,
  state: State,
  messagesForQuery: MessagesForQuery,
): AutoCompressionRequest | null {
  if (!canRuntimeAutoCompress(runtime)) {
    return null;
  }

  if (estimateMessagesForQueryTokens(messagesForQuery) < getAutoCompressTriggerTokens()) {
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

function estimateMessagesForQueryTokens(messagesForQuery: MessagesForQuery): number {
  return Math.ceil(JSON.stringify(messagesForQuery.messages).length / 4);
}

function getAutoCompressTriggerTokens(): number {
  const configured = Number(
    process.env.OPENCAT_AUTO_COMPRESS_TRIGGER_TOKENS,
  );

  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return DEFAULT_AUTO_COMPRESS_TRIGGER_TOKENS;
}

function throwIfQueryAborted(runtime: Runtime): void {
  runtime.toolUseContext.abortController.signal.throwIfAborted();
}

async function emitLongTermMemoryExtractionEvent(
  runtime: Runtime,
  result: LongTermMemoryExtractionResult,
): Promise<void> {
  await emitRunEvent(runtime, {
    type: "long_term_memory_extracted",
    status: result.status,
    count: result.status === "extracted" ? result.count : undefined,
    source: result.status === "extracted" ? result.source : undefined,
    reason: result.status === "skipped" || result.status === "failed"
      ? result.reason
      : undefined,
  });
}

function getAssistantTextChars(message: DeepSeekAssistantMessage): number {
  return typeof message.content === "string" ? message.content.length : 0;
}

function hasTaggedMessage(
  messagesForQuery: MessagesForQuery,
  tag: string,
): boolean {
  return messagesForQuery.messages.some((message) =>
    getDeepSeekMessageText(message).includes(tag)
  );
}

function getDeepSeekMessageText(
  message: MessagesForQuery["messages"][number],
): string {
  if (message.role === "assistant") {
    return typeof message.content === "string" ? message.content : "";
  }

  return message.content;
}

function preview(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...`;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
