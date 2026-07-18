import type { DeepSeekClient } from "../deepseek/client.js";
import type {
  DeepSeekAssistantMessage,
  DeepSeekCreateRequest,
  DeepSeekStreamRequest,
  DeepSeekUsage,
} from "../deepseek/types.js";
import type { Runtime } from "../types/runtime.js";
import { emitRunEvent } from "../telemetry/observer.js";
import { streamAssistantMessage, type AssistantStreamUpdate } from "./assistant-stream.js";
import type { QueryEvent } from "./types.js";
import { recordModelUsage } from "./usage.js";

type AssistantReady = Extract<
  AssistantStreamUpdate,
  { type: "assistant_message_ready" }
>;

type ReasoningContinuationOptions = {
  maxContinuationRounds: number;
};

const DEFAULT_REASONING_CONTINUATION_ROUNDS = 2;

export type AssistantWithUsage = {
  message: DeepSeekAssistantMessage;
  usage?: DeepSeekUsage;
  contextTokenCount?: number;
};

/**
 * Streams one assistant turn, recovering when the provider cuts the response at
 * the output-token boundary.
 *
 * This intentionally uses only ordinary OpenAI-compatible chat messages. Older
 * versions used DeepSeek beta `prefix + reasoning_content` to continue hidden
 * reasoning, but that path is provider-specific and breaks compatible gateways.
 * The generic recovery keeps visible partial assistant text as ordinary context,
 * then asks the model to resume directly.
 */
export async function* streamAssistantWithReasoningContinuation(
  runtime: Runtime,
  request: DeepSeekCreateRequest & { stream: true },
): AsyncGenerator<QueryEvent, AssistantWithUsage, void> {
  const options = getReasoningContinuationOptions();
  const primaryResult = yield* streamAssistantOnce(
    runtime,
    runtime.deepSeekClient,
    request,
  );
  let result = primaryResult;
  let usage = result.usage;
  let reasoningTrail = result.message.reasoning_content ?? "";
  let visibleContentTrail = getAssistantContent(result.message);

  if (!shouldRecoverMaxOutput(result)) {
    return {
      message: result.message,
      usage,
      contextTokenCount: getContextTokenCount(result.usage),
    };
  }

  for (let round = 1; round <= options.maxContinuationRounds; round++) {
    yield {
      type: "reasoning_continuation",
      phase: "continue_reasoning",
      round,
      reasoningChars: reasoningTrail.length,
    };

    result = yield* streamAssistantOnce(
      runtime,
      runtime.deepSeekClient,
      createOutputRecoveryRequest(
        runtime,
        request,
        visibleContentTrail,
        round,
      ),
    );
    usage = combineUsage(usage, result.usage);
    reasoningTrail = appendReasoningTrail(
      reasoningTrail,
      result.message.reasoning_content,
    );
    visibleContentTrail = appendVisibleContentTrail(
      visibleContentTrail,
      getAssistantContent(result.message),
    );

    if (!shouldRecoverMaxOutput(result)) {
      const message = mergeTrailsIntoMessage(
        result.message,
        visibleContentTrail,
        reasoningTrail,
      );
      return {
        message,
        usage,
        contextTokenCount: getContinuationContextTokenCount(
          primaryResult.usage,
          message,
        ),
      };
    }
  }

  yield {
    type: "reasoning_continuation",
    phase: "force_final_answer",
    round: options.maxContinuationRounds + 1,
    reasoningChars: reasoningTrail.length,
  };

  result = yield* streamAssistantOnce(
    runtime,
    runtime.deepSeekClient,
    createFinalAnswerRecoveryRequest(runtime, request, visibleContentTrail),
  );
  usage = combineUsage(usage, result.usage);
  visibleContentTrail = appendVisibleContentTrail(
    visibleContentTrail,
    getAssistantContent(result.message),
  );

  const message = mergeTrailsIntoMessage(
    result.message,
    visibleContentTrail,
    appendReasoningTrail(reasoningTrail, result.message.reasoning_content),
  );
  return {
    message,
    usage,
    contextTokenCount: getContinuationContextTokenCount(
      primaryResult.usage,
      message,
    ),
  };
}

async function* streamAssistantOnce(
  runtime: Runtime,
  client: DeepSeekClient,
  request: DeepSeekCreateRequest & { stream: true },
): AsyncGenerator<QueryEvent, AssistantReady & { usage?: DeepSeekUsage }, void> {
  let assistantResult: AssistantReady | undefined;
  let latestUsage: DeepSeekUsage | undefined;

  for await (const update of streamAssistantMessage(client, request)) {
    if (update.type === "assistant_message_ready") {
      assistantResult = update;
      continue;
    }

    if (update.type === "model_stream_event" && update.event.chunk?.usage) {
      const usage = update.event.chunk.usage;
      latestUsage = usage;
      const sessionUsage = recordModelUsage(runtime, usage);
      await emitRunEvent(runtime, {
        type: "model_usage",
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        promptCacheHitTokens: usage.prompt_cache_hit_tokens ?? 0,
        promptCacheMissTokens: usage.prompt_cache_miss_tokens ?? 0,
        sessionTotalTokens: sessionUsage.totalTokens,
        sessionPromptCacheHitTokens: sessionUsage.promptCacheHitTokens,
        sessionPromptCacheMissTokens: sessionUsage.promptCacheMissTokens,
      });
      yield {
        type: "model_usage",
        usage,
        sessionUsage,
      };
    }

    yield update;
  }

  if (!assistantResult) {
    throw new Error("Model stream completed without an assistant message.");
  }

  return { ...assistantResult, usage: latestUsage };
}

function combineUsage(
  left: DeepSeekUsage | undefined,
  right: DeepSeekUsage | undefined,
): DeepSeekUsage | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  return {
    prompt_tokens: (left.prompt_tokens ?? 0) + (right.prompt_tokens ?? 0),
    completion_tokens:
      (left.completion_tokens ?? 0) + (right.completion_tokens ?? 0),
    total_tokens: (left.total_tokens ?? 0) + (right.total_tokens ?? 0),
    prompt_cache_hit_tokens:
      (left.prompt_cache_hit_tokens ?? 0) +
      (right.prompt_cache_hit_tokens ?? 0),
    prompt_cache_miss_tokens:
      (left.prompt_cache_miss_tokens ?? 0) +
      (right.prompt_cache_miss_tokens ?? 0),
  };
}

function getContextTokenCount(usage: DeepSeekUsage | undefined): number | undefined {
  if (!usage) {
    return undefined;
  }

  // DeepSeek documents prompt_tokens as the complete prompt size. Its cache
  // hit/miss fields are a partition of prompt_tokens, so they must not be added.
  return (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
}

function getContinuationContextTokenCount(
  primaryUsage: DeepSeekUsage | undefined,
  finalMessage: DeepSeekAssistantMessage,
): number | undefined {
  if (!primaryUsage) {
    return undefined;
  }

  // Continuation requests deliberately omit tool schemas and accumulate usage
  // across attempts. Anchor on the original request's measured prompt instead,
  // then estimate the one merged assistant message that will persist locally.
  return (primaryUsage.prompt_tokens ?? 0) +
    Math.ceil(JSON.stringify(finalMessage).length / 4);
}

function shouldRecoverMaxOutput(result: AssistantReady): boolean {
  return result.finishReason === "length" &&
    (result.message.tool_calls?.length ?? 0) === 0;
}

function createOutputRecoveryRequest(
  runtime: Runtime,
  request: DeepSeekCreateRequest & { stream: true },
  visibleContentTrail: string,
  round: number,
): DeepSeekStreamRequest {
  return {
    ...request,
    messages: [
      ...request.messages,
      ...createVisiblePartialAssistantMessages(visibleContentTrail),
      {
        role: "user",
        content: [
          "Output token limit hit.",
          "Resume directly; do not apologize, recap, or restart from scratch.",
          "Pick up from the cut-off point if visible text was already produced.",
          "Break the remaining work into smaller pieces if needed.",
          `Recovery attempt ${round}.`,
        ].join(" "),
      },
    ],
    model: runtime.deepSeekRuntimeConfig.model as DeepSeekCreateRequest["model"],
    max_tokens: getContinuationMaxTokens(runtime),
  };
}

function createFinalAnswerRecoveryRequest(
  runtime: Runtime,
  request: DeepSeekCreateRequest & { stream: true },
  visibleContentTrail: string,
): DeepSeekStreamRequest {
  return {
    ...request,
    messages: [
      ...request.messages,
      ...createVisiblePartialAssistantMessages(visibleContentTrail),
      {
        role: "user",
        content: [
          "The output-limit recovery attempts have reached their configured limit.",
          "Produce the final visible answer now.",
          "Do not include hidden reasoning. Start with the final answer.",
        ].join(" "),
      },
    ],
    model: runtime.deepSeekRuntimeConfig.model as DeepSeekCreateRequest["model"],
    max_tokens: getFinalAnswerMaxTokens(runtime),
    reasoning_effort: undefined,
    tools: undefined,
    tool_choice: "none",
  };
}

function createVisiblePartialAssistantMessages(
  visibleContentTrail: string,
): DeepSeekStreamRequest["messages"] {
  if (!visibleContentTrail.trim()) {
    return [];
  }

  return [{
    role: "assistant",
    content: visibleContentTrail,
  }];
}

function mergeTrailsIntoMessage(
  message: DeepSeekAssistantMessage,
  visibleContentTrail: string,
  reasoningTrail: string,
): DeepSeekAssistantMessage {
  return {
    ...message,
    content: visibleContentTrail.trim() ? visibleContentTrail : message.content,
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

function getAssistantContent(message: DeepSeekAssistantMessage): string {
  if (typeof message.content !== "string") {
    return "";
  }

  return isSyntheticNoFinalAnswerContent(message.content) ? "" : message.content;
}

function appendVisibleContentTrail(current: string, next: string): string {
  if (!next) {
    return current;
  }

  if (!current) {
    return next;
  }

  return `${current}\n${next}`;
}

function isSyntheticNoFinalAnswerContent(content: string): boolean {
  return content.startsWith(
    "The model returned internal reasoning but did not produce a final answer.",
  );
}

function getReasoningContinuationOptions(): ReasoningContinuationOptions {
  return {
    maxContinuationRounds: readPositiveIntegerEnv(
      "OPENCAT_REASONING_CONTINUATION_ROUNDS",
      DEFAULT_REASONING_CONTINUATION_ROUNDS,
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
