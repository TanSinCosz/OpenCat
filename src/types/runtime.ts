import {
  createLongTermMemoryRuntimeConfig,
  type CreateLongTermMemoryRuntimeConfigOptions,
  type LongTermMemoryRuntimeConfig,
} from "../Memory/runtime.js";
import { MemoryTool } from "../Memory/Memory.js";
import type { MemoryConfig } from "../Memory/type.js";
import type { McpConnection } from "../mcp/index.js";
import {
  createTranscriptStore,
  type TranscriptStore,
} from "../transcript/persistence.js";
import { createAgentDefinitions } from "../Tools/Agent/index.js";
import { createDefaultTools } from "../Tools/index.js";
import { createDeepSeekClient, type DeepSeekClient } from "../deepseek/client.js";
import {
  createToolUseContext,
  type AgentDefinitionsResult,
  type AppState,
  type CanUseToolFn,
  type FileStateCache,
  type ThinkingConfig,
  type Tools,
  type ToolUseContext,
} from "../Tools/types.js";
import type { Tokenizer } from "../Tools/utils/Tokenizer.js";
import { createSessionId } from "../utils/session.js";
import {
  forceDeepSeekRuntimeSettings,
  type DeepSeekRuntimeSettings,
} from "./config.js";
import type { ContextProjectionState, ToolResultBudgetState } from "./context.js";
import type { Message } from "./messages.js";

export type MainAgentId = "main";
export type SubAgentId = `agent_${string}`;
export type RuntimeAgentId = MainAgentId | SubAgentId;
export type RuntimeAgentRole = "main" | "subagent" | "session";

export interface Runtime {
  // Runtime identity.
  sessionId: string;
  agentId: RuntimeAgentId;
  agentRole: RuntimeAgentRole;
  parentAgentId?: RuntimeAgentId;
  agentType?: string;

  // Runtime capabilities and configuration.
  cwd: string;
  deepSeekRuntimeConfig: DeepSeekRuntimeSettings;
  deepSeekClient: DeepSeekClient;
  systemPrompt?: string;
  contextProjectionState?: ContextProjectionState;
  toolResultBudgetState?: ToolResultBudgetState;
  MemoryConfig: MemoryConfig;
  longTermMemory?: MemoryTool;
  longTermMemoryConfig: LongTermMemoryRuntimeConfig;
  transcriptStore?: TranscriptStore;

  tools: Tools;
  toolUseContext: ToolUseContext;
  mcpConnections: readonly McpConnection[];
}

export interface CreateRuntimeOptions {
  // Runtime fields.
  sessionId?: string;
  agentId?: Runtime["agentId"];
  agentRole?: Runtime["agentRole"];
  parentAgentId?: Runtime["parentAgentId"];
  agentType?: Runtime["agentType"];
  cwd?: string;
  deepSeekRuntimeConfig: DeepSeekRuntimeSettings;
  deepSeekClient?: DeepSeekClient;
  systemPrompt?: string;
  contextProjectionState?: ContextProjectionState;
  toolResultBudgetState?: ToolResultBudgetState;
  MemoryConfig: MemoryConfig;
  longTermMemory?: MemoryTool;
  longTermMemoryConfig?: CreateLongTermMemoryRuntimeConfigOptions;
  transcriptStore?: TranscriptStore | false;
  tools?: Tools;
  mcpConnections?: readonly McpConnection[];

  // ToolUseContext fields.
  messages?: Message[];
  abortController?: AbortController;
  tokenizer?: Tokenizer;
  isNonInteractiveSession?: boolean;
  mainLoopModel?: string;
  agentDefinitions?: AgentDefinitionsResult;
  thinkingConfig?: ThinkingConfig;
  appState?: AppState;
  readFileState?: FileStateCache;
  canUseTool?: CanUseToolFn;
}

export function createRuntime(options: CreateRuntimeOptions): Runtime {
  const sessionId = options.sessionId ?? createSessionId();
  const agentId = options.agentId ?? "main";
  const agentRole = options.agentRole ?? (agentId === "main" ? "main" : "subagent");
  const agentDefinitions = options.agentDefinitions ?? createAgentDefinitions();
  const tools = options.tools ?? createDefaultTools({ agentDefinitions });
  const cwd = options.cwd ?? process.cwd();
  const deepSeekRuntimeConfig = forceDeepSeekRuntimeSettings(
    options.deepSeekRuntimeConfig,
  );
  const transcriptStore = options.transcriptStore === false
    ? undefined
    : options.transcriptStore ??
      createTranscriptStore({
        cwd,
        sessionId,
        agentId,
        agentRole,
        parentAgentId: options.parentAgentId,
        agentType: options.agentType,
      });

  return {
    sessionId,
    agentId,
    agentRole,
    parentAgentId: options.parentAgentId,
    agentType: options.agentType,
    cwd,
    deepSeekRuntimeConfig,
    deepSeekClient:
      options.deepSeekClient ??
      createDeepSeekClient({
        config: deepSeekRuntimeConfig,
    }),
    systemPrompt: options.systemPrompt,
    contextProjectionState: options.contextProjectionState,
    toolResultBudgetState: options.toolResultBudgetState,
    MemoryConfig: options.MemoryConfig,
    longTermMemory: options.longTermMemory,
    longTermMemoryConfig: createLongTermMemoryRuntimeConfig(
      options.longTermMemoryConfig,
      { sessionId, agentId },
    ),
    transcriptStore,
    tools,
    mcpConnections: options.mcpConnections ?? [],
    toolUseContext: createToolUseContext({
      tools,
      messages: options.messages,
      appState: options.appState,
      abortController: options.abortController,
      tokenizer: options.tokenizer,
      isNonInteractiveSession: options.isNonInteractiveSession,
      mainLoopModel: options.mainLoopModel,
      agentDefinitions,
      thinkingConfig: options.thinkingConfig,
      readFileState: options.readFileState,
      canUseTool: options.canUseTool,
    }),
  };
}
