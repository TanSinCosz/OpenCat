import assert from "node:assert/strict";
import test from "node:test";
import {
  DeepSeekApiError,
  formatErrorForUser,
  normalizeDeepSeekApiError,
} from "../src/deepseek/errors.js";

test("DeepSeek API errors are classified with actionable messages", () => {
  const error = normalizeDeepSeekApiError({
    status: 429,
    message: "Rate limit exceeded",
  });

  assert.ok(error instanceof DeepSeekApiError);
  assert.equal(error.status, 429);
  assert.equal(error.category, "rate_limited");
  assert.equal(error.retryable, true);
  assert.match(error.message, /429 - Rate limit reached/);
  assert.match(error.message, /Reduce concurrency/);
  assert.match(error.message, /Original: Rate limit exceeded/);
});

test("non API errors keep their original message", () => {
  const error = new Error("local failure");

  assert.equal(normalizeDeepSeekApiError(error), error);
  assert.equal(formatErrorForUser(error), "local failure");
});

test("known DeepSeek status codes include official recovery hints", () => {
  const cases = [
    [400, /request payload/i],
    [401, /DEEPSEEK_API_KEY/i],
    [402, /Recharge/i],
    [422, /model name/i],
    [500, /Retry later/i],
    [503, /backoff/i],
  ] as const;

  for (const [status, pattern] of cases) {
    const error = normalizeDeepSeekApiError({ status });
    assert.match(error.message, pattern);
  }
});
