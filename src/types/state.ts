import type {
  AutoCompressState,
  HistorySnipBoundary,
  ToolResultBudgetState,
} from "./context.js";
import {
  createAgentNotificationsState,
  createAgentTasksState,
  type AgentNotification,
  type AgentTasksState,
} from "../Tools/Agent/state.js";
import {
  createBackgroundTaskNotificationsState,
  createBackgroundTasksState,
  type BackgroundTaskNotification,
  type BackgroundTasksState,
} from "../Tools/Bash/state.js";
import type { Message, MessageId } from "./messages.js";
import {
  createSessionMemoryState,
  type SessionMemoryState,
} from "./session-memory.js";
import type { TodoList } from "../Tools/TodoWrite/type.js";

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
  /** 会话业务消息；模型输入由投影构建，保留现有历史与压缩的关系。 */
  Messages: Message[];
  /** 等待本轮注入的附件，合并为 opencat_context 消息后清空。 */
  runtimeContextMessages: Message[];
  /** 已有摘要和按摘要防重的回填标记。 */
  autoCompress: AutoCompressState;
  historySnips: HistorySnipBoundary[];
  /** 已生成的工具结果替换表，由 State 持久化。 */
  toolResultBudgetState: ToolResultBudgetState;
  /** 会话滚动笔记、覆盖位置和更新进度，主会话压缩依赖此状态。 */
  sessionMemory: SessionMemoryState;
  mode: "default" | "plan";
  plan?: PlanState;
  /** 父子智能体的协作任务表；活动执行资源由 Agent runner 管理。 */
  agentTasks: AgentTasksState;
  agentNotifications: AgentNotification[];
  backgroundTasks: BackgroundTasksState;
  backgroundTaskNotifications: BackgroundTaskNotification[];
  /** 已读取技能的正文，供现有压缩后回填逻辑使用。 */
  invokedSkills: InvokedSkill[];
  todos: Record<string, TodoList>;
  /** 文件记忆的召回去重、累计预算与提取游标；记忆库正文在文件中。 */
  longTermMemory: LongTermMemoryState;
}

export interface PlanState {
  path: string;
  content: string;
  updatedAt: number;
}

export interface SurfacedLongTermMemoryFile {
  modifiedAtMs: number;
  injectedBytes: number;
}

export interface LongTermMemoryState {
  surfacedFiles: Record<string, SurfacedLongTermMemoryFile>;
  surfacedBytes: number;
  lastExtractedMessageId?: MessageId;
  retryFromMessageId?: MessageId;
}

export interface CreateStateOptions {
  messages?: Message[];
  runtimeContextMessages?: Message[];
  autoCompress?: AutoCompressState;
  historySnips?: HistorySnipBoundary[];
  toolResultBudgetState?: ToolResultBudgetState;
  sessionMemory?: SessionMemoryState;
  mode?: State["mode"];
  plan?: State["plan"];
  agentTasks?: AgentTasksState;
  agentNotifications?: AgentNotification[];
  backgroundTasks?: BackgroundTasksState;
  backgroundTaskNotifications?: BackgroundTaskNotification[];
  invokedSkills?: InvokedSkill[];
  todos?: Record<string, TodoList>;
  longTermMemory?: LongTermMemoryState;
}

export function createState(options: CreateStateOptions = {}): State {
  return {
    Messages: options.messages ?? [],
    runtimeContextMessages: options.runtimeContextMessages ?? [],
    autoCompress: options.autoCompress ?? {
      summaries: [],
      sessionMemoryUpdated: false,
    },
    historySnips: options.historySnips ?? [],
    toolResultBudgetState: options.toolResultBudgetState ?? {
      seenIds: new Set(),
      replacements: new Map(),
    },
    sessionMemory: options.sessionMemory ?? createSessionMemoryState(),
    mode: options.mode ?? "default",
    plan: options.plan,
    agentTasks: options.agentTasks ?? createAgentTasksState(),
    agentNotifications: options.agentNotifications ??
      createAgentNotificationsState(),
    backgroundTasks: options.backgroundTasks ?? createBackgroundTasksState(),
    backgroundTaskNotifications: options.backgroundTaskNotifications ??
      createBackgroundTaskNotificationsState(),
    invokedSkills: options.invokedSkills ?? [],
    todos: options.todos ?? {},
    longTermMemory: options.longTermMemory ?? {
      surfacedFiles: {},
      surfacedBytes: 0,
    },
  };
}
