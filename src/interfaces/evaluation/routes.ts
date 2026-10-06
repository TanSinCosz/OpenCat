/** 看板路由表：解析输入、调用评测服务、输出响应，不直接处理文件和 Git。 */
import type { RequestListener } from "node:http";
import type { EvaluationService } from "../../evaluation/service.js";
import { sanitizeSegment, stringValue, stringifyError } from "../../evaluation/records.js";
import type { DashboardOptions } from "./options.js";
import { renderDashboardHtml } from "./page.js";
import { sendHtml, sendJson, sendText, readJsonBody } from "./http.js";

export function createDashboardRequestHandler(
  options: DashboardOptions,
  service: EvaluationService,
): RequestListener {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

      if (url.pathname === "/") {
        sendHtml(response, renderDashboardHtml(options));
        return;
      }

      if (url.pathname === "/api/runs") {
        sendJson(response, await service.listRuns());
        return;
      }

      if (url.pathname === "/api/run") {
        const run = await service.findRun(url.searchParams.get("name") ?? "");
        sendJson(response, await service.loadRunDetail(run));
        return;
      }

      if (url.pathname === "/api/events") {
        const run = await service.findRun(url.searchParams.get("run") ?? "");
        const caseId = sanitizeSegment(url.searchParams.get("case") ?? "");
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 80)));
        sendJson(response, await service.loadCaseEvents(run, caseId, limit));
        return;
      }

      if (url.pathname === "/api/conversation") {
        const run = await service.findRun(url.searchParams.get("run") ?? "");
        const caseId = sanitizeSegment(url.searchParams.get("case") ?? "");
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 160)));
        sendJson(response, await service.loadCaseConversation(run, caseId, limit));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/prepare-repo") {
        const body = await readJsonBody(request);
        const instanceId = stringValue(body.instanceId) ?? "";
        const instance = await service.findDatasetInstance(
          instanceId,
          stringValue(body.datasetDir),
        );
        if (!instance) {
          sendJson(response, { error: "SWE item not found." }, 404);
          return;
        }

        sendJson(response, await service.prepareRepoWorkspace(instance));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/prepare-all-repos") {
        const records = await service.loadDashboardDatasetRecords(
          url.searchParams.get("datasetDir") ?? undefined,
        );
        const results = [];
        for (const record of records) {
          results.push(await service.prepareRepoWorkspace(record));
        }
        sendJson(response, { results });
        return;
      }

      if (url.pathname === "/api/patch") {
        const instanceId = url.searchParams.get("instanceId") ?? "";
        const instance = await service.findDatasetInstance(
          instanceId,
          url.searchParams.get("datasetDir") ?? undefined,
        );
        if (!instance) {
          sendJson(response, { ok: false, error: "SWE item not found." }, 404);
          return;
        }

        sendJson(response, await service.exportRepoPatch(
          instance,
          url.searchParams.get("datasetDir") ?? undefined,
        ));
        return;
      }

      sendText(response, 404, "Not found");
    } catch (error) {
      sendJson(response, { error: stringifyError(error) }, 500);
    }
  };
}
