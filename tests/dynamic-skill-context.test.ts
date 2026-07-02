import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DeepSeekClient } from "../src/deepseek/client.js";
import type {
  DeepSeekChatCompletionResponse,
  DeepSeekCreateRequest,
  DeepSeekStreamEnvelope,
  DeepSeekStreamRequest,
} from "../src/deepseek/types.js";
import { query } from "../src/query.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("dynamic skills are materialized into opencat context once", async () => {
  const state = createState({
    messages: [
      createMessage({
        role: "user",
        content: "Use the project conventions.",
      }),
    ],
  });
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-dynamic-skill-")),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: createTextClient("OK"),
    MemoryConfig: createMemoryConfig(),
    longTermMemoryConfig: {
      enabled: false,
    },
    messages: state.Messages,
    tools: [],
  });
  runtime.toolUseContext.skillRuntime.dynamicSkills.set("repo-style", {
    name: "repo-style",
    description: "Repository style rules",
    content: "Always keep changes small and run targeted tests.",
    paths: ["src/**"],
    skillDir: join(runtime.cwd, ".claude", "skills"),
    skillPath: join(runtime.cwd, ".claude", "skills", "repo-style", "SKILL.md"),
  });

  for await (const _event of query(runtime, state, { maxTurns: 1 })) {
    // Drain query stream.
  }

  const contextMessages = getDynamicSkillContextMessages(state);
  assert.equal(contextMessages.length, 1);
  assert.match(contextMessages[0] ?? "", /<dynamic_skills>/);
  assert.match(contextMessages[0] ?? "", /repo-style/);
  assert.match(contextMessages[0] ?? "", /Repository style rules/);
  assert.match(contextMessages[0] ?? "", /<paths>src\/\*\*<\/paths>/);
  assert.match(contextMessages[0] ?? "", /<skill_dir>/);
  assert.doesNotMatch(contextMessages[0] ?? "", /Always keep changes small/);

  state.Messages.push(createMessage({
    role: "user",
    content: "Continue.",
  }));
  runtime.toolUseContext.messages = state.Messages;

  for await (const _event of query(runtime, state, { maxTurns: 1 })) {
    // Drain query stream.
  }

  assert.equal(getDynamicSkillContextMessages(state).length, 1);
});

function getDynamicSkillContextMessages(state: ReturnType<typeof createState>): string[] {
  return state.Messages
    .filter((message) =>
      message.role === "user" &&
      message.source === "runtime" &&
      message.name === "opencat_context" &&
      typeof message.content === "string" &&
      message.content.includes("<dynamic_skills>")
    )
    .map((message) => typeof message.content === "string" ? message.content : "");
}

function createTextClient(content: string): DeepSeekClient {
  return {
    async create(_input: DeepSeekCreateRequest): Promise<DeepSeekChatCompletionResponse> {
      throw new Error("create is not used in this test");
    },
    async *stream(_input: DeepSeekStreamRequest): AsyncGenerator<DeepSeekStreamEnvelope> {
      yield {
        raw: content,
        done: false,
        chunk: {
          id: "assistant-content",
          object: "chat.completion.chunk",
          created: 0,
          model: "deepseek-v4-flash",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content,
              },
              finish_reason: "stop",
            },
          ],
        },
      };
      yield {
        raw: "[DONE]",
        done: true,
        chunk: null,
      };
    },
    async collectStream(): Promise<never> {
      throw new Error("collectStream is not used in this test");
    },
  };
}

function createMemoryConfig() {
  return {
    embedder: {
      provider: "test",
      config: {},
    },
    vectorStore: {
      provider: "test",
      config: {},
    },
    llm: {
      provider: "test",
      config: {},
    },
  };
}
