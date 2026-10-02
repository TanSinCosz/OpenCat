import { getConfigValue } from "../src/config/load-config.js";
type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type Usage = {
  prompt_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: Usage;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

type TurnResult = {
  turn: number;
  message: string;
  status: number;
  promptTokens: number;
  hitTokens: number;
  missTokens: number;
  hitRate: string;
  assistantReply: string;
};

const apiKey = getConfigValue("model.apiKey")?.trim()
  ?? getConfigValue("model.apiKey")?.trim();
if (!apiKey) {
  throw new Error("Set model.apiKey in your OpenCat YAML config before running this smoke test.");
}

const baseUrl = (
  getConfigValue("model.baseUrl") ?? "https://api.deepseek.com"
).replace(/\/+$/, "");
const endpoint = baseUrl.endsWith("/chat/completions")
  ? baseUrl
  : `${baseUrl}/chat/completions`;
const model = getConfigValue("model.model") ?? "deepseek-v4-flash";
const maxTokens = readNonNegativeInteger("experiments.abaCache.maxTokens", 8);
const pauseMs = readNonNegativeInteger("experiments.abaCache.pauseMs", 800);
const prefixLines = readNonNegativeInteger("experiments.abaCache.prefixLines", 128);
const runId = getConfigValue("experiments.abaCache.runId")?.trim()
  || `aba-cache-${Date.now().toString(36)}`;
const userMessages = ["ABA", "ABC", "ABA"] as const;

const history: ChatMessage[] = [
  {
    role: "system",
    content: createCacheableSystemPrefix(runId, prefixLines),
  },
];
const results: TurnResult[] = [];

console.log(JSON.stringify({
  event: "config",
  endpoint,
  model,
  runId,
  userMessages,
  prefixLines,
  systemPrefixChars: history[0].content.length,
  maxTokens,
  pauseMs,
}));

for (const [index, message] of userMessages.entries()) {
  if (index > 0 && pauseMs > 0) {
    await sleep(pauseMs);
  }

  const userMessage: ChatMessage = { role: "user", content: message };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [...history, userMessage],
      max_tokens: maxTokens,
      temperature: 0,
      thinking: { type: "disabled" },
      stream: false,
    }),
  });

  const body = await parseResponse(response);
  if (!response.ok) {
    console.error(JSON.stringify({
      event: "api_error",
      turn: index + 1,
      message,
      status: response.status,
      error: body.error,
    }, null, 2));
    process.exitCode = 1;
    break;
  }

  const assistantReply = body.choices?.[0]?.message?.content ?? "";
  const usage = body.usage ?? {};
  const promptTokens = usage.prompt_tokens ?? 0;
  const hitTokens = usage.prompt_cache_hit_tokens ?? 0;
  const missTokens = usage.prompt_cache_miss_tokens ?? 0;
  const measuredPromptTokens = hitTokens + missTokens;
  const result: TurnResult = {
    turn: index + 1,
    message,
    status: response.status,
    promptTokens,
    hitTokens,
    missTokens,
    hitRate: measuredPromptTokens > 0
      ? `${((hitTokens / measuredPromptTokens) * 100).toFixed(2)}%`
      : "n/a",
    assistantReply,
  };

  results.push(result);
  console.log(JSON.stringify({ event: "turn", ...result }));

  history.push(
    userMessage,
    { role: "assistant", content: assistantReply },
  );
}

console.log("summary");
console.table(results);

if (results.length === userMessages.length) {
  const [first, second, third] = results;
  const laterTurnsHit = second.hitTokens > 0 || third.hitTokens > 0;

  console.log(JSON.stringify({
    event: "verdict",
    cacheHitObserved: laterTurnsHit,
    firstTurnHitTokens: first.hitTokens,
    secondTurnHitTokens: second.hitTokens,
    thirdTurnHitTokens: third.hitTokens,
    explanation: laterTurnsHit
      ? "Cache hits were reported after the first request warmed the shared conversation prefix."
      : "No cache hit was reported. DeepSeek caching is best-effort; retry the test or increase DEEPSEEK_ABA_PREFIX_LINES.",
  }, null, 2));
}

async function parseResponse(
  response: Response,
): Promise<ChatCompletionResponse> {
  const raw = await response.text();

  try {
    return JSON.parse(raw) as ChatCompletionResponse;
  } catch {
    return {
      error: {
        message: raw || "DeepSeek returned an empty non-JSON response.",
      },
    };
  }
}

function createCacheableSystemPrefix(
  id: string,
  lineCount: number,
): string {
  const lines = Array.from({ length: lineCount }, (_, index) =>
    `${index.toString().padStart(4, "0")}: stable cache probe ${id}; preserve this exact line.`,
  );

  return [
    "You are running a cache smoke test. Reply to each user message with exactly OK.",
    ...lines,
  ].join("\n");
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const raw = getConfigValue(name)?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, received: ${raw}`);
  }

  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
