/** Query 的计划审批与临时命令授权边界；普通工具校验仍由 Tools/executor.ts 负责。 */
import { randomUUID } from "node:crypto";
import type { ModelToolCall } from "../openai-compatible/types.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import { PLAN_TOOL_NAME } from "../Tools/Plan/prompt.js";
import {
  createPermissionDeniedToolCallResult,
  executeToolCallWithMetadata,
  getPlanModeToolDenialReason,
  type ToolCallExecutionResult,
} from "../Tools/executor.js";
import { emitRunEvent } from "../telemetry/observer.js";
import type { QueryOptions, ToolApprovalDecision } from "./types.js";

export type PendingToolApproval = {
  approvalId: string;
  reason: string;
  decision: Promise<ToolApprovalDecision>;
};

export function clearTemporaryCommandAllowRules(runtime: Runtime): void {
  // command 授权只覆盖当前查询；session 等更长生命周期的规则继续保留。
  const permissions = runtime.toolUseContext.permissionContext;
  if (!permissions.alwaysAllowRules.command?.length) {
    return;
  }

  const { command: _command, ...remainingAllowRules } = permissions.alwaysAllowRules;
  runtime.toolUseContext.permissionContext = {
    ...permissions,
    alwaysAllowRules: remainingAllowRules,
  };
}

export async function requestToolApprovalIfNeeded(
  runtime: Runtime,
  state: State,
  options: QueryOptions,
  toolCall: ModelToolCall,
): Promise<PendingToolApproval | null> {
  if (!isPlanApprovalToolCall(toolCall, state)) {
    return null;
  }

  const approvalId = `tool_permission_${randomUUID()}`;
  const reason = getPlanApprovalRequestReason(toolCall);
  // 此处只启动审批，不能等待结果：调用方须先 yield 审批事件，界面才能显示并回复。
  const decision = options.requestToolPermission
    ? options.requestToolPermission({
      approvalId,
      toolCall,
      mode: "plan",
      reason,
    }).catch((error): ToolApprovalDecision => ({
      behavior: "deny",
      reason: `Permission request failed: ${stringifyError(error)}`,
    }))
    : Promise.resolve({
      behavior: "deny",
      reason: "No interactive permission handler is available.",
    } satisfies ToolApprovalDecision);

  await emitRunEvent(runtime, {
    type: "tool_permission_requested",
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    mode: "plan",
  });

  return {
    approvalId,
    reason,
    decision,
  };
}

function isPlanApprovalToolCall(
  toolCall: ModelToolCall,
  state: State,
): boolean {
  if (state.mode !== "plan" || toolCall.function.name !== PLAN_TOOL_NAME) {
    return false;
  }

  return parsePlanToolAction(toolCall) === "request_approval";
}

function parsePlanToolAction(toolCall: ModelToolCall): string | null {
  try {
    const input = JSON.parse(toolCall.function.arguments || "{}") as {
      action?: unknown;
    };
    return typeof input.action === "string" ? input.action : null;
  } catch {
    return null;
  }
}

function getPlanApprovalRequestReason(toolCall: ModelToolCall): string {
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

export async function executeToolAfterPermissionDecision(
  runtime: Runtime,
  state: State,
  toolCall: ModelToolCall,
  decision: ToolApprovalDecision | null,
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

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
