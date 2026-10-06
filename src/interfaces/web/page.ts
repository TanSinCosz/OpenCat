/** 页面 HTML 骨架；服务端逻辑、样式和浏览器脚本分别维护。 */
import { randomUUID } from "node:crypto";
import { pageStyles } from "./page-styles.js";
import { clientScript } from "./client-script.js";

export function renderHtml(): string {
  const nonce = randomUUID();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCat</title>
  <style nonce="${nonce}">${pageStyles}</style>
</head>
<body>
  <!-- Top Bar -->
  <header id="topbar">
    <button id="sidebar-toggle" class="btn btn-icon" title="Toggle sessions sidebar">&#9776;</button>
    <div id="topbar-brand">Open<span>Cat</span></div>
    <div id="topbar-status">
      <span id="status-dot"></span>
      <span id="status-text">ready</span>
    </div>
    <div id="topbar-info">loading...</div>
    <div id="usage-badge" title="Session token usage and prompt cache hit rate">usage --</div>
    <div id="projection-badge" class="clean" title="Context projection compression status">projection clean</div>
    <div id="topbar-actions">
      <button id="patch-diff-btn" class="btn" type="button" title="Show current workspace git diff">Diff</button>
      <button id="export-patch-btn" class="btn" type="button" title="Export current SWE worktree diff" disabled>Export Patch</button>
      <button id="events-toggle" class="btn" title="Toggle events panel">Events</button>
      <label class="btn" title="Show raw stream events" style="cursor:pointer">
        <input id="raw" type="checkbox" style="margin:0"> raw
      </label>
      <button id="reset-btn" class="btn btn-danger" title="Start a new session">New</button>
    </div>
  </header>

  <!-- Layout -->
  <div id="layout">
    <!-- Sidebar -->
    <aside id="sidebar">
      <div id="sidebar-header">
        <span>Sessions</span>
        <button id="refresh-sessions" class="btn" style="height:22px;padding:0 6px;font-size:10px">&#8635;</button>
      </div>
      <div id="session-list"></div>
      <div style="padding:8px;border-top:1px solid var(--border-muted);font-size:10px;color:var(--text-muted);text-align:center">
        &darr; Click a session to load &darr;
      </div>
      <div class="sidebar-section-header">
        <span>SWE Items</span>
        <button id="refresh-swe" class="btn" style="height:22px;padding:0 6px;font-size:10px">&#8635;</button>
      </div>
      <div id="swe-list"></div>
    </aside>

    <!-- Main Chat -->
    <div id="main">
      <div id="chat-container">
        <div id="chat"></div>
        <div id="welcome">
          <div id="welcome-icon">&#128049;</div>
          <div id="welcome-title">OpenCat</div>
          <div id="welcome-sub">AI coding agent powered by DeepSeek. Ask questions, run tools, edit files, and build software.</div>
          <div id="welcome-hint">Shift+Enter for newline &middot; Enter to send &middot; Ctrl+Enter to force send</div>
        </div>
      </div>
      <div id="input-area">
        <form id="form">
          <div id="input-wrapper">
            <textarea id="prompt" rows="2" placeholder="Type your prompt here..." autofocus></textarea>
            <div id="input-meta">
              <span id="model-badge"></span>
              <span id="char-count">0</span>
            </div>
          </div>
          <button id="send" class="btn btn-primary" type="submit">Send</button>
          <button id="stop-btn" class="btn btn-danger" type="button" title="Stop generation">Stop</button>
        </form>
      </div>
    </div>

    <!-- Events Panel -->
    <aside id="events-panel">
      <div id="events-header">
        <span>Events</span>
        <button id="clear-events" class="btn" style="height:22px;padding:0 6px;font-size:10px">Clear</button>
      </div>
      <div id="events"></div>
    </aside>
  </div>

  <!-- Toast -->
  <div id="toast"></div>

  <!-- Change Review Card -->
  <div id="change-review-card" aria-hidden="true">
    <div id="change-review-header">
      <div id="change-review-icon">+/-</div>
      <div>
        <div id="change-review-title">Edited files</div>
        <div id="change-review-totals"></div>
      </div>
      <div id="change-review-actions">
        <button id="change-review-dismiss" class="btn" type="button" title="Hide this review card">Dismiss</button>
        <button id="change-review-open" class="btn" type="button" title="Open full diff review">Review</button>
      </div>
    </div>
    <div id="change-review-files"></div>
  </div>

  <!-- Patch Diff Modal -->
  <div id="patch-modal" aria-hidden="true">
    <div id="patch-modal-header">
      <div id="patch-modal-title">Workspace Diff</div>
      <div id="patch-modal-actions">
        <button id="patch-refresh-btn" class="btn" type="button">Refresh</button>
        <button id="patch-save-btn" class="btn" type="button">Save Snapshot</button>
        <button id="patch-apply-btn" class="btn" type="button">Apply Latest</button>
        <button id="patch-revert-btn" class="btn btn-danger" type="button">Revert Current</button>
        <button id="patch-approve-btn" class="btn btn-primary" type="button">Mark Approved</button>
        <button id="patch-close-btn" class="btn" type="button">Close</button>
      </div>
    </div>
    <pre id="patch-diff">Loading...</pre>
    <div id="patch-modal-footer">
      <span id="patch-status">-</span>
      <span id="patch-path">-</span>
    </div>
  </div>

  <script nonce="${nonce}">${clientScript}</script>
</body>
</html>`;
}
