import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { getAppConfig } from "./config/load-config.js";
import { closeMcpConnections } from "./mcp/index.js";
import { formatOpenAICompatibleErrorForUser } from "./openai-compatible/errors.js";
import { createToolsWithConfiguredMcp } from "./mcp/config.js";
import { query } from "./query.js";
import { drainPendingLongTermMemoryExtractions } from "./query/long-term-memory.js";
import { recordTranscriptMessage } from "./transcript/persistence.js";
import { createMessage } from "./types/messages.js";
import { createRuntime } from "./types/runtime.js";
import { createState, type State } from "./types/state.js";
import type { Runtime } from "./types/runtime.js";

export async function runCli(args: string[]): Promise<void> {
  const config = getAppConfig();
  const { tools, mcpConnections } = await createToolsWithConfiguredMcp(process.cwd(), config);
  const runtime = createRuntime({
    cwd: process.cwd(),
    appConfig: config,
    modelRuntimeConfig: config.model,
    longTermMemoryConfig: {
      ...config.memory,
      fileMemoryDirectory: config.memory.directory,
    },
    tools,
    mcpConnections,
  });
  const state = createState();
  const firstPrompt = args.join(" ").trim();

  console.log(`Session: ${runtime.sessionId}`);
  console.log(`Config: ${config.configPath ?? "built-in defaults"}`);
  console.log(`Model: ${runtime.modelRuntimeConfig.model ?? "default"}`);
  console.log(`Tools: ${runtime.tools.map((tool) => tool.name).join(", ")}`);
  console.log("Type /exit to quit.");

  const readline = createInterface({ input, output });
  let shouldExit = false;

  readline.on("SIGINT", () => {
    shouldExit = true;
    readline.close();
    output.write("\n");
  });

  try {
    if (firstPrompt) {
      await runUserPrompt(firstPrompt, runtime, state);
    }

    while (!shouldExit) {
      const prompt = (await readline.question("\n> ")).trim();

      if (!prompt) {
        continue;
      }

      if (prompt === "/exit" || prompt === "/quit") {
        break;
      }

      await runUserPrompt(prompt, runtime, state);
    }
  } finally {
    await drainPendingLongTermMemoryExtractions(runtime);
    closeMcpConnections(runtime.mcpConnections);
    readline.close();
  }
}

async function runUserPrompt(
  prompt: string,
  runtime: Runtime,
  state: State,
): Promise<void> {
  const userMessage = createMessage({
    role: "user",
    content: prompt,
  });
  state.Messages.push(userMessage);
  await recordTranscriptMessage(runtime, userMessage);

  let assistantHasOutput = false;

  try {
    for await (const event of query(runtime, state)) {
      switch (event.type) {
        case "assistant_text_delta": {
          if (!assistantHasOutput) {
            output.write("\nassistant> ");
            assistantHasOutput = true;
          }
          output.write(event.text);
          break;
        }
        case "tool_use": {
          if (assistantHasOutput) {
            output.write("\n");
            assistantHasOutput = false;
          }
          output.write(`[tool] ${event.toolCall.function.name}\n`);
          break;
        }
        case "assistant_message": {
          if (!assistantHasOutput && event.message.content) {
            output.write(`\nassistant> ${event.message.content}\n`);
          }
          break;
        }
        case "done": {
          if (assistantHasOutput) {
            output.write("\n");
          }
          if (event.reason === "max_turns") {
            output.write("[done] max turns reached\n");
          }
          break;
        }
      }
    }
  } catch (error) {
    output.write(`\n[error] ${stringifyError(error)}\n`);
  }
}

function stringifyError(error: unknown): string {
  return formatOpenAICompatibleErrorForUser(error);
}
