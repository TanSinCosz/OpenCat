import OpenAI from "openai";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ??
  process.env.OPENAI_API_KEY?.trim();

if (!apiKey) {
  throw new Error("Set DEEPSEEK_API_KEY before running this smoke script.");
}

const baseURL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const pauseMs = Number(process.env.OPENCAT_CACHE_FIELD_PAUSE_MS ?? 800);
const runId = process.env.OPENCAT_CACHE_FIELD_RUN_ID ??
  `field_${Date.now().toString(36)}`;

const client = new OpenAI({
  apiKey,
  baseURL,
});

type Usage = {
  prompt_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

type ToolDef = ReturnType<typeof makeTool>;

type Scenario = {
  name: string;
  tools: ToolDef[];
};

type ScenarioResult = {
  name: string;
  promptTokens: number;
  hitTokens: number;
  missTokens: number;
  hitRate: string;
};

const system = [
  `SYSTEM_BASE:${runId}: tool-field cache probe.`,
  repeatSentence(
    "Stable system context for measuring tool field cache behavior.",
    180,
  ),
].join("\n");

const messages = [
  {
    role: "user" as const,
    content: [
      `MESSAGE_BASE:${runId}: tool-field cache probe.`,
      repeatSentence(
        "Stable user message context for measuring tool field cache behavior.",
        180,
      ),
      "Reply with exactly OK.",
    ].join("\n"),
  },
];

const baseTools = makeTools();

const scenarios: Scenario[] = [
  {
    name: "same baseline",
    tools: baseTools,
  },
  {
    name: "change first tool function.name",
    tools: replaceTool(baseTools, 0, (tool) => ({
      ...tool,
      function: {
        ...tool.function,
        name: "cache_order_alpha_renamed",
      },
    })),
  },
  {
    name: "change first tool function.description first line",
    tools: replaceTool(baseTools, 0, (tool) => ({
      ...tool,
      function: {
        ...tool.function,
        description: tool.function.description.replace(
          `TOOL_ALPHA:${runId}: alpha description.`,
          `TOOL_ALPHA_DESC_CHANGED:${runId}: alpha description.`,
        ),
      },
    })),
  },
  {
    name: "change first tool parameters property name",
    tools: replaceTool(baseTools, 0, (tool) =>
      replaceFirstToolParameters(tool, {
        propertyName: "changed_value",
        requiredName: "changed_value",
      })
    ),
  },
  {
    name: "change first tool parameter description",
    tools: replaceTool(baseTools, 0, (tool) =>
      replaceFirstToolParameters(tool, {
        parameterDescriptionMarker: "PARAM_DESC_CHANGED",
      })
    ),
  },
  {
    name: "change first tool required array only",
    tools: replaceTool(baseTools, 0, (tool) =>
      replaceFirstToolParameters(tool, {
        requiredName: "other",
        includeOtherProperty: true,
      })
    ),
  },
  {
    name: "append optional parameter to first tool",
    tools: replaceTool(baseTools, 0, (tool) =>
      replaceFirstToolParameters(tool, {
        includeOtherProperty: true,
      })
    ),
  },
  {
    name: "change last tool function.name",
    tools: replaceTool(baseTools, 2, (tool) => ({
      ...tool,
      function: {
        ...tool.function,
        name: "cache_order_gamma_renamed",
      },
    })),
  },
  {
    name: "change last tool parameter description",
    tools: replaceTool(baseTools, 2, (tool) =>
      replaceFirstToolParameters(tool, {
        parameterDescriptionMarker: "LAST_PARAM_DESC_CHANGED",
      })
    ),
  },
];

console.log(
  JSON.stringify({
    event: "config",
    baseURL,
    model,
    pauseMs,
    runId,
    systemChars: system.length,
    messageChars: JSON.stringify(messages).length,
    toolsChars: JSON.stringify(baseTools).length,
  }),
);

console.log(JSON.stringify(await callScenario("warm baseline 1", baseTools)));
await sleep(pauseMs);
console.log(JSON.stringify(await callScenario("warm baseline 2", baseTools)));

const results: ScenarioResult[] = [];

for (const scenario of scenarios) {
  await sleep(pauseMs);
  const result = await callScenario(scenario.name, scenario.tools);
  results.push(result);
  console.log(JSON.stringify(result));
}

console.log("summary");
console.table(results);

function makeTools() {
  return [
    makeTool("cache_order_alpha", `TOOL_ALPHA:${runId}: alpha description.`),
    makeTool("cache_order_beta", `TOOL_BETA:${runId}: beta description.`),
    makeTool("cache_order_gamma", `TOOL_GAMMA:${runId}: gamma description.`),
  ];
}

function makeTool(name: string, descriptionFirstLine: string) {
  return {
    type: "function" as const,
    function: {
      name,
      description: [
        descriptionFirstLine,
        repeatSentence(
          `Tool ${name} stable long description before parameters.`,
          260,
        ),
      ].join("\n"),
      parameters: makeParameters({
        propertyName: "value",
        requiredName: "value",
        parameterDescriptionMarker: "PARAM_DESC_BASE",
      }),
      strict: true,
    },
  };
}

function makeParameters(options: {
  propertyName: string;
  requiredName: string;
  parameterDescriptionMarker: string;
  includeOtherProperty?: boolean;
}) {
  const properties: Record<string, unknown> = {
    [options.propertyName]: {
      type: "string",
      description: [
        `${options.parameterDescriptionMarker}:${runId}: parameter description.`,
        repeatSentence("Stable parameter description filler.", 80),
      ].join("\n"),
    },
  };

  if (options.includeOtherProperty) {
    properties.other = {
      type: "string",
      description: [
        `PARAM_OTHER:${runId}: optional parameter description.`,
        repeatSentence("Stable optional parameter description filler.", 40),
      ].join("\n"),
    };
  }

  return {
    type: "object",
    properties,
    required: [options.requiredName],
    additionalProperties: false,
  };
}

function replaceFirstToolParameters(
  tool: ToolDef,
  overrides: Partial<{
    propertyName: string;
    requiredName: string;
    parameterDescriptionMarker: string;
    includeOtherProperty: boolean;
  }>,
): ToolDef {
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: makeParameters({
        propertyName: overrides.propertyName ?? "value",
        requiredName: overrides.requiredName ?? "value",
        parameterDescriptionMarker:
          overrides.parameterDescriptionMarker ?? "PARAM_DESC_BASE",
        includeOtherProperty: overrides.includeOtherProperty,
      }),
    },
  };
}

function replaceTool(
  tools: ToolDef[],
  index: number,
  replacer: (tool: ToolDef) => ToolDef,
): ToolDef[] {
  return tools.map((tool, currentIndex) =>
    currentIndex === index ? replacer(tool) : tool
  );
}

async function callScenario(
  name: string,
  tools: ToolDef[],
): Promise<ScenarioResult> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: system,
      },
      ...messages,
    ],
    tools,
    tool_choice: "auto",
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
