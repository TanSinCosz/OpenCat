import type { MemoryConfig } from "../Memory/type.js";
import { createDeepSeekClient, type DeepSeekClient } from "../deepseek/client.js";
import {
  createToolUseContext,
  type AgentDefinitionsResult,
  type AppState,
  type ThinkingConfig,
  type Tools,
  type ToolUseContext,
} from "../Tools/types.js";
import type { Tokenizer } from "../Tools/utils/Tokenizer.js";
import type { DeepSeekMessage } from "../deepseek/types.js";
import { createSessionId } from "../utils/session.js";

export interface Runtime {
  sessionId: string;
  agentId: "main" | "sub";
  
  cwd: string;
  deepSeekRuntimeConfig: DeepSeekRuntimeSettings;
  deepSeekClient: DeepSeekClient;
  systemPrompt?: string;
  toolResultBudgetState?: ToolResultBudgetState;
  MemoryConfig: MemoryConfig
  
  tools: Tools;
  toolUseContext: ToolUseContext;
}

export interface State {
  Messages: Message[];
  mode: "default" | "plan"; 
}

export interface Message {
  message: DeepSeekMessage
}

export interface ToolResultBudgetState {
  seenIds: Set<string>;
  replacements: Map<string, string>;
}

export interface CreateStateOptions {
  messages?: Message[];
  mode?: State["mode"];
}

export interface CreateRuntimeOptions {
  sessionId?: string;
  agentId?: Runtime["agentId"];
  cwd?: string;
  deepSeekRuntimeConfig: DeepSeekRuntimeSettings;
  deepSeekClient?: DeepSeekClient;
  systemPrompt?: string;
  toolResultBudgetState?: ToolResultBudgetState;
  MemoryConfig: MemoryConfig;
  tools?: Tools;
  state?: State;
  abortController?: AbortController;
  tokenizer?: Tokenizer;
  isNonInteractiveSession?: boolean;
  mainLoopModel?: string;
  agentDefinitions?: AgentDefinitionsResult;
  thinkingConfig?: ThinkingConfig;
  appState?: AppState;
}

export function createState(options: CreateStateOptions = {}): State {
  return {
    Messages: options.messages ?? [],
    mode: options.mode ?? "default",
  };
}

export function createRuntime(options: CreateRuntimeOptions): Runtime {
  const state = options.state ?? createState();
  const tools = options.tools ?? [];

  return {
    sessionId: options.sessionId ?? createSessionId(),
    agentId: options.agentId ?? "main",
    cwd: options.cwd ?? process.cwd(),
    deepSeekRuntimeConfig: options.deepSeekRuntimeConfig,
    deepSeekClient:
      options.deepSeekClient ??
      createDeepSeekClient({
        config: options.deepSeekRuntimeConfig,
      }),
    systemPrompt: options.systemPrompt,
    toolResultBudgetState: options.toolResultBudgetState,
    MemoryConfig: options.MemoryConfig,
    tools,
    toolUseContext: createToolUseContext({
      tools,
      messages: state.Messages,
      appState: options.appState,
      abortController: options.abortController,
      tokenizer: options.tokenizer,
      isNonInteractiveSession: options.isNonInteractiveSession,
      mainLoopModel: options.mainLoopModel,
      agentDefinitions: options.agentDefinitions,
      thinkingConfig: options.thinkingConfig,
    }),
  };
}

export interface DeepSeekRuntimeSettings {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  model: string;
  maxTokens: number;
  systemPrompt?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
}
