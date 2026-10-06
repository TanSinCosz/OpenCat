/** 看板浏览器交互脚本；由 page.ts 内联组装，保留模板字符串转义。 */
import path from "node:path";
import type { DashboardOptions } from "./options.js";

export function renderDashboardScript(options: DashboardOptions): string {
  const { workspaceRoot, evalRoot, webChatUrl } = options;
  return `
    const state = { runs: [], detail: null, selectedCase: "", sideView: "conversation" };
    const dashboardDatasetDir = ${JSON.stringify(path.relative(workspaceRoot, evalRoot).replace(/\\/g, "/"))};
    const $ = (id) => document.getElementById(id);
    const fmt = new Intl.NumberFormat();
    const pct = (value) => Number.isFinite(value) ? Math.round(value * 1000) / 10 + "%" : "0%";
    const compact = (value) => {
      if (!Number.isFinite(value)) return "0";
      if (Math.abs(value) >= 1_000_000) return (value / 1_000_000).toFixed(1) + "m";
      if (Math.abs(value) >= 1_000) return (value / 1_000).toFixed(1) + "k";
      return String(value);
    };

    $("refreshButton").addEventListener("click", loadRuns);
    $("runSelect").addEventListener("change", () => loadRun($("runSelect").value));
    $("prepareAllButton").addEventListener("click", prepareAllRepos);
    $("loadEventsButton").addEventListener("click", loadEvents);
    $("conversationTab").addEventListener("click", async () => {
      state.sideView = "conversation";
      renderSideView();
      await loadConversation();
    });
    $("eventsTab").addEventListener("click", async () => {
      state.sideView = "events";
      renderSideView();
      await loadEvents();
    });

    loadRuns();

    async function loadRuns() {
      renderDashboardLoading("Loading SWE eval data...");
      try {
        state.runs = await fetchJson("/api/runs");
        $("runSelect").innerHTML = state.runs
          .map((run) => '<option value="' + escapeHtml(run.name) + '">[' + escapeHtml(run.version || "v1") + '] ' + escapeHtml(run.name) + '</option>')
          .join("");
        if (state.runs[0]) {
          await loadRun(state.runs[0].name);
        } else {
          renderDashboardError("No SWE eval runs or dataset found.");
        }
      } catch (error) {
        renderDashboardError(error.message || String(error));
      }
    }

    function openSweChatSession(instanceId) {
      if (!instanceId) return;
      const datasetDir = state.detail?.run?.evalRoot || dashboardDatasetDir;
      window.location.href = ${JSON.stringify(webChatUrl)} +
        "/?swe=" + encodeURIComponent(instanceId) +
        "&draft=investigate&datasetDir=" + encodeURIComponent(datasetDir);
    }

    async function copyPromptForItem(item, kind) {
      const prompt = buildSwePrompt(item, kind);
      try {
        await navigator.clipboard.writeText(prompt);
      } catch (error) {
        window.prompt("Copy this prompt:", prompt);
      }
    }

    function buildSwePrompt(item, kind) {
      if (kind === "investigate") {
        return buildSweInvestigatePrompt(item);
      }
      if (kind === "fix") {
        return buildSweFixPrompt(item);
      }

      const lines = [
        "You are working on a SWE-bench issue in OpenCat.",
        "Modify the checked-out repository to fix the issue. Prefer minimal, well-tested changes.",
        "Use the available tools to inspect, edit, and verify the code.",
        "Do not fetch unrelated web content unless the repository itself requires it.",
        "Before editing, inspect the relevant files in the workspace. After editing, run the most relevant tests you can.",
        "",
        "<swe_task>",
        "<instance_id>" + (item.instanceId || "") + "</instance_id>",
        "<repo>" + (item.repo || "") + "</repo>",
        "",
        "<problem_statement>",
        item.problemStatement || item.problemPreview || "",
        "</problem_statement>",
        item.hintsText ? "\\n<hints_text>\\n" + item.hintsText + "\\n</hints_text>" : "",
        kind === "debug" && item.testPatch ? "\\n<debug_test_patch>\\n" + item.testPatch + "\\n</debug_test_patch>" : "",
        "</swe_task>",
      ];
      return lines.filter((line) => line !== "").join("\\n");
    }

    function buildSweInvestigatePrompt(item) {
      return [
        "You are working on a SWE-bench issue in OpenCat.",
        "First investigate only. Do not modify files yet. Do not call Edit or Write.",
        "Read the issue, inspect the checked-out repository, identify the likely root cause, and explain the smallest code change you would make next.",
        "Use tools to inspect relevant files. Do not fetch unrelated web content unless the repository itself requires it.",
        "End with a concise investigation summary: root cause, relevant files/functions, proposed fix, and tests to run.",
        "",
        "<swe_task>",
        "<instance_id>" + (item.instanceId || "") + "</instance_id>",
        "<repo>" + (item.repo || "") + "</repo>",
        "",
        "<problem_statement>",
        item.problemStatement || item.problemPreview || "",
        "</problem_statement>",
        item.hintsText ? "\\n<hints_text>\\n" + item.hintsText + "\\n</hints_text>" : "",
        "</swe_task>",
      ].filter((line) => line !== "").join("\\n");
    }

    function buildSweFixPrompt(item) {
      return [
        "Based on the investigation from the previous turn, implement the smallest correct fix now.",
        "Modify only the checked-out SWE workspace for this item. Re-read any file you edit before changing it.",
        "After editing, run the most relevant tests you can. If tests cannot run, explain exactly why and what you verified instead.",
        "Finish with a concise summary of changed files, the behavior fixed, and verification results.",
        "",
        "<swe_task_followup>",
        "<instance_id>" + (item.instanceId || "") + "</instance_id>",
        "</swe_task_followup>",
      ].filter((line) => line !== "").join("\\n");
    }

    async function loadRun(name) {
      renderDashboardLoading("Loading " + name + "...");
      try {
        state.detail = await fetchJson("/api/run?name=" + encodeURIComponent(name));
        state.selectedCase = state.detail.datasetItems[0]?.instanceId || state.detail.cases[0]?.caseId || "";
        $("versionBadge").textContent = state.detail.version || "v1";
        $("runMeta").textContent = state.detail.run.path;
        renderCards(state.detail.totals, state.detail.cases.length, state.detail.version);
        renderConfig(state.detail.config || {}, state.detail.version);
        renderItems(state.detail.datasetItems || []);
        renderSelectedItemDetails();
      } catch (error) {
        renderDashboardError(error.message || String(error));
      }
    }

    function renderDashboardLoading(message) {
      $("cards").innerHTML = "";
      $("configGrid").innerHTML = '<div class="config-item"><div class="config-key">loading</div><div class="config-value">' + escapeHtml(message) + '</div></div>';
      $("datasetMeta").textContent = "";
      $("itemMeta").textContent = "";
      $("itemRows").innerHTML = '<tr><td colspan="8" class="muted">' + escapeHtml(message) + '</td></tr>';
    }

    function renderDashboardError(message) {
      $("cards").innerHTML = "";
      $("configGrid").innerHTML = '<div class="config-item"><div class="config-key">error</div><div class="config-value">' + escapeHtml(message) + '</div></div>';
      $("datasetMeta").textContent = "failed";
      $("itemMeta").textContent = "";
      $("itemRows").innerHTML = '<tr><td colspan="8" class="muted">' + escapeHtml(message) + '</td></tr>';
      $("conversationBox").innerHTML = '<div class="bubble system"><div class="bubble-head"><span>error</span></div><div class="bubble-body">' + escapeHtml(message) + '</div></div>';
    }

    function renderCards(totals, caseCount, version) {
      const cards = [
        ["Cases", caseCount, "instances"],
        ["Cache Hit", pct(totals.cacheHitRate), compact(totals.promptCacheMissTokens) + " miss"],
        ["Total Tokens", compact(totals.totalTokens), compact(totals.promptTokens) + " prompt"],
        ["Max Context", compact(totals.maxEstimatedTokens), "estimated tokens"],
        ["Tool Calls", compact(totals.toolCallCount), topTools(totals.toolCounts, 2)],
      ];
      $("cards").innerHTML = cards.map(([label, value, sub]) =>
        '<div class="card"><div class="label">' + escapeHtml(label) + '</div><div class="value">' +
        escapeHtml(String(value)) + '</div><div class="sub">' + escapeHtml(String(sub)) + '</div></div>'
      ).join("");
    }

    function renderConfig(config, version) {
      const keys = [
        "version",
        "datasetSource",
        "datasetPath",
        "datasetSplit",
        "autoPrepareDataset",
        "limit",
        "userRounds",
        "model",
        "allowWebTools",
        "allowNetworkClone",
        "reposDir",
        "python",
      ];
      $("configGrid").innerHTML = keys.map((key) => {
        const value = key === "version" ? (version || config.version || config.evalVersion || "v1") : config[key];
        return '<div class="config-item"><div class="config-key">' + escapeHtml(key) + '</div><div class="config-value" title="' +
          escapeHtml(value ?? "") + '">' + escapeHtml(value ?? "-") + '</div></div>';
      }).join("");
    }

    function renderItems(items) {
      const testedCount = items.filter((item) => item.tested).length;
      $("datasetMeta").textContent = items.length ? items.length + " dataset items" : "no dataset loaded";
      $("itemMeta").textContent = testedCount + " tested / " + Math.max(0, items.length - testedCount) + " pending";
      $("itemRows").innerHTML = items.map((item) => {
        const cache = item.tested && Number.isFinite(item.cacheHitRate) ? pct(item.cacheHitRate) : "-";
        const tokenText = item.tested ? compact(item.totalTokens || 0) : "-";
        const workspaceStatus = item.workspace && item.workspace.status ? item.workspace.status : "missing";
        return '<tr data-instance="' + escapeHtml(item.instanceId) + '" class="' +
          (item.instanceId === state.selectedCase ? "selected" : "") + '">' +
          '<td><span class="case-id">' + escapeHtml(item.instanceId) + '</span><br><span class="muted">' + escapeHtml(item.repo || "") + '</span></td>' +
          '<td><span class="status-pill ' + repoStatusClass(workspaceStatus) + '">' + escapeHtml(workspaceStatus) + '</span><br>' +
          '<button type="button" class="open-chat" data-prepare-repo="' + escapeHtml(item.instanceId) + '">Prepare</button></td>' +
          '<td><span class="status-pill ' + (item.tested ? "tested" : "untested") + '">' + (item.tested ? "tested" : "untested") + '</span></td>' +
          '<td>' + escapeHtml(item.status || "-") + '</td>' +
          '<td>' + escapeHtml(cache) + '</td>' +
          '<td>' + escapeHtml(tokenText) + '</td>' +
          '<td class="problem-preview">' + escapeHtml(item.problemPreview || "-") + '</td>' +
          '<td><button type="button" class="open-chat" data-open-session="' + escapeHtml(item.instanceId) + '">Open</button></td>' +
          '</tr>';
      }).join("");

      document.querySelectorAll("button[data-prepare-repo]").forEach((button) => {
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          await prepareRepo(button.getAttribute("data-prepare-repo"), button);
        });
      });

      document.querySelectorAll("button[data-open-session]").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          openSweChatSession(button.getAttribute("data-open-session"));
        });
      });

      document.querySelectorAll("tr[data-instance]").forEach((row) => {
        row.addEventListener("click", () => {
          const instanceId = row.getAttribute("data-instance");
          state.selectedCase = instanceId;
          renderItems(state.detail.datasetItems || []);
          renderSelectedItemDetails();
        });
      });
    }

    function renderSelectedItemDetails() {
      if (!state.detail || !state.selectedCase) return;
      const item = (state.detail.datasetItems || []).find((candidate) => candidate.instanceId === state.selectedCase);
      if (!item) {
        $("conversationBox").innerHTML = '<div class="bubble system"><div class="bubble-head"><span>item</span></div><div class="bubble-body">No dataset item selected.</div></div>';
        return;
      }

      state.sideView = "conversation";
      renderSideView();
      const sections = [
        ["instance_id", item.instanceId],
        ["repo", item.repo || ""],
        ["base_commit", item.baseCommit || ""],
        ["workspace_status", item.workspace ? item.workspace.status : "missing"],
        ["workspace_path", item.workspace ? item.workspace.path : ""],
        ["repo_cache_path", item.workspace && item.workspace.repoCachePath ? item.workspace.repoCachePath : ""],
        ["workspace_error", item.workspace && item.workspace.error ? item.workspace.error : ""],
        ["status", item.tested ? (item.status || "tested") : "untested"],
        ["problem_statement", item.problemStatement || item.problemPreview || ""],
        ["hints_text", item.hintsText || ""],
        ["test_patch", item.testPatch || ""],
      ].filter(([, value]) => value);

      $("conversationBox").innerHTML = '<article class="bubble system">' +
        '<div class="bubble-head"><span>dataset item</span><span>' + escapeHtml(item.instanceId) + '</span></div>' +
        '<div class="item-actions">' +
        '<button type="button" class="open-chat" id="copyPromptButton">Copy Prompt</button>' +
        '<button type="button" class="open-chat" id="copyInvestigatePromptButton">Copy Investigate Prompt</button>' +
        '<button type="button" class="open-chat" id="copyFixPromptButton">Copy Fix Prompt</button>' +
        '<button type="button" class="open-chat" id="copyDebugPromptButton">Copy Debug Prompt</button>' +
        '<button type="button" class="open-chat" id="exportPatchButton">Export Patch</button>' +
        '<button type="button" class="open-chat" id="openSelectedSweChatButton">Open Chat</button>' +
        '</div>' +
        sections.map(([label, value]) =>
          '<div class="bubble-body"><strong>' + escapeHtml(label) + '</strong><pre>' +
          escapeHtml(String(value)) + '</pre></div>'
        ).join("") +
        '</article>';
      $("copyPromptButton").addEventListener("click", () => copyPromptForItem(item, "standard"));
      $("copyInvestigatePromptButton").addEventListener("click", () => copyPromptForItem(item, "investigate"));
      $("copyFixPromptButton").addEventListener("click", () => copyPromptForItem(item, "fix"));
      $("copyDebugPromptButton").addEventListener("click", () => copyPromptForItem(item, "debug"));
      $("exportPatchButton").addEventListener("click", () => exportPatchForItem(item));
      $("openSelectedSweChatButton").addEventListener("click", () => openSweChatSession(item.instanceId));
    }

    function renderSideView() {
      const showingConversation = state.sideView === "conversation";
      $("conversationTab").classList.toggle("active", showingConversation);
      $("eventsTab").classList.toggle("active", !showingConversation);
      $("conversationBox").hidden = !showingConversation;
      $("eventsBox").hidden = showingConversation;
      $("sideTitle").textContent = showingConversation ? "Conversation: " + (state.selectedCase || "") : "Events: " + (state.selectedCase || "");
    }

    async function loadConversation() {
      if (!state.detail || !state.selectedCase) return;
      state.sideView = "conversation";
      renderSideView();
      const data = await fetchJson("/api/conversation?run=" + encodeURIComponent(state.detail.run.name) +
        "&case=" + encodeURIComponent(state.selectedCase) + "&limit=180");
      if (data.messages && data.messages.length) {
        $("conversationBox").innerHTML = data.messages.map(renderMessage).join("");
        return;
      }
      $("conversationBox").innerHTML = '<div class="bubble system"><div class="bubble-head"><span>fallback</span></div><div class="bubble-body">No transcript found. Showing event timeline in the Events tab.</div></div>';
      if (data.fallbackEvents && data.fallbackEvents.length) {
        $("eventsBox").textContent = data.fallbackEvents.map((event) => JSON.stringify(event, null, 2)).join("\\n\\n");
      }
    }

    async function loadEvents() {
      if (!state.detail || !state.selectedCase) return;
      state.sideView = "events";
      renderSideView();
      const data = await fetchJson("/api/events?run=" + encodeURIComponent(state.detail.run.name) +
        "&case=" + encodeURIComponent(state.selectedCase) + "&limit=120");
      $("eventsBox").textContent = data.events.map((event) => JSON.stringify(event, null, 2)).join("\\n\\n");
    }

    function renderMessage(message) {
      const role = String(message.role || "unknown").toLowerCase();
      const content = message.content || "";
      const meta = [
        message.toolName ? "tool: " + message.toolName : "",
        message.agentId && message.agentId !== "main" ? message.agentId : "",
        message.createdAt ? new Date(message.createdAt).toLocaleTimeString() : "",
      ].filter(Boolean).join(" · ");
      const usage = message.usage
        ? '<div class="usage-line">' + compact(message.usage.totalTokens) + ' tok · ' +
          compact(message.usage.promptTokens) + ' prompt · ' +
          pct(message.usage.cacheHitRate) + ' hit · ' +
          compact(message.usage.cacheMissTokens) + ' miss</div>'
        : "";
      const reasoning = message.reasoning
        ? '<details class="reasoning"><summary>' + compact(message.reasoning.length) + ' reasoning chars</summary><div class="bubble-body">' + escapeHtml(message.reasoning) + '</div></details>'
        : "";
      const toolCalls = message.toolCallCount
        ? '<div class="usage-line">tool calls: ' + message.toolCallCount + '</div>'
        : "";
      return '<article class="bubble ' + escapeHtml(role) + '">' +
        '<div class="bubble-head"><span>' + escapeHtml(role) + '</span><span>' + escapeHtml(meta) + '</span></div>' +
        '<div class="bubble-body">' + escapeHtml(content || "(empty)") + '</div>' +
        reasoning + toolCalls + usage +
        '</article>';
    }

    function topTools(toolCounts, limit) {
      return Object.entries(toolCounts || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([name, count]) => name + " " + count)
        .join(", ") || "-";
    }

    async function fetchJson(url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    async function prepareRepo(instanceId, button) {
      if (!instanceId) return;
      const previousSelection = state.selectedCase;
      if (button) {
        button.disabled = true;
        button.textContent = "Preparing";
      }
      try {
        const result = await postJson("/api/prepare-repo", {
          instanceId: instanceId,
          datasetDir: state.detail?.run?.evalRoot || dashboardDatasetDir,
        });
        if (result && result.status === "failed") {
          alert("Prepare failed: " + (result.error || "unknown error"));
        }
        if (state.detail) {
          await loadRun(state.detail.run.name);
          state.selectedCase = previousSelection || instanceId;
          renderItems(state.detail.datasetItems || []);
          renderSelectedItemDetails();
        }
      } catch (error) {
        alert("Prepare failed: " + error.message);
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = "Prepare";
        }
      }
    }

    async function prepareAllRepos() {
      const button = $("prepareAllButton");
      const previousSelection = state.selectedCase;
      button.disabled = true;
      button.textContent = "Preparing...";
      try {
        const result = await postJson(
          "/api/prepare-all-repos?datasetDir=" + encodeURIComponent(
            state.detail?.run?.evalRoot || dashboardDatasetDir,
          ),
          {},
        );
        const failures = (result.results || []).filter((item) => item && item.status === "failed");
        if (failures.length > 0) {
          alert("Prepare all completed with " + failures.length + " failure(s). First error: " + (failures[0].error || "unknown error"));
        }
        if (state.detail) {
          await loadRun(state.detail.run.name);
          state.selectedCase = previousSelection;
          renderItems(state.detail.datasetItems || []);
          renderSelectedItemDetails();
        }
      } catch (error) {
        alert("Prepare all failed: " + error.message);
      } finally {
        button.disabled = false;
        button.textContent = "Prepare All";
      }
    }

    async function exportPatchForItem(item) {
      if (!item || !item.instanceId) return;
      const button = $("exportPatchButton");
      const previousText = button ? button.textContent : "";
      if (button) {
        button.disabled = true;
        button.textContent = "Exporting";
      }
      try {
        const payload = await fetchJson(
          "/api/patch?instanceId=" + encodeURIComponent(item.instanceId) +
            "&datasetDir=" + encodeURIComponent(
              state.detail?.run?.evalRoot || dashboardDatasetDir,
            ),
        );
        if (!payload.ok) {
          alert(payload.error || "Export patch failed.");
          return;
        }
        if (payload.empty) {
          alert("No changes to export.");
          return;
        }
        if (payload.savedPath) {
          alert("Patch saved to:\\n" + payload.savedPath);
        } else {
          alert("Patch exported.");
        }
      } catch (error) {
        alert("Export patch failed: " + error.message);
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = previousText || "Export Patch";
        }
      }
    }

    function repoStatusClass(status) {
      if (status === "ready" || status === "failed" || status === "dirty" || status === "wrong-head") {
        return status;
      }
      return "untested";
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[ch]));
    }
  `;
}
