/** 看板启动配置：保持 YAML 优先于 --dataset 的路径选择，冻结本次应用配置。 */
import path from "node:path";
import { getAppConfig, getConfigValue, type AppConfig } from "../../config/load-config.js";
import type { EvaluationOptions } from "../../evaluation/types.js";

export interface DashboardOptions extends EvaluationOptions {
  webChatUrl: string;
  port: number;
}

export function createDashboardOptions(
  workspaceRoot: string,
  appConfig: AppConfig = getAppConfig(),
  args: readonly string[] = process.argv,
): DashboardOptions {
  const evalRoot = path.resolve(
    getConfigValue("evaluation.directory", appConfig)?.trim() ||
      getCliArgument("--dataset", args) ||
      path.join(workspaceRoot, ".opencat/evals/swe-verified-cache"),
  );
  const evalRootIsExplicit = Boolean(
    getConfigValue("evaluation.directory", appConfig)?.trim() || getCliArgument("--dataset", args),
  );
  const evalRoots = evalRootIsExplicit
    ? [evalRoot]
    : [
      evalRoot,
      path.join(workspaceRoot, ".opencat/evals/swe-lite"),
      path.join(workspaceRoot, ".opencat/evals/swe-lite-baseline"),
    ];
  const webChatUrl = (getConfigValue("web.url", appConfig)?.trim() || "http://localhost:5177")
    .replace(/\/+$/, "");
  const port = readPort(appConfig);
  return { workspaceRoot, evalRoot, evalRoots, webChatUrl, port, appConfig };
}

function getCliArgument(name: string, args: readonly string[]): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value?.trim() || undefined;
}

function readPort(appConfig: AppConfig): number {
  const value = Number(getConfigValue("evaluation.dashboardPort", appConfig) ?? 5188);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 5188;
}
