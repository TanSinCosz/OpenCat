/** Web 查询执行：流式响应、取消、断连处理与执行结束后的资源清理。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { query } from "../../query.js";
import { closeMcpConnections } from "../../mcp/index.js";
import { createMessage } from "../../types/messages.js";
import { recordTranscriptMessage } from "../../transcript/persistence.js";
import { captureWorkspacePatchBaseline } from "../../workspace/patch-snapshot.js";
import type { WebCliSession } from "./types.js";
import type { WebSessionManager } from "./session-manager.js";
import { readJsonBody, sendJson, writeEvent, stringifyError } from "./http.js";
import { normalizeQueryEvent } from "./presentation.js";
import {
  createToolPermissionRequestForSession,
  denyAllPendingToolApprovalsForSession,
} from "./tool-permissions.js";

export async function handleQuery(
  sessions: WebSessionManager,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // 固定本次请求的会话；浏览器切换会话后，后台查询仍写入原来的记录。
  const activeSession = sessions.current;
  if (activeSession.busy) {
    sendJson(response, { error: "A query is already running." }, 409);
    return;
  }

  const body = await readJsonBody<{ prompt?: unknown; includeRawEvents?: unknown }>(request);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  if (!prompt) {
    sendJson(response, { error: "Missing prompt." }, 400);
    return;
  }

  activeSession.busy = true;
  activeSession.clientAttached = true;
  activeSession.patchBaseline =
    await captureWorkspacePatchBaseline(activeSession.runtime);
  const previousAbortController = activeSession.runtime.toolUseContext.abortController;
  const queryAbortController = new AbortController();
  activeSession.activeQueryAbortController = queryAbortController;
  activeSession.runtime.toolUseContext.abortController = queryAbortController;

  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const markClientDetached = () => {
    if (!activeSession.clientAttached) {
      return;
    }

    // 断连只影响交互审批。查询继续执行，重开页面时可从 transcript 恢复进展。
    activeSession.clientAttached = false;
    denyAllPendingToolApprovalsForSession(
      activeSession,
      "Tool permission request was cancelled because the web client detached.",
    );
  };
  request.once("aborted", markClientDetached);
  response.once("close", markClientDetached);

  try {
    const userMessage = createMessage({
      role: "user",
      content: prompt,
    });
    activeSession.state.Messages.push(userMessage);
    await recordTranscriptMessage(activeSession.runtime, userMessage);

    writeEvent(response, {
      type: "user_message",
      id: userMessage.id,
      messageCount: activeSession.state.Messages.length,
    });

    for await (const event of query(activeSession.runtime, activeSession.state, {
      requestToolPermission: (toolRequest) =>
        createToolPermissionRequestForSession(activeSession, toolRequest),
    })) {
      const normalizedEvent = normalizeQueryEvent(
        event,
        Boolean(body.includeRawEvents),
      );

      if (normalizedEvent !== undefined) {
        writeEvent(response, normalizedEvent);
      }
    }
  } catch (error) {
    if (!queryAbortController.signal.aborted) {
      writeEvent(response, {
        type: "error",
        error: stringifyError(error),
      });
    }
  } finally {
    request.off("aborted", markClientDetached);
    response.off("close", markClientDetached);
    denyAllPendingToolApprovalsForSession(
      activeSession,
      "Query ended before the tool permission request was answered.",
    );
    activeSession.busy = false;
    activeSession.clientAttached = false;
    if (activeSession.activeQueryAbortController === queryAbortController) {
      activeSession.activeQueryAbortController = undefined;
    }
    activeSession.runtime.toolUseContext.abortController = previousAbortController;
    if (sessions.current !== activeSession) {
      closeMcpConnections(activeSession.runtime.mcpConnections);
    }
    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
  }
}

export function stopActiveQuery(session: WebCliSession, reason: string): void {
  const controller = session.activeQueryAbortController ??
    session.runtime.toolUseContext.abortController;
  if (!session.busy || controller.signal.aborted) {
    return;
  }

  controller.abort(new Error(reason));
  denyAllPendingToolApprovalsForSession(session, reason);
}
