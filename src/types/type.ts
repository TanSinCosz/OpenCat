import type { DeepSeekRuntimeConfig } from "../deepseek/runtime.js";
import type { Tool } from "../Tools/types.js";
import type{
  DeepSeekRole,
  DeepSeekToolChoice,
  DeepSeekMessage,
  DeepSeekResponseFormat,
} from "../deepseek/types.js";
import { MemoryConfig } from "../Memory/type.js";

export interface Runtime {
  sessionId: string;
  agentId: "main" | "sub";
  
  cwd: string;
  deepSeekRuntimeConfig: DeepSeekRuntimeConfig;
  MemoryConfig: MemoryConfig
  tools: Tool[];
}

export interface State {
  Messages: Message[];
  mode: "default" | "plan"; 
}

export interface Message {
  message: DeepSeekMessage
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


