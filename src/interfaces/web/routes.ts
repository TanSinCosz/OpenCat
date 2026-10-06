/** HTTP 路由表：校验输入、选择服务、输出响应；会话切换集中交给 manager。 */
import type { RequestListener } from "node:http";
import { createSweBenchSessionId, getSweWorkspaceStatus } from "../../swe/workspace.js";
import {
  applyWorkspacePatchSnapshot,
  approveWorkspacePatchSnapshot,
  getWorkspacePatchDiff,
  getWorkspacePatchDeltaDiff,
  getWorkspacePatchDeltaSummary,
  getWorkspacePatchSummary,
  revertWorkspacePatch,
  saveWorkspacePatchSnapshot,
} from "../../workspace/patch-snapshot.js";
import { sendHtml, sendJson, sendText, readJsonBody, stringifyError } from "./http.js";
import { listMainTranscriptSessions, hasMainTranscriptSession } from "./transcript-index.js";
import {
  listSweBenchItems,
  findSweBenchInstance,
  resolveSweDatasetDirectoryForSession,
  createSweWorkspaceOptions,
  isUsableSweWorkspaceStatus,
} from "./swe-dataset.js";
import { parseSweDraftKind, buildSweDraftPrompt } from "./swe-prompts.js";
import { getCurrentSweSessionInfo, exportCurrentSwePatch } from "./swe-patch.js";
import { MAX_SESSION_HISTORY_MESSAGES, normalizeSessionHistoryMessage } from "./presentation.js";
import { resolveSessionRuntimeCwd, type WebSessionManager } from "./session-manager.js";
import { handleQuery, stopActiveQuery } from "./query-handler.js";
import { handleToolPermissionResponse } from "./tool-permissions.js";

export function createWebRequestHandler(sessions: WebSessionManager): RequestListener {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/") {
        sendHtml(response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/session") {
        const sweSessionInfo = await getCurrentSweSessionInfo(sessions.current);
        sendJson(response, {
          sessionId: sessions.current.runtime.sessionId,
          model: sessions.current.runtime.modelRuntimeConfig.model,
          messageCount: sessions.current.state.Messages.length,
          tools: sessions.current.runtime.tools.map((tool) => tool.name),
          usage: sessions.current.runtime.usage,
          busy: sessions.current.busy,
          restored: sessions.current.loadInfo.restored,
          hydrate: sessions.current.loadInfo.hydrate,
          transcriptPath: sessions.current.loadInfo.transcriptPath,
          cwd: sessions.current.runtime.cwd,
          swe: sweSessionInfo,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/sessions") {
        sendJson(response, {
          sessions: await listMainTranscriptSessions(process.cwd()),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/swe/items") {
        sendJson(response, {
          items: await listSweBenchItems(
            process.cwd(),
            url.searchParams.get("datasetDir") ?? undefined,
          ),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/swe/prompt") {
        const instanceId = url.searchParams.get("instanceId")?.trim() ?? "";
        const kind = parseSweDraftKind(url.searchParams.get("kind"));
        const instance = await findSweBenchInstance(
          process.cwd(),
          instanceId,
          url.searchParams.get("datasetDir") ?? undefined,
        );
        if (!instance) {
          sendJson(response, { error: "SWE item not found." }, 404);
          return;
        }

        sendJson(response, {
          instanceId,
          kind,
          prompt: buildSweDraftPrompt(instance, kind),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/swe/session") {
        const body = await readJsonBody<{
          instanceId?: unknown;
          datasetDir?: unknown;
        }>(request);
        const instanceId = typeof body.instanceId === "string"
          ? body.instanceId.trim()
          : "";
        const datasetDir = typeof body.datasetDir === "string"
          ? body.datasetDir.trim()
          : undefined;
        const instance = await findSweBenchInstance(
          process.cwd(),
          instanceId,
          datasetDir,
        );
        if (!instance) {
          sendJson(response, { error: "SWE item not found." }, 404);
          return;
        }

        const datasetDirectory = resolveSweDatasetDirectoryForSession(
          process.cwd(),
          "",
          datasetDir,
        );
        const workspaceOptions = await createSweWorkspaceOptions(
          process.cwd(),
        );
        const sessionId = createSweBenchSessionId(
          instance.instance_id,
          workspaceOptions.workspaceNamespace,
        );
        const workspace = await getSweWorkspaceStatus(instance, workspaceOptions);
        const workspacePath = isUsableSweWorkspaceStatus(workspace.status)
          ? workspace.path
          : undefined;

        const existed = await hasMainTranscriptSession(process.cwd(), sessionId);
        await sessions.replace({
          sessionId,
          resume: existed,
          cwd: workspacePath ?? process.cwd(),
          sweDatasetDir: datasetDirectory,
        });

        sendJson(response, {
          ok: true,
          sessionId: sessions.current.runtime.sessionId,
          existed,
          workspaceReady: Boolean(workspacePath),
          datasetDir: datasetDirectory,
          messageCount: sessions.current.state.Messages.length,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/session/messages") {
        const messages = sessions.current.state.Messages.slice(-MAX_SESSION_HISTORY_MESSAGES)
          .map(normalizeSessionHistoryMessage)
          .filter((message) => message !== null);
        sendJson(response, {
          messages,
          total: sessions.current.state.Messages.length,
          truncated: sessions.current.state.Messages.length > MAX_SESSION_HISTORY_MESSAGES,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/query") {
        await handleQuery(sessions, request, response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/query/stop") {
        stopActiveQuery(sessions.current, "Stopped from the web UI.");
        sendJson(response, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tool-permission") {
        await handleToolPermissionResponse(sessions.current, request, response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/swe/patch") {
        sendJson(response, await exportCurrentSwePatch(sessions.current));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/patch/current") {
        sendJson(response, await getWorkspacePatchDiff(sessions.current.runtime));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/patch/summary") {
        sendJson(response, await getWorkspacePatchSummary(sessions.current.runtime));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/patch/turn/current") {
        sendJson(
          response,
          await getWorkspacePatchDeltaDiff(sessions.current.runtime, sessions.current.patchBaseline),
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/patch/turn/summary") {
        sendJson(
          response,
          await getWorkspacePatchDeltaSummary(sessions.current.runtime, sessions.current.patchBaseline),
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/patch/snapshot") {
        sendJson(response, await saveWorkspacePatchSnapshot(sessions.current.runtime, "manual"));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/patch/approve") {
        sendJson(response, await approveWorkspacePatchSnapshot(sessions.current.runtime));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/patch/apply") {
        const body = await readJsonBody<{ source?: unknown }>(request);
        const source = body.source === "approved" ? "approved" : "latest";
        sendJson(response, await applyWorkspacePatchSnapshot(sessions.current.runtime, source));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/patch/revert") {
        sendJson(response, await revertWorkspacePatch(sessions.current.runtime));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session/load") {
        const body = await readJsonBody<{ sessionId?: unknown }>(request);
        const sessionId = typeof body.sessionId === "string"
          ? body.sessionId.trim()
          : "";
        const available = await listMainTranscriptSessions(process.cwd());

        if (!available.some((candidate) => candidate.sessionId === sessionId)) {
          sendJson(response, { error: "Session transcript not found." }, 404);
          return;
        }

        const runtimeCwd = await resolveSessionRuntimeCwd(sessionId);

        await sessions.replace({
          sessionId,
          resume: true,
          cwd: runtimeCwd ?? process.cwd(),
        });
        sendJson(response, {
          ok: true,
          sessionId: sessions.current.runtime.sessionId,
          workspaceReady: Boolean(runtimeCwd),
          messageCount: sessions.current.state.Messages.length,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reset") {
        await sessions.reset();
        sendJson(response, { ok: true, sessionId: sessions.current.runtime.sessionId });
        return;
      }

      sendText(response, 404, "Not found");
    } catch (error) {
      sendJson(response, {
        error: stringifyError(error),
      }, 500);
    }
  };
}
