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
import { createMessage } from "./types/messages.js";
import { createRuntime, type Runtime } from "./types/runtime.js";
import { createState, type State } from "./types/state.js";
import type { QueryEvent } from "./query/types.js";
import { createSessionId } from "./utils/session.js";

const DEFAULT_PORT = 5177;
const MAX_BODY_BYTES = 256 * 1024;
const TRANSCRIPT_DIR = ".opencat/transcripts";

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
  const directory = join(cwd, TRANSCRIPT_DIR);

  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const path = join(directory, entry.name);
          return {
            sessionId: parse(entry.name).name,
            mtimeMs: (await stat(path)).mtimeMs,
          };
        }),
    );

    return candidates
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .at(0)?.sessionId;
  } catch {
    return undefined;
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

    if (request.method === "POST" && url.pathname === "/api/query") {
      await handleQuery(request, response);
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
        message: event.message,
      };
    case "tool_result":
      {
        const content = typeof event.message.content === "string"
          ? event.message.content
          : "";

        return {
          type: event.type,
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

async function resetSession(): Promise<void> {
  closeMcpConnections(session.runtime.mcpConnections);
  session = await createWebCliSession({
    sessionId: createSessionId(),
    resume: false,
  });
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
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
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
    body { margin: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: #111; color: #eee; }
    header { display: flex; gap: 12px; align-items: center; padding: 10px 12px; border-bottom: 1px solid #333; }
    main { display: grid; grid-template-columns: 1fr 420px; height: calc(100vh - 50px); }
    #chat, #events { overflow: auto; padding: 12px; }
    #events { border-left: 1px solid #333; background: #0b0b0b; }
    form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #333; }
    textarea { flex: 1; min-height: 72px; resize: vertical; background: #191919; color: #eee; border: 1px solid #444; padding: 8px; }
    button, label { background: #222; color: #eee; border: 1px solid #555; padding: 8px 10px; }
    label { display: inline-flex; gap: 6px; align-items: center; }
    button:disabled, textarea:disabled { opacity: .6; }
    .pane { display: flex; min-height: 0; flex-direction: column; }
    .message { white-space: pre-wrap; border-bottom: 1px solid #262626; padding: 10px 0; }
    .role { color: #8ab4f8; }
    .tool { color: #fbbc04; }
    .error { color: #ff7b72; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0 0 10px; color: #aaa; }
    .meta { color: #999; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <strong>OpenCat Debug CLI</strong>
    <span id="session" class="meta">loading...</span>
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
    const clearEventsButton = document.querySelector("#clear-events");
    const sessionLabel = document.querySelector("#session");
    const MAX_EVENT_NODES = 160;
    const MAX_EVENT_TEXT_CHARS = 12000;

    let currentAssistant = null;
    let assistantTextBuffer = "";
    let assistantRenderFrame = 0;

    init();

    async function init() {
      await refreshSession();
      promptInput.focus();
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const prompt = promptInput.value.trim();
      if (!prompt) return;

      appendMessage("user", prompt);
      promptInput.value = "";
      currentAssistant = appendMessage("assistant", "");
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
      } catch (error) {
        appendMessage("error", String(error));
      } finally {
        flushAssistantText();
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
      chat.textContent = "";
      events.textContent = "";
      currentAssistant = null;
      await refreshSession();
    });

    clearEventsButton.addEventListener("click", () => {
      events.textContent = "";
    });

    async function refreshSession() {
      const response = await fetch("/api/session");
      const session = await response.json();
      sessionLabel.textContent = [
        "session=" + session.sessionId,
        "model=" + session.model,
        "messages=" + session.messageCount,
        "tools=" + session.tools.length,
        session.restored ? "restored" : "new",
        "hydrate=" + session.hydrate,
      ].join(" | ");
    }

    function handleServerEvent(event) {
      if (shouldLogEvent(event)) {
        appendEvent(event);
      }

      if (event.type === "assistant_text_delta") {
        queueAssistantText(event.text);
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
        appendMessage("tool", event.toolCall?.function?.name ?? "tool");
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

      return event.type !== "assistant_text_delta" && event.type !== "model_stream_event";
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
      clearEventsButton.disabled = value;
    }

    function scrollToBottom(element) {
      element.scrollTop = element.scrollHeight;
    }
  </script>
</body>
</html>`;
}
