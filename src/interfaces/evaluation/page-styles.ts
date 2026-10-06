/** 看板样式；由 page.ts 内联组装，保留模板字符串转义。 */


export const dashboardStyles = `
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #151b23;
      --panel-2: #0f1620;
      --border: #2a3441;
      --text: #e6edf3;
      --muted: #8b949e;
      --good: #3fb950;
      --warn: #d29922;
      --bad: #f85149;
      --accent: #58a6ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: rgba(13, 17, 23, 0.96);
    }
    h1 { margin: 0; font-size: 16px; }
    select, button {
      color: var(--text);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 10px;
    }
    button { cursor: pointer; }
    main {
      display: grid;
      grid-template-columns: minmax(720px, 1fr) 420px;
      min-height: calc(100vh - 56px);
    }
    section { padding: 16px; }
    aside {
      border-left: 1px solid var(--border);
      background: var(--panel-2);
      min-width: 0;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(6, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .card {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 8px;
      padding: 10px;
      min-height: 72px;
    }
    .card .label { color: var(--muted); font-size: 12px; }
    .card .value { margin-top: 6px; font-size: 20px; font-weight: 700; }
    .card .sub { margin-top: 2px; color: var(--muted); font-size: 12px; }
    .version-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 34px;
      border: 1px solid rgba(88, 166, 255, 0.55);
      border-radius: 999px;
      padding: 3px 8px;
      color: var(--accent);
      background: rgba(88, 166, 255, 0.08);
      font-weight: 700;
    }
    .panel {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 8px;
      margin-bottom: 14px;
      overflow: hidden;
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: #111821;
    }
    .panel-title { font-weight: 700; }
    .item-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: #0f151d;
    }
    .config-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(160px, 1fr));
      gap: 10px;
      padding: 12px;
    }
    .config-item {
      min-width: 0;
    }
    .config-key {
      color: var(--muted);
      font-size: 12px;
    }
    .config-value {
      margin-top: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 12px;
    }
    .status-pill.tested {
      color: var(--good);
      border-color: rgba(63, 185, 80, 0.45);
      background: rgba(63, 185, 80, 0.08);
    }
    .status-pill.untested {
      color: var(--muted);
      border-color: var(--border);
    }
    .status-pill.ready {
      color: var(--good);
      border-color: rgba(63, 185, 80, 0.45);
      background: rgba(63, 185, 80, 0.08);
    }
    .status-pill.failed {
      color: var(--bad);
      border-color: rgba(248, 81, 73, 0.45);
      background: rgba(248, 81, 73, 0.08);
    }
    .status-pill.dirty {
      color: var(--warn);
      border-color: rgba(210, 153, 34, 0.45);
      background: rgba(210, 153, 34, 0.08);
    }
    .status-pill.wrong-head {
      color: var(--accent);
      border-color: rgba(88, 166, 255, 0.45);
      background: rgba(88, 166, 255, 0.08);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      border-bottom: 1px solid var(--border);
      padding: 8px 9px;
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      background: #111821;
    }
    tr[data-instance] { cursor: pointer; }
    tr[data-instance]:hover { background: #1b2430; }
    tr.selected { outline: 1px solid var(--accent); background: #142238; }
    .case-id { color: var(--accent); font-weight: 600; }
    .open-chat {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px 8px;
      background: #111821;
      color: var(--accent);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
    }
    .open-chat:hover { border-color: var(--accent); background: #142238; }
    .open-chat:disabled {
      cursor: progress;
      opacity: 0.65;
    }
    .problem-preview {
      max-width: 560px;
      white-space: normal;
      color: var(--muted);
    }
    .muted { color: var(--muted); }
    .good { color: var(--good); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .tools {
      max-width: 260px;
      white-space: normal;
      color: var(--muted);
    }
    .side-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
    }
    .view-tabs {
      display: flex;
      gap: 6px;
      margin-bottom: 10px;
    }
    .view-tabs button.active {
      border-color: var(--accent);
      background: #142238;
    }
    .chat {
      display: flex;
      flex-direction: column;
      gap: 10px;
      overflow: auto;
      max-height: calc(100vh - 164px);
      padding-right: 4px;
    }
    .bubble {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      background: var(--panel);
    }
    .bubble.user { border-color: #245a9f; background: #132033; }
    .bubble.assistant { border-color: #5d3fb0; }
    .bubble.tool { border-color: #2e7d45; background: #101b15; }
    .bubble.system { border-color: #755d24; background: #1b1710; }
    .bubble-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 7px;
      text-transform: uppercase;
    }
    .bubble-body {
      white-space: pre-wrap;
      word-break: break-word;
    }
    details.reasoning {
      margin-top: 8px;
      color: var(--muted);
      border-left: 2px solid var(--border);
      padding-left: 8px;
    }
    details.reasoning summary {
      cursor: pointer;
    }
    .usage-line {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    pre {
      margin: 0;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #090d13;
      overflow: auto;
      max-height: calc(100vh - 130px);
      white-space: pre-wrap;
      word-break: break-word;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    @media (max-width: 1100px) {
      main { grid-template-columns: 1fr; }
      aside { border-left: 0; border-top: 1px solid var(--border); }
      .cards { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .config-grid { grid-template-columns: repeat(2, minmax(160px, 1fr)); }
    }
  `;
