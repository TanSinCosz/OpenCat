import { getConfigValue } from "../src/config/load-config.js";
type Usage = {
  prompt_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type ProbeResult = {
  label: string;
  userId: string;
  status: number;
  ok: boolean;
  usage: Usage;
  error?: string;
};

const apiKey = getConfigValue("model.apiKey")?.trim();
if (!apiKey) {
  throw new Error("Set model.apiKey in your OpenCat YAML config before running this smoke test.");
}

const baseUrl = (
  getConfigValue("model.baseUrl") ?? "https://api.deepseek.com"
).replace(/\/+$/, "");
const endpoint = baseUrl.endsWith("/chat/completions")
  ? baseUrl
  : `${baseUrl}/chat/completions`;
const model = getConfigValue("model.model") ?? "deepseek-v4-pro";
const maxTokens = Number(getConfigValue("experiments.userIdCache.maxTokens") ?? 16);
const runId = `opencat-kv-${Date.now().toString(36)}`;
const userA = `${runId}-a`;
const userB = `${runId}-b`;
const prompt = createStablePrompt(runId);

console.log(JSON.stringify({ event: "config", endpoint, model, runId }));

const probes: Array<[string, string]> = [
  ["same_user_warm_1", userA],
  ["same_user_warm_2", userA],
  ["different_user_warm_1", userB],
  ["different_user_warm_2", userB],
  ["same_user_after_other_user", userA],
];

const results: ProbeResult[] = [];
for (const [label, userId] of probes) {
  const result = await runProbe(label, userId);
  results.push(result);
  console.log(JSON.stringify({ event: "probe", ...result }));
}

const sameUserRepeat = results[1]?.usage.prompt_cache_hit_tokens ?? 0;
const differentUserFirst = results[2]?.usage.prompt_cache_hit_tokens ?? 0;
const differentUserRepeat = results[3]?.usage.prompt_cache_hit_tokens ?? 0;
const sameUserAfterOther = results[4]?.usage.prompt_cache_hit_tokens ?? 0;

let verdict = "inconclusive";
let reason = "The provider returned insufficient cache usage data.";
if (sameUserRepeat > 0 && differentUserFirst === 0 && differentUserRepeat > 0) {
  verdict = "likely_isolated";
  reason =
    "The same user_id warmed independently, while a different user_id did not reuse the first user's cache.";
} else if (sameUserRepeat > 0 && differentUserFirst > 0) {
  verdict = "not_observed";
  reason =
    "The different user_id also received cache hits; isolation was not observable in this run."
      + " DeepSeek cache is best-effort, so repeat the test if needed.";
}

console.log(JSON.stringify({
  event: "verdict",
  verdict,
  reason,
  sameUserRepeat,
  differentUserFirst,
  differentUserRepeat,
  sameUserAfterOther,
}, null, 2));

async function runProbe(label: string, userId: string): Promise<ProbeResult> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0,
      stream: false,
      user_id: userId,
      messages: [
        { role: "system", content: "Reply with exactly OK." },
        { role: "user", content: prompt },
      ],
    }),
  });

  const body = await response.json() as {
    usage?: Usage;
    error?: { message?: string };
  };
  return {
    label,
    userId,
    status: response.status,
    ok: response.ok,
    usage: body.usage ?? {},
    error: body.error?.message,
  };
}

function createStablePrompt(run: string): string {
  const blocks = Array.from({ length: 600 }, (_, index) =>
    `cache-isolation-${run}-block-${index.toString().padStart(4, "0")}: `
      + "This text is intentionally repeated to create a stable cacheable prefix.\n",
  );
  return blocks.join("") + "\nReply with exactly OK.";
}
