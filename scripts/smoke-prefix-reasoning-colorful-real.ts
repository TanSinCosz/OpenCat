type ChatCompletionResponse = {
  id?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

const problem = String.raw`F. Colorful Works

Gold14526 is a painter. He can paint with n colors, numbered 1,2,...,n. Color i has a constraint interval [l_i,r_i].

A work is a rooted tree where every edge is colored with one of n colors. It is colorful if:
- Adjacent edges sharing a middle node must have different colors.
- For every color i, d(u,i) is the number of edges of color i on the path from u to the root. max_u d(u,i) must be in [l_i,r_i].

Two works are isomorphic if they have the same rooted colored tree structure.

Given up to 1e4 tests, sum n <= 2e6, r_i <= 2e5, and sum max r_i <= 2e5, output the number of pairwise non-isomorphic colorful works modulo 2.

Samples:
4
2
0 1
0 1
2
1 1
1 1
3
0 2
0 1
0 1
3
1 2
1 1
1 1

Output:
1
0
1
1

Solve this problem and eventually provide a C++17 solution.`;

const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error("Set DEEPSEEK_API_KEY before running this smoke script.");
}

const baseUrl = (process.env.DEEPSEEK_BETA_BASE_URL ??
  "https://api.deepseek.com/beta").replace(/\/+$/, "");
const model = process.env.OPENCAT_PREFIX_SMOKE_MODEL ?? "deepseek-v4-pro";
const firstMaxTokens = Number(process.env.OPENCAT_PREFIX_FIRST_MAX_TOKENS ?? 768);
const secondMaxTokens = Number(process.env.OPENCAT_PREFIX_SECOND_MAX_TOKENS ?? 1536);

const first = await createChatCompletion({
  model,
  max_tokens: firstMaxTokens,
  temperature: 0,
  reasoning_effort: "max",
  messages: [
    {
      role: "user",
      content: problem,
    },
  ],
});

const firstChoice = first.choices?.[0];
const firstMessage = firstChoice?.message;
const reasoningCheckpoint = firstMessage?.reasoning_content ?? "";

console.log(JSON.stringify({
  step: "first",
  ok: !first.error,
  finishReason: firstChoice?.finish_reason,
  reasoningChars: reasoningCheckpoint.length,
  contentChars: (firstMessage?.content ?? "").length,
  reasoningPreview: preview(reasoningCheckpoint),
  contentPreview: preview(firstMessage?.content ?? ""),
  usage: first.usage,
  error: first.error,
}, null, 2));

if (!reasoningCheckpoint) {
  console.log(JSON.stringify({
    step: "second",
    skipped: true,
    reason: "first_response_had_no_reasoning_content",
  }, null, 2));
  process.exit(first.error ? 1 : 0);
}

const second = await createChatCompletion({
  model,
  max_tokens: secondMaxTokens,
  temperature: 0,
  reasoning_effort: "max",
  messages: [
    {
      role: "user",
      content: [
        problem,
        "",
        "Continue the hidden reasoning from the checkpoint.",
        "Do not restart from scratch. Do not provide final C++ yet unless the reasoning is complete.",
      ].join("\n"),
    },
    {
      role: "assistant",
      prefix: true,
      content: "",
      reasoning_content: reasoningCheckpoint,
    },
  ],
});

const secondChoice = second.choices?.[0];
const secondMessage = secondChoice?.message;
const secondReasoning = secondMessage?.reasoning_content ?? "";

console.log(JSON.stringify({
  step: "second",
  ok: !second.error,
  finishReason: secondChoice?.finish_reason,
  continuedReasoning: secondReasoning.length > 0,
  reasoningChars: secondReasoning.length,
  contentChars: (secondMessage?.content ?? "").length,
  reasoningPreview: preview(secondReasoning),
  contentPreview: preview(secondMessage?.content ?? ""),
  usage: second.usage,
  error: second.error,
}, null, 2));

if (first.error || second.error) {
  process.exitCode = 1;
}

async function createChatCompletion(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();

  try {
    return JSON.parse(raw) as ChatCompletionResponse;
  } catch {
    return {
      error: {
        message: raw,
        type: `http_${response.status}`,
      },
    } satisfies ChatCompletionResponse;
  }
}

function preview(value: string, maxChars = 800): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}... [${value.length - maxChars} chars hidden]`;
}
