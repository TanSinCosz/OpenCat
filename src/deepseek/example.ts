import { createDeepSeekClient } from "./client.js";
import { execFileSync } from "node:child_process";

async function main(): Promise<void> {
  const apiKey = getDeepSeekApiKey();

  if (!apiKey) {
    throw new Error("Missing DEEPSEEK_API_KEY environment variable.");
  }

  const client = createDeepSeekClient({
    config: {
      apiKey,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      maxTokens: 4096,
      reasoningEffort: "high",
    },
  });

  for await (const result of client.stream({
    model: "deepseek-v4-pro",
    stream: true,
    messages: [
      {
        role: "user",
        content: "Say hello in one short sentence.",
      },
    ],
    thinking: {
      type: "enabled",
    },
    stream_options: {
      include_usage: true,
    },
    temperature: 0.2,
    user_id: "demo-user",
  })) {
    if (result.done) {
      process.stdout.write("\n[DONE]\n");
      continue;
    }

    const delta = result.chunk?.choices[0]?.delta;

    if (delta?.reasoning_content) {
      process.stdout.write(delta.reasoning_content);
    }

    if (delta?.content) {
      process.stdout.write(delta.content);
    }
  }
}

function getDeepSeekApiKey(): string {
  const sessionValue = process.env.DEEPSEEK_API_KEY?.trim();

  if (sessionValue) {
    return sessionValue;
  }

  try {
    const machineValue = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "[System.Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','Machine')",
      ],
      {
        encoding: "utf8",
      }
    ).trim();

    return machineValue;
  } catch {
    return "";
  }
}

void main();
