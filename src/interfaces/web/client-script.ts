/** Web 页面浏览器交互脚本；作为内联资源由 page.ts 组装，保留原有转义。 */


export const clientScript = `
    (function() {
      // --- Elements ---
      const chat = document.querySelector("#chat");
      const welcome = document.querySelector("#welcome");
      const events = document.querySelector("#events");
      const form = document.querySelector("#form");
      const promptInput = document.querySelector("#prompt");
      const sendButton = document.querySelector("#send");
      const stopButton = document.querySelector("#stop-btn");
      const rawInput = document.querySelector("#raw");
      const resetButton = document.querySelector("#reset-btn");
      const sessionList = document.querySelector("#session-list");
      const sweList = document.querySelector("#swe-list");
      const clearEventsButton = document.querySelector("#clear-events");
      const sidebarToggle = document.querySelector("#sidebar-toggle");
      const eventsToggle = document.querySelector("#events-toggle");
      const sidebar = document.querySelector("#sidebar");
      const eventsPanel = document.querySelector("#events-panel");
      const statusDot = document.querySelector("#status-dot");
      const statusText = document.querySelector("#status-text");
      const topbarInfo = document.querySelector("#topbar-info");
      const usageBadge = document.querySelector("#usage-badge");
      const projectionBadge = document.querySelector("#projection-badge");
      const charCount = document.querySelector("#char-count");
      const modelBadge = document.querySelector("#model-badge");
      const patchDiffButton = document.querySelector("#patch-diff-btn");
      const exportPatchButton = document.querySelector("#export-patch-btn");
      const patchModal = document.querySelector("#patch-modal");
      const patchModalTitle = document.querySelector("#patch-modal-title");
      const patchDiff = document.querySelector("#patch-diff");
      const patchStatus = document.querySelector("#patch-status");
      const patchPath = document.querySelector("#patch-path");
      const patchRefreshButton = document.querySelector("#patch-refresh-btn");
      const patchSaveButton = document.querySelector("#patch-save-btn");
      const patchApplyButton = document.querySelector("#patch-apply-btn");
      const patchRevertButton = document.querySelector("#patch-revert-btn");
      const patchApproveButton = document.querySelector("#patch-approve-btn");
      const patchCloseButton = document.querySelector("#patch-close-btn");
      const changeReviewCard = document.querySelector("#change-review-card");
      const changeReviewTitle = document.querySelector("#change-review-title");
      const changeReviewTotals = document.querySelector("#change-review-totals");
      const changeReviewFiles = document.querySelector("#change-review-files");
      const changeReviewDismiss = document.querySelector("#change-review-dismiss");
      const changeReviewOpen = document.querySelector("#change-review-open");
      const toast = document.querySelector("#toast");
      const refreshSessionsBtn = document.querySelector("#refresh-sessions");
      const refreshSweBtn = document.querySelector("#refresh-swe");

      const MAX_EVENT_NODES = 160;
      const MAX_EVENT_TEXT_CHARS = 12000;
      const EVENT_STORAGE_PREFIX = "opencat:web-cli:events:";
      const MAX_REASONING_RENDER_CHARS = 4000;
      const MAX_CHAR_WARN = 4000;

      let currentAssistant = null;
      let currentReasoning = null;
      let reasoningTextBuffer = "";
      let reasoningRenderFrame = 0;
      let assistantTextBuffer = "";
      let assistantRenderFrame = 0;
      let currentSessionId = "";
      let sweDatasetDir = new URLSearchParams(window.location.search).get("datasetDir") || "";
      let currentSweSession = null;
      let isBusy = false;
      let isSessionLoading = false;
      let abortController = null;
      let activeClientRequestId = 0;
      let latestUsage = null;
      let currentQueryUsage = null;
      let currentQueryRequestCount = 0;
      let currentQueryUsageBody = null;
      let eventLog = [];
      let chatAutoScroll = true;
      const toolMessages = new Map();

      // --- Init ---
      init();

      async function init() {
        try {
          await refreshSession(true);
          await populateSweItems();
          await openInitialSweSessionFromUrl();
        } finally {
          setBusy(false);
          updateCharCount();
          promptInput.focus();
        }
      }

      async function openInitialSweSessionFromUrl() {
        var params = new URLSearchParams(window.location.search);
        var instanceId = params.get("swe");
        if (!instanceId) return;
        var draftKind = params.get("draft") || "";
        sweDatasetDir = params.get("datasetDir") || sweDatasetDir;

        var payload = await openSweSession(instanceId, sweDatasetDir);
        if (draftKind && payload && Number(payload.messageCount || 0) === 0) {
          await fillSweDraftPrompt(instanceId, draftKind, sweDatasetDir);
        }
        params.delete("swe");
        params.delete("draft");
        params.delete("datasetDir");
        var nextSearch = params.toString();
        var nextUrl = window.location.pathname + (nextSearch ? "?" + nextSearch : "") + window.location.hash;
        window.history.replaceState(null, "", nextUrl);
      }

      // --- Toast ---
      function showToast(text, ms) {
        toast.textContent = text;
        toast.classList.add("show");
        setTimeout(function() { toast.classList.remove("show"); }, ms || 1800);
      }

      // --- Char count ---
      promptInput.addEventListener("input", updateCharCount);
      chat.addEventListener("scroll", function() {
        chatAutoScroll = isNearBottom(chat);
      }, { passive: true });

      function updateCharCount() {
        var len = promptInput.value.length;
        charCount.textContent = len;
        charCount.classList.toggle("warn", len > MAX_CHAR_WARN);
      }

      // --- Auto-resize textarea ---
      promptInput.addEventListener("input", function() {
        promptInput.style.height = "auto";
        promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + "px";
      });

      // --- Sidebar toggle ---
      sidebarToggle.addEventListener("click", function() {
        sidebar.classList.toggle("collapsed");
      });

      // --- Events toggle ---
      eventsToggle.addEventListener("click", function() {
        eventsPanel.classList.toggle("collapsed");
      });

      // --- Refresh sessions ---
      refreshSessionsBtn.addEventListener("click", async function() {
        await populateSessionList(currentSessionId);
        showToast("Sessions refreshed");
      });

      refreshSweBtn.addEventListener("click", async function() {
        await populateSweItems();
        showToast("SWE items refreshed");
      });

      patchDiffButton.addEventListener("click", openPatchModal);
      patchRefreshButton.addEventListener("click", function() {
        refreshPatchDiff("workspace");
      });
      patchSaveButton.addEventListener("click", savePatchSnapshot);
      patchApplyButton.addEventListener("click", applyLatestPatchSnapshot);
      patchRevertButton.addEventListener("click", revertCurrentPatch);
      patchApproveButton.addEventListener("click", approvePatchSnapshot);
      patchCloseButton.addEventListener("click", closePatchModal);
      changeReviewDismiss.addEventListener("click", hideChangeReviewCard);
      changeReviewOpen.addEventListener("click", openTurnPatchModal);
      exportPatchButton.addEventListener("click", exportSwePatch);

      // --- Form submit ---
      form.addEventListener("submit", async function(event) {
        event.preventDefault();
        if (isBusy) return;
        var prompt = promptInput.value.trim();
        if (!prompt) return;

        hideWelcome();
        hideChangeReviewCard();
        chatAutoScroll = true;
        appendMessage("user", prompt);
        promptInput.value = "";
        promptInput.style.height = "auto";
        updateCharCount();
        currentAssistant = appendMessage("assistant", "");
        currentReasoning = null;
        reasoningTextBuffer = "";
        resetCurrentQueryUsage(currentAssistant);
        setBusy(true);
        var clientRequestId = ++activeClientRequestId;

        try {
          abortController = new AbortController();
          var response = await fetch("/api/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: prompt, includeRawEvents: rawInput.checked }),
            signal: abortController.signal,
          });

          if (!response.ok || !response.body) {
            var errText = await response.text();
            appendMessage("error", errText.slice(0, 1000));
            return;
          }

          await readNdjson(response.body, handleServerEvent);
          safeFlushAssistantText();
          safeFlushReasoningText();
        } catch (error) {
          if (error.name !== "AbortError") {
            appendMessage("error", String(error));
          }
        } finally {
          safeFlushAssistantText();
          safeFlushReasoningText();
          closeReasoningBlock();
          if (clientRequestId === activeClientRequestId) {
            setBusy(false);
            abortController = null;
            promptInput.focus();
            try { await refreshSession(); } catch (e) { /* ignore */ }
          }
        }
      });

      // --- Keyboard shortcuts ---
      promptInput.addEventListener("keydown", function(event) {
        if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey) {
          event.preventDefault();
          form.requestSubmit();
        }
        if (event.key === "Enter" && event.ctrlKey) {
          event.preventDefault();
          form.requestSubmit();
        }
      });

      // --- Stop button ---
      stopButton.addEventListener("click", function() {
        if (abortController) {
          fetch("/api/query/stop", { method: "POST" }).catch(function() { /* ignore */ });
          abortController.abort();
          showToast("Stopped");
        }
      });

      // --- Reset ---
      resetButton.addEventListener("click", async function() {
        if (isSessionLoading) return;
        detachCurrentStream();
        setSessionLoading(true);
        try {
          var response = await fetch("/api/reset", { method: "POST" });
          if (!response.ok) {
            showToast("Failed to create session");
            return;
          }

          clearPersistedEvents();
          chat.textContent = "";
          welcome.classList.remove("hidden");
          toolMessages.clear();
          currentAssistant = null;
          currentReasoning = null;
          assistantTextBuffer = "";
          reasoningTextBuffer = "";
          resetCurrentQueryUsage(null);
          await refreshSession(true);
          showToast("New session created");
        } catch (e) {
          showToast("Failed to create session");
        } finally {
          setSessionLoading(false);
          restoreInputReadyState();
        }
      });

      // --- Clear events ---
      clearEventsButton.addEventListener("click", function() {
        clearPersistedEvents();
      });

      // --- Refresh session ---
      async function refreshSession(reloadHistory) {
        try {
          var response = await fetch("/api/session");
          if (!response.ok) return;
          var session = await response.json();
          var previousSessionId = currentSessionId;
          currentSessionId = session.sessionId;
          currentSweSession = session.swe || null;
          modelBadge.textContent = session.model || "";
          if (currentSessionId !== previousSessionId) {
            loadPersistedEvents();
          }

          statusText.textContent = session.busy ? "streaming" : "ready";
          statusDot.classList.toggle("busy", session.busy);

          topbarInfo.textContent = [
            session.sessionId ? session.sessionId.slice(0, 8) + "..." : "",
            (session.messageCount || 0) + " msg",
            (session.tools || []).length + " tools",
            session.restored ? "restored" : "new",
          ].filter(Boolean).join(" \u00b7 ");
          updateUsageBadge(session.usage);
          updateExportPatchButton();

          await populateSessionList(session.sessionId);

          if (reloadHistory) {
            await renderSessionHistory();
          }
        } catch (e) {
          // ignore
        }
      }

      // --- Session list ---
      async function populateSessionList(selectedSessionId) {
        try {
          var response = await fetch("/api/sessions");
          var payload = await response.json();
          var sessions = payload.sessions || [];
          if (!sessions.some(function(item) { return item.sessionId === selectedSessionId; })) {
            sessions.unshift({
              sessionId: selectedSessionId,
              modifiedAt: Date.now(),
              size: 0,
              category: categorizeSessionId(selectedSessionId),
            });
          }

          sessionList.textContent = "";

          appendSessionGroup("General", sessions.filter(function(item) {
            return (item.category || categorizeSessionId(item.sessionId)) === "general";
          }), selectedSessionId);
          appendSessionGroup("SWE Sessions", sessions.filter(function(item) {
            return (item.category || categorizeSessionId(item.sessionId)) === "swe";
          }), selectedSessionId);
          appendSessionGroup("SWE Serial", sessions.filter(function(item) {
            return (item.category || categorizeSessionId(item.sessionId)) === "swe_serial";
          }), selectedSessionId);
        } catch (e) {
          // ignore
        }
      }

      function appendSessionGroup(label, items, selectedSessionId) {
        if (!items.length) return;
        var header = document.createElement("div");
        header.className = "session-group-label";
        header.textContent = label;
        sessionList.append(header);

        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var div = document.createElement("div");
          div.className = "session-item" + (item.sessionId === selectedSessionId ? " active" : "");
          div.innerHTML =
            '<div class="id">' + escapeHtml(item.sessionId) + '</div>' +
            '<div class="date">' + new Date(item.modifiedAt).toLocaleString() + '</div>' +
            '<div class="meta"><span>' + formatBytes(item.size || 0) + '</span></div>';
          div.addEventListener("click", function(sid) {
            return function() { loadSession(sid); };
          }(item.sessionId));
          sessionList.append(div);
        }
      }

      function categorizeSessionId(sessionId) {
        if (typeof sessionId === "string" && sessionId.indexOf("session_swe_serial_") === 0) {
          return "swe_serial";
        }
        if (typeof sessionId === "string" && sessionId.indexOf("session_swe_") === 0) {
          return "swe";
        }
        return "general";
      }

      async function loadSession(sessionId) {
        if (!sessionId || sessionId === currentSessionId || isSessionLoading) return;
        detachCurrentStream();
        setSessionLoading(true);
        try {
          var response = await fetch("/api/session/load", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: sessionId }),
          });
          if (!response.ok) {
            showToast("Session not found");
            return;
          }
          chat.textContent = "";
          toolMessages.clear();
          currentAssistant = null;
          currentReasoning = null;
          resetCurrentQueryUsage(null);
          await refreshSession(true);
          loadPersistedEvents();
          showToast("Session loaded");
        } catch (e) {
          showToast("Failed to load session");
        } finally {
          setSessionLoading(false);
          restoreInputReadyState();
        }
      }

      async function populateSweItems() {
        try {
          var datasetQuery = sweDatasetDir
            ? "?datasetDir=" + encodeURIComponent(sweDatasetDir)
            : "";
          var response = await fetch("/api/swe/items" + datasetQuery);
          if (!response.ok) return;
          var payload = await response.json();
          var items = payload.items || [];
          sweList.textContent = "";

          if (items.length === 0) {
            var empty = document.createElement("div");
            empty.className = "session-item";
            empty.innerHTML = '<div class="id">No SWE dataset</div><div class="date">Prepare dataset first</div>';
            sweList.append(empty);
            return;
          }

          for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var div = document.createElement("div");
            div.className = "session-item" + (item.sessionId === currentSessionId ? " active" : "");
            div.innerHTML =
              '<div class="id">' + escapeHtml(item.instanceId) + '</div>' +
              '<div class="date">' + escapeHtml(item.problemPreview || item.repo || "") + '</div>' +
              '<div class="meta"><span>' + escapeHtml(item.repo || "") + '</span><span>' +
              escapeHtml(item.workspaceStatus || "missing") + '</span><span>' +
              (item.hasSession ? "session" : "new") + '</span></div>';
            div.addEventListener("click", function(instanceId) {
              return function() { openSweSession(instanceId, sweDatasetDir); };
            }(item.instanceId));
            sweList.append(div);
          }
        } catch (e) {
          // ignore
        }
      }

      async function openSweSession(instanceId, datasetDir) {
        if (!instanceId || isSessionLoading) return null;
        sweDatasetDir = datasetDir || sweDatasetDir;
        detachCurrentStream();
        setSessionLoading(true);
        try {
          var response = await fetch("/api/swe/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ instanceId: instanceId, datasetDir: sweDatasetDir }),
          });
          if (!response.ok) {
            var errorPayload = await response.json().catch(function() { return {}; });
            showToast(errorPayload.error || "Failed to open SWE item", 3200);
            return null;
          }
          chat.textContent = "";
          toolMessages.clear();
          currentAssistant = null;
          currentReasoning = null;
          resetCurrentQueryUsage(null);
          var payload = await response.json();
          await refreshSession(true);
          await populateSweItems();
          showToast(payload.workspaceReady
            ? "SWE session opened"
            : "SWE session opened; repo not prepared yet", 2600);
          return payload;
        } catch (e) {
          showToast("Failed to open SWE item");
          return null;
        } finally {
          setSessionLoading(false);
          restoreInputReadyState();
        }
      }

      async function fillSweDraftPrompt(instanceId, kind, datasetDir) {
        if (promptInput.value.trim()) return;
        try {
          var response = await fetch(
            "/api/swe/prompt?instanceId=" + encodeURIComponent(instanceId) +
              "&kind=" + encodeURIComponent(kind || "investigate") +
              "&datasetDir=" + encodeURIComponent(datasetDir || sweDatasetDir),
          );
          if (!response.ok) return;
          var payload = await response.json();
          if (!payload.prompt) return;
          promptInput.value = payload.prompt;
          promptInput.style.height = "auto";
          promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + "px";
          updateCharCount();
          promptInput.focus();
        } catch (e) {
          // Leave the editor empty if the draft cannot be generated.
        }
      }

      async function openPatchModal() {
        patchModal.classList.add("open");
        patchModal.setAttribute("aria-hidden", "false");
        await refreshPatchDiff("workspace");
      }

      async function openTurnPatchModal() {
        patchModal.classList.add("open");
        patchModal.setAttribute("aria-hidden", "false");
        await refreshPatchDiff("turn");
      }

      function closePatchModal() {
        patchModal.classList.remove("open");
        patchModal.setAttribute("aria-hidden", "true");
      }

      async function refreshPatchDiff(mode) {
        var diffMode = mode || "workspace";
        setPatchBusy(true);
        patchStatus.textContent = diffMode === "turn"
          ? "Loading this turn's git diff..."
          : "Loading current git diff...";
        patchPath.textContent = "";
        try {
          var response = await fetch(
            diffMode === "turn" ? "/api/patch/turn/current" : "/api/patch/current",
          );
          var payload = await response.json();
          if (!response.ok || payload.status === "failed") {
            renderPlainPatchText(payload.error || "Failed to load patch.");
            patchStatus.textContent = "failed";
            return;
          }
          if (payload.status === "not_git") {
            renderPlainPatchText("Current workspace is not a git worktree.");
            patchStatus.textContent = "not git";
            patchModalTitle.textContent = "Workspace Diff";
            return;
          }
          if (payload.status === "missing_baseline") {
            renderPlainPatchText("No query baseline is available for this turn.");
            patchStatus.textContent = "missing baseline";
            patchModalTitle.textContent = "Turn Diff";
            patchPath.textContent = payload.cwd || "";
            return;
          }
          if (payload.status === "empty") {
            patchModalTitle.textContent = diffMode === "turn"
              ? "Turn Diff"
              : "Workspace Diff";
            renderPlainPatchText("No changes.");
            patchStatus.textContent = "empty";
            patchPath.textContent = payload.cwd || "";
            return;
          }

          patchModalTitle.textContent = diffMode === "turn"
            ? "Turn Diff"
            : "Workspace Diff";
          if (payload.empty) {
            renderPlainPatchText("No changes.");
          } else {
            renderPatchDiff(payload.patch || "");
          }
          patchStatus.textContent = payload.empty
            ? "empty"
            : formatBytes(payload.bytes || 0) + (diffMode === "turn" ? " turn diff" : " diff");
          patchPath.textContent = payload.cwd || "";
        } catch (error) {
          renderPlainPatchText(String(error));
          patchStatus.textContent = "failed";
        } finally {
          setPatchBusy(false);
        }
      }

      function renderPlainPatchText(text) {
        patchDiff.textContent = text || "";
      }

      function renderPatchDiff(text) {
        patchDiff.textContent = "";
        var lines = String(text || "").split("\\n");
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          var span = document.createElement("span");
          span.className = "patch-line " + getPatchLineClass(line);
          span.textContent = line || " ";
          patchDiff.append(span);
        }
      }

      function getPatchLineClass(line) {
        if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) {
          return "file";
        }
        if (line.startsWith("@@")) {
          return "hunk";
        }
        if (line.startsWith("+")) {
          return "add";
        }
        if (line.startsWith("-")) {
          return "del";
        }
        return "ctx";
      }

      async function savePatchSnapshot() {
        setPatchBusy(true);
        patchStatus.textContent = "Saving snapshot...";
        try {
          var response = await fetch("/api/patch/snapshot", { method: "POST" });
          var payload = await response.json();
          if (!response.ok || payload.status === "failed") {
            showToast(payload.error || "Failed to save patch", 3200);
            patchStatus.textContent = "save failed";
            return;
          }
          if (payload.status === "empty") {
            showToast("No changes to save");
            patchStatus.textContent = "empty";
            return;
          }
          if (payload.status === "not_git") {
            showToast("Current workspace is not git");
            patchStatus.textContent = "not git";
            return;
          }

          patchStatus.textContent = "saved #" + payload.sequence + " · " + formatBytes(payload.bytes || 0);
          patchPath.textContent = payload.patchPath || "";
          showToast("Patch snapshot saved", 2600);
        } catch (error) {
          showToast("Failed to save patch");
          patchStatus.textContent = "save failed";
        } finally {
          setPatchBusy(false);
        }
      }

      async function approvePatchSnapshot() {
        setPatchBusy(true);
        patchStatus.textContent = "Marking approved...";
        try {
          var response = await fetch("/api/patch/approve", { method: "POST" });
          var payload = await response.json();
          if (!response.ok || payload.status === "failed") {
            showToast(payload.error || "Failed to approve patch", 3200);
            patchStatus.textContent = "approve failed";
            return;
          }
          if (payload.status === "empty") {
            showToast("No changes to approve");
            patchStatus.textContent = "empty";
            return;
          }
          if (payload.status === "not_git") {
            showToast("Current workspace is not git");
            patchStatus.textContent = "not git";
            return;
          }

          patchStatus.textContent = "approved #" + payload.sequence + " · " + formatBytes(payload.bytes || 0);
          patchPath.textContent = payload.approvedPath || "";
          showToast("Patch marked approved", 2600);
        } catch (error) {
          showToast("Failed to approve patch");
          patchStatus.textContent = "approve failed";
        } finally {
          setPatchBusy(false);
        }
      }

      async function applyLatestPatchSnapshot() {
        if (!window.confirm("Apply the latest saved patch snapshot to the current workspace?")) {
          return;
        }

        setPatchBusy(true);
        patchStatus.textContent = "Applying latest patch...";
        try {
          var response = await fetch("/api/patch/apply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: "latest" }),
          });
          var payload = await response.json();
          if (!response.ok || payload.status === "failed") {
            showToast(payload.error || "Failed to apply patch", 3200);
            patchStatus.textContent = "apply failed";
            return;
          }
          if (payload.status === "dirty") {
            showToast("Workspace has changes. Revert or save them before applying.", 3600);
            patchStatus.textContent = "dirty";
            return;
          }
          if (payload.status === "missing") {
            showToast("No saved latest patch for this session", 3200);
            patchStatus.textContent = "missing";
            return;
          }
          if (payload.status === "not_git") {
            showToast("Current workspace is not git");
            patchStatus.textContent = "not git";
            return;
          }

          patchStatus.textContent = "applied latest · " + formatBytes(payload.bytes || 0);
          patchPath.textContent = payload.patchPath || "";
          showToast("Patch applied", 2600);
          await refreshPatchDiff();
          await refreshChangeReviewCard();
        } catch (error) {
          showToast("Failed to apply patch");
          patchStatus.textContent = "apply failed";
        } finally {
          setPatchBusy(false);
        }
      }

      async function revertCurrentPatch() {
        if (!window.confirm("Revert the current tracked git changes in this workspace?")) {
          return;
        }

        setPatchBusy(true);
        patchStatus.textContent = "Reverting current changes...";
        try {
          var response = await fetch("/api/patch/revert", { method: "POST" });
          var payload = await response.json();
          if (!response.ok || payload.status === "failed") {
            showToast(payload.error || "Failed to revert patch", 3200);
            patchStatus.textContent = "revert failed";
            return;
          }
          if (payload.status === "empty") {
            showToast("No changes to revert");
            patchStatus.textContent = "empty";
            return;
          }
          if (payload.status === "not_git") {
            showToast("Current workspace is not git");
            patchStatus.textContent = "not git";
            return;
          }

          patchStatus.textContent = "reverted · " + formatBytes(payload.bytes || 0);
          patchPath.textContent = payload.cwd || "";
          hideChangeReviewCard();
          showToast("Current changes reverted", 2600);
          await refreshPatchDiff();
        } catch (error) {
          showToast("Failed to revert patch");
          patchStatus.textContent = "revert failed";
        } finally {
          setPatchBusy(false);
        }
      }

      function setPatchBusy(value) {
        patchRefreshButton.disabled = value;
        patchSaveButton.disabled = value || isBusy || isSessionLoading;
        patchApplyButton.disabled = value || isBusy || isSessionLoading;
        patchRevertButton.disabled = value || isBusy || isSessionLoading;
        patchApproveButton.disabled = value || isBusy || isSessionLoading;
        patchDiffButton.disabled = isSessionLoading;
      }

      async function refreshChangeReviewCard() {
        try {
          var response = await fetch("/api/patch/turn/summary");
          var payload = await response.json();
          if (!response.ok || payload.status !== "ok") {
            if (payload.status === "empty") hideChangeReviewCard();
            return;
          }

          renderChangeReviewCard(payload);
        } catch (error) {
          // Keep the editing flow quiet; the full Diff button can still be used.
        }
      }

      function renderChangeReviewCard(summary) {
        changeReviewCard.classList.add("open");
        changeReviewCard.setAttribute("aria-hidden", "false");
        changeReviewTitle.textContent = "Edited this turn: " + summary.fileCount + " file" + (summary.fileCount === 1 ? "" : "s");
        changeReviewTotals.innerHTML =
          '<span class="diff-add">+' + escapeHtml(String(summary.additions || 0)) + '</span>' +
          ' ' +
          '<span class="diff-del">-' + escapeHtml(String(summary.deletions || 0)) + '</span>';
        changeReviewFiles.textContent = "";

        var files = summary.files || [];
        for (var i = 0; i < files.length; i++) {
          var file = files[i];
          var row = document.createElement("div");
          row.className = "change-review-file";
          var path = document.createElement("div");
          path.className = "change-review-path";
          path.title = file.path || "";
          path.textContent = file.path || "";
          var stat = document.createElement("div");
          stat.innerHTML = file.binary
            ? '<span>binary</span>'
            : '<span class="diff-add">+' + escapeHtml(String(file.additions || 0)) + '</span>' +
              ' ' +
              '<span class="diff-del">-' + escapeHtml(String(file.deletions || 0)) + '</span>';
          row.append(path, stat);
          changeReviewFiles.append(row);
        }
      }

      function hideChangeReviewCard() {
        changeReviewCard.classList.remove("open");
        changeReviewCard.setAttribute("aria-hidden", "true");
      }

      function shouldShowChangeReviewForTool(event) {
        var name = event.toolName || "";
        return name === "Edit" || name === "Write" || name === "FileWrite";
      }

      async function exportSwePatch() {
        if (!currentSweSession || !currentSweSession.workspaceReady) {
          showToast("No prepared SWE workspace");
          return;
        }

        exportPatchButton.disabled = true;
        var previousText = exportPatchButton.textContent;
        exportPatchButton.textContent = "Exporting";
        try {
          var response = await fetch("/api/swe/patch");
          var payload = await response.json();
          if (!response.ok || !payload.ok) {
            showToast(payload.error || "Failed to export patch", 3200);
            return;
          }
          if (payload.empty) {
            showToast("No changes to export");
            return;
          }

          showToast(payload.savedPath ? "Patch saved: " + payload.savedPath : "Patch exported", 5000);
        } catch (e) {
          showToast("Failed to export patch");
        } finally {
          exportPatchButton.textContent = previousText || "Export Patch";
          updateExportPatchButton();
        }
      }

      function updateExportPatchButton() {
        if (!exportPatchButton) return;
        var enabled = Boolean(currentSweSession && currentSweSession.workspaceReady && !isBusy && !isSessionLoading);
        exportPatchButton.disabled = !enabled;
        if (patchDiffButton) patchDiffButton.disabled = isSessionLoading;
        if (patchSaveButton) patchSaveButton.disabled = isBusy || isSessionLoading;
        if (patchApplyButton) patchApplyButton.disabled = isBusy || isSessionLoading;
        if (patchRevertButton) patchRevertButton.disabled = isBusy || isSessionLoading;
        if (patchApproveButton) patchApproveButton.disabled = isBusy || isSessionLoading;
        exportPatchButton.title = currentSweSession
          ? (currentSweSession.workspaceReady
            ? "Export git diff --binary from the current SWE worktree"
            : "Prepare this SWE workspace before exporting a patch")
          : "Open a SWE item session before exporting a patch";
      }

      function detachCurrentStream() {
        if (!abortController) return;
        var controller = abortController;
        abortController = null;
        activeClientRequestId++;
        controller.abort();
        setBusy(false);
      }

      // --- History rendering ---
      async function renderSessionHistory() {
        chatAutoScroll = true;
        chat.textContent = "";
        welcome.classList.add("hidden");
        currentAssistant = null;
        currentReasoning = null;
        assistantTextBuffer = "";
        reasoningTextBuffer = "";
        resetCurrentQueryUsage(null);
        toolMessages.clear();

        try {
          var response = await fetch("/api/session/messages");
          var payload = await response.json();
          var messages = payload.messages || [];

          if (messages.length === 0) {
            welcome.classList.remove("hidden");
            return;
          }

          welcome.classList.add("hidden");

          var historyQuestionUsage = null;
          var historyQuestionRequestCount = 0;
          var historyQuestionBody = null;
          var historyAssistantBody = null;
          function flushHistoryQuestion() {
            finalizeAssistantBody(historyAssistantBody);
            renderUsageFooter(
              historyQuestionBody || historyAssistantBody,
              historyQuestionUsage,
              historyQuestionRequestCount,
              false,
            );
            historyQuestionUsage = null;
            historyQuestionRequestCount = 0;
            historyQuestionBody = null;
            historyAssistantBody = null;
            currentAssistant = null;
            currentReasoning = null;
          }
          function ensureHistoryAssistantBody() {
            if (!historyAssistantBody) {
              historyAssistantBody = appendMessage("assistant", "");
            }
            currentAssistant = historyAssistantBody;
            return historyAssistantBody;
          }
          function appendHistoryAssistantContent(body, content) {
            if (!body || !content) return;
            appendAssistantRawText(body, content, "\\n\\n");
          }

          for (var i = 0; i < messages.length; i++) {
            var msg = messages[i];
            if (msg.role === "user") {
              flushHistoryQuestion();
              if (msg.content) {
                appendMessage("user", msg.content);
              }
              continue;
            }
            if (msg.role === "assistant") {
              var body = ensureHistoryAssistantBody();
              appendHistoryAssistantContent(body, msg.content || "");
              if (msg.usage) {
                historyQuestionUsage = addUsage(historyQuestionUsage, msg.usage);
                historyQuestionRequestCount += 1;
                historyQuestionBody = body;
              }
              if (msg.reasoningContent) {
                appendReasoningText(msg.reasoningContent, msg.reasoningChars);
                closeReasoningBlock();
              }
              if (msg.toolCalls) {
                for (var j = 0; j < msg.toolCalls.length; j++) {
                  appendToolUse(msg.toolCalls[j]);
                }
              }
            } else if (msg.role === "tool") {
              completeToolUse({
                toolCallId: msg.toolCallId,
                toolName: msg.toolName,
                contentPreview: msg.contentPreview,
              });
            }
          }
          flushHistoryQuestion();

          scrollToBottom(chat, true);
        } catch (e) {
          // ignore
        }
      }

      // --- Server event handler ---
      function handleServerEvent(event) {
        if (shouldLogEvent(event)) {
          appendEvent(event);
        }

        switch (event.type) {
          case "assistant_text_delta":
            queueAssistantText(event.text);
            break;
          case "assistant_reasoning_delta":
            queueReasoningText(event.text);
            break;
          case "assistant_message":
            flushAssistantText();
            flushReasoningText();
            closeReasoningBlock();
            if (event.message && event.message.content && currentAssistant) {
              if (!getAssistantRawText(currentAssistant).trim()) {
                setAssistantRawText(currentAssistant, event.message.content, true);
              }
            }
            finalizeAssistantBody(currentAssistant);
            if (!currentQueryUsage && event.usage) {
              currentQueryUsage = addUsage(currentQueryUsage, event.usage);
              currentQueryRequestCount = Math.max(1, currentQueryRequestCount);
            }
            renderCurrentQueryUsage(false);
            scrollToBottom(chat);
            break;
          case "tool_use":
            appendToolUse(event.toolCall);
            break;
          case "tool_permission_request":
            renderToolPermissionRequest(event);
            break;
          case "tool_permission":
            markToolPermission(event);
            break;
          case "tool_result":
            completeToolUse(event);
            if (shouldShowChangeReviewForTool(event)) {
              refreshChangeReviewCard();
            }
            break;
          case "model_usage":
            updateUsageBadgeFromEvent(event);
            currentQueryUsage = addUsage(currentQueryUsage, getMessageUsageFromEvent(event));
            currentQueryRequestCount += 1;
            renderCurrentQueryUsage(true);
            break;
          case "done":
            if (event.sessionUsage) {
              updateUsageBadge(event.sessionUsage);
            }
            closeReasoningBlock();
            finalizeAssistantBody(currentAssistant);
            renderCurrentQueryUsage(false);
            break;
          case "context_ready":
            hideWelcome();
            updateProjectionBadge(event);
            break;
          case "user_message":
            hideWelcome();
            break;
          case "error":
            appendMessage("error", event.error);
            break;
        }
      }

      function shouldLogEvent(event) {
        if (rawInput.checked) return true;
        return event.type !== "assistant_text_delta" &&
          event.type !== "assistant_reasoning_delta" &&
          event.type !== "model_stream_event";
      }

      // --- Streaming helpers ---
      function queueAssistantText(text) {
        assistantTextBuffer += text;
        if (!assistantRenderFrame) {
          assistantRenderFrame = requestAnimationFrame(flushAssistantText);
        }
      }

      function flushAssistantText() {
        if (assistantRenderFrame) {
          cancelAnimationFrame(assistantRenderFrame);
          assistantRenderFrame = 0;
        }
        if (!currentAssistant || !assistantTextBuffer) return;
        appendAssistantRawText(currentAssistant, assistantTextBuffer, "");
        assistantTextBuffer = "";
        scrollToBottom(chat);
      }

      function queueReasoningText(text) {
        reasoningTextBuffer += text;
        if (!reasoningRenderFrame) {
          reasoningRenderFrame = requestAnimationFrame(flushReasoningText);
        }
      }

      function flushReasoningText() {
        if (reasoningRenderFrame) {
          cancelAnimationFrame(reasoningRenderFrame);
          reasoningRenderFrame = 0;
        }
        if (!reasoningTextBuffer) return;
        appendReasoningText(reasoningTextBuffer);
        reasoningTextBuffer = "";
      }

      function appendReasoningText(text, totalChars) {
        if (!currentAssistant) return;
        var entry = getOrCreateReasoningBlock();
        var chunkChars = Number.isFinite(totalChars) ? totalChars : text.length;
        entry.totalChars += chunkChars;

        if (entry.renderedChars < MAX_REASONING_RENDER_CHARS) {
          var remaining = MAX_REASONING_RENDER_CHARS - entry.renderedChars;
          var visible = text.slice(0, remaining);
          entry.body.textContent += visible;
          entry.renderedChars += visible.length;
        }

        var hiddenChars = Math.max(0, entry.totalChars - entry.renderedChars);
        entry.hidden.textContent = hiddenChars > 0
          ? "... [" + hiddenChars + " reasoning chars hidden]"
          : "";
        entry.summary.textContent = entry.totalChars + " reasoning chars";
        scrollToBottom(chat);
      }

      function getOrCreateReasoningBlock() {
        if (currentReasoning && !currentReasoning.closed) return currentReasoning;

        var details = document.createElement("details");
        details.className = "reasoning-block";
        details.open = false;
        var summary = document.createElement("summary");
        summary.textContent = "0 reasoning chars";
        var body = document.createElement("pre");
        var hidden = document.createElement("div");
        hidden.className = "hidden-note";
        details.append(summary, body, hidden);

        var parent = currentAssistant ? currentAssistant.closest(".msg") : null;
        if (parent) {
          parent.append(details);
        } else {
          chat.append(details);
        }

        currentReasoning = { details: details, summary: summary, body: body, hidden: hidden, totalChars: 0, renderedChars: 0, closed: false };
        return currentReasoning;
      }

      function closeReasoningBlock() {
        if (currentReasoning) {
          currentReasoning.closed = true;
          currentReasoning = null;
        }
      }

      // --- NDJSON reader ---
      async function readNdjson(body, onEvent) {
        var reader = body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";

        while (true) {
          var result = await reader.read();
          var value = result.value, done = result.done;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          var idx;
          while ((idx = buffer.indexOf("\\n")) >= 0) {
            var line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line) {
              try { onEvent(JSON.parse(line)); } catch(e) { /* skip malformed */ }
            }
          }
        }

        var tail = buffer.trim();
        if (tail) {
          try { onEvent(JSON.parse(tail)); } catch(e) { /* skip malformed */ }
        }
      }

      // --- Message rendering ---
      function appendMessage(role, text) {
        hideWelcome();

        var wrapper = document.createElement("div");
        wrapper.className = "msg " + role;

        var header = document.createElement("div");
        header.className = "msg-header";

        var icon = document.createElement("span");
        icon.className = "msg-role " + role;
        icon.textContent = role === "user" ? "U" : role === "assistant" ? "A" : "!";

        var label = document.createElement("span");
        label.className = "msg-label " + role;
        label.textContent = role;

        var time = document.createElement("span");
        time.className = "msg-time";
        time.textContent = formatTime(new Date());

        header.append(icon, label, time);

        var body = document.createElement("div");
        body.className = "msg-body";
        if (role === "assistant") {
          body.classList.add("streaming");
          body.dataset.rawText = text || "";
        }
        if (role === "assistant") {
          renderAssistantBody(body);
        } else {
          body.textContent = text || "";
        }

        wrapper.append(header, body);
        chat.append(wrapper);
        scrollToBottom(chat);
        return body;
      }

      // --- Finalize an assistant body into rendered Markdown ---
      function finalizeAssistantBody(body) {
        if (!body) return;
        body.classList.remove("streaming");
        var raw = getAssistantRawText(body);
        if (!raw.trim()) return;
        renderAssistantBody(body);
        scrollToBottom(chat);
      }

      function getAssistantRawText(body) {
        if (!body) return "";
        return body.dataset.rawText || "";
      }

      function setAssistantRawText(body, text, renderNow) {
        if (!body) return;
        body.dataset.rawText = text || "";
        if (renderNow) {
          renderAssistantBody(body);
        }
      }

      function appendAssistantRawText(body, text, separator) {
        if (!body || !text) return;
        var raw = getAssistantRawText(body);
        var next = raw + (raw && separator ? separator : "") + text;
        setAssistantRawText(body, next, true);
      }

      function renderAssistantBody(body) {
        if (!body) return;
        var raw = getAssistantRawText(body);
        body.innerHTML = raw.trim() ? renderMarkdown(raw) : "";
      }

      // --- Tool rendering ---
      function appendToolUse(toolCall) {
        hideWelcome();

        var toolCallId = toolCall && toolCall.id ? toolCall.id : "tool-" + generateId();
        var existing = toolMessages.get(toolCallId);
        if (existing) return existing;

        var details = document.createElement("details");
        details.className = "tool-card";
        details.open = false;

        var summary = document.createElement("summary");
        var indicator = document.createElement("span");
        indicator.className = "tool-indicator";
        var toolName = document.createElement("span");
        toolName.className = "tool-name";
        toolName.textContent = (toolCall && toolCall.function && toolCall.function.name) || "tool";
        var status = document.createElement("span");
        status.className = "tool-status";
        status.textContent = "running...";

        summary.append(indicator, toolName, status);

        var input = document.createElement("div");
        input.className = "tool-input";
        input.textContent = formatToolArguments(toolCall && toolCall.function && toolCall.function.arguments);
        var result = document.createElement("div");
        result.className = "tool-result";

        details.append(summary, input, result);
        var parent = currentAssistant ? currentAssistant.closest(".msg") : null;
        if (parent) {
          parent.append(details);
        } else {
          chat.append(details);
        }

        var entry = { details: details, summary: summary, indicator: indicator, status: status, result: result };
        toolMessages.set(toolCallId, entry);
        scrollToBottom(chat);
        return entry;
      }

      function completeToolUse(event) {
        var toolCallId = event.toolCallId || (event.toolCall && event.toolCall.id);
        var entry = toolCallId
          ? (toolMessages.get(toolCallId) || appendToolUse({ id: toolCallId, function: { name: event.toolName || (event.toolCall && event.toolCall.function && event.toolCall.function.name) } }))
          : appendToolUse({ function: { name: event.toolName || "tool" } });

        var content = event.contentPreview || (event.message && event.message.content) || "";
        renderToolResultContent(entry.result, content);
        if (!entry.indicator.classList.contains("blocked")) {
          entry.indicator.classList.add("done");
          entry.status.classList.add("done");
          entry.status.textContent = "done";
          entry.details.open = false;
        }
        scrollToBottom(chat);
      }

      function markToolPermission(event) {
        var toolCallId = event.toolCallId || (event.toolCall && event.toolCall.id);
        var entry = toolCallId
          ? (toolMessages.get(toolCallId) || appendToolUse({ id: toolCallId, function: { name: event.toolName || (event.toolCall && event.toolCall.function && event.toolCall.function.name) } }))
          : appendToolUse({ function: { name: event.toolName || "tool" } });

        renderToolResultContent(
          entry.result,
          "Permission denied: " + (event.reasonPreview || event.reason || "Tool execution was blocked."),
        );
        entry.indicator.classList.add("blocked");
        entry.status.classList.add("blocked");
        entry.status.textContent = "blocked";
        entry.details.open = true;
        scrollToBottom(chat);
      }

      function renderToolPermissionRequest(event) {
        var toolCallId = event.toolCallId || (event.toolCall && event.toolCall.id);
        var entry = toolCallId
          ? (toolMessages.get(toolCallId) || appendToolUse({ id: toolCallId, function: { name: event.toolName || (event.toolCall && event.toolCall.function && event.toolCall.function.name) } }))
          : appendToolUse({ function: { name: event.toolName || "tool" } });

        entry.result.textContent = "";
        var pre = document.createElement("pre");
        pre.className = "projection-pre";
        pre.textContent = "Permission required (" + (event.mode || "plan") + " mode):\\n" + (event.reasonPreview || event.reason || "");
        var actions = document.createElement("div");
        actions.className = "tool-permission-actions";
        var allow = document.createElement("button");
        allow.type = "button";
        allow.textContent = "Allow once";
        var deny = document.createElement("button");
        deny.type = "button";
        deny.className = "deny";
        deny.textContent = "Deny";
        actions.append(allow, deny);
        entry.result.append(pre, actions);
        entry.status.textContent = "approval needed";
        entry.details.open = true;

        allow.addEventListener("click", function() {
          respondToolPermission(event.approvalId, "allow", actions, entry);
        });
        deny.addEventListener("click", function() {
          respondToolPermission(event.approvalId, "deny", actions, entry);
        });
        scrollToBottom(chat);
      }

      async function respondToolPermission(approvalId, decision, actions, entry) {
        if (!approvalId) return;
        setPermissionButtonsDisabled(actions, true);
        entry.status.textContent = decision === "allow" ? "approved" : "denied";
        try {
          var response = await fetch("/api/tool-permission", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ approvalId: approvalId, decision: decision }),
          });
          if (!response.ok) {
            setPermissionButtonsDisabled(actions, false);
            entry.status.textContent = "approval failed";
            showToast("Failed to send permission response");
          }
        } catch (error) {
          setPermissionButtonsDisabled(actions, false);
          entry.status.textContent = "approval failed";
          showToast("Failed to send permission response");
        }
      }

      function setPermissionButtonsDisabled(actions, disabled) {
        var buttons = actions ? actions.querySelectorAll("button") : [];
        for (var i = 0; i < buttons.length; i++) {
          buttons[i].disabled = disabled;
        }
      }

      function renderToolResultContent(container, content) {
        var text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
        var projection = getProjectionReplacementInfo(text);
        container.textContent = "";

        if (projection) {
          var note = document.createElement("div");
          note.className = "projection-note " + projection.kind;
          note.textContent = projection.label;
          container.append(note);
        }

        var pre = document.createElement("pre");
        pre.className = "projection-pre";
        pre.textContent = text;
        container.append(pre);
      }

      function getProjectionReplacementInfo(text) {
        if (!text) return null;
        if (text.indexOf("<tool-result-compact>") === 0) {
          return { kind: "compact", label: "compacted tool result" };
        }
        if (text.indexOf("<tool-result-budget>") === 0) {
          return { kind: "budget", label: "budgeted tool result" };
        }
        if (text.indexOf("[History snipped:") === 0) {
          return { kind: "snip", label: "history snip marker" };
        }
        return null;
      }

      function formatToolArguments(value) {
        if (!value) return "";
        try { return JSON.stringify(JSON.parse(value), null, 2); } catch(e) { return String(value); }
      }

      // --- Event log ---
      function appendEvent(event) {
        eventLog.push(event);
        trimEventLogData();
        persistEvents();
        renderEventLog();
      }

      function renderEventLog() {
        events.textContent = "";
        for (var i = 0; i < eventLog.length; i++) {
          appendEventNode(eventLog[i]);
        }
        scrollToBottom(events);
      }

      function appendEventNode(event) {
        var pre = document.createElement("pre");
        pre.textContent = formatEvent(event);
        events.append(pre);
        trimEventLog();
      }

      function formatEvent(event) {
        var text = JSON.stringify(event, null, 2);
        if (text.length <= MAX_EVENT_TEXT_CHARS) return text;
        return text.slice(0, MAX_EVENT_TEXT_CHARS) + "\\n... [truncated]";
      }

      function trimEventLog() {
        while (events.childElementCount > MAX_EVENT_NODES) {
          if (events.firstElementChild) events.firstElementChild.remove();
        }
      }

      function trimEventLogData() {
        while (eventLog.length > MAX_EVENT_NODES) {
          eventLog.shift();
        }
      }

      function getEventStorageKey() {
        return currentSessionId ? EVENT_STORAGE_PREFIX + currentSessionId : "";
      }

      function persistEvents() {
        var key = getEventStorageKey();
        if (!key) return;
        try {
          localStorage.setItem(key, JSON.stringify(eventLog));
        } catch (e) {
          eventLog = eventLog.slice(Math.floor(eventLog.length / 2));
          try { localStorage.setItem(key, JSON.stringify(eventLog)); } catch (_) { /* ignore */ }
        }
      }

      function loadPersistedEvents() {
        var key = getEventStorageKey();
        if (!key) {
          eventLog = [];
          renderEventLog();
          return;
        }

        try {
          var parsed = JSON.parse(localStorage.getItem(key) || "[]");
          eventLog = Array.isArray(parsed) ? parsed.slice(-MAX_EVENT_NODES) : [];
        } catch (e) {
          eventLog = [];
        }
        renderEventLog();
      }

      function clearPersistedEvents() {
        eventLog = [];
        events.textContent = "";
        var key = getEventStorageKey();
        if (key) {
          try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
        }
      }

      // --- Busy state ---
      function setBusy(value) {
        isBusy = value;
        promptInput.disabled = value;
        sendButton.disabled = value;
        stopButton.classList.toggle("visible", value);
        resetButton.disabled = isSessionLoading;
        updateExportPatchButton();
        if (value) {
          statusDot.classList.add("busy");
          statusText.textContent = "streaming";
        } else {
          statusDot.classList.remove("busy");
          statusText.textContent = "ready";
          promptInput.focus();
        }
      }

      function setSessionLoading(value) {
        isSessionLoading = value;
        sessionList.classList.toggle("loading", value);
        refreshSessionsBtn.disabled = value;
        resetButton.disabled = value;
        statusText.textContent = value ? "loading session" : (isBusy ? "streaming" : "ready");
        updateExportPatchButton();
      }

      function restoreInputReadyState() {
        if (isBusy || isSessionLoading) return;
        promptInput.disabled = false;
        sendButton.disabled = false;
        resetButton.disabled = false;
        stopButton.classList.remove("visible");
        statusDot.classList.remove("busy");
        statusText.textContent = "ready";
        updateExportPatchButton();
        promptInput.focus();
      }

      function getMessageUsageFromEvent(event) {
        if (event.usage) {
          return normalizeUsage(event.usage);
        }

        return {
          promptTokens: event.promptTokens || 0,
          completionTokens: event.completionTokens || 0,
          totalTokens: event.totalTokens || 0,
          promptCacheHitTokens: event.promptCacheHitTokens || 0,
          promptCacheMissTokens: event.promptCacheMissTokens || 0,
        };
      }

      function resetCurrentQueryUsage(body) {
        currentQueryUsage = null;
        currentQueryRequestCount = 0;
        currentQueryUsageBody = body || null;
      }

      function addUsage(current, next) {
        var normalized = normalizeUsage(next);
        if (!normalized) return current;
        var base = normalizeUsage(current) || {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 0,
        };
        return {
          promptTokens: base.promptTokens + normalized.promptTokens,
          completionTokens: base.completionTokens + normalized.completionTokens,
          totalTokens: base.totalTokens + normalized.totalTokens,
          promptCacheHitTokens: base.promptCacheHitTokens + normalized.promptCacheHitTokens,
          promptCacheMissTokens: base.promptCacheMissTokens + normalized.promptCacheMissTokens,
        };
      }

      function renderCurrentQueryUsage(pending) {
        if (!currentAssistant || !currentQueryUsage) return;
        if (currentQueryUsageBody && currentQueryUsageBody !== currentAssistant) {
          var oldEl = getMessageUsageElement(currentQueryUsageBody, false);
          if (oldEl) oldEl.remove();
        }
        currentQueryUsageBody = currentAssistant;
        renderUsageFooter(
          currentAssistant,
          currentQueryUsage,
          currentQueryRequestCount,
          pending,
        );
      }

      function renderUsageFooter(body, usage, requestCount, pending) {
        if (!body || !usage) return;
        var normalized = normalizeUsage(usage);
        if (!normalized || normalized.totalTokens === 0) return;

        var el = getMessageUsageElement(body, true);
        if (!el) return;
        el.dataset.pending = pending ? "true" : "false";
        el.innerHTML = formatMessageUsageHtml(normalized, requestCount);
        el.title = [
          "This user turn",
          "Model requests: " + Math.max(1, Number(requestCount || 0)),
          "Prompt tokens: " + normalized.promptTokens,
          "Completion tokens: " + normalized.completionTokens,
          "Total tokens: " + normalized.totalTokens,
          "Prompt cache hit tokens: " + normalized.promptCacheHitTokens,
          "Prompt cache miss tokens: " + normalized.promptCacheMissTokens,
        ].join("\\n");
      }

      function getMessageUsageElement(body, create) {
        var wrapper = body ? body.closest(".msg") : null;
        if (!wrapper) return null;
        var existing = wrapper.querySelector(".msg-usage");
        if (existing) {
          wrapper.append(existing);
          return existing;
        }
        if (!create) return null;

        var el = document.createElement("div");
        el.className = "msg-usage";
        wrapper.append(el);
        return el;
      }

      function formatMessageUsageHtml(usage, requestCount) {
        var cacheTotal = usage.promptCacheHitTokens + usage.promptCacheMissTokens;
        var hitRate = cacheTotal > 0
          ? Math.round((usage.promptCacheHitTokens / cacheTotal) * 100)
          : 0;
        var requests = Math.max(1, Number(requestCount || 0));
        return [
          "turn total",
          formatCompactNumber(usage.totalTokens) + " tok",
          requests + " req",
          "prompt " + formatCompactNumber(usage.promptTokens),
          "out " + formatCompactNumber(usage.completionTokens),
          '<span class="hit">' + hitRate + "% hit</span>",
          '<span class="miss">' + formatCompactNumber(usage.promptCacheMissTokens) + " miss</span>",
        ].join(" · ");
      }

      function updateUsageBadgeFromEvent(event) {
        latestUsage = event.sessionUsage
          ? normalizeUsage(event.sessionUsage)
          : {
            promptTokens: event.sessionPromptTokens || 0,
            completionTokens: event.sessionCompletionTokens || 0,
            totalTokens: event.sessionTotalTokens || 0,
            promptCacheHitTokens: event.sessionPromptCacheHitTokens || 0,
            promptCacheMissTokens: event.sessionPromptCacheMissTokens || 0,
          };
        updateUsageBadge(latestUsage);
      }

      function updateUsageBadge(usage) {
        if (!usageBadge) return;
        latestUsage = normalizeUsage(usage || latestUsage);
        if (!latestUsage || latestUsage.totalTokens === 0) {
          usageBadge.textContent = "usage --";
          usageBadge.title = "No model usage reported yet.";
          return;
        }

        var cacheTotal = latestUsage.promptCacheHitTokens + latestUsage.promptCacheMissTokens;
        var hitRate = cacheTotal > 0
          ? Math.round((latestUsage.promptCacheHitTokens / cacheTotal) * 100)
          : 0;
        usageBadge.innerHTML =
          '<span>' + formatCompactNumber(latestUsage.totalTokens) + ' tok</span>' +
          '<span class="hit">' + hitRate + '% hit</span>' +
          '<span class="miss">' + formatCompactNumber(latestUsage.promptCacheMissTokens) + ' miss</span>';
        usageBadge.title = [
          "Session usage",
          "Prompt tokens: " + latestUsage.promptTokens,
          "Completion tokens: " + latestUsage.completionTokens,
          "Total tokens: " + latestUsage.totalTokens,
          "Prompt cache hit tokens: " + latestUsage.promptCacheHitTokens,
          "Prompt cache miss tokens: " + latestUsage.promptCacheMissTokens,
        ].join("\\n");
      }

      function updateProjectionBadge(event) {
        if (!projectionBadge || !event || event.type !== "context_ready") return;
        var stats = event.stats || {};
        var budget = Number(stats.toolResultBudgetReplacementCount || 0);
        var compact = Number(stats.bulkyToolCompactCount || 0);
        var snip = Number(stats.historySnipCount || 0);
        var markerBudget = event.hasToolResultBudget ? 1 : 0;
        var markerCompact = event.hasToolResultCompact ? 1 : 0;
        var markerSnip = event.hasHistorySnipMarker ? 1 : 0;
        var active = budget + compact + snip + markerBudget + markerCompact + markerSnip;

        if (!active) {
          projectionBadge.className = "clean";
          projectionBadge.textContent = "projection clean";
          projectionBadge.title = "No projection compression was applied for the latest request.";
          return;
        }

        var parts = ["projection"];
        if (budget || markerBudget) parts.push("budget " + Math.max(budget, markerBudget));
        if (compact || markerCompact) parts.push("compact " + Math.max(compact, markerCompact));
        if (snip || markerSnip) parts.push("snip " + Math.max(snip, markerSnip));
        projectionBadge.className = "";
        projectionBadge.innerHTML = '<span class="active">' + escapeHtml(parts.join(" 路 ")) + "</span>";
        projectionBadge.title = [
          "Latest request projection",
          "Tool result budget replacements: " + budget,
          "Bulky tool result compactions: " + compact,
          "History snips: " + snip,
          "Tool result chars before budget: " + Number(stats.toolResultCharsBeforeBudget || 0),
          "Tool result chars after budget: " + Number(stats.toolResultCharsAfterBudget || 0),
          "Tool result chars after compact: " + Number(stats.toolResultCharsAfterCompact || 0),
        ].join("\\n");
      }

      function normalizeUsage(usage) {
        if (!usage) return null;
        var promptTokens = Number(usage.promptTokens || usage.prompt_tokens || 0);
        var promptDetails = usage.prompt_tokens_details || {};
        var cacheHitTokens = Number(
          usage.promptCacheHitTokens ||
          usage.prompt_cache_hit_tokens ||
          promptDetails.cached_tokens ||
          0
        );
        return {
          promptTokens: promptTokens,
          completionTokens: Number(usage.completionTokens || usage.completion_tokens || 0),
          totalTokens: Number(usage.totalTokens || usage.total_tokens || 0),
          promptCacheHitTokens: cacheHitTokens,
          promptCacheMissTokens: Number(
            usage.promptCacheMissTokens ||
            usage.prompt_cache_miss_tokens ||
            Math.max(0, promptTokens - cacheHitTokens)
          ),
        };
      }

      function formatCompactNumber(value) {
        var n = Number(value || 0);
        if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\\.0$/, "") + "M";
        if (n >= 1000) return (n / 1000).toFixed(1).replace(/\\.0$/, "") + "k";
        return String(n);
      }

      // --- Safe flush wrappers (never throw) ---
      function safeFlushAssistantText() {
        try { flushAssistantText(); } catch (e) { /* ignore */ }
      }
      function safeFlushReasoningText() {
        try { flushReasoningText(); } catch (e) { /* ignore */ }
      }

      // --- Helpers ---
      function hideWelcome() {
        welcome.classList.add("hidden");
      }

      function scrollToBottom(el, force) {
        if (el === chat && !force && !chatAutoScroll) {
          return;
        }
        el.scrollTop = el.scrollHeight;
      }

      function isNearBottom(el) {
        return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
      }

      function formatTime(date) {
        var h = date.getHours(), m = date.getMinutes();
        return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
      }

      function formatBytes(bytes) {
        if (!bytes || bytes === 0) return "0 B";
        var units = ["B", "KB", "MB", "GB"];
        var i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
      }

      function escapeHtml(str) {
        return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }

      function generateId() {
        return "id-" + Math.random().toString(36).slice(2, 10);
      }

      // --- Markdown renderer (zero-dependency, handles the main DeepSeek output patterns) ---
      function renderMarkdown(src) {
        if (!src) return "";
        // Normalise line endings
        var s = String(src).replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");

        // ------ Step 1: Extract fenced code blocks to placeholders ------
        var fences = [];
        s = s.replace(/\x60\x60\x60(\\S*)\\n?([\\s\\S]*?)\x60\x60\x60/g, function(_, lang, body) {
          var idx = fences.length;
          // Strip trailing newline from body
          var clean = body.replace(/\\n$/, "");
          var langLabel = lang ? '<span class="md-code-lang">' + escapeHtml(lang) + '</span>' : "";
          fences[idx] = langLabel + '<pre><code>' + escapeHtml(clean) + '</code></pre>';
          return "\x00FENCE" + idx + "\x00";
        });

        // ------ Step 2: Escape HTML in remaining text ------
        s = escapeHtml(s);

        // ------ Step 3: Inline code (backticks) ------
        // Common Markdown escape form for showing fence markers inline:
        // a two-marker code span can wrap a three-marker fence literal.
        // Handle that form before the generic two-marker rule.
        s = s.replace(/\x60\x60\\s?(\x60{3,})\\s?\x60\x60/g, function(_, code) {
          return '<code>' + code + '</code>';
        });
        s = s.replace(/\x60\x60([\\s\\S]*?)\x60\x60/g, function(_, code) {
          return '<code>' + code + '</code>';
        });
        s = s.replace(/\x60([^\x60\\n]+?)\x60/g, function(_, code) {
          return '<code>' + code + '</code>';
        });

        // ------ Step 4: Bold & Italic ------
        // bold+italic
        s = s.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
        s = s.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
        // bold
        s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
        s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
        // italic
        s = s.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
        s = s.replace(/_(.+?)_/g, '<em>$1</em>');

        // ------ Step 5: Images (before links, since pattern overlaps) ------
        s = s.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+"([^"]*)")?\\)/g,
          '<img src="$2" alt="$1" title="$3" style="max-width:100%">');

        // ------ Step 6: Links ------
        s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)(?:\\s+"([^"]*)")?\\)/g,
          '<a href="$2" title="$3" target="_blank" rel="noopener">$1</a>');

        // ------ Step 7: Auto-link bare URLs ------
        s = s.replace(/(https?:\\/\\/[^\\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

        // ------ Step 8: Split into lines, process block-level ------
        var lines = s.split("\\n");
        var out = [];
        var inList = null;   // "ul" | "ol" | null
        var inBlockquote = false;
        var i = 0;

        while (i < lines.length) {
          var raw = lines[i];

          // Blockquote
          if (/^&gt;/.test(raw)) {
            if (!inBlockquote) { out.push('<blockquote>'); inBlockquote = true; }
            var qtext = raw.replace(/^&gt;\\s?/, "");
            out.push('<p>' + (qtext || "&nbsp;") + '</p>');
            i++;
            continue;
          } else if (inBlockquote) {
            out.push('</blockquote>');
            inBlockquote = false;
            continue; // re-process this line
          }

          // HR
          if (/^(-{3,}|\\*{3,}|_{3,})\\s*$/.test(raw)) {
            flushList();
            out.push('<hr>');
            i++;
            continue;
          }

          // Heading
          var hMatch = raw.match(/^(#{1,6})\\s+(.+)/);
          if (hMatch) {
            flushList();
            var level = hMatch[1].length;
            out.push('<h' + level + '>' + hMatch[2] + '</h' + level + '>');
            i++;
            continue;
          }

          // Unordered list
          var ulMatch = raw.match(/^( {0,3})([-*+])\\s+(.+)/);
          if (ulMatch) {
            ensureList("ul");
            out.push('<li>' + ulMatch[3] + '</li>');
            i++;
            continue;
          }

          // Ordered list
          var olMatch = raw.match(/^( {0,3})(\\d+)\\.\\s+(.+)/);
          if (olMatch) {
            ensureList("ol");
            out.push('<li>' + olMatch[3] + '</li>');
            i++;
            continue;
          }

          // Not a list item – flush
          flushList();

          if (isTableStart(i)) {
            var table = readTable(i);
            out.push(table.html);
            i = table.next;
            continue;
          }

          if (isDiagramStart(i)) {
            var diagram = readDiagram(i);
            out.push('<pre class="md-diagram">' + diagram.lines.join("\\n") + '</pre>');
            i = diagram.next;
            continue;
          }

          // Empty line -> paragraph break
          if (/^\\s*$/.test(raw)) {
            i++;
            continue;
          }

          // Normal paragraph
          out.push('<p>' + raw + '</p>');
          i++;
        }

        flushList();
        if (inBlockquote) out.push('</blockquote>');

        var html = out.join("\\n");

        // ------ Step 9: Restore fenced code blocks ------
        html = html.replace(/\x00FENCE(\\d+)\x00/g, function(_, idx) {
          return fences[+idx] || "";
        });

        return html;

        function ensureList(type) {
          if (inList === type) return;
          if (inList) out.push('</' + inList + '>');
          inList = type;
          out.push('<' + type + '>');
        }
        function flushList() {
          if (inList) { out.push('</' + inList + '>'); inList = null; }
        }
        function isTableStart(index) {
          return index + 1 < lines.length &&
            isTableRow(lines[index]) &&
            isTableSeparator(lines[index + 1]) &&
            splitTableRow(lines[index]).length === splitTableRow(lines[index + 1]).length;
        }
        function readTable(index) {
          var header = splitTableRow(lines[index]);
          var rows = [];
          var cursor = index + 2;
          while (cursor < lines.length && isTableRow(lines[cursor])) {
            var row = splitTableRow(lines[cursor]);
            if (row.length !== header.length) break;
            rows.push(row);
            cursor++;
          }
          var html = '<table><thead><tr>' +
            header.map(function(cell) { return '<th>' + cell + '</th>'; }).join("") +
            '</tr></thead><tbody>' +
            rows.map(function(row) {
              return '<tr>' + row.map(function(cell) { return '<td>' + cell + '</td>'; }).join("") + '</tr>';
            }).join("") +
            '</tbody></table>';
          return { html: html, next: cursor };
        }
        function isTableRow(line) {
          var trimmed = line.trim();
          if (!trimmed || trimmed.indexOf("|") === -1) return false;
          if (/^[|\\s]+$/.test(trimmed)) return false;
          return splitTableRow(line).length >= 2;
        }
        function isTableSeparator(line) {
          var cells = splitTableRow(line);
          return cells.length >= 2 && cells.every(function(cell) {
            return /^:?-{3,}:?$/.test(cell.trim());
          });
        }
        function splitTableRow(line) {
          var trimmed = line.trim();
          if (trimmed.charAt(0) === "|") trimmed = trimmed.slice(1);
          if (trimmed.charAt(trimmed.length - 1) === "|") trimmed = trimmed.slice(0, -1);
          return trimmed.split("|").map(function(cell) { return cell.trim(); });
        }
        function isDiagramStart(index) {
          if (!looksLikeDiagramLine(lines[index])) return false;
          return index + 1 < lines.length && looksLikeDiagramLine(lines[index + 1]);
        }
        function readDiagram(index) {
          var collected = [];
          var cursor = index;
          while (cursor < lines.length) {
            var line = lines[cursor];
            if (/^\\s*$/.test(line)) {
              if (cursor + 1 < lines.length && looksLikeDiagramLine(lines[cursor + 1])) {
                collected.push(line);
                cursor++;
                continue;
              }
              break;
            }
            if (!looksLikeDiagramLine(line)) break;
            collected.push(line);
            cursor++;
          }
          return { lines: collected, next: cursor };
        }
        function looksLikeDiagramLine(line) {
          var trimmed = line.trim();
          if (!trimmed) return false;
          if (/^[|\\u2502\\u2503\\u2551\\u254e\\u254f]\\s*$/.test(trimmed)) return true;
          return /[\\u251c\\u2514\\u250c\\u2510\\u2518\\u252c\\u2534\\u253c\\u2500\\u2501\\u2502\\u2503\\u2551\\u254e\\u254f]/.test(trimmed) ||
            /^[|\\u2502\\u2503\\u2551\\u254e\\u254f]\\s*(?:[-+*]?>|[A-Za-z0-9_./"'{[(])/.test(trimmed);
        }
      }
    })();
  `;
