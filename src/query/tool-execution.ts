/** 工具回合执行：并发安全工具成批运行，写入 State、transcript 和事件时保持模型调用顺序。 */
import type { ModelToolCall } from "../openai-compatible/types.js";
import { createMessage, toModelMessage, type ToolMessage } from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import type { ToolCallExecutionResult } from "../Tools/executor.js";
import { recordTranscriptMessage } from "../transcript/persistence.js";
import { emitRunEvent } from "../telemetry/observer.js";
import type { QueryEvent, QueryOptions } from "./types.js";
import {
  requestToolApprovalIfNeeded,
  executeToolAfterPermissionDecision,
  type PendingToolApproval,
} from "./tool-permissions.js";

/** 按模型给出的顺序划分执行批次，返回已持久化的工具消息供回合摘要使用。 */
export async function* executeToolCallsForTurn(
  runtime: Runtime,
  state: State,
  options: QueryOptions,
  turn: number,
  toolCalls: readonly ModelToolCall[],
): AsyncGenerator<QueryEvent, ToolMessage[], void> {
  const results: ToolMessage[] = [];
  for (const batch of partitionToolCallsForExecution(runtime, toolCalls)) {
    const batchResults = yield* executeToolCallBatch(runtime, state, options, turn, batch);
    results.push(...batchResults);
  }
  return results;
}

type ToolCallExecutionBatch = {
  concurrencySafe: boolean;
  toolCalls: ModelToolCall[];
};

type PreparedToolCallExecution = {
  toolCall: ModelToolCall;
  startedAt: number;
  permissionApproval: PendingToolApproval | null;
};

type CompletedToolCallExecution = {
  toolCall: ModelToolCall;
  startedAt: number;
  finishedAt: number;
  execution: ToolCallExecutionResult;
};

function partitionToolCallsForExecution(
  runtime: Runtime,
  toolCalls: readonly ModelToolCall[],
): ToolCallExecutionBatch[] {
  const batches: ToolCallExecutionBatch[] = [];

  // 只有相邻的安全工具才能合批；不安全工具构成串行边界，后面的调用不能越过它。
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
  toolCall: ModelToolCall,
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
    runtime.toolUseContext.abortController.signal.throwIfAborted();
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
    if (permissionApproval) {
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

  // Promise.all 保留输入顺序：工具可以先完成，但消息、持久化和事件仍按模型调用顺序写入。
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

    runtime.toolUseContext.abortController.signal.throwIfAborted();
    state.Messages.push(stateToolResultMessage);
    persistedToolResultMessages.push(stateToolResultMessage);
    await recordTranscriptMessage(runtime, stateToolResultMessage);
    yield {
      type: "tool_result",
      toolCall,
      message: toModelMessage(stateToolResultMessage),
      succeeded: completed.execution.succeeded,
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
    runtime.toolUseContext.abortController.signal.throwIfAborted();
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

function preview(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...`;
}
