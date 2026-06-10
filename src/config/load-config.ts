import type { AgentConfig } from "../types/config.js";

export function loadConfig(): AgentConfig {
    return {
        model: process.env.OPENCAT_MODEL ?? "gpt-4.1-mini",
        apiBaseUrl: process.env.OPENCAT_API_BASE_URL ?? "https://api.openai.com/v1",
        apiKeyEnvVar: "OPENAI_API_KEY"
    };
}
