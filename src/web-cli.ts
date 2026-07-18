import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse } from "node:path";
import { promisify } from "node:util";

import { loadConfig } from "./config/load-config.js";
import { createMemoryConfig } from "./Memory/config.js";
import { closeMcpConnections } from "./mcp/index.js";
import { createToolsWithConfiguredMcp } from "./mcp/config.js";
import { query } from "./query.js";
import {
  createTranscriptStore,
  loadStateFromTranscript,
  recordTranscriptMessage,
} from "./transcript/persistence.js";
import { createMessage, type Message } from "./types/messages.js";
import { createRuntime, type Runtime } from "./types/runtime.js";
import { createState, type State } from "./types/state.js";
import type {
  QueryEvent,
  ToolPermissionDecision,
  ToolPermissionRequest,
} from "./query/types.js";
import type { DeepSeekAssistantMessage } from "./deepseek/types.js";
import { formatErrorForUser } from "./deepseek/errors.js";
import {
  createSweBenchSessionId,
  getSweWorkspaceStatus,
  parseSweBenchSessionId,
  type SweWorkspaceStatusValue,
} from "./swe/workspace.js";
import { createSessionId } from "./utils/session.js";
import {
  applyWorkspacePatchSnapshot,
  approveWorkspacePatchSnapshot,
  captureWorkspacePatchBaseline,
  getWorkspacePatchDiff,
  getWorkspacePatchDeltaDiff,
  getWorkspacePatchDeltaSummary,
  getWorkspacePatchSummary,
  revertWorkspacePatch,
  saveWorkspacePatchSnapshot,
  type WorkspacePatchBaseline,
} from "./workspace/patch-snapshot.js";

const DEFAULT_PORT = 5177;
const MAX_BODY_BYTES = 256 * 1024;
const TRANSCRIPT_DIR = ".opencat/transcripts";
const SWE_EVAL_DIR = ".opencat/evals/swe-verified-cache";
const MAX_SESSION_HISTORY_MESSAGES = 200;
const MAX_HISTORY_TOOL_CHARS = 2_000;
const MAX_HISTORY_REASONING_CHARS = 4_000;
const MAX_PATCH_BYTES = 50 * 1024 * 1024;
const execFileAsync = promisify(execFile);

type TranscriptHydrationMode = "auto" | "full";

interface WebCliSession {
  runtime: Runtime;
  state: State;
  busy: boolean;
  clientAttached: boolean;
  activeQueryAbortController?: AbortController;
  loadInfo: WebCliSessionLoadInfo;
  pendingToolApprovals: Map<string, PendingToolApproval>;
  patchBaseline?: WorkspacePatchBaseline;
}

interface PendingToolApproval {
  resolve: (decision: ToolPermissionDecision) => void;
  timeout: NodeJS.Timeout;
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
  category: WebCliTranscriptCategory;
}

type WebCliTranscriptCategory = "general" | "swe" | "swe_serial";

interface SweBenchItem {
  instanceId: string;
  repo: string;
  baseCommit: string;
  problemPreview: string;
  sessionId: string;
  hasSession: boolean;
  workspaceStatus: SweWorkspaceStatusValue;
}

interface SweBenchInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hints_text?: string;
  test_patch?: string;
}

type SweDraftKind = "investigate" | "fix" | "standard";

let session = await createWebCliSession({
  sessionId: await resolveInitialSessionId(process.cwd()),
  resume: true,
});

interface CreateWebCliSessionOptions {
  sessionId?: string;
  resume: boolean;
  cwd?: string;
}

async function createWebCliSession(
  options: CreateWebCliSessionOptions,
): Promise<WebCliSession> {
  const sessionId = options.sessionId ?? createSessionId();
  const runtimeCwd = options.cwd ??
    await resolveSessionRuntimeCwd(sessionId) ??
    process.cwd();
  const { tools, mcpConnections } = await createToolsWithConfiguredMcp(runtimeCwd);
  const transcriptStore = createTranscriptStore({
    cwd: runtimeCwd,
    sessionId,
    agentId: "main",
    agentRole: "main",
    directory: join(process.cwd(), TRANSCRIPT_DIR),
  });
  const runtime = createRuntime({
    cwd: runtimeCwd,
    sessionId,
    deepSeekRuntimeConfig: loadConfig(),
    MemoryConfig: createMemoryConfig({ cwd: runtimeCwd }),
    longTermMemoryConfig: {
      autoInject: true,
      autoExtract: true,
    },
    transcriptStore,
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
    clientAttached: false,
    pendingToolApprovals: new Map(),
    loadInfo: {
      restored: Boolean(restored),
      requestedSessionId: options.sessionId,
      transcriptPath: runtime.transcriptStore?.path,
      hydrate,
      messageCount: state.Messages.length,
    },
  };
}

async function resolveSessionRuntimeCwd(
  sessionId: string,
): Promise<string | undefined> {
  const instanceId = parseSweBenchSessionId(sessionId);
  if (!instanceId) {
    return undefined;
  }

  const instance = await findSweBenchInstance(process.cwd(), instanceId);
  if (!instance) {
    return undefined;
  }

  const workspace = await getSweWorkspaceStatus(instance);
  return isUsableSweWorkspaceStatus(workspace.status)
    ? workspace.path
    : undefined;
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
  return (await listMainTranscriptSessions(cwd))
    .find((item) => !parseSweBenchSessionId(item.sessionId))
    ?.sessionId;
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
            category: categorizeTranscriptSessionId(parse(entry.name).name),
          };
        }),
    );

    return candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  } catch {
    return [];
  }
}

function categorizeTranscriptSessionId(sessionId: string): WebCliTranscriptCategory {
  if (sessionId.startsWith("session_swe_serial_")) {
    return "swe_serial";
  }

  if (sessionId.startsWith("session_swe_")) {
    return "swe";
  }

  return "general";
}

async function hasMainTranscriptSession(
  cwd: string,
  sessionId: string,
): Promise<boolean> {
  return (await listMainTranscriptSessions(cwd))
    .some((item) => item.sessionId === sessionId);
}

async function listSweBenchItems(cwd: string): Promise<SweBenchItem[]> {
  const instances = await loadSweBenchInstances(cwd);
  const sessions = new Set(
    (await listMainTranscriptSessions(cwd)).map((item) => item.sessionId),
  );

  return await Promise.all(instances.map(async (instance) => {
    const sessionId = createSweBenchSessionId(instance.instance_id);
    const workspace = await getSweWorkspaceStatus(instance);
    return {
      instanceId: instance.instance_id,
      repo: instance.repo,
      baseCommit: instance.base_commit,
      problemPreview: firstLine(instance.problem_statement),
      sessionId,
      hasSession: sessions.has(sessionId),
      workspaceStatus: workspace.status,
    };
  }));
}

async function findSweBenchInstance(
  cwd: string,
  instanceId: string,
): Promise<SweBenchInstance | undefined> {
  return (await loadSweBenchInstances(cwd))
    .find((instance) => instance.instance_id === instanceId);
}

async function loadSweBenchInstances(cwd: string): Promise<SweBenchInstance[]> {
  const config = await readJsonFile<Record<string, unknown>>(
    join(cwd, SWE_EVAL_DIR, "config.json"),
  );
  const configuredDatasetPath = typeof config?.datasetPath === "string"
    ? config.datasetPath
    : "";
  const datasetPath = configuredDatasetPath
    ? (isAbsolute(configuredDatasetPath)
      ? configuredDatasetPath
      : join(cwd, configuredDatasetPath))
    : join(cwd, SWE_EVAL_DIR, "dataset.jsonl");
  const records = await readJsonlOrArray<SweBenchInstance>(datasetPath);

  return records
    .filter(isSweBenchInstance);
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readJsonlOrArray<T>(filePath: string): Promise<T[]> {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed as T[] : [];
  }

  return trimmed.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function isSweBenchInstance(value: unknown): value is SweBenchInstance {
  const record = value as Partial<SweBenchInstance>;
  return typeof record.instance_id === "string" &&
    typeof record.repo === "string" &&
    typeof record.base_commit === "string" &&
    typeof record.problem_statement === "string";
}

function isUsableSweWorkspaceStatus(status: SweWorkspaceStatusValue): boolean {
  return status === "ready" || status === "dirty" || status === "wrong-head";
}

async function getCurrentSweSessionInfo(): Promise<{
  instanceId: string;
  workspaceReady: boolean;
  workspaceStatus: SweWorkspaceStatusValue;
  workspacePath?: string;
} | null> {
  const instanceId = parseSweBenchSessionId(session.runtime.sessionId);
  if (!instanceId) {
    return null;
  }

  const instance = await findSweBenchInstance(process.cwd(), instanceId);
  if (!instance) {
    return {
      instanceId,
      workspaceReady: false,
      workspaceStatus: "missing",
    };
  }

  const workspace = await getSweWorkspaceStatus(instance);
  return {
    instanceId,
    workspaceReady: isUsableSweWorkspaceStatus(workspace.status),
    workspaceStatus: workspace.status,
    workspacePath: workspace.path,
  };
}

async function exportCurrentSwePatch(): Promise<{
  ok: true;
  instanceId: string;
  fileName: string;
  patch: string;
  empty: boolean;
  savedPath?: string;
  workspacePath: string;
} | {
  ok: false;
  error: string;
}> {
  const swe = await getCurrentSweSessionInfo();
  if (!swe) {
    return { ok: false, error: "Current session is not a SWE session." };
  }

  if (!swe.workspaceReady || !swe.workspacePath) {
    return {
      ok: false,
      error: `SWE workspace is not ready: ${swe.workspaceStatus}.`,
    };
  }

  const { stdout } = await execFileAsync("git", [
    "-c",
    "safe.directory=*",
    "diff",
    "--binary",
  ], {
    cwd: swe.workspacePath,
    maxBuffer: MAX_PATCH_BYTES,
    windowsHide: true,
  });
  const patch = String(stdout);
  const savedPath = patch.trim().length === 0
    ? undefined
    : await saveSwePatchFile(swe.instanceId, patch);

  return {
    ok: true,
    instanceId: swe.instanceId,
    fileName: `${swe.instanceId}.patch`,
    patch,
    empty: patch.trim().length === 0,
    savedPath,
    workspacePath: swe.workspacePath,
  };
}

async function saveSwePatchFile(
  instanceId: string,
  patch: string,
): Promise<string> {
  const directory = resolveSwePatchDirectory();
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, `${sanitizePatchFileName(instanceId)}.patch`);
  await writeFile(filePath, patch, "utf8");
  return filePath;
}

function resolveSwePatchDirectory(): string {
  const configured = process.env.OPENCAT_SWE_PATCH_DIR?.trim();
  if (!configured) {
    return join(process.cwd(), SWE_EVAL_DIR, "patches");
  }

  return isAbsolute(configured) ? configured : join(process.cwd(), configured);
}

function sanitizePatchFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function parseSweDraftKind(value: string | null): SweDraftKind {
  return value === "fix" || value === "standard" ? value : "investigate";
}

function buildSweDraftPrompt(
  instance: SweBenchInstance,
  kind: SweDraftKind,
): string {
  if (kind === "investigate") {
    return buildSweInvestigatePrompt(instance);
  }

  if (kind === "fix") {
    return [
      "Based on the investigation from the previous turn, implement the smallest correct fix now.",
      "Modify only the checked-out SWE workspace for this item. Re-read any file you edit before changing it.",
      "After editing, run the most relevant tests you can. If tests cannot run, explain exactly why and what you verified instead.",
      "Finish with a concise summary of changed files, the behavior fixed, and verification results.",
      "",
      "<swe_task_followup>",
      `<instance_id>${instance.instance_id}</instance_id>`,
      "</swe_task_followup>",
    ].join("\n");
  }

  return [
    "You are working on a SWE-bench Verified issue in OpenCat.",
    "Modify the checked-out repository to fix the issue. Prefer minimal, well-tested changes.",
    "Use the available tools to inspect, edit, and verify the code.",
    "Do not fetch unrelated web content unless the repository itself requires it.",
    "Before editing, inspect the relevant files in the workspace. After editing, run the most relevant tests you can.",
    "",
    "<swe_task>",
    `<instance_id>${instance.instance_id}</instance_id>`,
    `<repo>${instance.repo}</repo>`,
    "",
    "<problem_statement>",
    instance.problem_statement,
    "</problem_statement>",
    instance.hints_text ? `\n<hints_text>\n${instance.hints_text}\n</hints_text>` : "",
    "</swe_task>",
  ].filter((line) => line !== "").join("\n");
}

function buildSweInvestigatePrompt(instance: SweBenchInstance): string {
  return [
    "You are working on a SWE-bench Verified issue in OpenCat.",
    "First investigate only. Do not modify files yet. Do not call Edit or Write.",
    "Read the issue, inspect the checked-out repository, identify the likely root cause, and explain the smallest code change you would make next.",
    "Use tools to inspect relevant files. Do not fetch unrelated web content unless the repository itself requires it.",
    "End with a concise investigation summary: root cause, relevant files/functions, proposed fix, and tests to run.",
    "",
    "<swe_task>",
    `<instance_id>${instance.instance_id}</instance_id>`,
    `<repo>${instance.repo}</repo>`,
    "",
    "<problem_statement>",
    instance.problem_statement,
    "</problem_statement>",
    instance.hints_text ? `\n<hints_text>\n${instance.hints_text}\n</hints_text>` : "",
    "</swe_task>",
  ].filter((line) => line !== "").join("\n");
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
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
      const sweSessionInfo = await getCurrentSweSessionInfo();
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
        cwd: session.runtime.cwd,
        swe: sweSessionInfo,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      sendJson(response, {
        sessions: await listMainTranscriptSessions(process.cwd()),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/swe/items") {
      sendJson(response, {
        items: await listSweBenchItems(process.cwd()),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/swe/prompt") {
      const instanceId = url.searchParams.get("instanceId")?.trim() ?? "";
      const kind = parseSweDraftKind(url.searchParams.get("kind"));
      const instance = await findSweBenchInstance(process.cwd(), instanceId);
      if (!instance) {
        sendJson(response, { error: "SWE item not found." }, 404);
        return;
      }

      sendJson(response, {
        instanceId,
        kind,
        prompt: buildSweDraftPrompt(instance, kind),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/swe/session") {
      const body = await readJsonBody<{ instanceId?: unknown }>(request);
      const instanceId = typeof body.instanceId === "string"
        ? body.instanceId.trim()
        : "";
      const instance = await findSweBenchInstance(process.cwd(), instanceId);
      if (!instance) {
        sendJson(response, { error: "SWE item not found." }, 404);
        return;
      }

      const sessionId = createSweBenchSessionId(instance.instance_id);
      const workspace = await getSweWorkspaceStatus(instance);
      const workspacePath = isUsableSweWorkspaceStatus(workspace.status)
        ? workspace.path
        : undefined;

      const existed = await hasMainTranscriptSession(process.cwd(), sessionId);
      await replaceSession({
        sessionId,
        resume: existed,
        cwd: workspacePath ?? process.cwd(),
      });

      sendJson(response, {
        ok: true,
        sessionId: session.runtime.sessionId,
        existed,
        workspaceReady: Boolean(workspacePath),
        messageCount: session.state.Messages.length,
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

    if (request.method === "POST" && url.pathname === "/api/query/stop") {
      stopActiveQuery("Stopped from the web UI.");
      sendJson(response, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/tool-permission") {
      await handleToolPermissionResponse(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/swe/patch") {
      sendJson(response, await exportCurrentSwePatch());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/patch/current") {
      sendJson(response, await getWorkspacePatchDiff(session.runtime));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/patch/summary") {
      sendJson(response, await getWorkspacePatchSummary(session.runtime));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/patch/turn/current") {
      sendJson(
        response,
        await getWorkspacePatchDeltaDiff(session.runtime, session.patchBaseline),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/patch/turn/summary") {
      sendJson(
        response,
        await getWorkspacePatchDeltaSummary(session.runtime, session.patchBaseline),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/patch/snapshot") {
      sendJson(response, await saveWorkspacePatchSnapshot(session.runtime, "manual"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/patch/approve") {
      sendJson(response, await approveWorkspacePatchSnapshot(session.runtime));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/patch/apply") {
      const body = await readJsonBody<{ source?: unknown }>(request);
      const source = body.source === "approved" ? "approved" : "latest";
      sendJson(response, await applyWorkspacePatchSnapshot(session.runtime, source));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/patch/revert") {
      sendJson(response, await revertWorkspacePatch(session.runtime));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/load") {
      const body = await readJsonBody<{ sessionId?: unknown }>(request);
      const sessionId = typeof body.sessionId === "string"
        ? body.sessionId.trim()
        : "";
      const available = await listMainTranscriptSessions(process.cwd());

      if (!available.some((candidate) => candidate.sessionId === sessionId)) {
        sendJson(response, { error: "Session transcript not found." }, 404);
        return;
      }

      const runtimeCwd = await resolveSessionRuntimeCwd(sessionId);

      await replaceSession({
        sessionId,
        resume: true,
        cwd: runtimeCwd ?? process.cwd(),
      });
      sendJson(response, {
        ok: true,
        sessionId: session.runtime.sessionId,
        workspaceReady: Boolean(runtimeCwd),
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
  const activeSession = session;
  if (activeSession.busy) {
    sendJson(response, { error: "A query is already running." }, 409);
    return;
  }

  const body = await readJsonBody<{ prompt?: unknown; includeRawEvents?: unknown }>(request);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  if (!prompt) {
    sendJson(response, { error: "Missing prompt." }, 400);
    return;
  }

  activeSession.busy = true;
  activeSession.clientAttached = true;
  activeSession.patchBaseline =
    await captureWorkspacePatchBaseline(activeSession.runtime);
  const previousAbortController = activeSession.runtime.toolUseContext.abortController;
  const queryAbortController = new AbortController();
  activeSession.activeQueryAbortController = queryAbortController;
  activeSession.runtime.toolUseContext.abortController = queryAbortController;

  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const markClientDetached = () => {
    if (!activeSession.clientAttached) {
      return;
    }

    activeSession.clientAttached = false;
    denyAllPendingToolApprovalsForSession(
      activeSession,
      "Tool permission request was cancelled because the web client detached.",
    );
  };
  request.once("aborted", markClientDetached);
  response.once("close", markClientDetached);

  try {
    const userMessage = createMessage({
      role: "user",
      content: prompt,
    });
    activeSession.state.Messages.push(userMessage);
    await recordTranscriptMessage(activeSession.runtime, userMessage);

    writeEvent(response, {
      type: "user_message",
      id: userMessage.id,
      messageCount: activeSession.state.Messages.length,
    });

    for await (const event of query(activeSession.runtime, activeSession.state, {
      requestToolPermission: (toolRequest) =>
        createToolPermissionRequestForSession(activeSession, toolRequest),
    })) {
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
    request.off("aborted", markClientDetached);
    response.off("close", markClientDetached);
    denyAllPendingToolApprovalsForSession(
      activeSession,
      "Query ended before the tool permission request was answered.",
    );
    activeSession.busy = false;
    activeSession.clientAttached = false;
    if (activeSession.activeQueryAbortController === queryAbortController) {
      activeSession.activeQueryAbortController = undefined;
    }
    activeSession.runtime.toolUseContext.abortController = previousAbortController;
    if (session !== activeSession) {
      closeMcpConnections(activeSession.runtime.mcpConnections);
    }
    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
  }
}

function stopActiveQuery(reason: string): void {
  const controller = session.activeQueryAbortController ??
    session.runtime.toolUseContext.abortController;
  if (!session.busy || controller.signal.aborted) {
    return;
  }

  controller.abort(new Error(reason));
  denyAllPendingToolApprovalsForSession(session, reason);
}

async function handleToolPermissionResponse(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody<{
    approvalId?: unknown;
    decision?: unknown;
  }>(request);
  const approvalId = typeof body.approvalId === "string"
    ? body.approvalId.trim()
    : "";
  const decision = body.decision === "allow" || body.decision === "deny"
    ? body.decision
    : "";

  if (!approvalId || !decision) {
    sendJson(response, { error: "Invalid tool permission response." }, 400);
    return;
  }

  const pending = session.pendingToolApprovals.get(approvalId);
  if (!pending) {
    sendJson(response, { error: "Tool permission request not found." }, 404);
    return;
  }

  clearTimeout(pending.timeout);
  session.pendingToolApprovals.delete(approvalId);
  pending.resolve(
    decision === "allow"
      ? { behavior: "allow" }
      : { behavior: "deny", reason: "Denied by user from the web UI." },
  );
  sendJson(response, { ok: true });
}

function createToolPermissionRequestForSession(
  targetSession: WebCliSession,
  request: ToolPermissionRequest,
): Promise<ToolPermissionDecision> {
  if (!targetSession.clientAttached) {
    return Promise.resolve({
      behavior: "deny",
      reason: "Tool permission request cannot be approved because the web client is detached.",
    });
  }

  const existing = targetSession.pendingToolApprovals.get(request.approvalId);
  if (existing) {
    clearTimeout(existing.timeout);
    targetSession.pendingToolApprovals.delete(request.approvalId);
    existing.resolve({
      behavior: "deny",
      reason: "Superseded by a newer tool permission request.",
    });
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      targetSession.pendingToolApprovals.delete(request.approvalId);
      resolve({
        behavior: "deny",
        reason: "Tool permission request timed out.",
      });
    }, 5 * 60 * 1000);

    targetSession.pendingToolApprovals.set(request.approvalId, {
      resolve,
      timeout,
    });
  });
}

function denyAllPendingToolApprovalsForSession(
  targetSession: WebCliSession,
  reason: string,
): void {
  for (const [approvalId, pending] of targetSession.pendingToolApprovals) {
    clearTimeout(pending.timeout);
    pending.resolve({ behavior: "deny", reason });
    targetSession.pendingToolApprovals.delete(approvalId);
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
          stats: event.stats,
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
    case "tool_permission":
      return {
        type: event.type,
        toolCallId: event.toolCall.id,
        toolName: event.toolCall.function.name,
        behavior: event.behavior,
        reason: event.reason,
        reasonPreview: previewText(event.reason),
      };
    case "tool_permission_request":
      return {
        type: event.type,
        approvalId: event.approvalId,
        toolCallId: event.toolCall.id,
        toolName: event.toolCall.function.name,
        mode: event.mode,
        reason: event.reason,
        reasonPreview: previewText(event.reason),
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
  if (!session.busy) {
    closeMcpConnections(session.runtime.mcpConnections);
  }
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

  try {
    response.write(`${JSON.stringify(event)}\n`);
  } catch {
    // The browser may have navigated away. Keep the query running; the
    // transcript remains the source of truth when the session is reopened.
  }
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

        var payload = await openSweSession(instanceId);
        if (draftKind && payload && Number(payload.messageCount || 0) === 0) {
          await fillSweDraftPrompt(instanceId, draftKind);
        }
        params.delete("swe");
        params.delete("draft");
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
          var response = await fetch("/api/swe/items");
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
              return function() { openSweSession(instanceId); };
            }(item.instanceId));
            sweList.append(div);
          }
        } catch (e) {
          // ignore
        }
      }

      async function openSweSession(instanceId) {
        if (!instanceId || isSessionLoading) return null;
        detachCurrentStream();
        setSessionLoading(true);
        try {
          var response = await fetch("/api/swe/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ instanceId: instanceId }),
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

      async function fillSweDraftPrompt(instanceId, kind) {
        if (promptInput.value.trim()) return;
        try {
          var response = await fetch(
            "/api/swe/prompt?instanceId=" + encodeURIComponent(instanceId) +
              "&kind=" + encodeURIComponent(kind || "investigate"),
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
  </script>
</body>
</html>`;
}
