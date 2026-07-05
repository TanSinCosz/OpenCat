import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { Agent } from "../src/Tools/Agent/Agent.js";
import { createAgentDefinitions } from "../src/Tools/Agent/index.js";
import { SendMessage } from "../src/Tools/SendMessage/SendMessage.js";
import type { Tool, ToolUseContext } from "../src/Tools/types.js";
import type { DeepSeekClient } from "../src/deepseek/client.js";
import type {
  DeepSeekChatCompletionResponse,
  DeepSeekCreateRequest,
  DeepSeekStreamEnvelope,
  DeepSeekStreamRequest,
} from "../src/deepseek/types.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("SendMessage queues a pending message for a running agent", () => {
  const { runtime, state } = createHarness();
  state.agentTasks.agent_test = createTask("running");
  const tool = new SendMessage();

  const output = tool.call(
    {
      to: "agent_test",
      summary: "follow up",
      message: "please include edge cases",
    },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.deepEqual(output, {
    success: true,
    queued: true,
    agentId: "agent_test",
    pendingMessageCount: 1,
    message: "Message queued for agent_test.",
  });
  assert.deepEqual(state.agentTasks.agent_test?.pendingMessages, [
    "please include edge cases",
  ]);
});

test("SendMessage reports a missing target agent", () => {
  const { runtime, state } = createHarness();
  const tool = new SendMessage();

  const output = tool.call(
    {
      to: "missing_agent",
      message: "hello",
    },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(output.success, false);
  assert.equal(output.queued, false);
  assert.equal(output.agentId, "missing_agent");
  assert.match(output.message, /Agent not found/);
});

test("SendMessage does not queue messages for finished agents", () => {
  const { runtime, state } = createHarness();
  state.agentTasks.agent_test = {
    ...createTask("completed"),
    pendingMessages: ["existing"],
  };
  const tool = new SendMessage();

  const output = tool.call(
    {
      to: "agent_test",
      message: "late message",
    },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(output.success, false);
  assert.equal(output.queued, false);
  assert.equal(output.pendingMessageCount, 1);
  assert.deepEqual(state.agentTasks.agent_test?.pendingMessages, ["existing"]);
});

test("SendMessage pending messages are drained into the running agent context", async () => {
  const agentDefinitions = createAgentDefinitions();
  let releaseWaitTool!: () => void;
  const waitToolRelease = new Promise<void>((resolve) => {
    releaseWaitTool = resolve;
  });
  let markWaitToolStarted!: () => void;
  const waitToolStarted = new Promise<void>((resolve) => {
    markWaitToolStarted = resolve;
  });
  const waitTool = new WaitTool(waitToolRelease, markWaitToolStarted);
  const streamRequests: DeepSeekStreamRequest[] = [];
  const client = createStreamingClient([
    [toolCallChunk("tool_call_1", "WaitForMessage", {})],
    [textChunk("done")],
  ], streamRequests);
  const state = createState();
  const runtime = createRuntime({
    cwd: process.cwd(),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: client,
    MemoryConfig: createMemoryConfig(),
    agentDefinitions,
    tools: [
      new Agent(agentDefinitions),
      new SendMessage(),
      waitTool,
    ],
    transcriptStore: false,
  });
  const agent = runtime.tools.find((tool): tool is Agent => tool instanceof Agent);
  assert.ok(agent);

  const output = await agent.call(
    {
      prompt: "wait, then continue",
      description: "drain pending messages",
      subagent_type: "worker",
      execution_mode: "async",
    },
    runtime.toolUseContext,
    runtime,
    state,
  );

  await waitToolStarted;

  const sendOutput = new SendMessage().call(
    {
      to: output.agentId,
      message: "please include pending context",
    },
    runtime.toolUseContext,
    runtime,
    state,
  );
  assert.equal(sendOutput.queued, true);
  releaseWaitTool();

  await waitFor(() => state.agentTasks[output.agentId]?.status === "completed");
  assert.equal(state.agentTasks[output.agentId]?.pendingMessages.length, 0);
  assert.ok(
    streamRequests[1]?.messages.some((message) =>
      message.role === "user" &&
      message.content.includes("please include pending context")
    ),
  );
});

function createHarness() {
  const state = createState();
  const runtime = createRuntime({
    cwd: process.cwd(),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: createFakeClient(),
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
  });

  return { runtime, state };
}

function createTask(status: "running" | "completed") {
  return {
    id: "agent_test",
    agentType: "worker",
    description: "test agent",
    prompt: "wait for instructions",
    mode: "async" as const,
    status,
    createdAt: 1,
    updatedAt: 1,
    pendingMessages: [],
  };
}

class WaitTool implements Tool<Record<string, never>, { ok: true }> {
  name = "WaitForMessage";
  inputSchema = () => z.strictObject({});
  outputSchema = () => z.strictObject({ ok: z.boolean() });
  strict = true;

  constructor(
    private readonly release: Promise<void>,
    private readonly onStart: () => void,
  ) {}

  description(): string {
    return "Wait for the test to queue a message.";
  }

  prompt(): string {
    return "Waits until the test releases it.";
  }

  async call(
    _input: Record<string, never>,
    _context: ToolUseContext,
  ): Promise<{ ok: true }> {
    this.onStart();
    await this.release;
    return { ok: true };
  }
}

function createStreamingClient(
  streams: DeepSeekStreamEnvelope[][],
  streamRequests: DeepSeekStreamRequest[],
): DeepSeekClient {
  let streamIndex = 0;

  return {
    async create(_input: DeepSeekCreateRequest): Promise<DeepSeekChatCompletionResponse> {
      throw new Error("create is not used in this test");
    },
    async *stream(input: DeepSeekStreamRequest): AsyncGenerator<DeepSeekStreamEnvelope> {
      streamRequests.push(input);
      const events = streams[streamIndex++] ?? [];
      for (const event of events) {
        yield event;
      }
      yield {
        chunk: null,
        raw: "[DONE]",
        done: true,
      };
    },
    async collectStream(): Promise<never> {
      throw new Error("collectStream is not used in this test");
    },
  };
}

function textChunk(text: string): DeepSeekStreamEnvelope {
  return {
    raw: text,
    done: false,
    chunk: {
      id: "assistant-chunk",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-flash",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: text,
          },
          finish_reason: "stop",
        },
      ],
    },
  };
}

function toolCallChunk(
  id: string,
  name: string,
  input: Record<string, unknown>,
): DeepSeekStreamEnvelope {
  return {
    raw: "tool_call",
    done: false,
    chunk: {
      id: "assistant-tool-call",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-flash",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify(input),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createFakeClient(): DeepSeekClient {
  return {
    async create(_input: DeepSeekCreateRequest): Promise<DeepSeekChatCompletionResponse> {
      throw new Error("create is not used in this test");
    },
    async *stream(_input: DeepSeekStreamRequest): AsyncGenerator<DeepSeekStreamEnvelope> {
      throw new Error("stream is not used in this test");
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
