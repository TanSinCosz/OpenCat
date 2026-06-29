import { createDeepSeekClient, type DeepSeekClient } from "../deepseek/client.js";
import type {
  DeepSeekAssistantMessage,
  DeepSeekCreateRequest,
  DeepSeekStreamRequest,
} from "../deepseek/types.js";
import type { Runtime } from "../types/runtime.js";
import { streamAssistantMessage, type AssistantStreamUpdate } from "./assistant-stream.js";
import type { QueryEvent } from "./types.js";

type AssistantReady = Extract<
  AssistantStreamUpdate,
  { type: "assistant_message_ready" }
>;

type ReasoningContinuationOptions = {
  maxContinuationRounds: number;
  reasoningPrefixMaxChars: number;
};

const DEFAULT_REASONING_CONTINUATION_ROUNDS = 2;
const DEFAULT_REASONING_PREFIX_MAX_CHARS = 240_000;
const DEFAULT_DEEPSEEK_BETA_BASE_URL = "https://api.deepseek.com/beta";

/**
 * Streams one assistant turn, continuing hidden reasoning when the provider
 * cuts the response at the output-token boundary before any visible answer is
 * produced.
 *
 * DeepSeek beta prefix completion can accept an assistant message containing
 * `reasoning_content`, so we use that as a checkpoint for continuation rounds.
 * The final persisted assistant message is still one logical response: visible
 * content comes from the last successful stream, while reasoning text is merged
 * across all continuation attempts.
 */
export async function* streamAssistantWithReasoningContinuation(
  runtime: Runtime,
  request: DeepSeekCreateRequest & { stream: true },
): AsyncGenerator<QueryEvent, DeepSeekAssistantMessage, void> {
  const options = getReasoningContinuationOptions();
  const primaryResult = yield* streamAssistantOnce(
    runtime.deepSeekClient,
    request,
  );
  let result = primaryResult;
  let reasoningTrail = result.message.reasoning_content ?? "";

  if (!shouldContinueReasoning(result)) {
    return result.message;
  }

  const continuationClient = createReasoningContinuationClient(runtime);

  for (let round = 1; round <= options.maxContinuationRounds; round++) {
    yield {
      type: "reasoning_continuation",
      phase: "continue_reasoning",
      round,
      reasoningChars: reasoningTrail.length,
    };

    result = yield* streamAssistantOnce(
      continuationClient,
      createReasoningContinuationRequest(runtime, request, reasoningTrail, options),
    );
    reasoningTrail = appendReasoningTrail(
      reasoningTrail,
      result.message.reasoning_content,
    );

    if (!shouldContinueReasoning(result)) {
      return mergeReasoningIntoMessage(result.message, reasoningTrail);
    }
  }

  yield {
    type: "reasoning_continuation",
    phase: "force_final_answer",
    round: options.maxContinuationRounds + 1,
    reasoningChars: reasoningTrail.length,
  };

  result = yield* streamAssistantOnce(
    continuationClient,
    createFinalAnswerPrefixRequest(runtime, request, reasoningTrail, options),
  );

  return mergeReasoningIntoMessage(
    result.message,
    appendReasoningTrail(reasoningTrail, result.message.reasoning_content),
  );
}

async function* streamAssistantOnce(
  client: DeepSeekClient,
  request: DeepSeekCreateRequest & { stream: true },
): AsyncGenerator<QueryEvent, AssistantReady, void> {
  let assistantResult: AssistantReady | undefined;

  for await (const update of streamAssistantMessage(client, request)) {
    if (update.type === "assistant_message_ready") {
      assistantResult = update;
      continue;
    }

    yield update;
  }

  if (!assistantResult) {
    throw new Error("Model stream completed without an assistant message.");
  }

  return assistantResult;
}

function shouldContinueReasoning(result: AssistantReady): boolean {
  return result.finishReason === "length" &&
    !result.hadContent &&
    (result.message.tool_calls?.length ?? 0) === 0 &&
    Boolean(result.message.reasoning_content);
}

/**
 * Uses the runtime client when it is already configured for DeepSeek beta.
 * Otherwise creates a short-lived beta client only for prefix continuation.
 * This keeps ordinary requests on the configured endpoint while enabling the
 * beta-only `prefix + reasoning_content` recovery path.
 */
function createReasoningContinuationClient(runtime: Runtime): DeepSeekClient {
  if (isDeepSeekBetaBaseUrl(runtime.deepSeekRuntimeConfig.baseUrl)) {
    return runtime.deepSeekClient;
  }

  return createDeepSeekClient({
    config: {
      ...runtime.deepSeekRuntimeConfig,
      baseUrl: getDeepSeekBetaBaseUrl(runtime.deepSeekRuntimeConfig.baseUrl),
    },
  });
}

function createReasoningContinuationRequest(
  runtime: Runtime,
  request: DeepSeekCreateRequest & { stream: true },
  reasoningTrail: string,
  options: ReasoningContinuationOptions,
): DeepSeekStreamRequest {
  return {
    ...request,
    messages: [
      ...request.messages,
      {
        role: "user",
        content: [
          "Your previous hidden reasoning was cut off by the output-token limit.",
          "Continue the hidden reasoning from the assistant checkpoint.",
          "Do not restart from scratch.",
          "If the reasoning becomes complete, produce the final answer.",
        ].join(" "),
      },
      {
        role: "assistant",
        content: "",
        prefix: true,
        reasoning_content: tail(reasoningTrail, options.reasoningPrefixMaxChars),
      },
    ],
    model: runtime.deepSeekRuntimeConfig.model as DeepSeekCreateRequest["model"],
    max_tokens: getContinuationMaxTokens(runtime),
    tools: undefined,
    tool_choice: "none",
  };
}

function createFinalAnswerPrefixRequest(
  runtime: Runtime,
  request: DeepSeekCreateRequest & { stream: true },
  reasoningTrail: string,
  options: ReasoningContinuationOptions,
): DeepSeekStreamRequest {
  return {
    ...request,
    messages: [
      ...request.messages,
      {
        role: "user",
        content: [
          "The hidden reasoning has reached the configured continuation limit.",
          "Use the assistant checkpoint to produce the final answer now.",
          "Do not include the hidden reasoning. Start with the final answer.",
        ].join(" "),
      },
      {
        role: "assistant",
        content: "Final answer:\n",
        prefix: true,
        reasoning_content: tail(reasoningTrail, options.reasoningPrefixMaxChars),
      },
    ],
    model: runtime.deepSeekRuntimeConfig.model as DeepSeekCreateRequest["model"],
    max_tokens: getFinalAnswerMaxTokens(runtime),
    reasoning_effort: undefined,
    tools: undefined,
    tool_choice: "none",
  };
}

function mergeReasoningIntoMessage(
  message: DeepSeekAssistantMessage,
  reasoningTrail: string,
): DeepSeekAssistantMessage {
  return {
    ...message,
    reasoning_content: reasoningTrail || message.reasoning_content,
  };
}

function appendReasoningTrail(
  current: string,
  next: string | null | undefined,
): string {
  if (!next) {
    return current;
  }

  if (!current) {
    return next;
  }

  return `${current}\n\n${next}`;
}

function getReasoningContinuationOptions(): ReasoningContinuationOptions {
  return {
    maxContinuationRounds: readPositiveIntegerEnv(
      "OPENCAT_REASONING_CONTINUATION_ROUNDS",
      DEFAULT_REASONING_CONTINUATION_ROUNDS,
    ),
    reasoningPrefixMaxChars: readPositiveIntegerEnv(
      "OPENCAT_REASONING_PREFIX_MAX_CHARS",
      DEFAULT_REASONING_PREFIX_MAX_CHARS,
    ),
  };
}

function getContinuationMaxTokens(runtime: Runtime): number {
  return readPositiveIntegerEnv(
    "OPENCAT_REASONING_CONTINUATION_MAX_TOKENS",
    runtime.deepSeekRuntimeConfig.maxTokens,
  );
}

function getFinalAnswerMaxTokens(runtime: Runtime): number {
  return readPositiveIntegerEnv(
    "OPENCAT_REASONING_FINAL_MAX_TOKENS",
    runtime.deepSeekRuntimeConfig.maxTokens,
  );
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function tail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

function getDeepSeekBetaBaseUrl(baseUrl: string | undefined): string {
  const explicit = process.env.DEEPSEEK_BETA_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  if (!baseUrl) {
    return DEFAULT_DEEPSEEK_BETA_BASE_URL;
  }

  const normalized = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  if (isDeepSeekBetaBaseUrl(normalized)) {
    return normalized;
  }

  return `${normalized}/beta`;
}

function isDeepSeekBetaBaseUrl(baseUrl: string | undefined): boolean {
  return /\/beta$/.test(baseUrl?.replace(/\/+$/, "") ?? "");
}
