import { createDeepSeekClient } from "../src/deepseek/client.js";
import type {
  DeepSeekStreamRequest,
  DeepSeekUsage,
} from "../src/deepseek/types.js";
import { buildMessagesForQuery } from "../src/query/messages.js";
import { createStreamRequest } from "../src/query/request.js";
import { createDefaultTools } from "../src/Tools/index.js";
import { createMessage, type Message } from "../src/types/messages.js";
import { createRuntime, type RuntimeAgentId } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

if (!apiKey) {
  throw new Error("Set DEEPSEEK_API_KEY before running this smoke script.");
}

const deepSeekApiKey = apiKey;
const model = process.env.OPENCAT_AGENT_CACHE_MODEL ?? "deepseek-v4-pro";
const maxTokens = Number(process.env.OPENCAT_AGENT_CACHE_MAX_TOKENS ?? 1);
const pauseMs = Number(process.env.OPENCAT_AGENT_CACHE_PAUSE_MS ?? 1200);
const runId = process.env.OPENCAT_AGENT_CACHE_RUN_ID ??
  `agent_cache_${Date.now().toString(36)}`;

const client = createDeepSeekClient({
  config: {
    apiKey: deepSeekApiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    model,
    maxTokens,
    reasoningEffort: "max",
  },
});

const tools = createDefaultTools();
const parentMessages = createParentMessages(runId);
const parentRequest = await createMeasuredRequest({
  agentId: "main",
  agentRole: "main",
  messages: parentMessages,
});
const childMessages = [
  ...parentMessages.map((message) => ({ ...message })),
  createMessage({
    role: "user",
    content: buildForkDirective(runId),
  }, { source: "agent_message" }),
];
const childRequest = await createMeasuredRequest({
  agentId: "agent_cache_probe",
  agentRole: "subagent",
  parentAgentId: "main",
  messages: childMessages,
  systemPrompt: parentRequest.systemPrompt,
});

const parentComparable = comparableRequest(parentRequest.request);
const childComparable = comparableRequest(childRequest.request);
const prefix = comparePrefix(parentComparable, childComparable);
const inheritedMessagesMatch = parentRequest.request.messages.every(
  (message, index) =>
    JSON.stringify(message) === JSON.stringify(childRequest.request.messages[index]),
);

console.log(JSON.stringify({
  event: "request_shape",
  runId,
  model,
  tools: tools.length,
  parentMessages: parentRequest.request.messages.length,
  childMessages: childRequest.request.messages.length,
  inheritedMessagesMatch,
  parentRequestChars: parentComparable.length,
  childRequestChars: childComparable.length,
  commonPrefixChars: prefix.commonPrefixChars,
  commonPrefixPercentOfParent: formatPercent(
    parentComparable.length === 0
      ? 0
      : (prefix.commonPrefixChars / parentComparable.length) * 100,
  ),
  firstDiffPath: firstDiffJsonPath(parentComparable, childComparable),
}));

const parentWarm = await call("parent warm", parentRequest.request);
console.log(JSON.stringify(parentWarm));
await sleep(pauseMs);

const parentRepeat = await call("parent repeat", parentRequest.request);
console.log(JSON.stringify(parentRepeat));
await sleep(pauseMs);

const childFork = await call("fork child", childRequest.request);
console.log(JSON.stringify(childFork));

console.table([parentWarm, parentRepeat, childFork]);

async function createMeasuredRequest(options: {
  agentId: RuntimeAgentId;
  agentRole: "main" | "subagent";
  parentAgentId?: RuntimeAgentId;
  messages: Message[];
  systemPrompt?: string;
}): Promise<{ request: DeepSeekStreamRequest; systemPrompt: string }> {
  const state = createState({
    messages: options.messages,
  });
  const runtime = createRuntime({
    cwd: process.cwd(),
    sessionId: `session_${runId}`,
    agentId: options.agentId,
    agentRole: options.agentRole,
    parentAgentId: options.parentAgentId,
    agentType: options.agentRole === "main" ? undefined : "worker",
    deepSeekRuntimeConfig: {
      apiKey: deepSeekApiKey,
      baseUrl: process.env.DEEPSEEK_BASE_URL,
      model,
      maxTokens,
      reasoningEffort: "max",
    },
    deepSeekClient: client,
    MemoryConfig: createMemoryConfig(),
    tools,
    systemPrompt: options.systemPrompt,
    messages: state.Messages,
    transcriptStore: false,
  });
  const messagesForQuery = await buildMessagesForQuery(runtime, state);
  const request = await createStreamRequest(runtime, messagesForQuery.messages);

  return {
    request: {
      ...request,
      max_tokens: maxTokens,
      tool_choice: "none",
      stream_options: {
        include_usage: true,
      },
    },
    systemPrompt: messagesForQuery.systemPrompt,
  };
}

async function call(name: string, request: DeepSeekStreamRequest) {
  const result = await client.collectStream(request);
  const usage = result.response?.usage;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const hitTokens = getUsageNumber(usage, "prompt_cache_hit_tokens");
  const missTokens = getUsageNumber(usage, "prompt_cache_miss_tokens");

  return {
    name,
    promptTokens,
    hitTokens,
    missTokens,
    hitRate: promptTokens > 0
      ? formatPercent((hitTokens / promptTokens) * 100)
      : "0.00%",
    text: result.text,
  };
}

function createParentMessages(marker: string): Message[] {
  return [
    createMessage({
      role: "user",
      content: [
        `CACHE_PARENT:${marker}: inherited parent request.`,
        repeatSentence(
          "The fork child should inherit this stable parent context exactly for prompt-cache measurement.",
          520,
        ),
        "Reply with exactly OK. Do not call tools.",
      ].join("\n"),
    }),
    createMessage({
      role: "assistant",
      content: [
        "Acknowledged. The stable parent context is available.",
        repeatSentence(
          "Assistant stable context line retained before the fork directive.",
          180,
        ),
      ].join("\n"),
    }),
    createMessage({
      role: "user",
      content: [
        `CACHE_PARENT_TAIL:${marker}: final inherited user turn.`,
        repeatSentence(
          "This final inherited parent turn should remain before the fork-only directive.",
          260,
        ),
        "Reply with exactly OK. Do not call tools.",
      ].join("\n"),
    }),
  ];
}

function buildForkDirective(marker: string): string {
  return `<fork_worker>
STOP. READ THIS FIRST.

You are a forked worker process. You are not the main agent.

Rules:
1. You inherit the parent conversation context above. Use it, but do not repeat it.
2. Do not spawn other agents.
3. Execute the directive directly using your tools.
4. Stay strictly within the directive's scope.
5. Keep your final report concise and factual.

Directive: CACHE_FORK:${marker}: reply with exactly OK. Do not call tools.
</fork_worker>`;
}

function comparableRequest(request: DeepSeekStreamRequest): string {
  return JSON.stringify({
    model: request.model,
    reasoning_effort: request.reasoning_effort,
    tools: request.tools,
    tool_choice: request.tool_choice,
    messages: request.messages,
  });
}

function comparePrefix(left: string, right: string): { commonPrefixChars: number } {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index++) {
    if (left[index] !== right[index]) {
      return { commonPrefixChars: index };
    }
  }

  return { commonPrefixChars: limit };
}

function firstDiffJsonPath(left: string, right: string): string {
  try {
    return findFirstDiff(JSON.parse(left), JSON.parse(right)) ?? "(none)";
  } catch {
    return "(not JSON)";
  }
}

function findFirstDiff(left: unknown, right: unknown, path = "$"): string | undefined {
  if (Object.is(left, right)) {
    return undefined;
  }

  if (
    typeof left !== "object" ||
    typeof right !== "object" ||
    left === null ||
    right === null ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return path;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    const max = Math.max(left.length, right.length);

    for (let index = 0; index < max; index++) {
      if (!(index in left) || !(index in right)) {
        return `${path}[${index}]`;
      }

      const nested = findFirstDiff(left[index], right[index], `${path}[${index}]`);
      if (nested) {
        return nested;
      }
    }

    return undefined;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])];

  for (const key of keys) {
    if (!(key in leftRecord) || !(key in rightRecord)) {
      return `${path}.${key}`;
    }

    const nested = findFirstDiff(leftRecord[key], rightRecord[key], `${path}.${key}`);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function repeatSentence(sentence: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${index}: ${sentence}`).join(
    "\n",
  );
}

function getUsageNumber(
  usage: DeepSeekUsage | undefined,
  key: "prompt_cache_hit_tokens" | "prompt_cache_miss_tokens",
): number {
  const value = usage?.[key];
  return typeof value === "number" ? value : 0;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
