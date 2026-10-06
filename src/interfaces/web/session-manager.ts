/** 会话生命周期：组装 Runtime、恢复 State、切换会话和释放空闲连接。 */
import { join } from "node:path";
import { getAppConfig } from "../../config/load-config.js";
import { closeMcpConnections } from "../../mcp/index.js";
import { createToolsWithConfiguredMcp } from "../../mcp/config.js";
import { createTranscriptStore, loadStateFromTranscript } from "../../transcript/persistence.js";
import { createRuntime } from "../../types/runtime.js";
import { createState } from "../../types/state.js";
import { createSessionId } from "../../utils/session.js";
import { getSweWorkspaceStatus, parseSweBenchSessionId } from "../../swe/workspace.js";
import {
  TRANSCRIPT_DIR,
  getTranscriptHydrationMode,
  resolveInitialSessionId,
} from "./transcript-index.js";
import {
  resolveSweDatasetDirectoryForSession,
  findSweBenchInstance,
  createSweWorkspaceOptions,
  isUsableSweWorkspaceStatus,
} from "./swe-dataset.js";
import type { CreateWebCliSessionOptions, WebCliSession } from "./types.js";

async function createWebCliSession(
  options: CreateWebCliSessionOptions,
): Promise<WebCliSession> {
  const config = getAppConfig();
  const sessionId = options.sessionId ?? createSessionId();
  const sweDatasetDir = resolveSweDatasetDirectoryForSession(
    process.cwd(),
    sessionId,
    options.sweDatasetDir,
  );
  const runtimeCwd = options.cwd ??
    await resolveSessionRuntimeCwd(sessionId, sweDatasetDir) ??
    process.cwd();
  const { tools, mcpConnections } = await createToolsWithConfiguredMcp(runtimeCwd, config);
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
    appConfig: config,
    modelRuntimeConfig: config.model,
    longTermMemoryConfig: {
      ...config.memory,
      fileMemoryDirectory: config.memory.directory,
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
    sweDatasetDir,
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

export async function resolveSessionRuntimeCwd(
  sessionId: string,
  sweDatasetDir?: string,
): Promise<string | undefined> {
  const instanceId = parseSweBenchSessionId(sessionId);
  if (!instanceId) {
    return undefined;
  }

  const instance = await findSweBenchInstance(
    process.cwd(),
    instanceId,
    resolveSweDatasetDirectoryForSession(process.cwd(), sessionId, sweDatasetDir),
  );
  if (!instance) {
    return undefined;
  }

  const workspace = await getSweWorkspaceStatus(
    instance,
    await createSweWorkspaceOptions(process.cwd()),
  );
  return isUsableSweWorkspaceStatus(workspace.status)
    ? workspace.path
    : undefined;
}

/** 管理当前会话的替换；HTTP 层不直接修改共享会话引用。 */
export class WebSessionManager {
  constructor(public current: WebCliSession) {}

  static async create(): Promise<WebSessionManager> {
    return new WebSessionManager(await createWebCliSession({
      sessionId: await resolveInitialSessionId(process.cwd()),
      resume: true,
    }));
  }

  async reset(): Promise<void> {
    await this.replace({ sessionId: createSessionId(), resume: false });
  }

  async replace(options: CreateWebCliSessionOptions): Promise<void> {
    // 正在执行的请求持有旧会话，结束时由 query-handler 释放它的 MCP 连接。
    // 空闲会话可立即释放，避免切换后遗留外部进程。
    if (!this.current.busy) {
      closeMcpConnections(this.current.runtime.mcpConnections);
    }
    this.current = await createWebCliSession(options);
  }
}
