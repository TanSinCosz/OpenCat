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
    },
    tools,
    mcpConnections,
  });
  const hydrate = getTranscriptHydrationMode();
  const restored = options.resume && runtime.transcriptStore
    ? await loadStateFromTranscript(runtime.transcriptStore, { hydrate })
    : null;
  const state = restored ?? createState();

  runtime.toolUseContext.messages = state.Messages;

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
    session.runtime.toolUseContext.messages = session.state.Messages;

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
    writeEvent(response, {
      type: "error",
      error: stringifyError(error),
    });
  } finally {
    session.busy = false;
    response.end();
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
      return {
        type: event.type,
        systemPromptChars: event.systemPrompt.length,
        messageCount: event.messages.length,
      };
    case "model_stream_event":
      return undefined;
    case "assistant_message":
      return {
        type: event.type,
        message: normalizeAssistantMessageForWeb(event.message),
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
  <title>OpenCat Debug CLI</title>
  <style nonce="${nonce}">
    body { margin: 0; height: 100vh; display: flex; flex-direction: column; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: #111; color: #eee; }
    header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 12px; border-bottom: 1px solid #333; }
    main { display: grid; grid-template-columns: minmax(0, 1fr) 420px; flex: 1; min-height: 0; }
    #chat, #events { overflow: auto; padding: 12px; }
    #events { border-left: 1px solid #333; background: #0b0b0b; }
    form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #333; }
    textarea { flex: 1; min-height: 72px; resize: vertical; background: #191919; color: #eee; border: 1px solid #444; padding: 8px; }
    button, label, select { background: #222; color: #eee; border: 1px solid #555; padding: 8px 10px; }
    label { display: inline-flex; gap: 6px; align-items: center; }
    select { min-width: 220px; max-width: 360px; }
    button:disabled, textarea:disabled, select:disabled { opacity: .6; }
    .pane { display: flex; min-height: 0; flex-direction: column; }
    .message { white-space: pre-wrap; border-bottom: 1px solid #262626; padding: 10px 0; }
    .role { color: #8ab4f8; }
    .reasoning { margin-top: 8px; color: #9aa0a6; }
    .reasoning summary { cursor: pointer; color: #9aa0a6; }
    .reasoning pre { margin: 8px 0 0 16px; color: #8d949e; max-height: 260px; overflow: auto; }
    .reasoning .hidden { margin: 6px 0 0 16px; color: #777; }
    .tool { color: #fbbc04; }
    .tool-message { padding: 0; }
    .tool-message summary { cursor: pointer; padding: 10px 0; }
    .tool-name { margin-left: 8px; color: #eee; }
    .tool-detail { margin: 0 0 10px 20px; color: #aaa; }
    .tool-result { color: #c9d1d9; }
    .error { color: #ff7b72; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0 0 10px; color: #aaa; }
    .meta { color: #999; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <strong>OpenCat Debug CLI</strong>
    <span id="session" class="meta">loading...</span>
    <select id="session-select" aria-label="Session"></select>
    <button id="load-session" type="button">load</button>
    <button id="reset" type="button">reset</button>
    <button id="clear-events" type="button">clear events</button>
    <label><input id="raw" type="checkbox"> raw events</label>
  </header>
  <main>
    <section class="pane">
      <div id="chat"></div>
      <form id="form">
        <textarea id="prompt" placeholder="Type a prompt. Shift+Enter for newline. Enter to send."></textarea>
        <button id="send" type="submit">send</button>
      </form>
    </section>
    <section id="events"></section>
  </main>
  <script nonce="${nonce}">
    const chat = document.querySelector("#chat");
    const events = document.querySelector("#events");
    const form = document.querySelector("#form");
    const promptInput = document.querySelector("#prompt");
    const sendButton = document.querySelector("#send");
    const rawInput = document.querySelector("#raw");
    const resetButton = document.querySelector("#reset");
    const sessionSelect = document.querySelector("#session-select");
    const loadSessionButton = document.querySelector("#load-session");
    const clearEventsButton = document.querySelector("#clear-events");
    const sessionLabel = document.querySelector("#session");
    const MAX_EVENT_NODES = 160;
    const MAX_EVENT_TEXT_CHARS = 12000;
    const MAX_REASONING_RENDER_CHARS = 4000;

    let currentAssistant = null;
    let currentReasoning = null;
    let reasoningTextBuffer = "";
    let reasoningRenderFrame = 0;
    let assistantTextBuffer = "";
    let assistantRenderFrame = 0;
    let currentSessionId = "";
    const toolMessages = new Map();

    init();

    async function init() {
      await refreshSession(true);
      promptInput.focus();
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const prompt = promptInput.value.trim();
      if (!prompt) return;

      appendMessage("user", prompt);
      promptInput.value = "";
      currentAssistant = appendMessage("assistant", "");
      currentReasoning = null;
      reasoningTextBuffer = "";
      setBusy(true);

      try {
        const response = await fetch("/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            includeRawEvents: rawInput.checked,
          }),
        });

        if (!response.ok || !response.body) {
          appendMessage("error", await response.text());
          return;
        }

        await readNdjson(response.body, handleServerEvent);
        flushAssistantText();
        flushReasoningText();
      } catch (error) {
        appendMessage("error", String(error));
      } finally {
        flushAssistantText();
        flushReasoningText();
        setBusy(false);
        await refreshSession();
      }
    });

    promptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    resetButton.addEventListener("click", async () => {
      await fetch("/api/reset", { method: "POST" });
      events.textContent = "";
      await refreshSession(true);
    });

    loadSessionButton.addEventListener("click", async () => {
      const sessionId = sessionSelect.value;
      if (!sessionId || sessionId === currentSessionId) return;

      setBusy(true);
      try {
        const response = await fetch("/api/session/load", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });

        if (!response.ok) {
          appendMessage("error", await response.text());
          return;
        }

        events.textContent = "";
        await refreshSession(true);
      } finally {
        setBusy(false);
      }
    });

    clearEventsButton.addEventListener("click", () => {
      events.textContent = "";
    });

    async function refreshSession(reloadHistory = false) {
      const response = await fetch("/api/session");
      const session = await response.json();
      currentSessionId = session.sessionId;
      sessionLabel.textContent = [
        "session=" + session.sessionId,
        "model=" + session.model,
        "messages=" + session.messageCount,
        "tools=" + session.tools.length,
        session.restored ? "restored" : "new",
        "hydrate=" + session.hydrate,
      ].join(" | ");
      await refreshSessionList(session.sessionId);

      if (reloadHistory) {
        await renderSessionHistory();
      }
    }

    async function refreshSessionList(selectedSessionId) {
      const response = await fetch("/api/sessions");
      const payload = await response.json();
      sessionSelect.textContent = "";

      const sessions = payload.sessions ?? [];
      if (!sessions.some((item) => item.sessionId === selectedSessionId)) {
        sessions.unshift({
          sessionId: selectedSessionId,
          modifiedAt: Date.now(),
          size: 0,
        });
      }

      for (const item of sessions) {
        const option = document.createElement("option");
        option.value = item.sessionId;
        option.textContent = item.sessionId + " | " +
          new Date(item.modifiedAt).toLocaleString();
        option.selected = item.sessionId === selectedSessionId;
        sessionSelect.append(option);
      }
    }

    async function renderSessionHistory() {
      const response = await fetch("/api/session/messages");
      const payload = await response.json();
      chat.textContent = "";
      currentAssistant = null;
      currentReasoning = null;
      assistantTextBuffer = "";
      reasoningTextBuffer = "";
      toolMessages.clear();

      for (const message of payload.messages ?? []) {
        if (message.role === "user" || message.role === "assistant") {
          if (message.content || message.reasoningContent || message.role === "assistant") {
            const body = appendMessage(message.role, message.content ?? "");
            if (message.role === "assistant") {
              currentAssistant = body;
              currentReasoning = null;
              if (message.reasoningContent) {
                appendReasoningText(message.reasoningContent, message.reasoningChars);
              }
            }
          }

          for (const toolCall of message.toolCalls ?? []) {
            appendToolUse(toolCall);
          }
          continue;
        }

        if (message.role === "tool") {
          completeToolUse({
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            contentPreview: message.contentPreview,
          });
        }
      }

      scrollToBottom(chat);
    }

    function handleServerEvent(event) {
      if (shouldLogEvent(event)) {
        appendEvent(event);
      }

      if (event.type === "assistant_text_delta") {
        queueAssistantText(event.text);
        return;
      }

      if (event.type === "assistant_reasoning_delta") {
        queueReasoningText(event.text);
        return;
      }

      if (event.type === "assistant_message" && event.message?.content && !currentAssistant.textContent) {
        flushAssistantText();
      }

      if (event.type === "assistant_message" && event.message?.content && !currentAssistant.textContent) {
        currentAssistant.textContent = event.message.content;
        scrollToBottom(chat);
        return;
      }

      if (event.type === "tool_use") {
        appendToolUse(event.toolCall);
        return;
      }

      if (event.type === "tool_result") {
        completeToolUse(event);
        return;
      }

      if (event.type === "error") {
        appendMessage("error", event.error);
      }
    }

    function shouldLogEvent(event) {
      if (rawInput.checked) {
        return true;
      }

      return event.type !== "assistant_text_delta" &&
        event.type !== "assistant_reasoning_delta" &&
        event.type !== "model_stream_event";
    }

    function queueAssistantText(text) {
      assistantTextBuffer += text;

      if (assistantRenderFrame) {
        return;
      }

      assistantRenderFrame = requestAnimationFrame(flushAssistantText);
    }

    function flushAssistantText() {
      if (assistantRenderFrame) {
        cancelAnimationFrame(assistantRenderFrame);
        assistantRenderFrame = 0;
      }

      if (!currentAssistant || !assistantTextBuffer) {
        return;
      }

      currentAssistant.textContent += assistantTextBuffer;
      assistantTextBuffer = "";
      scrollToBottom(chat);
    }

    function queueReasoningText(text) {
      reasoningTextBuffer += text;

      if (reasoningRenderFrame) {
        return;
      }

      reasoningRenderFrame = requestAnimationFrame(flushReasoningText);
    }

    function flushReasoningText() {
      if (reasoningRenderFrame) {
        cancelAnimationFrame(reasoningRenderFrame);
        reasoningRenderFrame = 0;
      }

      if (!reasoningTextBuffer) {
        return;
      }

      appendReasoningText(reasoningTextBuffer);
      reasoningTextBuffer = "";
    }

    function appendReasoningText(text, totalChars) {
      const entry = getOrCreateReasoningBlock();
      const chunkChars = Number.isFinite(totalChars) ? totalChars : text.length;
      entry.totalChars += chunkChars;

      if (entry.renderedChars < MAX_REASONING_RENDER_CHARS) {
        const remaining = MAX_REASONING_RENDER_CHARS - entry.renderedChars;
        const visible = text.slice(0, remaining);
        entry.body.textContent += visible;
        entry.renderedChars += visible.length;
      }

      const hiddenChars = Math.max(0, entry.totalChars - entry.renderedChars);
      entry.hidden.textContent = hiddenChars > 0
        ? "... [" + hiddenChars + " reasoning chars hidden from UI]"
        : "";
      entry.summary.textContent = "thinking> " + entry.totalChars + " chars";
      scrollToBottom(chat);
    }

    function getOrCreateReasoningBlock() {
      if (currentReasoning) {
        return currentReasoning;
      }

      const details = document.createElement("details");
      details.className = "reasoning";
      const summary = document.createElement("summary");
      summary.textContent = "thinking> 0 chars";
      const body = document.createElement("pre");
      const hidden = document.createElement("div");
      hidden.className = "hidden";
      details.append(summary, body, hidden);

      const container = currentAssistant?.parentElement ?? chat;
      container.append(details);
      currentReasoning = {
        details,
        summary,
        body,
        hidden,
        totalChars: 0,
        renderedChars: 0,
      };
      return currentReasoning;
    }

    async function readNdjson(body, onEvent) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) onEvent(JSON.parse(line));
        }
      }

      const tail = buffer.trim();
      if (tail) onEvent(JSON.parse(tail));
    }

    function appendMessage(role, text) {
      const wrapper = document.createElement("div");
      wrapper.className = "message";
      const title = document.createElement("div");
      title.className = role === "error" ? "error" : role === "tool" ? "tool" : "role";
      title.textContent = role + ">";
      const body = document.createElement("div");
      body.textContent = text;
      wrapper.append(title, body);
      chat.append(wrapper);
      scrollToBottom(chat);
      return body;
    }

    function appendToolUse(toolCall) {
      const toolCallId = toolCall?.id ?? "tool-" + crypto.randomUUID();
      const existing = toolMessages.get(toolCallId);
      if (existing) {
        return existing;
      }

      const details = document.createElement("details");
      details.className = "message tool-message";
      const summary = document.createElement("summary");
      const role = document.createElement("span");
      role.className = "tool";
      role.textContent = "tool>";
      const name = document.createElement("span");
      name.className = "tool-name";
      name.textContent = toolCall?.function?.name ?? "tool";
      summary.append(role, name);

      const input = document.createElement("pre");
      input.className = "tool-detail";
      input.textContent = formatToolArguments(toolCall?.function?.arguments);
      const result = document.createElement("pre");
      result.className = "tool-detail tool-result";
      details.append(summary, input, result);
      chat.append(details);

      const entry = { details, summary, result };
      toolMessages.set(toolCallId, entry);
      scrollToBottom(chat);
      return entry;
    }

    function completeToolUse(event) {
      const toolCallId = event.toolCallId ?? event.toolCall?.id;
      const entry = toolCallId
        ? toolMessages.get(toolCallId) ??
          appendToolUse({
            id: toolCallId,
            function: { name: event.toolName ?? event.toolCall?.function?.name },
          })
        : appendToolUse({
            function: { name: event.toolName ?? "tool" },
          });
      const content = event.contentPreview ??
        event.message?.content ??
        "";
      entry.result.textContent = typeof content === "string"
        ? content
        : JSON.stringify(content, null, 2);
    }

    function formatToolArguments(value) {
      if (!value) return "";

      try {
        return JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        return String(value);
      }
    }

    function appendEvent(event) {
      const pre = document.createElement("pre");
      pre.textContent = formatEvent(event);
      events.append(pre);
      trimEventLog();
      scrollToBottom(events);
    }

    function formatEvent(event) {
      const text = JSON.stringify(event, null, 2);

      if (text.length <= MAX_EVENT_TEXT_CHARS) {
        return text;
      }

      return text.slice(0, MAX_EVENT_TEXT_CHARS) + "\\n... [event truncated]";
    }

    function trimEventLog() {
      while (events.childElementCount > MAX_EVENT_NODES) {
        events.firstElementChild?.remove();
      }
    }

    function setBusy(value) {
      promptInput.disabled = value;
      sendButton.disabled = value;
      resetButton.disabled = value;
      sessionSelect.disabled = value;
      loadSessionButton.disabled = value;
      clearEventsButton.disabled = value;
    }

    function scrollToBottom(element) {
      element.scrollTop = element.scrollHeight;
    }
  </script>
</body>
</html>`;
}
