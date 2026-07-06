import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join, parse } from "node:path";

import { loadConfig } from "./config/load-config.js";
import { createMemoryConfig } from "./Memory/config.js";
import { closeMcpConnections } from "./mcp/index.js";
import { createToolsWithConfiguredMcp } from "./mcp/config.js";
import { query } from "./query.js";
import {
  loadStateFromTranscript,
  recordTranscriptMessage,
} from "./transcript/persistence.js";
import { createMessage, type Message } from "./types/messages.js";
import { createRuntime, type Runtime } from "./types/runtime.js";
import { createState, type State } from "./types/state.js";
import type { QueryEvent } from "./query/types.js";
import type { DeepSeekAssistantMessage } from "./deepseek/types.js";
import { formatErrorForUser } from "./deepseek/errors.js";
import { createSessionId } from "./utils/session.js";

const DEFAULT_PORT = 5177;
const MAX_BODY_BYTES = 256 * 1024;
const TRANSCRIPT_DIR = ".opencat/transcripts";
const MAX_SESSION_HISTORY_MESSAGES = 200;
const MAX_HISTORY_TOOL_CHARS = 2_000;
const MAX_HISTORY_REASONING_CHARS = 4_000;

type TranscriptHydrationMode = "auto" | "full";

interface WebCliSession {
  runtime: Runtime;
  state: State;
  busy: boolean;
  loadInfo: WebCliSessionLoadInfo;
}

interface WebCliSessionLoadInfo {
  restored: boolean;
  requestedSessionId?: string;
  transcriptPath?: string;
  hydrate: TranscriptHydrationMode;
  messageCount: number;
}

interface WebCliTranscriptSummary {
  sessionId: string;
  modifiedAt: number;
  size: number;
}

let session = await createWebCliSession({
  sessionId: await resolveInitialSessionId(process.cwd()),
  resume: true,
});

interface CreateWebCliSessionOptions {
  sessionId?: string;
  resume: boolean;
}

async function createWebCliSession(
  options: CreateWebCliSessionOptions,
): Promise<WebCliSession> {
  const { tools, mcpConnections } = await createToolsWithConfiguredMcp(process.cwd());
  const runtime = createRuntime({
    cwd: process.cwd(),
    sessionId: options.sessionId,
    deepSeekRuntimeConfig: loadConfig(),
    MemoryConfig: createMemoryConfig({ cwd: process.cwd() }),
    longTermMemoryConfig: {
      autoInject: true,
      autoExtract: true,
    },
    tools,
    mcpConnections,
  });
  const hydrate = getTranscriptHydrationMode();
  const restored = options.resume && runtime.transcriptStore
    ? await loadStateFromTranscript(runtime.transcriptStore, { hydrate })
    : null;
  const state = restored ?? createState();


  return {
    runtime,
    state,
    busy: false,
    loadInfo: {
      restored: Boolean(restored),
      requestedSessionId: options.sessionId,
      transcriptPath: runtime.transcriptStore?.path,
      hydrate,
      messageCount: state.Messages.length,
    },
  };
}

async function resolveInitialSessionId(cwd: string): Promise<string | undefined> {
  const configured = process.env.OPENCAT_SESSION_ID?.trim();
  if (configured) {
    return configured;
  }

  if (process.env.OPENCAT_RESUME_SESSION === "0" ||
    process.env.OPENCAT_RESUME_SESSION === "false") {
    return undefined;
  }

  return findLatestMainTranscriptSessionId(cwd);
}

async function findLatestMainTranscriptSessionId(
  cwd: string,
): Promise<string | undefined> {
  return (await listMainTranscriptSessions(cwd)).at(0)?.sessionId;
}

async function listMainTranscriptSessions(
  cwd: string,
): Promise<WebCliTranscriptSummary[]> {
  const directory = join(cwd, TRANSCRIPT_DIR);

  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const path = join(directory, entry.name);
          const fileStat = await stat(path);
          return {
            sessionId: parse(entry.name).name,
            modifiedAt: fileStat.mtimeMs,
            size: fileStat.size,
          };
        }),
    );

    return candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  } catch {
    return [];
  }
}

function getTranscriptHydrationMode(): TranscriptHydrationMode {
  return process.env.OPENCAT_TRANSCRIPT_HYDRATE === "full" ? "full" : "auto";
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/session") {
      sendJson(response, {
        sessionId: session.runtime.sessionId,
        model: session.runtime.deepSeekRuntimeConfig.model,
        messageCount: session.state.Messages.length,
        tools: session.runtime.tools.map((tool) => tool.name),
        usage: session.runtime.usage,
        busy: session.busy,
        restored: session.loadInfo.restored,
        hydrate: session.loadInfo.hydrate,
        transcriptPath: session.loadInfo.transcriptPath,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      sendJson(response, {
        sessions: await listMainTranscriptSessions(process.cwd()),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/session/messages") {
      const messages = session.state.Messages.slice(-MAX_SESSION_HISTORY_MESSAGES)
        .map(normalizeSessionHistoryMessage)
        .filter((message) => message !== null);
      sendJson(response, {
        messages,
        total: session.state.Messages.length,
        truncated: session.state.Messages.length > MAX_SESSION_HISTORY_MESSAGES,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/query") {
      await handleQuery(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/load") {
      if (session.busy) {
        sendJson(response, { error: "A query is already running." }, 409);
        return;
      }

      const body = await readJsonBody<{ sessionId?: unknown }>(request);
      const sessionId = typeof body.sessionId === "string"
        ? body.sessionId.trim()
        : "";
      const available = await listMainTranscriptSessions(process.cwd());

      if (!available.some((candidate) => candidate.sessionId === sessionId)) {
        sendJson(response, { error: "Session transcript not found." }, 404);
        return;
      }

      await replaceSession({ sessionId, resume: true });
      sendJson(response, {
        ok: true,
        sessionId: session.runtime.sessionId,
        messageCount: session.state.Messages.length,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/reset") {
      await resetSession();
      sendJson(response, { ok: true, sessionId: session.runtime.sessionId });
      return;
    }

    sendText(response, 404, "Not found");
  } catch (error) {
    sendJson(response, {
      error: stringifyError(error),
    }, 500);
  }
});

const port = Number(process.env.OPENCAT_WEB_PORT ?? DEFAULT_PORT);
server.listen(port, () => {
  console.log(`OpenCat debug web CLI: http://localhost:${port}`);
  console.log(`Session: ${session.runtime.sessionId}`);
  console.log(`Model: ${session.runtime.deepSeekRuntimeConfig.model}`);
  console.log(
    session.loadInfo.restored
      ? `Restored transcript: ${session.loadInfo.transcriptPath}`
      : "Started a new transcript session.",
  );
});

async function handleQuery(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (session.busy) {
    sendJson(response, { error: "A query is already running." }, 409);
    return;
  }

  const body = await readJsonBody<{ prompt?: unknown; includeRawEvents?: unknown }>(request);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  if (!prompt) {
    sendJson(response, { error: "Missing prompt." }, 400);
    return;
  }

  session.busy = true;
  const previousAbortController = session.runtime.toolUseContext.abortController;
  const queryAbortController = new AbortController();
  session.runtime.toolUseContext.abortController = queryAbortController;
  let responseCompleted = false;
  const abortQuery = () => {
    if (!responseCompleted && !queryAbortController.signal.aborted) {
      queryAbortController.abort(new Error("Web client disconnected."));
    }
  };
  request.once("aborted", abortQuery);
  response.once("close", abortQuery);

  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  try {
    const userMessage = createMessage({
      role: "user",
      content: prompt,
    });
    session.state.Messages.push(userMessage);
    await recordTranscriptMessage(session.runtime, userMessage);

    writeEvent(response, {
      type: "user_message",
      id: userMessage.id,
      messageCount: session.state.Messages.length,
    });

    for await (const event of query(session.runtime, session.state)) {
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
    session.busy = false;
    session.runtime.toolUseContext.abortController = previousAbortController;
    request.off("aborted", abortQuery);
    response.off("close", abortQuery);
    responseCompleted = true;
    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
  }
}

function normalizeQueryEvent(
  event: QueryEvent,
  includeRawEvents: boolean,
): unknown | undefined {
  if (includeRawEvents) {
    return event;
  }

  switch (event.type) {
    case "context_ready":
      {
        const serializedMessages = JSON.stringify(event.messages);
        return {
          type: event.type,
          systemPromptChars: event.systemPrompt.length,
          messageCount: event.messages.length,
          hasLongTermMemory: serializedMessages.includes("<long_term_memory>"),
          hasSessionMemory: serializedMessages.includes("<session_memory>"),
          hasLocalCompactSummary: serializedMessages.includes("<local_compact_summary>"),
          hasToolResultBudget: serializedMessages.includes("<tool-result-budget>"),
          hasToolResultCompact: serializedMessages.includes("<tool-result-compact>"),
          hasHistorySnipMarker: serializedMessages.includes("[History snipped:"),
        };
      }
    case "model_stream_event":
      return undefined;
    case "model_usage":
      return {
        type: event.type,
        promptTokens: event.usage.prompt_tokens,
        completionTokens: event.usage.completion_tokens,
        totalTokens: event.usage.total_tokens,
        promptCacheHitTokens: event.usage.prompt_cache_hit_tokens ?? 0,
        promptCacheMissTokens: event.usage.prompt_cache_miss_tokens ?? 0,
        sessionPromptTokens: event.sessionUsage.promptTokens,
        sessionCompletionTokens: event.sessionUsage.completionTokens,
        sessionTotalTokens: event.sessionUsage.totalTokens,
        sessionPromptCacheHitTokens: event.sessionUsage.promptCacheHitTokens,
        sessionPromptCacheMissTokens: event.sessionUsage.promptCacheMissTokens,
      };
    case "assistant_message":
      return {
        type: event.type,
        message: normalizeAssistantMessageForWeb(event.message),
        usage: event.usage,
      };
    case "tool_result":
      {
        const content = typeof event.message.content === "string"
          ? event.message.content
          : "";

        return {
          type: event.type,
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.function.name,
          contentChars: content.length,
          contentPreview: previewText(content),
        };
      }
    default:
      return event;
  }
}

function previewText(value: string, maxChars = 500): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}... [${value.length - maxChars} chars hidden]`;
}

function normalizeAssistantMessageForWeb(
  message: DeepSeekAssistantMessage,
): unknown {
  const reasoningContent = message.reasoning_content ?? "";

  return {
    ...message,
    reasoning_content: reasoningContent
      ? previewText(reasoningContent, MAX_HISTORY_REASONING_CHARS)
      : reasoningContent,
    reasoning_content_chars: reasoningContent.length,
  };
}

async function resetSession(): Promise<void> {
  await replaceSession({
    sessionId: createSessionId(),
    resume: false,
  });
}

async function replaceSession(options: CreateWebCliSessionOptions): Promise<void> {
  closeMcpConnections(session.runtime.mcpConnections);
  session = await createWebCliSession(options);
}

function normalizeSessionHistoryMessage(message: Message): unknown | null {
  if (isHiddenRuntimeContextMessage(message)) {
    return null;
  }

  switch (message.role) {
    case "system":
      return null;
    case "user":
      return {
        role: message.role,
        content: message.content,
      };
    case "assistant":
      {
        const reasoningContent = message.reasoning_content ?? "";
        return {
          role: message.role,
          content: typeof message.content === "string" ? message.content : "",
          reasoningContent: previewText(
            reasoningContent,
            MAX_HISTORY_REASONING_CHARS,
          ),
          reasoningChars: reasoningContent.length,
          toolCalls: message.tool_calls ?? [],
          usage: message.usage,
        };
      }
    case "tool":
      return {
        role: message.role,
        toolCallId: message.tool_call_id,
        toolName: message.toolName,
        contentPreview: previewText(message.content, MAX_HISTORY_TOOL_CHARS),
      };
  }
}

function isHiddenRuntimeContextMessage(message: Message): boolean {
  return message.source === "runtime" ||
    (message.role === "user" && message.name === "opencat_context");
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function writeEvent(response: ServerResponse, event: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }

  response.write(`${JSON.stringify(event)}\n`);
}

function sendHtml(response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(renderHtml());
}

function sendJson(
  response: ServerResponse,
  value: unknown,
  statusCode = 200,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  text: string,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(text);
}

function stringifyError(error: unknown): string {
  return formatErrorForUser(error);
}

function renderHtml(): string {
  const nonce = randomUUID();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCat</title>
  <style nonce="${nonce}">
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
    #usage-badge {
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
      flex: 1;
      overflow-y: auto;
      padding: 6px;
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

    /* ===== Responsive ===== */
    @media (max-width: 900px) {
      #sidebar { display: none; }
      #events-panel { width: 280px; min-width: 280px; }
    }
    @media (max-width: 640px) {
      #events-panel { display: none; }
      #topbar-info { display: none; }
      #usage-badge { display: none; }
      #chat { padding: 10px 12px; }
      #input-area { padding: 8px 10px; }
    }
  </style>
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
    <div id="topbar-actions">
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

  <script nonce="${nonce}">
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
      const clearEventsButton = document.querySelector("#clear-events");
      const sidebarToggle = document.querySelector("#sidebar-toggle");
      const eventsToggle = document.querySelector("#events-toggle");
      const sidebar = document.querySelector("#sidebar");
      const eventsPanel = document.querySelector("#events-panel");
      const statusDot = document.querySelector("#status-dot");
      const statusText = document.querySelector("#status-text");
      const topbarInfo = document.querySelector("#topbar-info");
      const usageBadge = document.querySelector("#usage-badge");
      const charCount = document.querySelector("#char-count");
      const modelBadge = document.querySelector("#model-badge");
      const toast = document.querySelector("#toast");
      const refreshSessionsBtn = document.querySelector("#refresh-sessions");

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
      let isBusy = false;
      let isSessionLoading = false;
      let abortController = null;
      let latestUsage = null;
      let currentQueryUsage = null;
      let currentQueryRequestCount = 0;
      let currentQueryUsageBody = null;
      let eventLog = [];
      const toolMessages = new Map();

      // --- Init ---
      init();

      async function init() {
        try {
          await refreshSession(true);
        } finally {
          setBusy(false);
          updateCharCount();
          promptInput.focus();
        }
      }

      // --- Toast ---
      function showToast(text, ms) {
        toast.textContent = text;
        toast.classList.add("show");
        setTimeout(function() { toast.classList.remove("show"); }, ms || 1800);
      }

      // --- Char count ---
      promptInput.addEventListener("input", updateCharCount);
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

      // --- Form submit ---
      form.addEventListener("submit", async function(event) {
        event.preventDefault();
        if (isBusy) return;
        var prompt = promptInput.value.trim();
        if (!prompt) return;

        hideWelcome();
        appendMessage("user", prompt);
        promptInput.value = "";
        promptInput.style.height = "auto";
        updateCharCount();
        currentAssistant = appendMessage("assistant", "");
        currentReasoning = null;
        reasoningTextBuffer = "";
        resetCurrentQueryUsage(currentAssistant);
        setBusy(true);

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
          setBusy(false);
          abortController = null;
          promptInput.focus();
          try { await refreshSession(); } catch (e) { /* ignore */ }
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
          abortController.abort();
          showToast("Stopped");
        }
      });

      // --- Reset ---
      resetButton.addEventListener("click", async function() {
        if (isBusy || isSessionLoading) return;
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
            sessions.unshift({ sessionId: selectedSessionId, modifiedAt: Date.now(), size: 0 });
          }

          sessionList.textContent = "";

          for (var i = 0; i < sessions.length; i++) {
            var item = sessions[i];
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
        } catch (e) {
          // ignore
        }
      }

      async function loadSession(sessionId) {
        if (!sessionId || sessionId === currentSessionId || isBusy || isSessionLoading) return;
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

      // --- History rendering ---
      async function renderSessionHistory() {
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

          scrollToBottom(chat);
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
          case "tool_result":
            completeToolUse(event);
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
        entry.indicator.classList.add("done");
        entry.status.classList.add("done");
        entry.status.textContent = "done";
        entry.details.open = false;
        scrollToBottom(chat);
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
        resetButton.disabled = value;
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
        statusText.textContent = value ? "loading session" : (isBusy ? "streaming" : "ready");
      }

      function restoreInputReadyState() {
        if (isBusy || isSessionLoading) return;
        promptInput.disabled = false;
        sendButton.disabled = false;
        resetButton.disabled = false;
        stopButton.classList.remove("visible");
        statusDot.classList.remove("busy");
        statusText.textContent = "ready";
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

      function normalizeUsage(usage) {
        if (!usage) return null;
        return {
          promptTokens: Number(usage.promptTokens || usage.prompt_tokens || 0),
          completionTokens: Number(usage.completionTokens || usage.completion_tokens || 0),
          totalTokens: Number(usage.totalTokens || usage.total_tokens || 0),
          promptCacheHitTokens: Number(usage.promptCacheHitTokens || usage.prompt_cache_hit_tokens || 0),
          promptCacheMissTokens: Number(usage.promptCacheMissTokens || usage.prompt_cache_miss_tokens || 0),
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

      function scrollToBottom(el) {
        el.scrollTop = el.scrollHeight;
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
  </script>
</body>
</html>`;
}
