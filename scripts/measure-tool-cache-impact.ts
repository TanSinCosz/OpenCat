import { z } from "zod";

import { buildMessagesForQuery } from "../src/query/messages.js";
import { createStreamRequest } from "../src/query/request.js";
import { createDefaultTools } from "../src/Tools/index.js";
import type { Tool } from "../src/Tools/types.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

type Snapshot = {
  systemPrompt: string;
  toolsJson: string;
  requestJson: string;
};

type Diff = {
  commonPrefixChars: number;
  totalChars: number;
  retainedPercent: number;
  firstDiffPath: string;
};

const baseTools = createDefaultTools();

const scenarios: Array<{ name: string; tools: () => readonly Tool[] }> = [
  {
    name: "change last tool description",
    tools: () => replaceTool(baseTools, baseTools.length - 1, (tool) =>
      wrapTool(tool, {
        description: async () =>
          `${await tool.description()} Cache-impact probe suffix.`,
      })
    ),
  },
  {
    name: "change first tool description",
    tools: () => replaceTool(baseTools, 0, (tool) =>
      wrapTool(tool, {
        description: async () =>
          `${await tool.description()} Cache-impact probe suffix.`,
      })
    ),
  },
  {
    name: "change middle tool prompt",
    tools: () => replaceTool(baseTools, Math.floor(baseTools.length / 2), (tool) =>
      wrapTool(tool, {
        prompt: async () => `${await tool.prompt()}\nCache-impact probe suffix.`,
      })
    ),
  },
  {
    name: "remove last tool",
    tools: () => baseTools.slice(0, -1),
  },
  {
    name: "add tool at end",
    tools: () => [...baseTools, createProbeTool()],
  },
  {
    name: "move last tool to front",
    tools: () => [baseTools.at(-1)!, ...baseTools.slice(0, -1)],
  },
];

const baseline = await snapshot(baseTools);

console.log("baseline");
console.table({
  tools: baseTools.length,
  systemPromptChars: baseline.systemPrompt.length,
  toolsJsonChars: baseline.toolsJson.length,
  requestJsonChars: baseline.requestJson.length,
});

console.log("cache-impact scenarios");
console.table(
  await Promise.all(
    scenarios.map(async (scenario) => {
      const scenarioTools = scenario.tools();
      const current = await snapshot(scenarioTools);
      const system = diffSnapshot(baseline.systemPrompt, current.systemPrompt);
      const tools = diffSnapshot(baseline.toolsJson, current.toolsJson);
      const request = diffSnapshot(baseline.requestJson, current.requestJson);

      return {
        scenario: scenario.name,
        tools: scenarioTools.length,
        systemPrefixChars: system.commonPrefixChars,
        systemRetained: formatPercent(system.retainedPercent),
        toolsPrefixChars: tools.commonPrefixChars,
        toolsRetained: formatPercent(tools.retainedPercent),
        requestPrefixChars: request.commonPrefixChars,
        requestRetained: formatPercent(request.retainedPercent),
        firstRequestDiff: request.firstDiffPath,
      };
    }),
  ),
);

console.log("cache-impact scenarios with frozen system prompt");
console.table(
  await Promise.all(
    scenarios.map(async (scenario) => {
      const scenarioTools = scenario.tools();
      const current = await snapshot(scenarioTools, baseline.systemPrompt);
      const tools = diffSnapshot(baseline.toolsJson, current.toolsJson);
      const request = diffSnapshot(baseline.requestJson, current.requestJson);

      return {
        scenario: scenario.name,
        tools: scenarioTools.length,
        toolsPrefixChars: tools.commonPrefixChars,
        toolsRetained: formatPercent(tools.retainedPercent),
        requestPrefixChars: request.commonPrefixChars,
        requestRetained: formatPercent(request.retainedPercent),
        firstRequestDiff: request.firstDiffPath,
      };
    }),
  ),
);

async function snapshot(
  tools: readonly Tool[],
  systemPrompt?: string,
): Promise<Snapshot> {
  const state = createState({
    messages: [
      createMessage({
        role: "user",
        content: "Measure how tool changes affect prompt-cache prefix reuse.",
      }),
    ],
  });
  const runtime = createRuntime({
    cwd: process.cwd(),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 256,
    },
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
    tools,
    systemPrompt,
    messages: state.Messages,
  });
  const messagesForQuery = await buildMessagesForQuery(runtime, state);
  const request = await createStreamRequest(runtime, messagesForQuery.messages);

  return {
    systemPrompt: messagesForQuery.systemPrompt,
    toolsJson: JSON.stringify(request.tools ?? []),
    requestJson: JSON.stringify(request),
  };
}

function diffSnapshot(left: string, right: string): Diff {
  const commonPrefixChars = commonPrefixLength(left, right);
  const totalChars = Math.max(left.length, right.length);
  const retainedPercent =
    totalChars === 0 ? 100 : (commonPrefixChars / totalChars) * 100;

  return {
    commonPrefixChars,
    totalChars,
    retainedPercent,
    firstDiffPath: firstDiffJsonPath(left, right),
  };
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);

  for (let index = 0; index < limit; index++) {
    if (left[index] !== right[index]) {
      return index;
    }
  }

  return limit;
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

function replaceTool(
  tools: readonly Tool[],
  index: number,
  replacer: (tool: Tool) => Tool,
): readonly Tool[] {
  return tools.map((tool, current) => current === index ? replacer(tool) : tool);
}

function wrapTool(
  tool: Tool,
  overrides: Partial<Pick<Tool, "name" | "inputSchema" | "outputSchema">> & {
    description?: Tool["description"];
    prompt?: Tool["prompt"];
  },
): Tool {
  return {
    name: overrides.name ?? tool.name,
    inputSchema: overrides.inputSchema ?? tool.inputSchema,
    outputSchema: overrides.outputSchema ?? tool.outputSchema,
    inputJsonSchema: tool.inputJsonSchema,
    maxResultSizeChars: tool.maxResultSizeChars,
    searchHint: tool.searchHint,
    shouldDefer: tool.shouldDefer,
    alwaysLoad: tool.alwaysLoad,
    strict: tool.strict,
    description: overrides.description ?? (() => tool.description()),
    prompt: overrides.prompt ?? (() => tool.prompt()),
    isEnabled: tool.isEnabled ? () => tool.isEnabled!() : undefined,
    userFacingName: tool.userFacingName ? () => tool.userFacingName!() : undefined,
    isConcurrencySafe: tool.isConcurrencySafe
      ? () => tool.isConcurrencySafe!()
      : undefined,
    call: (...args) => tool.call(...args),
  };
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
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

function createProbeTool(): Tool {
  return {
    name: "ProbeTool",
    inputSchema: z.object({
      value: z.string().optional(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
    }),
    description: () =>
      "Small diagnostic tool used only for cache-impact measurements.",
    prompt: () => "Use this tool only in local cache-impact diagnostics.",
    call: () => ({ ok: true }),
  };
}
