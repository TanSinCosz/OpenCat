import assert from "node:assert/strict";
import test from "node:test";
import { streamAssistantMessage } from "../src/query/assistant-stream.js";
import { createMessage, toDeepSeekMessage } from "../src/types/messages.js";
import type { DeepSeekClient } from "../src/deepseek/client.js";
import type {
  DeepSeekCreateRequest,
  DeepSeekStreamRequest,
} from "../src/deepseek/types.js";

test("assistant reasoning content is not projected back into model history", () => {
  const message = createMessage({
    role: "assistant",
    content: "final answer",
    reasoning_content: "private chain of thought",
  });

  const projected = toDeepSeekMessage(message);

  assert.equal(projected.role, "assistant");
  assert.equal(projected.content, "final answer");
  assert.equal("reasoning_content" in projected, false);
});

test("message source is local metadata and is not projected into model history", () => {
  const message = createMessage({
    role: "user",
    content: "runtime context",
  }, { source: "agent_notification" });

  const projected = toDeepSeekMessage(message);

  assert.equal(message.source, "agent_notification");
  assert.equal(projected.role, "user");
  assert.equal(projected.content, "runtime context");
  assert.equal("source" in projected, false);
});

test("reasoning-only streams produce a visible diagnostic instead of blank content", async () => {
  const client: DeepSeekClient = {
    async create(_input: DeepSeekCreateRequest) {
      throw new Error("create is not used in this test");
    },
    async *stream(_input: DeepSeekStreamRequest) {
      yield {
        raw: "reasoning",
        done: false,
        chunk: {
          id: "reasoning-only",
          object: "chat.completion.chunk",
          created: 0,
          model: "deepseek-v4-pro",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                reasoning_content: "unfinished reasoning",
              },
              finish_reason: "length",
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
    async collectStream() {
      throw new Error("collectStream is not used in this test");
    },
  };

  let message;
  let reasoningDelta = "";
  for await (
    const update of streamAssistantMessage(client, {
      model: "deepseek-v4-pro",
      messages: [],
      stream: true,
    })
  ) {
    if (update.type === "assistant_message_ready") {
      message = update.message;
    }
    if (update.type === "assistant_reasoning_delta") {
      reasoningDelta += update.text;
    }
  }

  assert.equal(reasoningDelta, "unfinished reasoning");
  assert.ok(message);
  assert.match(
    message.content ?? "",
    /did not produce a final answer/,
  );
  assert.equal(message.reasoning_content, "unfinished reasoning");
});

test("reasoning deltas are emitted so frontends can render collapsed thinking", async () => {
  const client: DeepSeekClient = {
    async create(_input: DeepSeekCreateRequest) {
      throw new Error("create is not used in this test");
    },
    async *stream(_input: DeepSeekStreamRequest) {
      yield {
        raw: "reasoning",
        done: false,
        chunk: {
          id: "reasoning-delta",
          object: "chat.completion.chunk",
          created: 0,
          model: "deepseek-v4-pro",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                reasoning_content: "think ",
              },
              finish_reason: null,
            },
          ],
        },
      };
      yield {
        raw: "content",
        done: false,
        chunk: {
          id: "content-delta",
          object: "chat.completion.chunk",
          created: 0,
          model: "deepseek-v4-pro",
          choices: [
            {
              index: 0,
              delta: {
                content: "answer",
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
    async collectStream() {
      throw new Error("collectStream is not used in this test");
    },
  };

  const events = [];
  for await (
    const update of streamAssistantMessage(client, {
      model: "deepseek-v4-pro",
      messages: [],
      stream: true,
    })
  ) {
    events.push(update);
  }

  assert.deepEqual(
    events
      .filter((event) =>
        event.type === "assistant_reasoning_delta" ||
        event.type === "assistant_text_delta"
      )
      .map((event) => [event.type, event.text]),
    [
      ["assistant_reasoning_delta", "think "],
      ["assistant_text_delta", "answer"],
    ],
  );
});
