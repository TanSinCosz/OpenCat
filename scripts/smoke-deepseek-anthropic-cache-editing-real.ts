type AnthropicResponse = {
  id?: string;
  type?: string;
  role?: string;
  content?: unknown;
  usage?: Record<string, unknown>;
  error?: {
    type?: string;
    message?: string;
  };
  [key: string]: unknown;
};

type UsageSummary = {
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheDeletedTokens: number;
  totalTokens: number;
  hitRate: number;
  raw?: Record<string, unknown>;
};

type ProbeResult = {
  name: string;
  requestAccepted: boolean;
  status: number;
  errorType?: string;
  errorMessage?: string;
  usage: UsageSummary;
  contentText?: string;
};

type EffectVerdict =
  | "likely_effective"
  | "likely_ignored"
  | "rejected"
  | "inconclusive";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ??
  process.env.ANTHROPIC_API_KEY?.trim();

if (!apiKey) {
  throw new Error(
    "Set DEEPSEEK_API_KEY before running this smoke script.",
  );
}

const baseUrl = (
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL ??
  "https://api.deepseek.com/anthropic"
).replace(/\/+$/, "");
const endpoint = process.env.DEEPSEEK_ANTHROPIC_MESSAGES_URL ??
  `${baseUrl}/v1/messages`;
const model = process.env.DEEPSEEK_ANTHROPIC_MODEL ?? "deepseek-v4-flash";
const maxTokens = Number(process.env.OPENCAT_CACHE_EDITING_MAX_TOKENS ?? 64);
const pauseMs = Number(process.env.OPENCAT_CACHE_EDITING_PAUSE_MS ?? 800);
const toolResultLines = Number(
  process.env.OPENCAT_CACHE_EDITING_TOOL_LINES ?? 800,
);
const runId = process.env.OPENCAT_CACHE_EDITING_RUN_ID ??
  `cache_edit_${Date.now().toString(36)}`;

console.log(JSON.stringify({
  event: "config",
  endpoint,
  model,
  maxTokens,
  pauseMs,
  toolResultLines,
  runId,
}));

const schemaResults = await runSchemaAcceptanceProbes();
for (const result of schemaResults) {
  console.log(JSON.stringify({ event: "schema_probe", ...result }));
}

const effectResults = await runCacheEffectProbe();
console.log(JSON.stringify({ event: "cache_effect", ...effectResults }, null, 2));

console.log("schema summary");
console.table(schemaResults.map((result) => ({
  name: result.name,
  requestAccepted: result.requestAccepted,
  status: result.status,
  prompt: result.usage.promptTokens,
  hit: result.usage.cacheHitTokens,
  miss: result.usage.cacheMissTokens,
  error: result.errorMessage ?? "",
})));

console.log("effect summary");
console.table([
  summarizeEffectRow("warm 1", effectResults.warm1),
  summarizeEffectRow("warm 2", effectResults.warm2),
  summarizeEffectRow("with context_management", effectResults.withContextManagement),
  summarizeEffectRow("same payload after edit probe", effectResults.afterContextManagement),
]);
console.log(JSON.stringify({
  verdict: effectResults.verdict,
  reason: effectResults.reason,
}));

async function runSchemaAcceptanceProbes(): Promise<ProbeResult[]> {
  const probes = [
    {
      name: "baseline",
      payload: basePayload(),
    },
    {
      name: "cache_control_probe",
      payload: {
        ...basePayload(),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Reply exactly: OK",
                cache_control: { type: "ephemeral" },
              },
            ],
          },
        ],
      },
    },
    {
      name: "context_management_clear_tool_uses",
      payload: {
        ...toolHistoryPayload({ compactableToolResult: true }),
        context_management: clearToolUsesContextManagement(),
      },
    },
    {
      name: "context_management_clear_thinking",
      payload: {
        ...basePayload(),
        context_management: {
          edits: [
            {
              type: "clear_thinking_20251015",
              keep: { type: "thinking_turns", value: 1 },
            },
          ],
        },
      },
    },
  ];

  const results: ProbeResult[] = [];
  for (const probe of probes) {
    results.push(await runProbe(probe.name, probe.payload));
    await sleep(pauseMs);
  }
  return results;
}

async function runCacheEffectProbe(): Promise<{
  warm1: ProbeResult;
  warm2: ProbeResult;
  withContextManagement: ProbeResult;
  afterContextManagement: ProbeResult;
  verdict: EffectVerdict;
  reason: string;
}> {
  const baselinePayload = toolHistoryPayload({ compactableToolResult: true });
  const contextManagementPayload = {
    ...toolHistoryPayload({ compactableToolResult: true }),
    context_management: clearToolUsesContextManagement(),
  };

  const warm1 = await runProbe("effect_warm_1", baselinePayload);
  await sleep(pauseMs);
  const warm2 = await runProbe("effect_warm_2", baselinePayload);
  await sleep(pauseMs);
  const withContextManagement = await runProbe(
    "effect_with_context_management",
    contextManagementPayload,
  );
  await sleep(pauseMs);
  const afterContextManagement = await runProbe(
    "effect_after_context_management",
    baselinePayload,
  );

  const { verdict, reason } = inferEffect({
    warm2,
    withContextManagement,
  });

  return {
    warm1,
    warm2,
    withContextManagement,
    afterContextManagement,
    verdict,
    reason,
  };
}

function inferEffect(input: {
  warm2: ProbeResult;
  withContextManagement: ProbeResult;
}): { verdict: EffectVerdict; reason: string } {
  const baselinePrompt = input.warm2.usage.promptTokens;
  const editedPrompt = input.withContextManagement.usage.promptTokens;
  const promptDrop = baselinePrompt - editedPrompt;
  const promptDropRatio = baselinePrompt > 0 ? promptDrop / baselinePrompt : 0;

  if (!input.withContextManagement.requestAccepted) {
    return {
      verdict: "rejected",
      reason: "The context_management request was rejected by the endpoint.",
    };
  }

  if (input.withContextManagement.usage.cacheDeletedTokens > 0) {
    return {
      verdict: "likely_effective",
      reason:
        `usage reports cacheDeletedTokens=${input.withContextManagement.usage.cacheDeletedTokens}.`,
    };
  }

  if (promptDrop > 1_000 && promptDropRatio >= 0.2) {
    return {
      verdict: "likely_effective",
      reason:
        `prompt tokens dropped from ${baselinePrompt} to ${editedPrompt} (${Math.round(promptDropRatio * 100)}%).`,
    };
  }

  if (baselinePrompt > 0 && editedPrompt > 0 && Math.abs(promptDropRatio) < 0.05) {
    return {
      verdict: "likely_ignored",
      reason:
        `prompt tokens stayed almost unchanged (${baselinePrompt} -> ${editedPrompt}); the field was probably ignored.`,
    };
  }

  return {
    verdict: "inconclusive",
    reason:
      `prompt token comparison was not decisive (${baselinePrompt} -> ${editedPrompt}).`,
  };
}

function basePayload(): Record<string, unknown> {
  return {
    model,
    max_tokens: maxTokens,
    system: [
      `Cache editing compatibility probe ${runId}.`,
      "Follow the user instruction exactly.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Reply exactly: OK",
          },
        ],
      },
    ],
  };
}

function toolHistoryPayload(options: {
  compactableToolResult: boolean;
}): Record<string, unknown> {
  const toolUseId = "toolu_cache_edit_probe_read_1";

  return {
    model,
    max_tokens: maxTokens,
    system: [
      `Cache editing behavior probe ${runId}.`,
      "Follow the final user instruction exactly.",
    ].join("\n"),
    tools: [
      {
        name: "Read",
        description: "Read a file from disk.",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
          },
          required: ["file_path"],
        },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Pretend the assistant already read a file. Continue after the tool result.",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: "Read",
            input: { file_path: "README.md" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: [
              {
                type: "text",
                text: [
                  "README probe content.",
                  repeat(
                    `Large stable tool-result content for cache editing probe ${runId}.`,
                    options.compactableToolResult ? toolResultLines : 8,
                  ),
                ].join("\n"),
              },
            ],
          },
          {
            type: "text",
            text: "Reply exactly: OK",
          },
        ],
      },
    ],
  };
}

function clearToolUsesContextManagement(): Record<string, unknown> {
  return {
    edits: [
      {
        type: "clear_tool_uses_20250919",
        trigger: { type: "input_tokens", value: 1 },
        clear_at_least: { type: "input_tokens", value: 1 },
        clear_tool_inputs: ["Read"],
      },
    ],
  };
}

async function runProbe(
  name: string,
  payload: Record<string, unknown>,
): Promise<ProbeResult> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey!,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "context-management-2025-06-27",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const body = parseJson(text);
  const error = extractError(body, text);

  return {
    name,
    requestAccepted: response.ok,
    status: response.status,
    ...(error.type ? { errorType: error.type } : {}),
    ...(error.message ? { errorMessage: error.message } : {}),
    usage: summarizeUsage(body?.usage),
    ...(body ? { contentText: extractText(body) } : {}),
  };
}

function summarizeUsage(usage: Record<string, unknown> | undefined): UsageSummary {
  const promptTokens = numberField(
    usage,
    "prompt_tokens",
    "input_tokens",
  );
  const cacheHitTokens = numberField(
    usage,
    "prompt_cache_hit_tokens",
    "cache_read_input_tokens",
  );
  const cacheMissTokens = numberField(
    usage,
    "prompt_cache_miss_tokens",
    "cache_creation_input_tokens",
  );
  const cacheDeletedTokens = numberField(
    usage,
    "cache_deleted_input_tokens",
    "cache_deleted_tokens",
  );
  const totalTokens = numberField(
    usage,
    "total_tokens",
    "input_tokens",
  );

  return {
    promptTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheDeletedTokens,
    totalTokens,
    hitRate: promptTokens > 0 ? cacheHitTokens / promptTokens : 0,
    ...(usage ? { raw: usage } : {}),
  };
}

function numberField(
  value: Record<string, unknown> | undefined,
  ...keys: string[]
): number {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return 0;
}

function summarizeEffectRow(name: string, result: ProbeResult): Record<string, unknown> {
  return {
    name,
    accepted: result.requestAccepted,
    status: result.status,
    prompt: result.usage.promptTokens,
    hit: result.usage.cacheHitTokens,
    miss: result.usage.cacheMissTokens,
    deleted: result.usage.cacheDeletedTokens,
    hitRate: `${Math.round(result.usage.hitRate * 100)}%`,
    error: result.errorMessage ?? "",
  };
}

function parseJson(text: string): AnthropicResponse | null {
  try {
    return JSON.parse(text) as AnthropicResponse;
  } catch {
    return null;
  }
}

function extractError(
  body: AnthropicResponse | null,
  rawText: string,
): { type?: string; message?: string } {
  if (body?.error) {
    return {
      type: body.error.type,
      message: body.error.message,
    };
  }

  if (body && typeof body.message === "string") {
    return { message: body.message };
  }

  if (rawText && !body) {
    return { message: rawText.slice(0, 500) };
  }

  return {};
}

function extractText(body: AnthropicResponse): string {
  if (!Array.isArray(body.content)) {
    return "";
  }

  return body.content
    .map((block) => {
      if (
        block &&
        typeof block === "object" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 500);
}

function repeat(text: string, count: number): string {
  return Array.from({ length: count }, () => text).join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
