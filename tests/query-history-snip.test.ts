import assert from "node:assert/strict";
import test from "node:test";
import type { DeepSeekMessage } from "../src/deepseek/types.js";
import {
  applyBulkyToolResultCompression,
  applyHistorySnip,
  applyToolResultBudget,
  buildMessagesForQuery,
} from "../src/query/messages.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("applyHistorySnip does not snip around the old 260k char threshold", () => {
  const originalHardChars = process.env.OPENCAT_HISTORY_SNIP_HARD_CHARS;

  try {
    delete process.env.OPENCAT_HISTORY_SNIP_HARD_CHARS;

    const messages = createMessages(30, 10_000);
    const projected = applyHistorySnip(messages);

    assert.equal(projected.length, messages.length);
    assert.equal(projected, messages);
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_HARD_CHARS", originalHardChars);
  }
});

test("applyHistorySnip still works as a hard fallback when explicitly configured", () => {
  const originalHardChars = process.env.OPENCAT_HISTORY_SNIP_HARD_CHARS;
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;

  try {
    process.env.OPENCAT_HISTORY_SNIP_HARD_CHARS = "1200";
    process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES = "3";

    const messages = createMessages(10, 500);
    const projected = applyHistorySnip(messages);

    assert.ok(projected.length < messages.length);
    assert.equal(projected[0]?.role, "system");
    assert.match(projected[1]?.content ?? "", /History snipped/);
    assert.ok(projected.length >= 5);
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_HARD_CHARS", originalHardChars);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
  }
});

test("buildMessagesForQuery records durable snip boundaries before hard snipping", async () => {
  const originalHardChars = process.env.OPENCAT_HISTORY_SNIP_HARD_CHARS;
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;

  try {
    process.env.OPENCAT_HISTORY_SNIP_HARD_CHARS = "14000";
    process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES = "4";

    const state = createState({
      messages: [
        createMessage({ role: "user", content: "old user request" }),
        createMessage({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_old_read",
              type: "function",
              function: {
                name: "Read",
                arguments: "{\"file_path\":\"old.ts\"}",
              },
            },
          ],
        }),
        createMessage({
          role: "tool",
          tool_call_id: "call_old_read",
          content: "large old tool result\n" + "x".repeat(12_000),
        }),
        ...Array.from({ length: 8 }, (_, index) =>
          createMessage({
            role: "user",
            content: `recent user ${index}\n${"recent ".repeat(80)}`,
          })
        ),
      ],
    });
    const runtime = createRuntime({
      deepSeekRuntimeConfig: {
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        maxTokens: 1024,
      },
      MemoryConfig: createMemoryConfig(),
      transcriptStore: false,
      tools: [],
    });

    // The old tool round is eligible for durable removal, so the decision is
    // recorded before the hard snip fallback runs.
    const first = await buildMessagesForQuery(runtime, state);
    const removedIds = new Set(
      state.historySnips[0]?.removedMessageIds ?? [],
    );

    assert.equal(state.historySnips.length, 1);
    assert.ok(removedIds.has(state.Messages[1]!.id));
    assert.ok(removedIds.has(state.Messages[2]!.id));
    assert.doesNotMatch(JSON.stringify(first.messages), /large old tool result/);

    // Second call reuses the recorded boundary for stable prompt projection.
    await buildMessagesForQuery(runtime, state);

    assert.equal(state.historySnips.length, 1);
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_HARD_CHARS", originalHardChars);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
  }
});

test("buildMessagesForQuery falls back to hard snip when durable candidates are insufficient", async () => {
  const originalHardChars = process.env.OPENCAT_HISTORY_SNIP_HARD_CHARS;
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;

  try {
    // Use a threshold low enough that the old tool round alone cannot satisfy
    // the removal target, so no durable boundary is recorded and hard snip is
    // left as the fallback.
    process.env.OPENCAT_HISTORY_SNIP_HARD_CHARS = "3800";
    process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES = "4";

    const state = createState({
      messages: [
        createMessage({ role: "user", content: "old user request" }),
        createMessage({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_old_read",
              type: "function",
              function: {
                name: "Read",
                arguments: "{\"file_path\":\"old.ts\"}",
              },
            },
          ],
        }),
        createMessage({
          role: "tool",
          tool_call_id: "call_old_read",
          content: "large old tool result\n" + "x".repeat(12_000),
        }),
        ...Array.from({ length: 8 }, (_, index) =>
          createMessage({
            role: "user",
            content: `recent user ${index}\n${"recent ".repeat(80)}`,
          })
        ),
      ],
    });
    const runtime = createRuntime({
      deepSeekRuntimeConfig: {
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        maxTokens: 1024,
      },
      MemoryConfig: createMemoryConfig(),
      transcriptStore: false,
      tools: [],
    });

    const first = await buildMessagesForQuery(runtime, state);

    assert.equal(state.historySnips.length, 0);
    assert.doesNotMatch(
      JSON.stringify(first.messages),
      /large old tool result/,
    );

    const second = await buildMessagesForQuery(runtime, state);

    assert.equal(state.historySnips.length, 0);
    assert.doesNotMatch(
      JSON.stringify(second.messages),
      /large old tool result/,
    );
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_HARD_CHARS", originalHardChars);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
  }
});


test("buildMessagesForQuery records durable snip boundaries for old attachment context", async () => {
  const originalHardChars = process.env.OPENCAT_HISTORY_SNIP_HARD_CHARS;
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;
  const attachmentSources = [
    "runtime",
    "long_term_memory",
    "file_restore",
    "dynamic_skill",
    "agent_notification",
    "agent_message",
  ] as const;

  try {
    process.env.OPENCAT_HISTORY_SNIP_HARD_CHARS = "14000";
    process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES = "4";

    for (const source of attachmentSources) {
      const attachment = createMessage({
        role: "user",
        content: `${source} old attachment\n${"attachment ".repeat(1_200)}`,
      }, { source });
      const state = createState({
        messages: [
          createMessage({ role: "user", content: "old user request" }),
          attachment,
          ...Array.from({ length: 8 }, (_, index) =>
            createMessage({
              role: "user",
              content: `recent user ${index}\n${"recent ".repeat(80)}`,
            })
          ),
        ],
      });
      const runtime = createRuntime({
        deepSeekRuntimeConfig: {
          apiKey: "test-key",
          model: "deepseek-v4-flash",
          maxTokens: 1024,
        },
        MemoryConfig: createMemoryConfig(),
        transcriptStore: false,
        tools: [],
      });

      const first = await buildMessagesForQuery(runtime, state);
      const removedIds = new Set(
        state.historySnips[0]?.removedMessageIds ?? [],
      );

      assert.equal(state.historySnips.length, 1, source);
      assert.ok(removedIds.has(attachment.id), source);
      assert.doesNotMatch(JSON.stringify(first.messages), /old attachment/);
    }
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_HARD_CHARS", originalHardChars);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
  }
});

test("applyBulkyToolResultCompression compacts large read-like tool outputs", () => {
  const originalThreshold = process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CHARS;

  try {
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CHARS = "2000";
    const runtime = createRuntime({
      deepSeekRuntimeConfig: {
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        maxTokens: 1024,
      },
      MemoryConfig: createMemoryConfig(),
      transcriptStore: false,
      tools: [
        {
          name: "Read",
          inputSchema: {} as never,
          outputSchema: {} as never,
          description: () => "",
          prompt: () => "",
          call: () => "",
          renderResult: ({ content, maxChars }) =>
            `<read-renderer-preview>${content.slice(0, maxChars / 4)}</read-renderer-preview>`,
        },
      ],
    });
    const messages = [
      createMessage({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_read",
            type: "function",
            function: { name: "Read", arguments: "{}" },
          },
          {
            id: "call_other",
            type: "function",
            function: { name: "Other", arguments: "{}" },
          },
        ],
      }),
      createMessage({
        role: "tool",
        tool_call_id: "call_read",
        content: "read-head\n" + "r".repeat(8_000) + "\nread-tail",
      }),
      createMessage({
        role: "tool",
        tool_call_id: "call_other",
        content: "other-head\n" + "o".repeat(8_000) + "\nother-tail",
      }),
    ];

    const projected = applyBulkyToolResultCompression(messages, runtime);
    const readResult = projected[1];
    const otherResult = projected[2];

    assert.equal(readResult?.role, "tool");
    assert.equal(otherResult?.role, "tool");
    assert.match(readResult.content, /<tool-result-compact>/);
    assert.match(readResult.content, /Tool result from Read was compacted/);
    assert.match(readResult.content, /<read-renderer-preview>read-head/);
    assert.doesNotMatch(readResult.content, /read-tail/);
    assert.doesNotMatch(readResult.content, /r{5000}/);
    assert.match(otherResult.content, /o{5000}/);

    const secondProjection = applyBulkyToolResultCompression(messages, runtime);
    assert.equal(secondProjection[1]?.role, "tool");
    assert.equal(readResult.content, secondProjection[1].content);
  } finally {
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_COMPACT_CHARS", originalThreshold);
  }
});

test("applyToolResultBudget replaces oversized fresh results with persisted references", () => {
  const runtime = createRuntime({
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
    tools: [],
  });
  const hugePersistedContent = [
    "Tool result from Read was 240000 bytes and was persisted to disk because it is too large to inline in the conversation transcript.",
    "Full output path: .opencat/tool-results/session_x/read-output.txt",
    "SHA-256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "",
    "<tool_result_preview>",
    "SECRET_PREVIEW_SHOULD_NOT_SURVIVE",
    "x".repeat(120_000),
    "</tool_result_preview>",
  ].join("\n");
  const messages = [
    createMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_read",
          type: "function",
          function: { name: "Read", arguments: "{}" },
        },
        {
          id: "call_grep",
          type: "function",
          function: { name: "Grep", arguments: "{}" },
        },
      ],
    }),
    createMessage({
      role: "tool",
      tool_call_id: "call_read",
      content: hugePersistedContent,
    }),
    createMessage({
      role: "tool",
      tool_call_id: "call_grep",
      content: "y".repeat(100_000),
    }),
  ];

  const projected = applyToolResultBudget(messages, runtime);
  const readResult = projected.find((message) =>
    message.role === "tool" && message.tool_call_id === "call_read"
  );

  assert.ok(readResult);
  assert.equal(readResult.role, "tool");
  assert.match(readResult.content, /<tool-result-budget>/);
  assert.match(
    readResult.content,
    /Full result path: \.opencat\/tool-results\/session_x\/read-output\.txt/,
  );
  assert.match(
    readResult.content,
    /sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/,
  );
  assert.doesNotMatch(readResult.content, /SECRET_PREVIEW_SHOULD_NOT_SURVIVE/);
});

test("applyToolResultBudget includes tools without finite result caps", () => {
  const runtime = createRuntime({
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
    tools: [
      {
        name: "Read",
        inputSchema: {} as never,
        outputSchema: {} as never,
        maxResultSizeChars: Infinity,
        description: () => "",
        prompt: () => "",
        call: () => "",
      },
    ],
  });
  const messages = [
    createMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_read",
          type: "function",
          function: { name: "Read", arguments: "{}" },
        },
        {
          id: "call_other",
          type: "function",
          function: { name: "Other", arguments: "{}" },
        },
      ],
    }),
    createMessage({
      role: "tool",
      tool_call_id: "call_read",
      content: "read-result\n" + "r".repeat(150_000),
    }),
    createMessage({
      role: "tool",
      tool_call_id: "call_other",
      content: "other-result\n" + "o".repeat(100_000),
    }),
  ];

  const projected = applyToolResultBudget(messages, runtime);
  const readResult = projected.find((message) =>
    message.role === "tool" && message.tool_call_id === "call_read"
  );

  assert.ok(readResult);
  assert.equal(readResult.role, "tool");
  assert.match(readResult.content, /<tool-result-budget>/);
});

test("applyToolResultBudget keys decisions by local tool message id", () => {
  const runtime = createRuntime({
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
    tools: [],
  });
  const messages = [
    createMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_reused",
          type: "function",
          function: { name: "Read", arguments: "{\"file_path\":\"a.ts\"}" },
        },
      ],
    }),
    createMessage({
      role: "tool",
      tool_call_id: "call_reused",
      content: "large-result\n" + "a".repeat(240_000),
    }),
    createMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_reused",
          type: "function",
          function: { name: "Read", arguments: "{\"file_path\":\"b.ts\"}" },
        },
      ],
    }),
    createMessage({
      role: "tool",
      tool_call_id: "call_reused",
      content: "small-result",
    }),
  ];

  const projected = applyToolResultBudget(messages, runtime);
  const firstToolResult = projected[1];
  const secondToolResult = projected[3];

  assert.equal(firstToolResult?.role, "tool");
  assert.equal(secondToolResult?.role, "tool");
  assert.match(firstToolResult.content, /<tool-result-budget>/);
  assert.equal(secondToolResult.content, "small-result");
});

function createMessages(count: number, charsPerMessage: number): DeepSeekMessage[] {
  return [
    {
      role: "system",
      content: "stable system prompt",
    },
    ...Array.from({ length: count }, (_, index) => ({
      role: "user" as const,
      content: `message ${index}\n${"x".repeat(charsPerMessage)}`,
    })),
  ];
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function createMemoryConfig() {
  return {
    embedder: {
      provider: "test",
      config: {},
    },
    vectorStore: {
      provider: "test",
      config: {},
    },
    llm: {
      provider: "test",
      config: {},
    },
  };
}
