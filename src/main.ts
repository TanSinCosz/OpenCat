import { runCli } from "./cli.js";
import { getConfigCliOptions, initializeAppConfig, stripConfigCliOptions } from "./config/load-config.js";

// entry point
initializeAppConfig(getConfigCliOptions());
await runCli(stripConfigCliOptions(process.argv.slice(2)));
