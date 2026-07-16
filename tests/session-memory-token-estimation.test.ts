import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateMessageTokens,
  shouldUpdateSessionMemory,
} from "../src/session-memory/session-memory.js";
import { createMessage } from "../src/types/messages.js";
import {
  DEFAULT_SESSION_MEMORY_CONFIG,
} from "../src/types/session-memory.js";
import { createState } from "../src/types/state.js";

function createUsage(promptTokens: number, completionTokens = 0) {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

test("session-memory token estimate anchors on the latest API context usage", () => {
  const assistant = createMessage(
    { role: "assistant", content: "completed response" },
    { usage: createUsage(10_000, 400) },
  );
  const newestUserMessage = createMessage({
    role: "user",
    content: "new context after the previous API response",
  });

  const expected = 10_400 + newestUserMessage.size!.estimatedTokens;

  assert.equal(
    estimateMessageTokens([assistant, newestUserMessage]),
    expected,
  );
});

test("session-memory token estimate prefers a continuation context snapshot", () => {
  const assistant = createMessage(
    { role: "assistant", content: "merged continuation response" },
    {
      // This represents aggregate billable usage across continuation attempts.
      usage: createUsage(50_000, 20_000),
      contextTokenCount: 12_000,
    },
  );
  const tool = createMessage({
    role: "tool",
    tool_call_id: "call_1",
    content: "tool result appended after the request",
  });

  const expected = 12_000 + tool.size!.estimatedTokens;

  assert.equal(estimateMessageTokens([assistant, tool]), expected);
});

test("session memory defaults and thresholds match the official update cadence", () => {
  assert.equal(DEFAULT_SESSION_MEMORY_CONFIG.minimumMessageTokensToInit, 10_000);
  assert.equal(DEFAULT_SESSION_MEMORY_CONFIG.minimumTokensBetweenUpdate, 5_000);
  assert.equal(DEFAULT_SESSION_MEMORY_CONFIG.toolCallsBetweenUpdates, 3);

  const state = createState({
    messages: [
      createMessage(
        { role: "assistant", content: "below first extraction threshold" },
        { usage: createUsage(9_999) },
      ),
    ],
  });
  assert.deepEqual(shouldUpdateSessionMemory(state), {
    update: false,
    reason: "below_initialization_threshold",
  });

  state.Messages = [
    createMessage(
      { role: "assistant", content: "first extraction threshold reached" },
      { usage: createUsage(10_000) },
    ),
  ];
  assert.deepEqual(shouldUpdateSessionMemory(state), { update: true });

  state.sessionMemory.initialized = true;
  state.sessionMemory.tokensAtLastExtraction = 10_000;
  state.Messages = [
    createMessage(
      { role: "assistant", content: "not enough new context" },
      { usage: createUsage(14_999) },
    ),
  ];
  assert.deepEqual(shouldUpdateSessionMemory(state), {
    update: false,
    reason: "below_update_threshold",
  });

  state.Messages = [
    createMessage(
      { role: "assistant", content: "update threshold reached" },
      { usage: createUsage(15_000) },
    ),
  ];
  assert.deepEqual(shouldUpdateSessionMemory(state), { update: true });
});

test("session memory can update after enough tool calls accumulate", () => {
  const assistant = createMessage(
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "Read", arguments: "{}" },
        },
        {
          id: "call_2",
          type: "function",
          function: { name: "Grep", arguments: "{}" },
        },
        {
          id: "call_3",
          type: "function",
          function: { name: "Bash", arguments: "{}" },
        },
      ],
    },
    { usage: createUsage(15_000) },
  );
  const state = createState({
    messages: [
      assistant,
      createMessage({
        role: "tool",
        tool_call_id: "call_1",
        content: "read result",
      }),
      createMessage({
        role: "tool",
        tool_call_id: "call_2",
        content: "grep result",
      }),
      createMessage({
        role: "tool",
        tool_call_id: "call_3",
        content: "bash result",
      }),
    ],
  });
  state.sessionMemory.initialized = true;
  state.sessionMemory.tokensAtLastExtraction = 10_000;

  assert.deepEqual(shouldUpdateSessionMemory(state), { update: true });
});
