/** 评测服务组装；每次创建独立实例，导入模块不会读取数据或执行外部命令。 */
import type { EvaluationOptions } from "./types.js";
import { createDatasetRepository } from "./dataset.js";
import { createEvaluationWorkspace } from "./workspace.js";
import { createRunRepository } from "./runs.js";
import { loadCaseEvents, loadCaseConversation } from "./conversation.js";

export function createEvaluationService(options: EvaluationOptions) {
  const datasets = createDatasetRepository(options);
  const workspaces = createEvaluationWorkspace(options);
  const runs = createRunRepository(options, datasets, workspaces);
  return { ...runs, ...workspaces, ...datasets, loadCaseEvents, loadCaseConversation };
}

export type EvaluationService = ReturnType<typeof createEvaluationService>;
