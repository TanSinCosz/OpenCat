import type { AutoCompressState } from "./context.js";
import {
  createAgentNotificationsState,
  createAgentTasksState,
  type AgentNotification,
  type AgentTasksState,
} from "../Tools/Agent/state.js";
import type { Message } from "./messages.js";
import {
  createSessionMemoryState,
  type SessionMemoryState,
} from "./session-memory.js";

export interface InvokedSkill {
  name: string;
  description: string;
  content: string;
  invokedAt: number;
  agentId: string | null;
  skillDir?: string;
  skillPath?: string;
}

export interface State {
  Messages: Message[];
  runtimeContextMessages: Message[];
  autoCompress: AutoCompressState;
  sessionMemory: SessionMemoryState;
  mode: "default" | "plan";
  agentTasks: AgentTasksState;
  agentNotifications: AgentNotification[];
  invokedSkills: InvokedSkill[];
}

export interface CreateStateOptions {
  messages?: Message[];
  runtimeContextMessages?: Message[];
  autoCompress?: AutoCompressState;
  sessionMemory?: SessionMemoryState;
  mode?: State["mode"];
  agentTasks?: AgentTasksState;
  agentNotifications?: AgentNotification[];
  invokedSkills?: InvokedSkill[];
}

export function createState(options: CreateStateOptions = {}): State {
  return {
    Messages: options.messages ?? [],
    runtimeContextMessages: options.runtimeContextMessages ?? [],
    autoCompress: options.autoCompress ?? {
      summaries: [],
      sessionMemoryUpdated: false,
    },
    sessionMemory: options.sessionMemory ?? createSessionMemoryState(),
    mode: options.mode ?? "default",
    agentTasks: options.agentTasks ?? createAgentTasksState(),
    agentNotifications: options.agentNotifications ??
      createAgentNotificationsState(),
    invokedSkills: options.invokedSkills ?? [],
  };
}
