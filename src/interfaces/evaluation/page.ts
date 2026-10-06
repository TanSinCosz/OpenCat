/** 看板 HTML 骨架；页面资源与服务逻辑分别维护。 */
import type { DashboardOptions } from "./options.js";
import { dashboardStyles } from "./page-styles.js";
import { renderDashboardScript } from "./client-script.js";

export function renderDashboardHtml(options: DashboardOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenCat SWE Eval Dashboard</title>
  <style>${dashboardStyles}</style>
</head>
<body>
  <header>
    <h1>OpenCat SWE Eval</h1>
    <select id="runSelect"></select>
    <span id="versionBadge" class="version-badge">v1</span>
    <button id="refreshButton">Refresh</button>
    <span id="runMeta" class="muted"></span>
  </header>
  <main>
    <section>
      <div id="cards" class="cards"></div>
      <div class="panel">
        <div class="panel-head">
          <span class="panel-title">Eval Config</span>
          <span id="datasetMeta" class="muted"></span>
        </div>
        <div id="configGrid" class="config-grid"></div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <span class="panel-title">Dataset Items</span>
          <span>
            <button id="prepareAllButton" type="button">Prepare All</button>
            <span id="itemMeta" class="muted"></span>
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Repo</th>
              <th>Tested</th>
              <th>Status</th>
              <th>Cache</th>
              <th>Tokens</th>
              <th>Problem</th>
              <th>Chat</th>
            </tr>
          </thead>
          <tbody id="itemRows"></tbody>
        </table>
      </div>
    </section>
    <aside>
      <section>
        <div class="side-head">
          <strong id="sideTitle">Conversation</strong>
          <button id="loadEventsButton">Refresh</button>
        </div>
        <div class="view-tabs">
          <button id="conversationTab" class="active">Conversation</button>
          <button id="eventsTab">Events</button>
        </div>
        <div id="conversationBox" class="chat">Select a case to inspect the conversation.</div>
        <pre id="eventsBox" hidden>Select a case to inspect raw events.</pre>
      </section>
    </aside>
  </main>
  <script>${renderDashboardScript(options)}</script>
</body>
</html>`;
}
