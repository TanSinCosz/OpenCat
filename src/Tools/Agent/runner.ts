import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { query } from "../../query.js";
import { buildSystemPrompt } from "../../system-prompt.js";
import { emitRunEvent } from "../../telemetry/observer.js";
import {
  recordTranscriptStateSnapshot,
} from "../../transcript/persistence.js";
import { createMessage, type Message } from "../../types/messages.js";
import {
  createRuntime,
  type Runtime,
  type RuntimeAgentRole,
  type SubAgentId,
} from "../../types/runtime.js";
import { createState, type State } from "../../types/state.js";
import type {
  AppState,
  CanUseToolFn,
  FileStateCache,
  PermissionMode,
  ToolPermissionContext,
} from "../types.js";
import { cloneFileStateCache } from "../types.js";
import type { AgentDefinition } from "./definitions.js";
import {
  resolveAgentTools,
  type ResolvedAgentTools,
} from "./tool-policy.js";

const execFileAsync = promisify(execFile);

export type AgentExecutionMode = "sync" | "async" | "fork";
export type AgentIsolationMode = "none" | "worktree";

export type AgentCompletedOutput = {
  status: "completed";
  mode: "sync" | "fork";
  agentId: string;
  agentType: string;
  description: string;
  result: string;
  messageCount: number;
  worktreePath?: string;
  worktreeBranch?: string;
  baseCommit?: string;
  changedFiles?: string[];
};

export type AgentAsyncLaunchedOutput = {
  status: "async_launched";
  mode: "async";
  agentId: string;
  agentType: string;
  description: string;
  prompt: string;
  outputFile: string;
  worktreePath?: string;
  worktreeBranch?: string;
  baseCommit?: string;
};

export type AgentOutput = AgentCompletedOutput | AgentAsyncLaunchedOutput;

export type RunAgentOptions = {
  parentRuntime: Runtime;
  parentState: State;
  agentDefinition: AgentDefinition;
  prompt: string;
  description: string;
  mode: AgentExecutionMode;
  isolation: AgentIsolationMode;
  maxTurns?: number;
  agentId?: SubAgentId;
  recordTaskLifecycle?: boolean;
  worktree?: AgentWorktreeSession;
  canUseTool?: CanUseToolFn;
  readFileState?: FileStateCache;
  agentRole?: RuntimeAgentRole;
  forkContextMessages?: readonly Message[];
};

type AgentWorktreeSession = {
  worktreePath: string;
  worktreeBranch: string;
  baseCommit: string;
  repoRoot: string;
};

type FinalizedWorktree = {
  worktreePath?: string;
  worktreeBranch?: string;
  baseCommit?: string;
  changedFiles?: string[];
};

export async function runAgentTask(options: RunAgentOptions): Promise<AgentOutput> {
  if (options.mode === "async") {
    return launchAsyncAgent(options);
  }

  return runAgentSynchronously(options);
}

async function launchAsyncAgent(options: RunAgentOptions): Promise<AgentAsyncLaunchedOutput> {
  const agentId = createAgentId();
  const worktree = await prepareAgentWorktreeIfNeeded(options, agentId);
  const outputFile = getAgentOutputFile(agentId);

  registerAgentTask(options, agentId, "async", outputFile, worktree);

  void runAgentSynchronously({
    ...options,
    mode: "sync",
    agentId,
    worktree,
    recordTaskLifecycle: false,
  })
    .then(async (result) => {
      await writeAgentOutput(outputFile, result);
      await completeAgentTask(options, agentId, result.result, outputFile, result);
    })
    .catch(async (error) => {
      const message = stringifyError(error);
      const finalizedWorktree = await preserveAgentWorktreeAfterFailure(worktree);
      await writeAgentOutput(outputFile, {
        status: "failed",
        agentId,
        agentType: options.agentDefinition.agentType,
        description: options.description,
        error: message,
        ...finalizedWorktree,
      });
      await failAgentTask(options, agentId, message, outputFile, finalizedWorktree);
    });

  return {
    status: "async_launched",
    mode: "async",
    agentId,
    agentType: options.agentDefinition.agentType,
    description: options.description,
    prompt: options.prompt,
    outputFile,
    ...worktreeToOutput(worktree),
  };
}

async function runAgentSynchronously(
  options: RunAgentOptions,
): Promise<AgentCompletedOutput> {
  const agentId = options.agentId ?? createAgentId();
  const worktree = options.worktree ??
    await prepareAgentWorktreeIfNeeded(options, agentId);
  const shouldRecordLifecycle = options.recordTaskLifecycle ?? true;

  if (shouldRecordLifecycle) {
    registerAgentTask(options, agentId, options.mode, undefined, worktree);
  }

  const resolvedAgentTools = resolveAgentTools(
    options.agentDefinition,
    options.parentRuntime.tools,
    {
      isAsync: options.mode === "async",
      isFork: options.mode === "fork",
    },
  );
  const agentToolPolicyPrompt = renderAgentToolPolicyPrompt(
    options,
    resolvedAgentTools,
  );
  const childState = createChildAgentState(
    options,
    agentId,
    worktree,
    agentToolPolicyPrompt,
  );
  const childRuntime = createChildAgentRuntime(
    options,
    childState,
    agentId,
    worktree,
    resolvedAgentTools,
  );
  if (options.mode !== "fork") {
    childRuntime.systemPrompt = await buildSystemPrompt(childRuntime, {
      outputStyle: {
        name: `${options.agentDefinition.agentType} agent`,
        prompt: [
          options.agentDefinition.getSystemPrompt(),
          agentToolPolicyPrompt,
        ].join("\n\n"),
      },
    });
  }

  let result = "";
  let finalizedWorktree: FinalizedWorktree = worktreeToOutput(worktree);
  const startedAt = Date.now();

  await emitRunEvent(options.parentRuntime, {
    type: "agent_started",
    childAgentId: agentId,
    childAgentType: options.agentDefinition.agentType,
    mode: options.mode,
    isolation: options.isolation,
    allowedTools: resolvedAgentTools.resolvedTools.map((tool) => tool.name),
    worktreePath: worktree?.worktreePath,
    worktreeBranch: worktree?.worktreeBranch,
  });

  try {
    for await (const event of query(childRuntime, childState, {
      maxTurns: options.maxTurns ?? options.agentDefinition.maxTurns ?? 100,
    })) {
      if (event.type === "assistant_message" && event.message.content) {
        result = event.message.content;
      }
    }

    finalizedWorktree = await finalizeAgentWorktree(worktree);

    if (shouldRecordLifecycle) {
      await completeAgentTask(options, agentId, result, undefined, finalizedWorktree);
    }
    await emitRunEvent(options.parentRuntime, {
      type: "agent_finished",
      childAgentId: agentId,
      childAgentType: options.agentDefinition.agentType,
      mode: options.mode,
      durationMs: Date.now() - startedAt,
      messageCount: childState.Messages.length,
      changedFiles: finalizedWorktree.changedFiles,
      worktreePath: finalizedWorktree.worktreePath,
      worktreeBranch: finalizedWorktree.worktreeBranch,
    });

    return {
      status: "completed",
      mode: options.mode === "fork" ? "fork" : "sync",
      agentId,
      agentType: options.agentDefinition.agentType,
      description: options.description,
      result,
      messageCount: childState.Messages.length,
      ...finalizedWorktree,
    };
  } catch (error) {
    finalizedWorktree = await preserveAgentWorktreeAfterFailure(worktree);

    if (shouldRecordLifecycle) {
      await failAgentTask(
        options,
        agentId,
        stringifyError(error),
        undefined,
        finalizedWorktree,
      );
    }
    await emitRunEvent(options.parentRuntime, {
      type: "agent_failed",
      childAgentId: agentId,
      childAgentType: options.agentDefinition.agentType,
      mode: options.mode,
      durationMs: Date.now() - startedAt,
      error: stringifyError(error),
      changedFiles: finalizedWorktree.changedFiles,
      worktreePath: finalizedWorktree.worktreePath,
      worktreeBranch: finalizedWorktree.worktreeBranch,
    });

    throw error;
  }
}

function buildInitialMessages(
  options: RunAgentOptions,
  worktree: AgentWorktreeSession | undefined,
  agentToolPolicyPrompt: string,
): Message[] {
  const worktreeNotice = worktree
    ? `${buildWorktreeNotice(options.parentRuntime.cwd, worktree.worktreePath)}\n\n`
    : "";

  if (options.mode === "fork") {
    const contextMessages = options.forkContextMessages ??
      options.parentState.Messages;

    return [
      ...filterIncompleteToolCallMessages(
        contextMessages,
      ),
      createMessage({
        role: "user",
        content:
          `${worktreeNotice}${buildForkDirective(options.prompt, agentToolPolicyPrompt)}`,
      }, { source: "agent_message" }),
    ];
  }

  return [
    createMessage({
      role: "user",
      content: `${worktreeNotice}${options.prompt}`,
    }, { source: "agent_message" }),
  ];
}

function createChildAgentState(
  options: RunAgentOptions,
  agentId: SubAgentId,
  worktree: AgentWorktreeSession | undefined,
  agentToolPolicyPrompt: string,
): State {
  const messages = buildInitialMessages(options, worktree, agentToolPolicyPrompt);

  if (options.mode === "fork") {
    return createState({
      messages,
      runtimeContextMessages: cloneMessages(options.parentState.runtimeContextMessages),
      autoCompress: cloneAutoCompressState(options.parentState.autoCompress),
      sessionMemory: cloneSessionMemoryState(options.parentState.sessionMemory),
      invokedSkills: cloneInvokedSkillsForFork(
        options.parentState.invokedSkills,
        options.parentRuntime.agentId,
        agentId,
      ),
      todos: cloneTodosForFork(
        options.parentState.todos,
        options.parentRuntime.agentId,
        agentId,
      ),
      mode: options.parentState.mode,
      agentTasks: options.parentState.agentTasks,
    });
  }

  return createState({
    messages,
    mode: options.agentDefinition.permissionMode === "plan" ? "plan" : "default",
    agentTasks: options.parentState.agentTasks,
  });
}

function cloneMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({ ...message }) as Message);
}

function filterIncompleteToolCallMessages(
  messages: readonly Message[],
): Message[] {
  const resultIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "tool") {
      resultIds.add(message.tool_call_id);
    }
  }

  const keepAssistantIds = new Set<Message["id"]>();
  const keepToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    const toolCallIds = (message.tool_calls ?? []).map((toolCall) => toolCall.id);
    if (toolCallIds.length === 0) {
      keepAssistantIds.add(message.id);
      continue;
    }

    if (toolCallIds.every((toolCallId) => resultIds.has(toolCallId))) {
      keepAssistantIds.add(message.id);
      for (const toolCallId of toolCallIds) {
        keepToolCallIds.add(toolCallId);
      }
    }
  }

  return messages.flatMap((message) => {
    if (message.role === "assistant" && !keepAssistantIds.has(message.id)) {
      return [];
    }

    if (message.role === "tool" && !keepToolCallIds.has(message.tool_call_id)) {
      return [];
    }

    return [{ ...message } as Message];
  });
}

function cloneInvokedSkillsForFork(
  skills: readonly State["invokedSkills"][number][],
  parentAgentId: string,
  childAgentId: string,
): State["invokedSkills"] {
  return skills.map((skill) => ({
    ...skill,
    agentId: skill.agentId === parentAgentId ? childAgentId : skill.agentId,
  }));
}

function cloneAutoCompressState(state: State["autoCompress"]): State["autoCompress"] {
  return {
    ...state,
    summaries: state.summaries.map((summary) => ({ ...summary })),
  };
}

function cloneTodosForFork(
  todos: State["todos"],
  parentAgentId: string,
  childAgentId: string,
): State["todos"] {
  const cloned = Object.fromEntries(
    Object.entries(todos).map(([agentId, items]) => [
      agentId,
      items.map((item) => ({ ...item })),
    ]),
  );

  if (todos[parentAgentId] && !cloned[childAgentId]) {
    cloned[childAgentId] = todos[parentAgentId].map((item) => ({ ...item }));
  }

  return cloned;
}

function cloneSessionMemoryState(
  state: State["sessionMemory"],
): State["sessionMemory"] {
  return {
    ...state,
    config: { ...state.config },
  };
}

function createChildAgentRuntime(
  options: RunAgentOptions,
  childState: State,
  agentId: SubAgentId,
  worktree: AgentWorktreeSession | undefined,
  resolvedAgentTools: ResolvedAgentTools,
): Runtime {
  const parent = options.parentRuntime;
  const childTools = resolvedAgentTools.resolvedTools;

  return createRuntime({
    sessionId: parent.sessionId,
    agentId,
    agentRole: options.agentRole ?? "subagent",
    parentAgentId: parent.agentId,
    agentType: options.agentDefinition.agentType,
    cwd: worktree?.worktreePath ?? parent.cwd,
    deepSeekRuntimeConfig: {
      ...parent.deepSeekRuntimeConfig,
      model: resolveAgentModel(
        options.agentDefinition.model,
        parent.deepSeekRuntimeConfig.model,
      ),
    },
    deepSeekClient: parent.deepSeekClient,
    contextProjectionState: parent.contextProjectionState,
    toolResultBudgetState: parent.toolResultBudgetState,
    MemoryConfig: parent.MemoryConfig,
    longTermMemory: parent.longTermMemory,
    longTermMemoryConfig: {
      ...parent.longTermMemoryConfig,
      agentId,
    },
    tools: childTools,
    observer: parent.observer,
    usage: parent.usage,
    tokenizer: parent.toolUseContext.tokenizer,
    isNonInteractiveSession: parent.toolUseContext.options.isNonInteractiveSession,
    mainLoopModel: parent.deepSeekRuntimeConfig.model,
    agentDefinitions: parent.toolUseContext.options.agentDefinitions,
    thinkingConfig: parent.toolUseContext.options.thinkingConfig,
    appState: deriveChildAppState(options),
    systemPrompt: options.mode === "fork" ? parent.systemPrompt : undefined,
    readFileState: options.readFileState ??
      (options.mode === "fork" && !worktree
        ? cloneFileStateCache(parent.toolUseContext.readFileState)
        : undefined),
    canUseTool: options.canUseTool,
  });
}

function deriveChildAppState(options: RunAgentOptions): AppState {
  const parentAppState = options.parentRuntime.toolUseContext.getAppState();

  return {
    ...parentAppState,
    toolPermissionContext: deriveChildPermissionContext(
      parentAppState.toolPermissionContext,
      options,
    ),
  };
}

function deriveChildPermissionContext(
  parent: ToolPermissionContext,
  options: RunAgentOptions,
): ToolPermissionContext {
  const mode = resolveChildPermissionMode(parent.mode, options);

  return {
    ...parent,
    mode,
    additionalWorkingDirectories: new Map(parent.additionalWorkingDirectories),
    alwaysAllowRules: clonePermissionRules(parent.alwaysAllowRules),
    alwaysDenyRules: clonePermissionRules(parent.alwaysDenyRules),
    alwaysAskRules: clonePermissionRules(parent.alwaysAskRules),
  };
}

function resolveChildPermissionMode(
  parentMode: PermissionMode,
  options: RunAgentOptions,
): PermissionMode {
  if (options.mode === "fork") {
    return parentMode;
  }

  return options.agentDefinition.permissionMode ?? parentMode;
}

function clonePermissionRules<T extends Record<string, string[] | undefined>>(
  rules: T,
): T {
  return Object.fromEntries(
    Object.entries(rules).map(([source, values]) => [
      source,
      values ? [...values] : values,
    ]),
  ) as T;
}

function resolveAgentModel(
  agentModel: AgentDefinition["model"],
  parentModel: string,
): string {
  if (!agentModel || agentModel === "inherit") {
    return parentModel;
  }

  return agentModel;
}

function buildForkDirective(prompt: string, agentToolPolicyPrompt: string): string {
  return `<fork_worker>
STOP. READ THIS FIRST.

You are a forked worker process. You are not the main agent.

Rules:
1. You inherit the parent conversation context above. Use it, but do not repeat it.
2. Do not spawn other agents.
3. Execute the directive directly using your tools.
4. Stay strictly within the directive's scope.
5. Keep your final report concise and factual.

The inherited parent system prompt may mention parent-agent tools. That parent
tool list does not apply to this fork. The tool policy below is the authoritative
list for this child agent:

${agentToolPolicyPrompt}

Output format:
Scope: <the scope you handled>
Result: <answer or key findings>
Key files: <relevant file paths, if any>
Files changed: <files changed, if any>
Issues: <only if there are issues to flag>
</fork_worker>

Directive: ${prompt}`;
}

function renderAgentToolPolicyPrompt(
  options: RunAgentOptions,
  resolvedAgentTools: ResolvedAgentTools,
): string {
  const availableTools = resolvedAgentTools.resolvedTools
    .map((tool) => tool.name)
    .join(", ") || "(none)";
  const unavailableTools = uniqueStrings(resolvedAgentTools.unavailableTools)
    .join(", ") || "(none)";
  const lines = [
    "<agent_tool_policy>",
    `Agent type: ${options.agentDefinition.agentType}`,
    `Execution mode: ${options.mode}`,
    `Available tools: ${availableTools}`,
    `Unavailable tools: ${unavailableTools}`,
    "Use only the tools listed as available. Do not attempt to call unavailable tools.",
    "If an unavailable tool would be needed, report the blocker to the parent agent instead of trying to work around the policy.",
  ];

  if (options.agentDefinition.category === "explore" ||
    options.agentDefinition.category === "plan") {
    lines.push(
      "This is a read-only agent. Do not create, edit, delete, move, copy, or install anything.",
    );
  } else if (options.agentDefinition.category === "verify") {
    lines.push(
      "This is a verification-only agent. You may run existing checks and read-only inspection commands, but must not edit project files.",
    );
  } else {
    lines.push(
      "Do not spawn nested agents. The Agent tool is unavailable to child agents.",
    );
  }

  lines.push("</agent_tool_policy>");
  return lines.join("\n");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function buildWorktreeNotice(parentCwd: string, worktreeCwd: string): string {
  return `<worktree_isolation>
You are operating in an isolated git worktree.
Parent cwd: ${parentCwd}
Your cwd: ${worktreeCwd}

Paths from inherited context may refer to the parent cwd. Translate them to your worktree before editing. Re-read files in your worktree before modifying them. Your changes stay in this worktree and do not modify the parent's working copy.
</worktree_isolation>`;
}

function createAgentId(): SubAgentId {
  return `agent_${randomUUID()}`;
}

function registerAgentTask(
  options: RunAgentOptions,
  agentId: string,
  mode: AgentExecutionMode,
  outputFile?: string,
  worktree?: AgentWorktreeSession,
): void {
  const now = Date.now();

  options.parentState.agentTasks[agentId] = {
    id: agentId,
    agentType: options.agentDefinition.agentType,
    description: options.description,
    prompt: options.prompt,
    mode,
    status: "running",
    createdAt: now,
    updatedAt: now,
    pendingMessages: [],
    outputFile,
    ...worktreeToOutput(worktree),
  };
}

async function completeAgentTask(
  options: RunAgentOptions,
  agentId: string,
  result: string,
  outputFile?: string,
  worktree?: FinalizedWorktree,
): Promise<void> {
  const now = Date.now();
  const existing = options.parentState.agentTasks[agentId];

  options.parentState.agentTasks[agentId] = {
    ...(existing ?? createTaskFallback(options, agentId, outputFile)),
    status: "completed",
    updatedAt: now,
    result,
    outputFile: outputFile ?? existing?.outputFile,
    ...worktree,
  };

  if (outputFile || worktree?.worktreePath) {
    await enqueueAgentNotification(options, agentId, "completed", outputFile, worktree);
  }
}

async function failAgentTask(
  options: RunAgentOptions,
  agentId: string,
  error: string,
  outputFile?: string,
  worktree?: FinalizedWorktree,
): Promise<void> {
  const now = Date.now();
  const existing = options.parentState.agentTasks[agentId];

  options.parentState.agentTasks[agentId] = {
    ...(existing ?? createTaskFallback(options, agentId, outputFile)),
    status: "failed",
    updatedAt: now,
    error,
    outputFile: outputFile ?? existing?.outputFile,
    ...worktree,
  };

  if (outputFile || worktree?.worktreePath) {
    await enqueueAgentNotification(options, agentId, "failed", outputFile, worktree);
  }
}

function createTaskFallback(
  options: RunAgentOptions,
  agentId: string,
  outputFile?: string,
) {
  const now = Date.now();

  return {
    id: agentId,
    agentType: options.agentDefinition.agentType,
    description: options.description,
    prompt: options.prompt,
    mode: options.mode,
    status: "running" as const,
    createdAt: now,
    updatedAt: now,
    pendingMessages: [],
    outputFile,
  };
}

async function enqueueAgentNotification(
  options: RunAgentOptions,
  agentId: string,
  status: "completed" | "failed",
  outputFile?: string,
  worktree?: FinalizedWorktree,
): Promise<void> {
  options.parentState.agentNotifications.push({
    id: `agent_notification_${randomUUID()}`,
    agentTaskId: agentId,
    agentType: options.agentDefinition.agentType,
    description: options.description,
    status,
    createdAt: Date.now(),
    message: buildAgentNotificationMessage(
      options,
      agentId,
      status,
      outputFile,
      worktree,
    ),
    outputFile,
    ...worktree,
  });
  await recordTranscriptStateSnapshot(
    options.parentRuntime,
    options.parentState,
    "agent_notification",
  );
}

function buildAgentNotificationMessage(
  options: RunAgentOptions,
  agentId: string,
  status: "completed" | "failed",
  outputFile?: string,
  worktree?: FinalizedWorktree,
): string {
  const lines = [
    `<task-notification>`,
    `Agent task ${status}: ${options.description}`,
    `agent_id: ${agentId}`,
    `agent_type: ${options.agentDefinition.agentType}`,
  ];

  if (outputFile) {
    lines.push(`output_file: ${outputFile}`);
  }

  if (worktree?.worktreePath) {
    lines.push(`worktree_path: ${worktree.worktreePath}`);
  }

  if (worktree?.worktreeBranch) {
    lines.push(`worktree_branch: ${worktree.worktreeBranch}`);
  }

  if (worktree?.changedFiles?.length) {
    lines.push(`changed_files: ${worktree.changedFiles.join(", ")}`);
  }

  lines.push(`</task-notification>`);

  return lines.join("\n");
}

async function prepareAgentWorktreeIfNeeded(
  options: RunAgentOptions,
  agentId: SubAgentId,
): Promise<AgentWorktreeSession | undefined> {
  if (options.isolation !== "worktree") {
    return undefined;
  }

  const repoRoot = await getGitRepoRoot(options.parentRuntime.cwd);
  const baseCommit = await git(["rev-parse", "HEAD"], repoRoot);
  const slug = sanitizeWorktreeSlug(`${agentId}-${options.agentDefinition.agentType}`);
  const worktreeBranch = `opencat-agent-${slug}`;
  const worktreePath = path.join(tmpdir(), "opencat-agent-worktrees", slug);

  await mkdir(path.dirname(worktreePath), { recursive: true });
  await git(["worktree", "add", "-b", worktreeBranch, worktreePath, baseCommit], repoRoot);

  return {
    worktreePath,
    worktreeBranch,
    baseCommit,
    repoRoot,
  };
}

async function finalizeAgentWorktree(
  worktree: AgentWorktreeSession | undefined,
): Promise<FinalizedWorktree> {
  if (!worktree) {
    return {};
  }

  const changedFiles = await getChangedFiles(worktree.worktreePath);
  if (changedFiles.length === 0) {
    await cleanupAgentWorktree(worktree);
    return {
      worktreePath: undefined,
      worktreeBranch: undefined,
      baseCommit: undefined,
      changedFiles: undefined,
    };
  }

  return {
    ...worktreeToOutput(worktree),
    changedFiles,
  };
}

async function preserveAgentWorktreeAfterFailure(
  worktree: AgentWorktreeSession | undefined,
): Promise<FinalizedWorktree> {
  if (!worktree) {
    return {};
  }

  return {
    ...worktreeToOutput(worktree),
    changedFiles: await getChangedFiles(worktree.worktreePath),
  };
}

function worktreeToOutput(
  worktree: AgentWorktreeSession | undefined,
): FinalizedWorktree {
  if (!worktree) {
    return {};
  }

  return {
    worktreePath: worktree.worktreePath,
    worktreeBranch: worktree.worktreeBranch,
    baseCommit: worktree.baseCommit,
  };
}

async function getGitRepoRoot(cwd: string): Promise<string> {
  try {
    return await git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    throw new Error("Agent worktree isolation requires running inside a git repository.");
  }
}

async function getChangedFiles(cwd: string): Promise<string[]> {
  const status = await git(["status", "--short"], cwd);
  return status
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

async function cleanupAgentWorktree(worktree: AgentWorktreeSession): Promise<void> {
  await git([
    "worktree",
    "remove",
    "--force",
    worktree.worktreePath,
  ], worktree.repoRoot);
  await git(["branch", "-D", worktree.worktreeBranch], worktree.repoRoot);
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
  });

  return stdout.trim();
}

function sanitizeWorktreeSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function getAgentOutputFile(agentId: string): string {
  return path.join(tmpdir(), "opencat-agents", `${agentId}.json`);
}

async function writeAgentOutput(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
