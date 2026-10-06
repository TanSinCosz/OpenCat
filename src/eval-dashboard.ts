/** SWE 评测看板入口；功能地图见 interfaces/evaluation/README.md。 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigCliOptions, initializeAppConfig } from "./config/load-config.js";
import { createDashboardOptions } from "./interfaces/evaluation/options.js";
import { startEvaluationDashboard } from "./interfaces/evaluation/server.js";

initializeAppConfig(getConfigCliOptions());
// 以入口所在的项目目录定位数据，保持从 src 与 dist 启动时路径一致。
const workspaceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
startEvaluationDashboard(createDashboardOptions(workspaceRoot));
