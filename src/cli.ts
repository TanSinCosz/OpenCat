
import { loadConfig } from "./config/load-config.js";
import type { Runtime } from "./types/type.js";
import { createSessionId } from "./utils/session.js";

export async function runCli(args: string[]): Promise<void> {
    const prompt = args.join(" ").trim();

    if (!prompt) {
        console.error("Please provide a prompt.");
        process.exitCode = 1;
        return;
    }

    const config = loadConfig();
    const runtime: Runtime = {
        sessionId: createSessionId(),
        cwd: process.cwd(),
        config
    };

    console.log(`Session: ${runtime.sessionId}`);
    console.log(`Model: ${runtime.config.model}`);
    console.log(`Prompt: ${prompt}`);
}
