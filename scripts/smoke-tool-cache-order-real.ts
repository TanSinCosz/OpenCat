import OpenAI from "openai";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ??
  process.env.OPENAI_API_KEY?.trim();

if (!apiKey) {
  throw new Error("Set DEEPSEEK_API_KEY before running this smoke script.");
}

const baseURL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const rounds = Number(process.env.OPENCAT_CACHE_ORDER_ROUNDS ?? 1);
const pauseMs = Number(process.env.OPENCAT_CACHE_ORDER_PAUSE_MS ?? 800);
const toolChoice = (process.env.OPENCAT_CACHE_ORDER_TOOL_CHOICE ?? "auto") as
  | "auto"
  | "none";
const runId = process.env.OPENCAT_CACHE_ORDER_RUN_ID ??
  `run_${Date.now().toString(36)}`;

const client = new OpenAI({
  apiKey,
  baseURL,
});

type Usage = {
  prompt_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  total_tokens?: number;
};

type ScenarioResult = {
  name: string;
  promptTokens: number;
  hitTokens: number;
  missTokens: number;
  hitRate: string;
};

const baseSystem = makeSystem("SYSTEM_BASE");
const baseMessages = makeMessages("MESSAGE_BASE");
const baseTools = makeTools("TOOL_BASE");

const scenarios = [
  {
    name: "same baseline",
    system: baseSystem,
    messages: baseMessages,
    tools: baseTools,
  },
  {
    name: "change system first line",
    system: makeSystem("SYSTEM_CHANGED"),
    messages: baseMessages,
    tools: baseTools,
  },
  {
    name: "change first user message",
    system: baseSystem,
    messages: makeMessages("MESSAGE_CHANGED"),
    tools: baseTools,
  },
  {
    name: "change first user message tail",
    system: baseSystem,
    messages: makeMessages("MESSAGE_BASE", "MESSAGE_TAIL_CHANGED"),
    tools: baseTools,
  },
  {
    name: "append one user message",
    system: baseSystem,
    messages: [
      ...baseMessages,
      {
        role: "user" as const,
        content: [
          `MESSAGE_APPEND:${runId}: appended user message.`,
          repeatSentence(
            "Appended message stable context for cache-order measurement.",
            80,
          ),
          "Reply with exactly OK.",
        ].join("\n"),
      },
    ],
    tools: baseTools,
  },
  {
    name: "change first tool description",
    system: baseSystem,
    messages: baseMessages,
    tools: makeTools("TOOL_CHANGED"),
  },
  {
    name: "change second tool description",
    system: baseSystem,
    messages: baseMessages,
    tools: replaceToolDescription(baseTools, 1, `TOOL_SECOND_CHANGED:${runId}`),
  },
  {
    name: "change last tool description",
    system: baseSystem,
    messages: baseMessages,
    tools: replaceToolDescription(baseTools, 2, `TOOL_LAST_CHANGED:${runId}`),
  },
  {
    name: "append one tool",
    system: baseSystem,
    messages: baseMessages,
    tools: [...baseTools, makeExtraTool("EXTRA_TOOL")],
  },
  {
    name: "move last tool to front",
    system: baseSystem,
    messages: baseMessages,
    tools: [baseTools.at(-1)!, ...baseTools.slice(0, -1)],
  },
];

console.log(
  JSON.stringify({
    event: "config",
    baseURL,
    model,
    rounds,
    pauseMs,
    toolChoice,
    runId,
    systemChars: baseSystem.length,
    messageChars: JSON.stringify(baseMessages).length,
    toolsChars: JSON.stringify(baseTools).length,
  }),
);

const warmup1 = await callScenario("warm baseline 1", {
  system: baseSystem,
  messages: baseMessages,
  tools: baseTools,
});
console.log(JSON.stringify(warmup1));

await sleep(pauseMs);

const warmup2 = await callScenario("warm baseline 2", {
  system: baseSystem,
  messages: baseMessages,
  tools: baseTools,
});
console.log(JSON.stringify(warmup2));

const results: ScenarioResult[] = [];

for (let round = 1; round <= rounds; round++) {
  for (const scenario of scenarios) {
    await sleep(pauseMs);
    const result = await callScenario(`${scenario.name} / round ${round}`, scenario);
    results.push(result);
    console.log(JSON.stringify(result));
  }
}

console.log("summary");
console.table(results);

function makeSystem(marker: string): string {
  return [
    `${marker}:${runId}: cache-order probe system segment.`,
    "The next lines are stable filler to make the system segment visible to prompt caching.",
    repeatSentence(
      "System stable instruction: preserve this exact sentence for the cache-order experiment.",
      220,
    ),
  ].join("\n");
}

function makeMessages(marker: string, tailMarker = "MESSAGE_TAIL_BASE") {
  return [
    {
      role: "user" as const,
      content: [
        `${marker}:${runId}: cache-order probe first user message.`,
        repeatSentence(
          "Message stable context: this sentence exists to make message ordering measurable.",
          220,
        ),
        `${tailMarker}:${runId}: cache-order probe first user message tail.`,
        "Reply with exactly OK.",
      ].join("\n"),
    },
  ];
}

function makeTools(marker: string) {
  return [
    makeTool("cache_order_alpha", `${marker}:${runId}: alpha tool description.`),
    makeTool("cache_order_beta", `TOOL_BASE:${runId}: beta tool description.`),
    makeTool("cache_order_gamma", `TOOL_BASE:${runId}: gamma tool description.`),
  ];
}

function makeExtraTool(marker: string) {
  return makeTool(
    "cache_order_delta",
    `${marker}:${runId}: appended delta tool description.`,
  );
}

function replaceToolDescription(
  tools: ReturnType<typeof makeTools>,
  index: number,
  marker: string,
) {
  return tools.map((tool, currentIndex) => {
    if (currentIndex !== index) {
      return tool;
    }

    return makeTool(
      tool.function.name,
      `${marker}: changed ${tool.function.name} description.`,
    );
  });
}

function makeTool(name: string, firstDescriptionLine: string) {
  return {
    type: "function" as const,
    function: {
      name,
      description: [
        firstDescriptionLine,
        repeatSentence(
          `Tool ${name} stable description filler for cache-order measurement.`,
          180,
        ),
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          value: {
            type: "string",
            description: repeatSentence(
              `Tool ${name} stable parameter description.`,
              40,
            ),
          },
        },
        required: ["value"],
        additionalProperties: false,
      },
      strict: true,
    },
  };
}

async function callScenario(
  name: string,
  input: {
    system: string;
    messages: ReturnType<typeof makeMessages>;
    tools: ReturnType<typeof makeTools>;
  },
): Promise<ScenarioResult> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: input.system,
      },
      ...input.messages,
    ],
    tools: input.tools,
    tool_choice: toolChoice,
    temperature: 0,
    max_tokens: 1,
  });
  const usage = response.usage as Usage | undefined;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const hitTokens = usage?.prompt_cache_hit_tokens ?? 0;
  const missTokens = usage?.prompt_cache_miss_tokens ?? 0;

  return {
    name,
    promptTokens,
    hitTokens,
    missTokens,
    hitRate: promptTokens > 0
      ? `${((hitTokens / promptTokens) * 100).toFixed(2)}%`
      : "0.00%",
  };
}

function repeatSentence(sentence: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${index}: ${sentence}`).join(
    "\n",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
