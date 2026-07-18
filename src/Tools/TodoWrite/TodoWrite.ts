import type { z } from "zod";

import { recordTranscriptStateSnapshot } from "../../transcript/persistence.js";
import type { Runtime } from "../../types/runtime.js";
import type { State } from "../../types/state.js";
import type { Tool, ToolUseContext } from "../types.js";
import {
  DESCRIPTION,
  renderTodoWritePrompt,
  TODO_WRITE_TOOL_NAME,
} from "./prompt.js";
import { inputSchema, outputSchema, type TodoList } from "./type.js";

type TodoWriteInput = z.infer<ReturnType<typeof inputSchema>>;
type TodoWriteOutput = z.infer<ReturnType<typeof outputSchema>>;

export class TodoWrite
  implements Tool<TodoWriteInput, TodoWriteOutput, typeof inputSchema, typeof outputSchema> {
  name = TODO_WRITE_TOOL_NAME;
  inputSchema = inputSchema;
  outputSchema = outputSchema;
  strict = true;
  maxResultSizeChars = 100_000;
  searchHint = "update the session todo list";
  shouldDefer = false;
  alwaysLoad = true;

  description(): string {
    return DESCRIPTION;
  }

  prompt(): string {
    return renderTodoWritePrompt();
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  formatResult({ output }: { output: TodoWriteOutput }): string {
    const count = output.newTodos.length;
    return [
      `Todo list updated: ${count} item${count === 1 ? "" : "s"}.`,
      ...renderTodoList(output.newTodos),
      "Continue using the todo list to track progress when applicable.",
    ].join("\n");
  }

  async call(
    input: TodoWriteInput,
    _context: ToolUseContext,
    runtime: Runtime,
    state: State,
  ): Promise<TodoWriteOutput> {
    const todoKey = runtime.agentId;
    const oldTodos = state.todos[todoKey] ?? [];
    const newTodos = normalizeTodos(input.todos);

    state.todos = {
      ...state.todos,
      [todoKey]: newTodos,
    };

    await recordTranscriptStateSnapshot(runtime, state, "todo");

    return {
      oldTodos,
      newTodos,
    };
  }
}

function normalizeTodos(todos: TodoList): TodoList {
  return todos.map((todo) => ({
    content: todo.content.trim(),
    activeForm: todo.activeForm.trim(),
    status: todo.status,
  }));
}

function renderTodoList(todos: TodoList): string[] {
  if (todos.length === 0) {
    return ["Todo list is now empty."];
  }

  return todos.map((todo, index) =>
    `${index + 1}. [${todo.status}] ${todo.content}`
  );
}

export default TodoWrite;
