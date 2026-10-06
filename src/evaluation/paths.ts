/** 评测目录解析；仅选择本次应用配置允许读取的根目录。 */
import path from "node:path";
import type { EvaluationOptions } from "./types.js";

export function resolveEvalRoot(options: EvaluationOptions, datasetDir?: string): string {
  if (!datasetDir) return options.evalRoot;
  const requested = path.resolve(options.workspaceRoot, datasetDir);
  return options.evalRoots.find((root) => path.resolve(root) === requested) ?? options.evalRoot;
}
