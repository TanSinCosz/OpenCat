import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMessagesForQuery } from "../src/query/messages.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("buildMessagesForQuery drops orphan tool result after content-only snip strips tool calls", async () => {
  const assistant = createMessage({
    role: "assistant",
    content: "I will inspect the file first.",
    tool_calls: [
      {
        id: "call_read",
        type: "function",
        function: {
          name: "Read",
          arguments: "{\"file_path\":\"src/index.ts\"}",
        },
      },
    ],
  });
  const tool = createMessage({
    role: "tool",
    tool_call_id: "call_read",
    content: "file contents",
  });
  const state = createState({
    messages: [
      createMessage({ role: "user", content: "inspect" }),
      assistant,
      tool,
      createMessage({ role: "user", content: "continue" }),
    ],
    historySnips: [
      {
        id: "history_snip_test_content_only",
        removedMessageIds: [],
        contentOnlyMessageIds: [assistant.id],
        createdAtMessageId: tool.id,
        reason: "prompt_budget",
        createdAt: Date.now(),
      },
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

  const result = await buildMessagesForQuery(runtime, state);

  assert.equal(
    result.messages.some((message) => message.role === "tool"),
    false,
  );
  assert.equal(
    result.messages.some((message) =>
      message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0
    ),
    false,
  );
});

test("buildMessagesForQuery drops orphan tool result after snip removes tool-call assistant", async () => {
  const assistant = createMessage({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_grep",
        type: "function",
        function: {
          name: "Grep",
          arguments: "{\"pattern\":\"foo\"}",
        },
      },
    ],
  });
  const tool = createMessage({
    role: "tool",
    tool_call_id: "call_grep",
    content: "foo.ts:1:foo",
  });
  const state = createState({
    messages: [
      createMessage({ role: "user", content: "search" }),
      assistant,
      tool,
      createMessage({ role: "user", content: "continue" }),
    ],
    historySnips: [
      {
        id: "history_snip_test_removed_assistant",
        removedMessageIds: [assistant.id],
        createdAtMessageId: tool.id,
        reason: "prompt_budget",
        createdAt: Date.now(),
      },
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

  const result = await buildMessagesForQuery(runtime, state);

  assert.equal(
    result.messages.some((message) => message.role === "tool"),
    false,
  );
});

test("buildMessagesForQuery records durable snip boundaries after bulky compact misses target", async () => {
  const originalTargetTokens = process.env.OPENCAT_HISTORY_SNIP_TARGET_TOKENS;
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;
  const originalBulkyTargetTokens = process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS;
  const originalBulkyCompactTargetTokens =
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS;
  const originalKeepRecent = process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;

  try {
    process.env.OPENCAT_HISTORY_SNIP_TARGET_TOKENS = "800";
    process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES = "4";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS = "500";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS = "2000";
    process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT = "0";

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

    // The old tool round is eligible for durable removal after bulky compact
    // cannot reach the configured context target.
    const first = await buildMessagesForQuery(runtime, state);
    const removedIds = new Set(
      state.historySnips[0]?.removedMessageIds ?? [],
    );

    assert.equal(state.historySnips.length, 1);
    assert.ok(removedIds.has(state.Messages[1]!.id));
    assert.ok(removedIds.has(state.Messages[2]!.id));
    assert.doesNotMatch(JSON.stringify(first.messages), /large old tool result/);

    // Second call reuses the recorded boundary for stable request building.
    await buildMessagesForQuery(runtime, state);

    assert.equal(state.historySnips.length, 1);
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_TARGET_TOKENS", originalTargetTokens);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS", originalBulkyTargetTokens);
    restoreEnv(
      "OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS",
      originalBulkyCompactTargetTokens,
    );
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT", originalKeepRecent);
  }
});

test("buildMessagesForQuery does not mark snipped Read cache entries as partial views", async () => {
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;
  const cwd = await mkdtemp(join(tmpdir(), "opencat-snip-read-"));
  const filePath = join(cwd, "old.ts");

  try {
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
                arguments: JSON.stringify({ file_path: filePath }),
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
      cwd,
      deepSeekRuntimeConfig: {
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        maxTokens: 1024,
      },
      MemoryConfig: createMemoryConfig(),
      transcriptStore: false,
      tools: [],
    });
    runtime.toolUseContext.readFileState.set(filePath, {
      content: "old source",
      timestamp: 100,
      offset: 1,
      limit: undefined,
    });

    await buildMessagesForQuery(runtime, state);

    assert.equal(
      runtime.toolUseContext.readFileState.get(filePath)?.isPartialView,
      undefined,
    );
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
  }
});

test("buildMessagesForQuery persists snip boundaries after bulky compact misses target", async () => {
  const originalTargetTokens = process.env.OPENCAT_HISTORY_SNIP_TARGET_TOKENS;
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;
  const originalBulkyTargetTokens = process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS;
  const originalBulkyCompactTargetTokens =
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS;
  const originalKeepRecent = process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;

  try {
    // Use a target low enough that bulky compact alone cannot satisfy the
    // removal target. The snip is still recorded as a durable boundary so
    // subsequent turns keep the same prefix shape.
    process.env.OPENCAT_HISTORY_SNIP_TARGET_TOKENS = "500";
    process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES = "4";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS = "500";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS = "2000";
    process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT = "0";

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

    assert.equal(state.historySnips.length, 1);
    assert.doesNotMatch(
      JSON.stringify(first.messages),
      /large old tool result/,
    );

    const second = await buildMessagesForQuery(runtime, state);

    assert.equal(state.historySnips.length, 1);
    assert.doesNotMatch(
      JSON.stringify(second.messages),
      /large old tool result/,
    );
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_TARGET_TOKENS", originalTargetTokens);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS", originalBulkyTargetTokens);
    restoreEnv(
      "OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS",
      originalBulkyCompactTargetTokens,
    );
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT", originalKeepRecent);
  }
});


test("buildMessagesForQuery records durable snip boundaries for old attachment context", async () => {
  const originalTargetTokens = process.env.OPENCAT_HISTORY_SNIP_TARGET_TOKENS;
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;
  const originalBulkyTargetTokens = process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS;
  const originalBulkyCompactTargetTokens =
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS;
  const originalKeepRecent = process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;
  const attachmentSources = [
    "runtime",
    "long_term_memory",
    "file_restore",
    "dynamic_skill",
    "agent_notification",
    "agent_message",
  ] as const;

  try {
    process.env.OPENCAT_HISTORY_SNIP_TARGET_TOKENS = "800";
    process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES = "4";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS = "500";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS = "4000";
    process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT = "0";

    for (const source of attachmentSources) {
      const attachment = createMessage({
        role: "user",
        content: `${source} old attachment\n${"attachment ".repeat(1_200)}`,
      }, { source });
      const state = createState({
        messages: [
          createMessage({ role: "user", content: "old user request" }),
          attachment,
          createMessage({
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: `call_old_read_${source}`,
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
            tool_call_id: `call_old_read_${source}`,
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
      const removedIds = new Set(
        state.historySnips[0]?.removedMessageIds ?? [],
      );

      assert.equal(state.historySnips.length, 1, source);
      assert.ok(removedIds.has(attachment.id), source);
      assert.doesNotMatch(JSON.stringify(first.messages), /old attachment/);
    }
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_TARGET_TOKENS", originalTargetTokens);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS", originalBulkyTargetTokens);
    restoreEnv(
      "OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS",
      originalBulkyCompactTargetTokens,
    );
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT", originalKeepRecent);
  }
});

test("buildMessagesForQuery keeps old user and assistant text as content-only history", async () => {
  const originalTargetTokens = process.env.OPENCAT_HISTORY_SNIP_TARGET_TOKENS;
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;
  const originalBulkyTargetTokens = process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS;
  const originalBulkyCompactTargetTokens =
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS;
  const originalKeepRecent = process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;

  try {
    process.env.OPENCAT_HISTORY_SNIP_TARGET_TOKENS = "800";
    process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES = "5";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS = "500";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS = "1200";
    process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT = "0";

    const oldUser = createMessage({
      role: "user",
      content: "old user content that should remain visible",
    });
    const oldAssistant = createMessage({
      role: "assistant",
      content: "old assistant answer that should remain visible",
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
    });
    const oldTool = createMessage({
      role: "tool",
      tool_call_id: "call_old_read",
      content: "large old tool result\n" + "x".repeat(10_000),
    });
    const state = createState({
      messages: [
        oldUser,
        oldAssistant,
        oldTool,
        ...Array.from({ length: 5 }, (_, index) =>
          createMessage({
            role: "user",
            content: `recent user ${index}`,
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
    const serialized = JSON.stringify(first.messages);
    const projectedAssistant = first.messages.find((message) =>
      message.role === "assistant" &&
      message.content === oldAssistant.content
    );

    assert.equal(state.historySnips.length, 1);
    assert.deepEqual(
      state.historySnips[0]?.contentOnlyMessageIds,
      [oldAssistant.id],
    );
    assert.ok(state.historySnips[0]?.removedMessageIds.includes(oldTool.id));
    assert.match(serialized, /old user content that should remain visible/);
    assert.match(serialized, /old assistant answer that should remain visible/);
    assert.doesNotMatch(serialized, /large old tool result/);
    assert.equal(projectedAssistant?.role, "assistant");
    assert.equal("tool_calls" in (projectedAssistant ?? {}), false);

    await buildMessagesForQuery(runtime, state);

    assert.equal(state.historySnips.length, 1);
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_TARGET_TOKENS", originalTargetTokens);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS", originalBulkyTargetTokens);
    restoreEnv(
      "OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS",
      originalBulkyCompactTargetTokens,
    );
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT", originalKeepRecent);
  }
});

test("buildMessagesForQuery skips history snip when bulky compact reaches the target", async () => {
  const originalHistoryTargetTokens = process.env.OPENCAT_HISTORY_SNIP_TARGET_TOKENS;
  const originalBulkyTargetTokens = process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS;
  const originalBulkyCompactTargetTokens =
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS;
  const originalKeepRecent = process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;

  try {
    process.env.OPENCAT_HISTORY_SNIP_TARGET_TOKENS = "5000";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS = "500";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS = "5000";
    process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT = "0";

    const state = createState({
      messages: [
        createMessage({ role: "user", content: "old user request" }),
        createMessage({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_large_read",
              type: "function",
              function: {
                name: "Read",
                arguments: "{\"file_path\":\"large.ts\"}",
              },
            },
          ],
        }),
        createMessage({
          role: "tool",
          tool_call_id: "call_large_read",
          content: "large-read-head\n" + "x".repeat(30_000) + "\nlarge-read-tail",
        }),
        ...Array.from({ length: 5 }, (_, index) =>
          createMessage({
            role: "user",
            content: `recent user ${index}`,
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

    const result = await buildMessagesForQuery(runtime, state);
    const serialized = JSON.stringify(result.messages);

    assert.equal(state.historySnips.length, 0);
    assert.equal(result.stats.historySnipCount, 0);
    assert.ok(result.stats.bulkyToolCompactCount > 0);
    assert.match(serialized, /<tool-result-compact>/);
    assert.doesNotMatch(serialized, /x{5000}/);
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_TARGET_TOKENS", originalHistoryTargetTokens);
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS", originalBulkyTargetTokens);
    restoreEnv(
      "OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS",
      originalBulkyCompactTargetTokens,
    );
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT", originalKeepRecent);
  }
});

test("buildMessagesForQuery rolls back new bulky compactions when snip still exceeds cancel threshold", async () => {
  const originalHistoryTargetTokens = process.env.OPENCAT_HISTORY_SNIP_TARGET_TOKENS;
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;
  const originalBulkyTargetTokens = process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS;
  const originalBulkyCompactTargetTokens =
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS;
  const originalCancelTokens = process.env.OPENCAT_HISTORY_SNIP_CANCEL_CONTEXT_TOKENS;
  const originalKeepRecent = process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;

  try {
    process.env.OPENCAT_HISTORY_SNIP_TARGET_TOKENS = "80";
    process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES = "0";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS = "500";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS = "80";
    process.env.OPENCAT_HISTORY_SNIP_CANCEL_CONTEXT_TOKENS = "1";
    process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT = "0";

    const state = createState({
      messages: [
        createMessage({ role: "user", content: "old user request" }),
        createMessage({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_large_read_rollback",
              type: "function",
              function: {
                name: "Read",
                arguments: "{\"file_path\":\"large.ts\"}",
              },
            },
          ],
        }),
        createMessage({
          role: "tool",
          tool_call_id: "call_large_read_rollback",
          content: "large-read-head\n" + "x".repeat(30_000) + "\nlarge-read-tail",
        }),
        createMessage({ role: "user", content: "recent user request" }),
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

    const result = await buildMessagesForQuery(runtime, state);
    const hasCompactedToolResult = result.forkContextMessages.some((message) =>
      message.role === "tool" && message.content.includes("<tool-result-compact>")
    );

    assert.equal(state.historySnips.length, 0);
    assert.equal(result.stats.historySnipCount, 0);
    assert.equal(state.toolResultBudgetState.seenIds.size, 0);
    assert.equal(state.toolResultBudgetState.replacements.size, 0);
    assert.equal(hasCompactedToolResult, false);
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_TARGET_TOKENS", originalHistoryTargetTokens);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS", originalBulkyTargetTokens);
    restoreEnv(
      "OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS",
      originalBulkyCompactTargetTokens,
    );
    restoreEnv("OPENCAT_HISTORY_SNIP_CANCEL_CONTEXT_TOKENS", originalCancelTokens);
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT", originalKeepRecent);
  }
});

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


