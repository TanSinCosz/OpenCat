/** 每个会话独立的工具审批队列；浏览器断开或查询结束时结清待处理请求。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../query/types.js";
import type { WebCliSession } from "./types.js";
import { readJsonBody, sendJson } from "./http.js";

export async function handleToolPermissionResponse(
  session: WebCliSession,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody<{
    approvalId?: unknown;
    decision?: unknown;
  }>(request);
  const approvalId = typeof body.approvalId === "string"
    ? body.approvalId.trim()
    : "";
  const decision = body.decision === "allow" || body.decision === "deny"
    ? body.decision
    : "";

  if (!approvalId || !decision) {
    sendJson(response, { error: "Invalid tool permission response." }, 400);
    return;
  }

  const pending = session.pendingToolApprovals.get(approvalId);
  if (!pending) {
    sendJson(response, { error: "Tool permission request not found." }, 404);
    return;
  }

  clearTimeout(pending.timeout);
  session.pendingToolApprovals.delete(approvalId);
  pending.resolve(
    decision === "allow"
      ? { behavior: "allow" }
      : { behavior: "deny", reason: "Denied by user from the web UI." },
  );
  sendJson(response, { ok: true });
}

export function createToolPermissionRequestForSession(
  targetSession: WebCliSession,
  request: ToolApprovalRequest,
): Promise<ToolApprovalDecision> {
  if (!targetSession.clientAttached) {
    return Promise.resolve({
      behavior: "deny",
      reason: "Tool permission request cannot be approved because the web client is detached.",
    });
  }

  const existing = targetSession.pendingToolApprovals.get(request.approvalId);
  if (existing) {
    // 替换同 ID 的审批前必须结清旧 Promise，否则原工具调用会一直等待。
    clearTimeout(existing.timeout);
    targetSession.pendingToolApprovals.delete(request.approvalId);
    existing.resolve({
      behavior: "deny",
      reason: "Superseded by a newer tool permission request.",
    });
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      targetSession.pendingToolApprovals.delete(request.approvalId);
      resolve({
        behavior: "deny",
        reason: "Tool permission request timed out.",
      });
    }, 5 * 60 * 1000);

    targetSession.pendingToolApprovals.set(request.approvalId, {
      resolve,
      timeout,
    });
  });
}

export function denyAllPendingToolApprovalsForSession(
  targetSession: WebCliSession,
  reason: string,
): void {
  for (const [approvalId, pending] of targetSession.pendingToolApprovals) {
    clearTimeout(pending.timeout);
    pending.resolve({ behavior: "deny", reason });
    targetSession.pendingToolApprovals.delete(approvalId);
  }
}
