export type DeepSeekApiErrorCategory =
  | "format_error"
  | "authentication_failed"
  | "insufficient_balance"
  | "parameter_error"
  | "rate_limited"
  | "server_error"
  | "server_busy"
  | "unknown";

type DeepSeekApiErrorInfo = {
  category: DeepSeekApiErrorCategory;
  title: string;
  cause: string;
  suggestion: string;
  retryable: boolean;
};

export class DeepSeekApiError extends Error {
  readonly status?: number;
  readonly category: DeepSeekApiErrorCategory;
  readonly causeText: string;
  readonly suggestion: string;
  readonly retryable: boolean;
  readonly originalMessage?: string;

  constructor(input: {
    status?: number;
    originalMessage?: string;
    cause?: unknown;
  }) {
    const info = classifyDeepSeekApiError(input.status);
    const message = formatDeepSeekApiErrorMessage({
      status: input.status,
      info,
      originalMessage: input.originalMessage,
    });

    super(message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "DeepSeekApiError";
    this.status = input.status;
    this.category = info.category;
    this.causeText = info.cause;
    this.suggestion = info.suggestion;
    this.retryable = info.retryable;
    this.originalMessage = input.originalMessage;
  }
}

export function normalizeDeepSeekApiError(error: unknown): Error {
  if (error instanceof DeepSeekApiError) {
    return error;
  }

  const status = readErrorStatus(error);
  if (status === undefined) {
    return error instanceof Error ? error : new Error(String(error));
  }

  return new DeepSeekApiError({
    status,
    originalMessage: readErrorMessage(error),
    cause: error,
  });
}

export function formatErrorForUser(error: unknown): string {
  const normalized = normalizeDeepSeekApiError(error);
  return normalized.message;
}

function classifyDeepSeekApiError(
  status: number | undefined,
): DeepSeekApiErrorInfo {
  switch (status) {
    case 400:
      return {
        category: "format_error",
        title: "400 - Request format error",
        cause: "The request body format is invalid.",
        suggestion: "Check the request payload and schema conversion.",
        retryable: false,
      };
    case 401:
      return {
        category: "authentication_failed",
        title: "401 - Authentication failed",
        cause: "The API key is missing, invalid, or rejected.",
        suggestion: "Check DEEPSEEK_API_KEY / OPENAI_API_KEY and restart the process.",
        retryable: false,
      };
    case 402:
      return {
        category: "insufficient_balance",
        title: "402 - Insufficient balance",
        cause: "The account balance is insufficient.",
        suggestion: "Recharge the DeepSeek account or switch to a funded key.",
        retryable: false,
      };
    case 422:
      return {
        category: "parameter_error",
        title: "422 - Parameter error",
        cause: "One or more request parameters are invalid.",
        suggestion: "Check model name, max_tokens, tools, prefix/beta settings, and message fields.",
        retryable: false,
      };
    case 429:
      return {
        category: "rate_limited",
        title: "429 - Rate limit reached",
        cause: "TPM or RPM request rate reached the account limit.",
        suggestion: "Reduce concurrency, wait briefly, or add backoff/retry scheduling.",
        retryable: true,
      };
    case 500:
      return {
        category: "server_error",
        title: "500 - Server error",
        cause: "DeepSeek reported an internal server error.",
        suggestion: "Retry later. If it persists, collect request metadata and contact DeepSeek.",
        retryable: true,
      };
    case 503:
      return {
        category: "server_busy",
        title: "503 - Server busy",
        cause: "DeepSeek servers are currently overloaded.",
        suggestion: "Retry later with backoff.",
        retryable: true,
      };
    default:
      return {
        category: "unknown",
        title: status ? `${status} - DeepSeek API error` : "DeepSeek API error",
        cause: "The DeepSeek API request failed.",
        suggestion: "Inspect the original error message and request context.",
        retryable: false,
      };
  }
}

function formatDeepSeekApiErrorMessage(input: {
  status?: number;
  info: DeepSeekApiErrorInfo;
  originalMessage?: string;
}): string {
  return [
    `DeepSeek API error: ${input.info.title}`,
    `Cause: ${input.info.cause}`,
    `Suggestion: ${input.info.suggestion}`,
    `Retryable: ${input.info.retryable ? "yes" : "no"}`,
    input.originalMessage ? `Original: ${input.originalMessage}` : undefined,
  ].filter(Boolean).join("\n");
}

function readErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const direct = error.status ?? error.statusCode ?? error.code;
  if (typeof direct === "number") {
    return direct;
  }

  if (typeof direct === "string" && /^\d+$/.test(direct)) {
    return Number(direct);
  }

  return undefined;
}

function readErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }

  if (!isRecord(error)) {
    return undefined;
  }

  if (typeof error.message === "string") {
    return error.message;
  }

  if (isRecord(error.error) && typeof error.error.message === "string") {
    return error.error.message;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
