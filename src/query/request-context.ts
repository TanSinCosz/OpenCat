/** 压缩后生成本轮上下文：刷新计划、Todo、技能和记忆，将待处理上下文写入一个请求附件。 */
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import { recordTranscriptMessage, recordTranscriptStateSnapshot } from "../transcript/persistence.js";
import { restorePlan } from "../plan/persistence.js";
import { createLongTermMemoryContextMessage } from "./long-term-memory.js";
import {
  loadRuntimeContextForQuery,
  loadDynamicSkillContextForQuery,
  createProjectionContextStateMessage,
} from "./runtime-context.js";

export async function materializeRequestContext(
  runtime: Runtime,
  state: State,
): Promise<void> {
  await loadRuntimeContextForQuery(runtime, state);
  await loadDynamicSkillContextForQuery(runtime, state);
  // 可变信息每轮重新生成，先移除上一轮的同类块，避免旧计划、Todo 和记忆反复累积。
  removePreviousVolatileContextBlocks(state);
  await restorePlan(runtime, state);

  const longTermMemoryMessage = shouldAttachLongTermMemory(state)
    ? await createLongTermMemoryContextMessage(
      runtime,
      state.Messages,
      state.longTermMemory,
    )
    : null;
  const contextMessage = createProjectionContextStateMessage([
    ...createPlanModeContextBlocks(state),
    ...createTodoListContextBlocks(runtime, state),
    ...(longTermMemoryMessage
      ? [{
        source: "long_term_memory" as const,
        content: typeof longTermMemoryMessage.content === "string"
          ? longTermMemoryMessage.content
          : "",
      }]
      : []),
    ...state.runtimeContextMessages.map((message) => ({
      source: message.source,
      content: typeof message.content === "string" ? message.content : "",
    })),
  ]);

  if (!contextMessage) {
    return;
  }

  state.Messages.push(contextMessage);
  state.runtimeContextMessages = [];
  await recordTranscriptMessage(runtime, contextMessage);
  await recordTranscriptStateSnapshot(runtime, state, "runtime_context");
}

function createPlanModeContextBlocks(
  state: State,
): Array<{ source: "plan_mode"; content: string }> {
  if (state.mode !== "plan") {
    return [];
  }

  return [{
    source: "plan_mode",
    content: [
      "<plan_mode>",
      "The current agent is in plan mode. Inspect, reason, and update TodoWrite if useful, but do not modify files or run environment-changing tools until plan mode is exited.",
      "</plan_mode>",
    ].join("\n"),
  }];
}

function createTodoListContextBlocks(
  runtime: Runtime,
  state: State,
): Array<{ source: "todo_list"; content: string }> {
  const todos = state.todos[runtime.agentId] ?? [];
  if (todos.length === 0) {
    return [];
  }

  return [{
    source: "todo_list",
    content: renderTodoListContext(todos),
  }];
}

function renderTodoListContext(todos: State["todos"][string]): string {
  return [
    "<todo_list>",
    "Current task list for this agent. Use it as progress context; update it with TodoWrite when the plan changes.",
    ...todos.map((todo, index) =>
      `${index + 1}. [${todo.status}] ${todo.content} (${todo.activeForm})`
    ),
    "</todo_list>",
  ].join("\n");
}

function removePreviousVolatileContextBlocks(state: State): void {
  state.Messages = state.Messages.flatMap((message) => {
    if (
      message.role !== "user" ||
      message.name !== "opencat_context" ||
      typeof message.content !== "string"
    ) {
      return [message];
    }

    const content = stripVolatileContextBlocks(message.content);
    if (content === message.content) {
      return [message];
    }

    if (!content.includes("<context_block source=")) {
      return [];
    }

    return [{ ...message, content }];
  });
}

function stripVolatileContextBlocks(content: string): string {
  return content
    .replace(
      /(?:\r?\n)?<context_block source="long_term_memory">[\s\S]*?<\/context_block>(?:\r?\n)?/g,
      "\n",
    )
    .replace(
      /(?:\r?\n)?<context_block source="dynamic_skill">[\s\S]*?<\/context_block>(?:\r?\n)?/g,
      "\n",
    )
    .replace(
      /(?:\r?\n)?<context_block source="todo_list">[\s\S]*?<\/context_block>(?:\r?\n)?/g,
      "\n",
    )
    .replace(
      /(?:\r?\n)?<context_block source="plan_mode">[\s\S]*?<\/context_block>(?:\r?\n)?/g,
      "\n",
    )
    .replace(
      /(?:\r?\n)?<context_block source="plan_file">[\s\S]*?<\/context_block>(?:\r?\n)?/g,
      "\n",
    )
    .replace(
      /(?:\r?\n)?<context_block source="agent_task_status">[\s\S]*?<\/context_block>(?:\r?\n)?/g,
      "\n",
    )
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n<\/opencat_context>/, "\n</opencat_context>");
}

function shouldAttachLongTermMemory(state: State): boolean {
  // 只在用户的新输入后召回记忆；工具反馈不触发重复召回。
  const lastMessage = state.Messages.at(-1);
  return lastMessage?.role === "user" && lastMessage.source === "user";
}
