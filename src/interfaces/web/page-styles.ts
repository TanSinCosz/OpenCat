/** Web 页面样式；作为内联资源由 page.ts 组装，保留原有转义。 */


export const pageStyles = `
    /* ===== Theme Variables ===== */
    :root {
      --bg-primary: #0d1117;
      --bg-secondary: #161b22;
      --bg-tertiary: #21262d;
      --bg-inset: #0b0f14;
      --border-default: #30363d;
      --border-muted: #21262d;
      --text-primary: #e6edf3;
      --text-secondary: #8b949e;
      --text-muted: #6e7681;
      --accent-blue: #58a6ff;
      --accent-green: #3fb950;
      --accent-yellow: #f0b429;
      --accent-orange: #d29922;
      --accent-red: #f85149;
      --accent-purple: #a371f7;
      --accent-pink: #db61a2;
      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --transition-fast: 120ms ease;
      --transition-normal: 200ms ease;
    }

    *, *::before, *::after { box-sizing: border-box; }

    body {
      margin: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      font-family: var(--font-sans);
      background: var(--bg-primary);
      color: var(--text-primary);
      overflow: hidden;
    }

    /* ===== Scrollbar ===== */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

    /* ===== Top Bar ===== */
    #topbar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 16px;
      height: 44px;
      min-height: 44px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-default);
      z-index: 20;
    }
    #topbar-brand {
      font-weight: 700;
      font-size: 14px;
      color: var(--text-primary);
      letter-spacing: -0.2px;
      white-space: nowrap;
    }
    #topbar-brand span { color: var(--accent-blue); }
    #topbar-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text-secondary);
      white-space: nowrap;
    }
    #status-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--accent-green);
      flex-shrink: 0;
    }
    #status-dot.busy { background: var(--accent-orange); animation: pulse 1.2s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
    #topbar-info {
      font-size: 12px;
      color: var(--text-muted);
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #usage-badge,
    #projection-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      height: 24px;
      padding: 0 8px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      font-size: 11px;
      font-family: var(--font-mono);
      white-space: nowrap;
    }
    #usage-badge .hit { color: var(--accent-green); }
    #usage-badge .miss { color: var(--accent-orange); }
    #projection-badge.clean { display: none; }
    #projection-badge .active { color: var(--accent-orange); }
    #projection-badge .ok { color: var(--accent-green); }
    #topbar-actions {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }

    /* ===== Buttons ===== */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      height: 28px;
      padding: 0 10px;
      font-size: 12px;
      font-weight: 500;
      font-family: var(--font-sans);
      color: var(--text-secondary);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all var(--transition-fast);
      white-space: nowrap;
    }
    .btn:hover { color: var(--text-primary); background: #292e36; border-color: var(--text-muted); }
    .btn:active { background: #1c2128; }
    .btn:disabled { opacity: .4; pointer-events: none; }
    .btn-primary { color: #fff; background: #238636; border-color: #2ea043; }
    .btn-primary:hover { background: #2ea043; }
    .btn-danger { color: var(--accent-red); }
    .btn-icon { width: 28px; padding: 0; font-size: 15px; }

    /* ===== Layout ===== */
    #layout {
      display: flex;
      flex: 1;
      min-height: 0;
      position: relative;
    }

    /* ===== Sidebar ===== */
    #sidebar {
      width: 260px;
      min-width: 260px;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border-default);
      display: flex;
      flex-direction: column;
      transition: margin var(--transition-normal), opacity var(--transition-normal);
    }
    #sidebar.collapsed {
      margin-left: -260px;
      opacity: 0;
      pointer-events: none;
    }
    #sidebar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .6px;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border-muted);
    }
    #session-list {
      flex: 1 1 45%;
      min-height: 140px;
      overflow-y: auto;
      padding: 6px;
    }
    #swe-list {
      flex: 1 1 45%;
      min-height: 160px;
      overflow-y: auto;
      padding: 6px;
      border-top: 1px solid var(--border-muted);
    }
    .sidebar-section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 14px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .6px;
      color: var(--text-muted);
      border-top: 1px solid var(--border-muted);
      border-bottom: 1px solid var(--border-muted);
      flex-shrink: 0;
    }
    .session-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: background var(--transition-fast);
      font-size: 12px;
    }
    .session-item:hover { background: var(--bg-tertiary); }
    .session-item.active { background: #1f2937; border: 1px solid var(--border-default); }
    .session-item .id { font-family: var(--font-mono); font-size: 11px; color: var(--text-primary); word-break: break-all; }
    .session-item .date { font-size: 11px; color: var(--text-muted); }
    .session-item .meta { display: flex; gap: 8px; font-size: 10px; color: var(--text-secondary); margin-top: 2px; }
    .session-group-label {
      padding: 8px 8px 4px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .7px;
      color: var(--text-muted);
    }

    /* ===== Main Chat Area ===== */
    #main {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    #chat-container {
      flex: 1;
      min-height: 0;
      position: relative;
      overflow: hidden;
    }
    #chat {
      height: 100%;
      overflow-y: auto;
      padding: 16px 20px;
      scroll-behavior: smooth;
    }
    #welcome {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 12px;
      color: var(--text-muted);
      text-align: center;
      padding: 40px;
      pointer-events: none;
    }
    #welcome.hidden { display: none; }
    #welcome-icon { font-size: 40px; margin-bottom: 8px; }
    #welcome-title { font-size: 18px; font-weight: 600; color: var(--text-secondary); }
    #welcome-sub { font-size: 13px; max-width: 360px; line-height: 1.5; }
    #welcome-hint { font-size: 11px; color: var(--text-muted); margin-top: 8px; }

    /* ===== Messages ===== */
    .msg {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 16px;
      animation: fadeIn .2s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    .msg-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      font-weight: 600;
    }
    .msg-role {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px; height: 20px;
      border-radius: 50%;
      font-size: 11px;
    }
    .msg-role.user { background: var(--accent-blue); color: #fff; }
    .msg-role.assistant { background: var(--accent-purple); color: #fff; }
    .msg-role.error { background: var(--accent-red); color: #fff; }
    .msg-label { text-transform: uppercase; letter-spacing: .4px; }
    .msg-label.user { color: var(--accent-blue); }
    .msg-label.assistant { color: var(--accent-purple); }
    .msg-label.error { color: var(--accent-red); }
    .msg-time { font-weight: 400; color: var(--text-muted); margin-left: auto; }
    .msg-body {
      padding: 10px 14px;
      border-radius: var(--radius-md);
      font-size: 13px;
      line-height: 1.6;
      word-break: break-word;
      font-family: var(--font-sans);
    }
    .msg-body.streaming { white-space: pre-wrap; }
    .msg.user .msg-body { background: #1a2332; border: 1px solid #1f3550; margin-left: 28px; }
    .msg.assistant .msg-body { background: transparent; border: none; padding: 4px 0 4px 28px; }
    .msg.error .msg-body { background: #2d1114; border: 1px solid #4a1c1e; color: var(--accent-red); margin-left: 28px; }
    .msg-usage {
      margin: 4px 0 0 28px;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
    }
    .msg-usage .hit { color: var(--accent-green); }
    .msg-usage .miss { color: var(--accent-orange); }

    /* ---------- Markdown rendered content ---------- */
    .msg-body p { margin: 0 0 8px; }
    .msg-body p:last-child { margin-bottom: 0; }
    .msg-body h1, .msg-body h2, .msg-body h3, .msg-body h4, .msg-body h5, .msg-body h6 {
      margin: 14px 0 6px;
      font-weight: 600;
      line-height: 1.3;
      color: var(--text-primary);
    }
    .msg-body h1 { font-size: 1.25em; border-bottom: 1px solid var(--border-default); padding-bottom: 4px; }
    .msg-body h2 { font-size: 1.15em; border-bottom: 1px solid var(--border-muted); padding-bottom: 3px; }
    .msg-body h3 { font-size: 1.05em; }
    .msg-body h4 { font-size: 1em; color: var(--text-secondary); }
    .msg-body h5, .msg-body h6 { font-size: .95em; color: var(--text-muted); }

    .msg-body ul, .msg-body ol { margin: 0 0 8px; padding-left: 22px; }
    .msg-body li { margin-bottom: 2px; }
    .msg-body li > ul, .msg-body li > ol { margin-bottom: 0; margin-top: 2px; }

    .msg-body code {
      font-family: var(--font-mono);
      font-size: .88em;
      background: var(--bg-inset);
      border: 1px solid var(--border-default);
      border-radius: 3px;
      padding: 1px 5px;
      color: var(--accent-orange);
    }
    .msg-body pre {
      margin: 8px 0;
      border-radius: var(--radius-md);
      overflow: hidden;
    }
    .msg-body pre code {
      display: block;
      padding: 10px 14px;
      overflow-x: auto;
      font-size: .85em;
      line-height: 1.5;
      color: var(--text-primary);
      background: var(--bg-inset);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
    }
    .msg-body .md-code-lang {
      display: inline-block;
      padding: 3px 10px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .4px;
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }

    .msg-body blockquote {
      margin: 8px 0;
      padding: 4px 12px;
      border-left: 3px solid var(--accent-blue);
      color: var(--text-secondary);
      background: rgba(88,166,255,.05);
      border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    }
    .msg-body blockquote p { margin: 4px 0; }

    .msg-body hr { margin: 12px 0; border: none; border-top: 1px solid var(--border-default); }

    .msg-body strong { color: var(--text-primary); font-weight: 600; }
    .msg-body em { font-style: italic; }

    .msg-body a { color: var(--accent-blue); text-decoration: none; }
    .msg-body a:hover { text-decoration: underline; }

    .msg-body table { border-collapse: collapse; margin: 8px 0; width: 100%; font-size: .9em; }
    .msg-body th, .msg-body td { border: 1px solid var(--border-default); padding: 6px 10px; text-align: left; }
    .msg-body th { background: var(--bg-tertiary); font-weight: 600; }
    .msg-body .md-diagram {
      margin: 8px 0;
      padding: 0;
      background: transparent;
      border: none;
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.7;
      white-space: pre-wrap;
    }

    /* ===== Reasoning Block ===== */
    .reasoning-block {
      margin: 6px 0 4px 28px;
      border-left: 2px solid var(--text-muted);
      padding-left: 12px;
    }
    .reasoning-block summary {
      cursor: pointer;
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      padding: 4px 0;
      user-select: none;
    }
    .reasoning-block summary:hover { color: var(--text-secondary); }
    .reasoning-block pre {
      margin: 6px 0;
      font-size: 12px;
      color: var(--text-secondary);
      font-family: var(--font-mono);
      white-space: pre-wrap;
      max-height: 200px;
      overflow-y: auto;
      line-height: 1.5;
    }
    .reasoning-block .hidden-note {
      font-size: 11px;
      color: var(--text-muted);
      font-style: italic;
      margin-top: 2px;
    }

    /* ===== Tool Call Card ===== */
    .tool-card {
      margin: 4px 0 8px 28px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      overflow: hidden;
    }
    .tool-card summary {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 12px;
      user-select: none;
      transition: background var(--transition-fast);
    }
    .tool-card summary:hover { background: var(--bg-tertiary); }
    .tool-card .tool-indicator {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--accent-orange);
      flex-shrink: 0;
    }
    .tool-card .tool-indicator.done { background: var(--accent-green); }
    .tool-card .tool-indicator.blocked { background: var(--accent-yellow); }
    .tool-card .tool-name {
      font-weight: 600;
      color: var(--accent-orange);
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .tool-card .tool-status {
      margin-left: auto;
      font-size: 10px;
      color: var(--text-muted);
    }
    .tool-card .tool-status.done { color: var(--accent-green); }
    .tool-card .tool-status.blocked { color: var(--accent-yellow); }
    .tool-card .tool-input,
    .tool-card .tool-result {
      padding: 8px 12px 8px 28px;
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 180px;
      overflow-y: auto;
      border-top: 1px solid var(--border-muted);
      line-height: 1.45;
    }
    .tool-card .tool-result { color: var(--text-primary); }
    .tool-permission-actions {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    .tool-permission-actions button {
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-size: 11px;
      font-family: var(--font-mono);
      padding: 4px 8px;
      cursor: pointer;
    }
    .tool-permission-actions button:hover { border-color: var(--accent-blue); }
    .tool-permission-actions button.deny:hover { border-color: var(--accent-red); }
    #change-review-card {
      position: fixed;
      top: 54px;
      right: 18px;
      width: min(520px, calc(100vw - 36px));
      z-index: 70;
      display: none;
      background: var(--bg-secondary);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      box-shadow: 0 12px 36px rgba(0,0,0,.32);
      overflow: hidden;
    }
    #change-review-card.open { display: block; }
    #change-review-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-muted);
    }
    #change-review-icon {
      width: 28px;
      height: 28px;
      border: 1px solid var(--border-muted);
      border-radius: var(--radius-sm);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      flex-shrink: 0;
      font-family: var(--font-mono);
    }
    #change-review-title {
      flex: 1;
      min-width: 0;
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 600;
    }
    #change-review-totals {
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .diff-add { color: var(--accent-green); }
    .diff-del { color: var(--accent-red); }
    #change-review-actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    #change-review-files {
      padding: 8px 12px 10px 12px;
      display: grid;
      gap: 8px;
      max-height: 220px;
      overflow: auto;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .change-review-file {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: baseline;
      color: var(--text-secondary);
    }
    .change-review-path {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .projection-note {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin: 0 0 6px 0;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid var(--border-muted);
      background: rgba(88,166,255,.08);
      color: var(--accent-blue);
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .projection-note.compact { color: var(--accent-green); background: rgba(63,185,80,.08); }
    .projection-note.budget { color: var(--accent-orange); background: rgba(210,153,34,.08); }
    .projection-note.snip { color: var(--text-muted); background: rgba(139,148,158,.08); }
    .projection-pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--font-mono);
    }

    /* ===== Events Panel ===== */
    #events-panel {
      width: 360px;
      min-width: 360px;
      background: var(--bg-inset);
      border-left: 1px solid var(--border-default);
      display: flex;
      flex-direction: column;
      transition: width var(--transition-normal), min-width var(--transition-normal), opacity var(--transition-normal);
    }
    #events-panel.collapsed { width: 0; min-width: 0; opacity: 0; pointer-events: none; overflow: hidden; }
    #events-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .6px;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border-muted);
    }
    #events {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    #events pre {
      margin: 0 0 4px;
      font-size: 10px;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.4;
      padding: 6px 8px;
      background: var(--bg-primary);
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
    }
    #events pre:hover { border-color: var(--border-default); }

    /* ===== Input Area ===== */
    #input-area {
      padding: 12px 16px;
      border-top: 1px solid var(--border-default);
      background: var(--bg-secondary);
    }
    #form {
      display: flex;
      gap: 10px;
      align-items: flex-end;
    }
    #input-wrapper {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #prompt {
      width: 100%;
      min-height: 56px;
      max-height: 200px;
      resize: none;
      background: var(--bg-primary);
      color: var(--text-primary);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      padding: 10px 14px;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.5;
      outline: none;
      transition: border-color var(--transition-fast);
    }
    #prompt:focus { border-color: var(--accent-blue); box-shadow: 0 0 0 2px rgba(88,166,255,.15); }
    #prompt::placeholder { color: var(--text-muted); }
    #prompt:disabled { opacity: .5; cursor: not-allowed; background: var(--bg-inset); }
    #input-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10px;
      color: var(--text-muted);
      padding: 0 4px;
    }
    #char-count.warn { color: var(--accent-orange); }
    #send {
      height: 40px;
      padding: 0 20px;
      font-size: 13px;
      font-weight: 600;
      flex-shrink: 0;
    }
    #stop-btn { display: none; }
    #stop-btn.visible { display: inline-flex; }

    /* ===== Toast ===== */
    #toast {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #1f2937;
      color: var(--text-primary);
      border: 1px solid var(--border-default);
      padding: 8px 18px;
      border-radius: 20px;
      font-size: 12px;
      z-index: 100;
      pointer-events: none;
      opacity: 0;
      transition: opacity var(--transition-normal);
      font-family: var(--font-sans);
    }
    #toast.show { opacity: 1; }

    /* ===== Patch Diff Modal ===== */
    #patch-modal {
      position: fixed;
      inset: 52px 24px 24px 24px;
      z-index: 80;
      display: none;
      flex-direction: column;
      min-height: 0;
      background: var(--bg-secondary);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      box-shadow: 0 16px 50px rgba(0,0,0,.45);
    }
    #patch-modal.open { display: flex; }
    #patch-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-muted);
    }
    #patch-modal-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 600;
    }
    #patch-modal-actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    #patch-diff {
      flex: 1;
      margin: 0;
      padding: 12px;
      overflow: auto;
      white-space: pre;
      tab-size: 2;
      color: var(--text-primary);
      background: var(--bg-primary);
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.45;
    }
    .patch-line {
      display: block;
      min-height: 1.45em;
      padding: 0 8px;
      margin: 0 -4px;
      border-left: 2px solid transparent;
    }
    .patch-line.add {
      color: #8ee89f;
      background: rgba(34, 197, 94, .10);
      border-left-color: rgba(34, 197, 94, .85);
    }
    .patch-line.del {
      color: #ff9a9a;
      background: rgba(239, 68, 68, .12);
      border-left-color: rgba(239, 68, 68, .85);
    }
    .patch-line.hunk {
      color: #7dd3fc;
      background: rgba(56, 189, 248, .10);
      border-left-color: rgba(56, 189, 248, .75);
    }
    .patch-line.file {
      color: #facc15;
      background: rgba(250, 204, 21, .08);
      border-left-color: rgba(250, 204, 21, .75);
    }
    #patch-modal-footer {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 12px;
      border-top: 1px solid var(--border-muted);
      color: var(--text-muted);
      font-size: 11px;
      font-family: var(--font-mono);
    }

    /* ===== Responsive ===== */
    @media (max-width: 900px) {
      #sidebar { display: none; }
      #events-panel { width: 280px; min-width: 280px; }
    }
    @media (max-width: 640px) {
      #events-panel { display: none; }
      #topbar-info { display: none; }
      #usage-badge { display: none; }
      #projection-badge { display: none; }
      #chat { padding: 10px 12px; }
      #input-area { padding: 8px 10px; }
    }
  `;
