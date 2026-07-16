import { z } from "zod";

export const todoStatusSchema = () =>
  z.enum(["pending", "in_progress", "completed"]);

export const todoItemSchema = () =>
  z.strictObject({
    content: z
      .string()
      .min(1)
      .describe("Imperative task description, e.g. 'Run tests'."),
    activeForm: z
      .string()
      .min(1)
      .describe("Present-continuous form, e.g. 'Running tests'."),
    status: todoStatusSchema().describe("Current task status."),
  });

export const todoListSchema = () => z.array(todoItemSchema());

export type TodoItem = z.infer<ReturnType<typeof todoItemSchema>>;
export type TodoList = TodoItem[];

export const inputSchema = () =>
  z.strictObject({
    todos: todoListSchema().describe("The complete updated todo list."),
  });

export const outputSchema = () =>
  z.object({
    oldTodos: todoListSchema(),
    newTodos: todoListSchema(),
  });
