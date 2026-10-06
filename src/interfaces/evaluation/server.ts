/** 看板服务启动与端口回退；导入模块本身不创建服务、不监听端口。 */
import http from "node:http";
import { createEvaluationService } from "../../evaluation/service.js";
import type { DashboardOptions } from "./options.js";
import { createDashboardRequestHandler } from "./routes.js";

export function startEvaluationDashboard(options: DashboardOptions): http.Server {
  const service = createEvaluationService(options);
  const server = http.createServer(createDashboardRequestHandler(options, service));
  listenOnAvailablePort(server, options.port, options.evalRoot);
  return server;
}

export function listenOnAvailablePort(
  server: http.Server,
  preferredPort: number,
  evalRoot: string,
): void {
  const maxPort = Math.min(preferredPort + 20, 65535);

  function tryListen(candidatePort: number): void {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE" && candidatePort < maxPort) {
        console.warn(
          `Port ${candidatePort} is already in use. Trying ${candidatePort + 1}...`,
        );
        tryListen(candidatePort + 1);
        return;
      }

      console.error(`Failed to start SWE eval dashboard: ${error.message}`);
      process.exitCode = 1;
    };

    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      const actualPort = typeof address === "object" && address
        ? address.port
        : candidatePort;
      console.log(`OpenCat SWE eval dashboard: http://localhost:${actualPort}`);
      console.log(`Reading eval data from: ${evalRoot}`);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(candidatePort);
  }

  tryListen(preferredPort);
}
