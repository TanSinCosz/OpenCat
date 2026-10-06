/** Web 应用启动与依赖组装；导入模块本身不会创建会话或监听端口。 */
import { createServer, type Server } from "node:http";
import { getConfigValue } from "../../config/load-config.js";
import { WebSessionManager } from "./session-manager.js";
import { createWebRequestHandler } from "./routes.js";

const DEFAULT_PORT = 5177;

export async function startWebCli(): Promise<Server> {
  const sessions = await WebSessionManager.create();
  const server = createServer(createWebRequestHandler(sessions));
  const port = Number(getConfigValue("web.port") ?? DEFAULT_PORT);
  server.listen(port, () => {
    console.log(`OpenCat debug web CLI: http://localhost:${port}`);
    console.log(`Session: ${sessions.current.runtime.sessionId}`);
    console.log(`Model: ${sessions.current.runtime.modelRuntimeConfig.model}`);
    console.log(
      sessions.current.loadInfo.restored
        ? `Restored transcript: ${sessions.current.loadInfo.transcriptPath}`
        : "Started a new transcript session.",
    );
  });
  return server;
}
