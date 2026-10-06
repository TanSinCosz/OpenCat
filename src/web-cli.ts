/** Web CLI 入口。业务实现与项目导航见 interfaces/web/README.md。 */
import { getConfigCliOptions, initializeAppConfig } from "./config/load-config.js";
import { startWebCli } from "./interfaces/web/server.js";

initializeAppConfig(getConfigCliOptions());
await startWebCli();
