import assert from "node:assert/strict";
import test from "node:test";
import { streamAssistantMessage } from "../src/query/assistant-stream.js";
import { query } from "../src/query.js";
import { buildMessagesForQuery } from "../src/query/messages.js";
import { createMessage, toDeepSeekMessage } from "../src/types/messages.js";
import type { DeepSeekClient } from "../src/deepseek/client.js";
import type {
  DeepSeekCreateRequest,
  DeepSeekStreamEnvelope,
  DeepSeekStreamRequest,
} from "../src/deepseek/types.js";
import { createMemoryConfig } from "../src/Memory/config.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";
import type { Tool } from "../src/Tools/types.js";

test("assistant reasoning content is preserved in model history", () => {
  const message = createMessage({
    role: "assistant",
    content: "final answer",
    reasoning_content: "private chain of thought",
  });

  const projected = toDeepSeekMessage(message);

  assert.equal(projected.role, "assistant");
  assert.equal(projected.content, "final answer");
  assert.equal(projected.reasoning_content, "private chain of thought");
});


test("assistant reasoning content is projected when the assistant turn called tools", () => {
  const message = createMessage({
    role: "assistant",
    content: null,
    reasoning_content: "tool-use reasoning",
    tool_calls: [
      {
        id: "call_echo",
        type: "function",
        function: { name: "Echo", arguments: "{}" },
      },
    ],
  });

  const projected = toDeepSeekMessage(message);

  assert.equal(projected.role, "assistant");
  assert.equal(projected.reasoning_content, "tool-use reasoning");
  assert.equal(projected.tool_calls?.[0]?.id, "call_echo");
});

test("buildMessagesForQuery keeps visible assistant reasoning content", async () => {
  const state = createState({
    messages: [
      createMessage({ role: "user", content: "question" }),
      createMessage({
        role: "assistant",
        content: "answer",
        reasoning_content: "recent reasoning",
      }),
    ],
  });
  const runtime = createRuntime({
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
    tools: [],
  });

  const request = await buildMessagesForQuery(runtime, state);
  const assistantMessage = request.messages.find((message) =>
    message.role === "assistant"
  );

  if (assistantMessage?.role !== "assistant") {
    assert.fail("expected assistant message");
  }
  assert.equal(assistantMessage.reasoning_content, "recent reasoning");
});

test("query carries assistant reasoning content into the next tool-followup request", async () => {
  const streamRequests: DeepSeekStreamRequest[] = [];
  const client: DeepSeekClient = {
    async create(_input: DeepSeekCreateRequest) {
      throw new Error("create is not used in this test");
    },
    async *stream(input: DeepSeekStreamRequest) {
      streamRequests.push(input);
      if (streamRequests.length === 1) {
        yield createToolCallReasoningChunk();
        yield { raw: "[DONE]", done: true, chunk: null };
        return;
      }

      yield createAssistantContentChunk("done");
      yield { raw: "[DONE]", done: true, chunk: null };
    },
    async collectStream() {
      throw new Error("collectStream is not used in this test");
    },
  };
  const echoTool: Tool = {
    name: "Echo",
    inputSchema: {} as never,
    outputSchema: {} as never,
    description: () => "Echo test tool",
    prompt: () => "Echo test tool",
    call: () => "echo-result",
  };
  const runtime = createRuntime({
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: client,
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
    tools: [echoTool],
  });
  const state = createState({
    messages: [createMessage({ role: "user", content: "use the echo tool" })],
  });

  for await (const _event of query(runtime, state, { maxTurns: 2 })) {
    // Drain query events.
  }

  const followupRequest = streamRequests[1];
  assert.ok(followupRequest);
  const assistantToolCallMessage = followupRequest.messages.find((message) =>
    message.role === "assistant" && message.tool_calls?.[0]?.id === "call_echo"
  );

  if (assistantToolCallMessage?.role !== "assistant") {
    assert.fail("expected assistant tool call message");
  }
  assert.equal(assistantToolCallMessage.reasoning_content, "tool reasoning");
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

function createToolCallReasoningChunk(): DeepSeekStreamEnvelope {
  return {
    raw: "tool-call",
    done: false,
    chunk: {
      id: "tool-call-reasoning",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-flash",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_content: "tool reasoning",
            tool_calls: [
              {
                index: 0,
                id: "call_echo",
                type: "function",
                function: { name: "Echo", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  };
}

function createAssistantContentChunk(content: string): DeepSeekStreamEnvelope {
  return {
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
          delta: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
    },
  };
}
