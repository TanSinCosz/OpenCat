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

const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error("Set DEEPSEEK_API_KEY before running this smoke script.");
}

const baseUrl = (process.env.DEEPSEEK_BETA_BASE_URL ??
  "https://api.deepseek.com/beta").replace(/\/+$/, "");
const model = process.env.OPENCAT_PREFIX_SMOKE_MODEL ?? "deepseek-v4-pro";

const response = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    max_tokens: 512,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          "You are verifying whether DeepSeek beta prefix completion can continue",
          "from a supplied reasoning checkpoint. Finish the tiny task concisely:",
          "What is gcd(12, 18)?",
        ].join(" "),
      },
      {
        role: "assistant",
        prefix: true,
        content: "Final answer:\n",
        reasoning_content: [
          "We need compute gcd(12, 18).",
          "The common divisors are 1, 2, 3, 6.",
          "The greatest common divisor is",
        ].join(" "),
      },
    ],
  }),
});

const raw = await response.text();
let parsed: ChatCompletionResponse;
try {
  parsed = JSON.parse(raw) as ChatCompletionResponse;
} catch {
  parsed = { error: { message: raw } };
}

const message = parsed.choices?.[0]?.message;

console.log(JSON.stringify({
  ok: response.ok,
  status: response.status,
  model,
  baseUrl,
  finishReason: parsed.choices?.[0]?.finish_reason,
  contentPreview: preview(message?.content ?? ""),
  reasoningPreview: preview(message?.reasoning_content ?? ""),
  usage: parsed.usage,
  error: parsed.error,
}, null, 2));

if (!response.ok) {
  process.exitCode = 1;
}

function preview(value: string, maxChars = 600): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}... [${value.length - maxChars} chars hidden]`;
}
