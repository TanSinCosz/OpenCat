import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { Agent } from "../src/Tools/Agent/Agent.js";
import { createAgentDefinitions } from "../src/Tools/Agent/index.js";
import {
  drainAgentMessages,
  queueAgentMessage,
} from "../src/Tools/Agent/state.js";
import type { AgentOutput } from "../src/Tools/Agent/runner.js";
import type { DeepSeekClient } from "../src/deepseek/client.js";
import type {
  DeepSeekChatCompletionResponse,
  DeepSeekCreateRequest,
  DeepSeekStreamEnvelope,
  DeepSeekStreamRequest,
} from "../src/deepseek/types.js";
import { buildMessagesForQuery } from "../src/query/messages.js";
import { createStreamRequest } from "../src/query/request.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

const execFileAsync = promisify(execFile);

test("Agent tool runs a sync subagent and returns the final assistant text", async () => {
  const { runtime, state } = createHarness({
    streams: [[textChunk("sync result")]],
  });
  const agent = findAgentTool(runtime);

  const output = await agent.call(
    {
      prompt: "answer from a child agent",
      description: "sync child",
      subagent_type: "worker",
      execution_mode: "sync",
    },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(output.status, "completed");
  assert.equal(output.mode, "sync");
  assert.equal(output.agentType, "worker");
  assert.equal(output.result, "sync result");
  assert.equal(state.agentTasks[output.agentId]?.status, "completed");
});

test("Agent tool fork mode inherits parent messages and read cache", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-agent-fork-"));
  const filePath = join(cwd, "fork-target.txt");
  await writeFile(filePath, "before\n", "utf8");

  const harness = createHarness({
    cwd,
    parentMessages: [
      createMessage({
        role: "user",
        content: "parent context that fork should inherit",
      }),
    ],
    streams: [
      [
        toolCallChunk("tool_call_1", "Write", {
          file_path: filePath,
          content: "after\n",
        }),
      ],
      [textChunk("fork write complete")],
    ],
  });
  const agent = findAgentTool(harness.runtime);
  const timestamp = Math.floor((await stat(filePath)).mtimeMs);
  harness.runtime.toolUseContext.readFileState.set(filePath, {
    content: "before\n",
    timestamp,
    offset: 1,
    limit: undefined,
  });

  const output = await agent.call(
    {
      prompt: "rewrite the inherited file",
      description: "fork writer",
      execution_mode: "fork",
    },
    harness.runtime.toolUseContext,
    harness.runtime,
    harness.state,
  );

  assert.equal(output.status, "completed");
  assert.equal(output.mode, "fork");
  assert.equal(output.result, "fork write complete");
  assert.equal(await readFile(filePath, "utf8"), "after\n");
  assert.ok(
    harness.streamRequests[0]?.messages.some(
      (message) =>
        message.role === "user" &&
        message.content.includes("parent context that fork should inherit"),
    ),
  );
});

test("Agent tool fork mode drops incomplete parent tool calls", async () => {
  const harness = createHarness({
    parentMessages: [
      createMessage({
        role: "user",
        content: "stable parent context",
      }),
      createMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_finished",
            type: "function",
            function: {
              name: "Read",
              arguments: "{}",
            },
          },
          {
            id: "call_missing",
            type: "function",
            function: {
              name: "Grep",
              arguments: "{}",
            },
          },
        ],
      }),
      createMessage({
        role: "tool",
        content: "partial result only",
        tool_call_id: "call_finished",
      }),
      createMessage({
        role: "user",
        content: "latest parent instruction",
      }),
    ],
    streams: [[textChunk("fork filtered complete")]],
  });
  const agent = findAgentTool(harness.runtime);

  const output = await agent.call(
    {
      prompt: "continue safely",
      description: "fork filter",
      execution_mode: "fork",
    },
    harness.runtime.toolUseContext,
    harness.runtime,
    harness.state,
  );

  const requestMessages = harness.streamRequests[0]?.messages ?? [];
  assert.equal(output.status, "completed");
  assert.equal(output.mode, "fork");
  assert.ok(
    requestMessages.some((message) =>
      message.role === "user" &&
      message.content.includes("stable parent context")
    ),
  );
  assert.ok(
    requestMessages.some((message) =>
      message.role === "user" &&
      message.content.includes("latest parent instruction")
    ),
  );
  assert.equal(
    requestMessages.some((message) =>
      message.role === "assistant" &&
      message.tool_calls?.some((toolCall) => toolCall.id === "call_missing")
    ),
    false,
  );
  assert.equal(
    requestMessages.some((message) =>
      message.role === "tool" && message.tool_call_id === "call_finished"
    ),
    false,
  );
});

test("Agent tool fork mode inherits parent state projection context", async () => {
  const harness = createHarness({
    parentMessages: [
      createMessage({
        role: "user",
        content: "parent message",
      }),
    ],
    streams: [[textChunk("fork state complete")]],
  });
  harness.state.runtimeContextMessages.push(
    createMessage({
      role: "user",
      content: "<runtime-context>fork-visible context</runtime-context>",
    }, { source: "runtime" }),
  );
  const agent = findAgentTool(harness.runtime);

  const output = await agent.call(
    {
      prompt: "inspect inherited state",
      description: "fork state",
      execution_mode: "fork",
    },
    harness.runtime.toolUseContext,
    harness.runtime,
    harness.state,
  );

  assert.equal(output.status, "completed");
  assert.equal(output.mode, "fork");
  assert.match(
    JSON.stringify(harness.streamRequests[0]?.messages),
    /fork-visible context/,
  );
});

test("Agent tool fork request preserves parent prompt prefix for cache reuse", async () => {
  const harness = createHarness({
    parentMessages: [
      createMessage({
        role: "user",
        content: "stable parent context for cache prefix",
      }),
      createMessage({
        role: "assistant",
        content: "stable assistant context for cache prefix",
      }),
      createMessage({
        role: "user",
        content: "latest parent instruction before fork",
      }),
    ],
    streams: [[textChunk("fork cache complete")]],
  });
  const parentMessagesForQuery = await buildMessagesForQuery(
    harness.runtime,
    harness.state,
  );
  const parentRequest = await createStreamRequest(
    harness.runtime,
    parentMessagesForQuery.messages,
  );
  const agent = findAgentTool(harness.runtime);

  await agent.call(
    {
      prompt: "continue from inherited context",
      description: "fork cache prefix",
      execution_mode: "fork",
    },
    harness.runtime.toolUseContext,
    harness.runtime,
    harness.state,
  );

  const childRequest = harness.streamRequests[0];
  assert.ok(childRequest);
  assert.deepEqual(
    getRequestToolNames(childRequest),
    getRequestToolNames(parentRequest).filter((toolName) => toolName !== "Agent"),
  );
  assert.deepEqual(
    childRequest.messages.slice(0, parentRequest.messages.length),
    parentRequest.messages,
  );
  assert.match(
    childRequest.messages[parentRequest.messages.length]?.content ?? "",
    /<fork_worker>/,
  );
  assert.match(
    childRequest.messages[parentRequest.messages.length]?.content ?? "",
    /Unavailable tools: .*Agent/,
  );
  assert.match(
    childRequest.messages[parentRequest.messages.length]?.content ?? "",
    /parent-agent tools/,
  );
});

test("Agent tool async mode registers task lifecycle and notification", async () => {
  const { runtime, state } = createHarness({
    streams: [[textChunk("async result")]],
  });
  const agent = findAgentTool(runtime);

  const output = await agent.call(
    {
      prompt: "run in background",
      description: "async child",
      subagent_type: "worker",
      execution_mode: "async",
    },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(output.status, "async_launched");
  assert.deepEqual(state.agentTasks[output.agentId]?.pendingMessages, []);
  await waitFor(() => state.agentTasks[output.agentId]?.status === "completed");
  assert.equal(state.agentTasks[output.agentId]?.result, "async result");
  assert.equal(state.agentNotifications.length, 1);
  assert.equal(state.agentNotifications[0]?.agentTaskId, output.agentId);
  assert.match(state.agentNotifications[0]?.message ?? "", /async child/);
});

test("read-only agents only receive read tools", async () => {
  const { runtime, state, streamRequests } = createHarness({
    streams: [[textChunk("explore result")]],
  });
  const agent = findAgentTool(runtime);

  const output = await agent.call(
    {
      prompt: "inspect the repo",
      description: "read-only child",
      subagent_type: "Explore",
      execution_mode: "sync",
    },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(output.status, "completed");
  assert.deepEqual(
    getRequestToolNames(streamRequests[0]),
    ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "ReadSkill"],
  );
  const systemPrompt = streamRequests[0]?.messages[0]?.content ?? "";
  assert.match(systemPrompt, /<agent_tool_policy>/);
  assert.match(systemPrompt, /Available tools: Read, Glob, Grep, WebSearch, WebFetch, ReadSkill/);
  assert.match(systemPrompt, /Unavailable tools: .*Agent/);
  assert.match(systemPrompt, /Unavailable tools: .*Edit/);
  assert.match(systemPrompt, /Unavailable tools: .*Write/);
  assert.match(systemPrompt, /read-only agent/);
});

test("verification agents receive Bash for checks but not editing tools", async () => {
  const { runtime, state, streamRequests } = createHarness({
    streams: [[textChunk("verification result")]],
  });
  const agent = findAgentTool(runtime);

  const output = await agent.call(
    {
      prompt: "verify the change",
      description: "verify child",
      subagent_type: "verification",
      execution_mode: "sync",
    },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(output.status, "completed");
  assert.deepEqual(
    getRequestToolNames(streamRequests[0]),
    ["Bash", "Read", "Glob", "Grep", "WebSearch", "WebFetch", "ReadSkill"],
  );
  const systemPrompt = streamRequests[0]?.messages[0]?.content ?? "";
  assert.match(systemPrompt, /<agent_tool_policy>/);
  assert.match(systemPrompt, /Available tools: Bash, Read, Glob, Grep, WebSearch, WebFetch, ReadSkill/);
  assert.match(systemPrompt, /Unavailable tools: .*Agent/);
  assert.match(systemPrompt, /Unavailable tools: .*Edit/);
  assert.match(systemPrompt, /Unavailable tools: .*Write/);
  assert.match(systemPrompt, /verification-only agent/);
});

test("worker agents receive editing tools but not recursive Agent tool", async () => {
  const { runtime, state, streamRequests } = createHarness({
    streams: [[textChunk("worker result")]],
  });
  const agent = findAgentTool(runtime);

  const output = await agent.call(
    {
      prompt: "implement a scoped change",
      description: "worker child",
      subagent_type: "worker",
      execution_mode: "sync",
    },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(output.status, "completed");
  const toolNames = getRequestToolNames(streamRequests[0]);
  assert.ok(toolNames.includes("Read"));
  assert.ok(toolNames.includes("Edit"));
  assert.ok(toolNames.includes("Write"));
  assert.ok(toolNames.includes("Bash"));
  assert.ok(!toolNames.includes("Agent"));
  const systemPrompt = streamRequests[0]?.messages[0]?.content ?? "";
  assert.match(systemPrompt, /<agent_tool_policy>/);
  assert.match(systemPrompt, /Unavailable tools: .*Agent/);
  assert.match(systemPrompt, /Do not spawn nested agents/);
});

test("Agent task pending messages can be queued and drained", () => {
  const state = createState();
  state.agentTasks.agent_test = {
    id: "agent_test",
    agentType: "worker",
    description: "test mailbox",
    prompt: "wait for messages",
    mode: "async",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    pendingMessages: [],
  };

  assert.equal(queueAgentMessage(state.agentTasks, "agent_test", "first"), true);
  assert.equal(queueAgentMessage(state.agentTasks, "missing", "lost"), false);
  assert.deepEqual(state.agentTasks.agent_test?.pendingMessages, ["first"]);

  assert.deepEqual(drainAgentMessages(state.agentTasks, "agent_test"), ["first"]);
  assert.deepEqual(drainAgentMessages(state.agentTasks, "agent_test"), []);

  state.agentTasks.agent_test!.status = "completed";
  assert.equal(queueAgentMessage(state.agentTasks, "agent_test", "late"), false);
});

test("Agent tool worktree isolation keeps file edits out of the parent cwd", async (t) => {
  if (!(await canWriteGitRefs())) {
    t.skip("git refs are not writable in this sandbox");
    return;
  }

  const streamRequests: DeepSeekStreamRequest[] = [];
  let worktreePath: string | undefined;
  let worktreeBranch: string | undefined;
  const client = createWorktreeClient(streamRequests, (pathFromPrompt) => {
    worktreePath = pathFromPrompt;
  });
  const agentDefinitions = createAgentDefinitions();
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
  });
  const agent = findAgentTool(runtime);

  try {
    const output = await callAgentOrSkipOnGitPermissionError(t, () =>
      agent.call(
        {
          prompt: "create an isolated file",
          description: "isolated write",
          subagent_type: "worker",
          execution_mode: "sync",
          isolation: "worktree",
        },
        runtime.toolUseContext,
        runtime,
        state,
      )
    );

    if (!output) {
      return;
    }

    assert.equal(output.status, "completed");
    assert.ok(output.worktreePath);
    assert.equal(output.worktreePath, worktreePath);
    assert.ok(output.worktreeBranch);
    worktreeBranch = output.worktreeBranch;
    assert.deepEqual(output.changedFiles, ["agent-created.txt"]);
    assert.equal(
      await readFile(join(output.worktreePath, "agent-created.txt"), "utf8"),
      "from worktree\n",
    );

    await assert.rejects(
      readFile(join(process.cwd(), "agent-created.txt"), "utf8"),
    );
    assert.match(
      streamRequests[0]?.messages.at(-1)?.content ?? "",
      /<worktree_isolation>/,
    );
  } finally {
    if (worktreePath) {
      await gitNoThrow(["worktree", "remove", "--force", worktreePath], process.cwd());
    }
    if (worktreeBranch) {
      await gitNoThrow(["branch", "-D", worktreeBranch], process.cwd());
    }
  }
});

type HarnessOptions = {
  cwd?: string;
  parentMessages?: ReturnType<typeof createMessage>[];
  streams: DeepSeekStreamEnvelope[][];
};

function createHarness(options: HarnessOptions) {
  const agentDefinitions = createAgentDefinitions();
  const streamRequests: DeepSeekStreamRequest[] = [];
  const client = createFakeClient(options.streams, streamRequests);
  const state = createState({
    messages: options.parentMessages ?? [],
  });
  const runtime = createRuntime({
    cwd: options.cwd ?? tmpdir(),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    deepSeekClient: client,
    MemoryConfig: createMemoryConfig(),
    agentDefinitions,
  });

  return { runtime, state, streamRequests };
}

function findAgentTool(runtime: ReturnType<typeof createRuntime>): Agent {
  const tool = runtime.tools.find((item) => item.name === "Agent");
  assert.ok(tool instanceof Agent);
  return tool;
}

function getRequestToolNames(request: DeepSeekStreamRequest | undefined): string[] {
  assert.ok(request);
  return (request.tools ?? []).map((tool) => tool.function.name);
}

function createFakeClient(
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

function createWorktreeClient(
  streamRequests: DeepSeekStreamRequest[],
  onWorktreePath: (worktreePath: string) => void,
): DeepSeekClient {
  let streamIndex = 0;

  return {
    async create(_input: DeepSeekCreateRequest): Promise<DeepSeekChatCompletionResponse> {
      throw new Error("create is not used in this test");
    },
    async *stream(input: DeepSeekStreamRequest): AsyncGenerator<DeepSeekStreamEnvelope> {
      streamRequests.push(input);
      if (streamIndex++ === 0) {
        const prompt = input.messages.at(-1)?.content ?? "";
        const match = prompt.match(/Your cwd: (.+)/);
        assert.ok(match?.[1]);
        const pathFromPrompt = match[1].trim();
        onWorktreePath(pathFromPrompt);
        yield toolCallChunk("tool_call_1", "Write", {
          file_path: join(pathFromPrompt, "agent-created.txt"),
          content: "from worktree\n",
        });
      } else {
        yield textChunk("worktree done");
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

async function gitNoThrow(args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync("git", args, { cwd, windowsHide: true });
  } catch {
    // Best-effort cleanup for test worktrees.
  }
}

async function canWriteGitRefs(): Promise<boolean> {
  try {
    await access(join(process.cwd(), ".git", "refs", "heads"), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function callAgentOrSkipOnGitPermissionError(
  t: { skip: (message?: string) => void },
  call: () => Promise<AgentOutput>,
): Promise<AgentOutput | null> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cannot lock ref|Permission denied/i.test(message)) {
      t.skip("git worktree refs are not writable in this sandbox");
      return null;
    }

    throw error;
  }
}
