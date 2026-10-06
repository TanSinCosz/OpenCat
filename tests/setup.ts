import { fileURLToPath } from "node:url";
import { initializeAppConfig } from "../src/config/load-config.js";

// 每个测试进程使用确定的配置，避免开发者本地 YAML 影响回归结果。
initializeAppConfig({
  configPath: fileURLToPath(new URL("./fixtures/app-config.yaml", import.meta.url)),
});
