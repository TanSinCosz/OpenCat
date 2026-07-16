import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compactBulkyToolResults,
  budgetToolResults,
  buildMessagesForQuery,
} from "../src/query/messages.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

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

test("compactBulkyToolResults compacts older read-like outputs under context pressure", () => {
  const originalThreshold = process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS;
  const originalCompactTarget =
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS;
  const originalKeepRecent = process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;

  try {
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS = "3000";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS = "3000";
    process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT = "1";
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
        },
      ],
    });
    const messages = [
      createMessage({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_old_read",
            type: "function",
            function: { name: "Read", arguments: "{}" },
          },
          {
            id: "call_recent_read",
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
        tool_call_id: "call_old_read",
        content: "old-read-head\n" + "r".repeat(8_000) + "\nold-read-tail",
      }),
      createMessage({
        role: "tool",
        tool_call_id: "call_recent_read",
        content: "recent-read-head\n" + "n".repeat(8_000) + "\nrecent-read-tail",
      }),
      createMessage({
        role: "tool",
        tool_call_id: "call_other",
        content: "other-head\n" + "o".repeat(8_000) + "\nother-tail",
      }),
    ];

    const compacted = compactBulkyToolResults(messages, runtime);
    const oldReadResult = compacted[1];
    const recentReadResult = compacted[2];
    const otherResult = compacted[3];

    assert.equal(oldReadResult?.role, "tool");
    assert.equal(recentReadResult?.role, "tool");
    assert.equal(otherResult?.role, "tool");
    assert.match(oldReadResult.content, /<tool-result-compact>/);
    assert.match(oldReadResult.content, /Tool result from Read was compacted/);
    assert.match(oldReadResult.content, /<preview_head>\nold-read-head/);
    assert.match(oldReadResult.content, /<preview_tail>/);
    assert.match(oldReadResult.content, /old-read-tail/);
    assert.doesNotMatch(oldReadResult.content, /r{5000}/);
    assert.match(recentReadResult.content, /recent-read-tail/);
    assert.match(recentReadResult.content, /n{5000}/);
    assert.match(otherResult.content, /o{5000}/);

    const secondCompacted = compactBulkyToolResults(messages, runtime);
    assert.equal(secondCompacted[1]?.role, "tool");
    assert.equal(oldReadResult.content, secondCompacted[1].content);
  } finally {
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS", originalThreshold);
    restoreEnv(
      "OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS",
      originalCompactTarget,
    );
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT", originalKeepRecent);
  }
});

test("compactBulkyToolResults does not mark compacted Read cache entries as partial views", async () => {
  const originalThreshold = process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS;
  const originalCompactTarget =
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS;
  const originalKeepRecent = process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;
  const cwd = await mkdtemp(join(tmpdir(), "opencat-partial-read-"));
  const oldFilePath = join(cwd, "old.ts");
  const recentFilePath = join(cwd, "recent.ts");

  try {
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS = "3000";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS = "3000";
    process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT = "1";
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
    runtime.toolUseContext.readFileState.set(oldFilePath, {
      content: "old source",
      timestamp: 100,
      offset: 1,
      limit: undefined,
    });
    runtime.toolUseContext.readFileState.set(recentFilePath, {
      content: "recent source",
      timestamp: 101,
      offset: 1,
      limit: undefined,
    });

    const messages = [
      createMessage({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_old_read",
            type: "function",
            function: {
              name: "Read",
              arguments: JSON.stringify({ file_path: oldFilePath }),
            },
          },
          {
            id: "call_recent_read",
            type: "function",
            function: {
              name: "Read",
              arguments: JSON.stringify({ file_path: recentFilePath }),
            },
          },
        ],
      }),
      createMessage({
        role: "tool",
        tool_call_id: "call_old_read",
        content: "old-read-head\n" + "r".repeat(8_000) + "\nold-read-tail",
      }),
      createMessage({
        role: "tool",
        tool_call_id: "call_recent_read",
        content: "recent-read-head\n" + "n".repeat(8_000) + "\nrecent-read-tail",
      }),
    ];

    compactBulkyToolResults(messages, runtime);

    assert.equal(
      runtime.toolUseContext.readFileState.get(oldFilePath)?.isPartialView,
      undefined,
    );
    assert.equal(
      runtime.toolUseContext.readFileState.get(recentFilePath)?.isPartialView,
      undefined,
    );
  } finally {
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS", originalThreshold);
    restoreEnv(
      "OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS",
      originalCompactTarget,
    );
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT", originalKeepRecent);
  }
});

test("compactBulkyToolResults compacts read-like outputs under context pressure", () => {
  const originalThreshold = process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS;
  const originalCompactTarget =
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS;
  const originalKeepRecent = process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;

  try {
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS = "2500";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS = "2500";
    process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT = "1";
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
        },
      ],
    });
    const messages = [
      createMessage({
        role: "user",
        content: "context-pressure\n" + "u".repeat(12_000),
      }),
      createMessage({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_context_old_read",
            type: "function",
            function: { name: "Read", arguments: "{}" },
          },
          {
            id: "call_context_recent_read",
            type: "function",
            function: { name: "Read", arguments: "{}" },
          },
        ],
      }),
      createMessage({
        role: "tool",
        tool_call_id: "call_context_old_read",
        content: "old-read-head\n" + "r".repeat(8_000) + "\nold-read-tail",
      }),
      createMessage({
        role: "tool",
        tool_call_id: "call_context_recent_read",
        content: "recent-read-head\n" + "n".repeat(8_000) + "\nrecent-read-tail",
      }),
    ];

    const compacted = compactBulkyToolResults(messages, runtime);
    const oldReadResult = compacted[2];
    const recentReadResult = compacted[3];

    assert.equal(oldReadResult?.role, "tool");
    assert.equal(recentReadResult?.role, "tool");
    assert.match(oldReadResult.content, /<tool-result-compact>/);
    assert.match(oldReadResult.content, /Tool result from Read was compacted/);
    assert.match(recentReadResult.content, /recent-read-tail/);
  } finally {
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS", originalThreshold);
    restoreEnv(
      "OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS",
      originalCompactTarget,
    );
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT", originalKeepRecent);
  }
});

test("compactBulkyToolResults defaults to recent-tail protection under context pressure", () => {
  const originalThreshold = process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS;
  const originalCompactTarget =
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS;
  const originalKeepRecent = process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;
  const originalTailTarget = process.env.OPENCAT_PROJECTION_RECENT_TAIL_TARGET_TOKENS;
  const originalTailMax = process.env.OPENCAT_PROJECTION_RECENT_TAIL_MAX_TOKENS;
  const originalTailMinApi =
    process.env.OPENCAT_PROJECTION_RECENT_TAIL_MIN_API_MESSAGES;
  const originalTailMinUserContent =
    process.env.OPENCAT_PROJECTION_RECENT_TAIL_MIN_USER_CONTENT_MESSAGES;
  const originalTailMinText =
    process.env.OPENCAT_PROJECTION_RECENT_TAIL_MIN_TEXT_MESSAGES;

  try {
    delete process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS;
    delete process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS;
    delete process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;
    delete process.env.OPENCAT_PROJECTION_RECENT_TAIL_TARGET_TOKENS;
    delete process.env.OPENCAT_PROJECTION_RECENT_TAIL_MAX_TOKENS;
    delete process.env.OPENCAT_PROJECTION_RECENT_TAIL_MIN_API_MESSAGES;
    delete process.env.OPENCAT_PROJECTION_RECENT_TAIL_MIN_USER_CONTENT_MESSAGES;
    delete process.env.OPENCAT_PROJECTION_RECENT_TAIL_MIN_TEXT_MESSAGES;
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
        },
      ],
    });
    const messages = [
      createMessage({
        role: "user",
        content: "context-pressure\n" + "u".repeat(510_000),
      }),
      createMessage({
        role: "assistant",
        content: "",
        tool_calls: Array.from({ length: 9 }, (_, index) => ({
          id: `call_default_read_${index}`,
          type: "function" as const,
          function: { name: "Read", arguments: "{}" },
        })),
      }),
      ...Array.from({ length: 9 }, (_, index) =>
        createMessage({
          role: "tool" as const,
          tool_call_id: `call_default_read_${index}`,
          content: `read-${index}-head\n${"r".repeat(20_000)}\nread-${index}-tail`,
        })
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        createMessage({
          role: "user" as const,
          content: `recent text ${index}`,
        })
      ),
    ];

    const compacted = compactBulkyToolResults(messages, runtime);
    const oldReadResult = compacted[2];
    const protectedReadResult = compacted[4];

    assert.equal(oldReadResult?.role, "tool");
    assert.equal(protectedReadResult?.role, "tool");
    assert.match(oldReadResult.content, /<tool-result-compact>/);
    assert.match(protectedReadResult.content, /read-2-tail/);
  } finally {
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS", originalThreshold);
    restoreEnv(
      "OPENCAT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS",
      originalCompactTarget,
    );
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT", originalKeepRecent);
    restoreEnv("OPENCAT_PROJECTION_RECENT_TAIL_TARGET_TOKENS", originalTailTarget);
    restoreEnv("OPENCAT_PROJECTION_RECENT_TAIL_MAX_TOKENS", originalTailMax);
    restoreEnv(
      "OPENCAT_PROJECTION_RECENT_TAIL_MIN_API_MESSAGES",
      originalTailMinApi,
    );
    restoreEnv(
      "OPENCAT_PROJECTION_RECENT_TAIL_MIN_USER_CONTENT_MESSAGES",
      originalTailMinUserContent,
    );
    restoreEnv(
      "OPENCAT_PROJECTION_RECENT_TAIL_MIN_TEXT_MESSAGES",
      originalTailMinText,
    );
  }
});

test("budgetToolResults persists oversized fresh results selected by group budget", async () => {
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-budget-tool-result-")),
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    MemoryConfig: createMemoryConfig(),
    transcriptStore: false,
    tools: [],
  });
  const readContent = [
    "read-result-head",
    "x".repeat(220_000),
    "read-result-tail",
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
      content: readContent,
    }),
    createMessage({
      role: "tool",
      tool_call_id: "call_grep",
      content: "y".repeat(100_000),
    }),
  ];

  const budgeted = await budgetToolResults(messages, runtime);
  const readResult = budgeted.find((message) =>
    message.role === "tool" && message.tool_call_id === "call_read"
  );

  assert.ok(readResult);
  assert.equal(readResult.role, "tool");
  assert.match(readResult.content, /Full output path:/);
  assert.match(readResult.content, /<tool_result_preview>/);
  assert.doesNotMatch(readResult.content, /read-result-tail/);

  const fullOutputPath = readResult.content.match(/^Full output path:\s*(.+)$/m)
    ?.[1];
  assert.ok(fullOutputPath);
  const fullOutput = await readFile(join(runtime.cwd, fullOutputPath), "utf8");
  assert.equal(fullOutput, readContent);
});

test("budgetToolResults leaves under-budget tool results inline", async () => {
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-budget-inline-")),
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
          id: "call_small",
          type: "function",
          function: { name: "Grep", arguments: "{}" },
        },
      ],
    }),
    createMessage({
      role: "tool",
      tool_call_id: "call_small",
      content: "small-result\n" + "s".repeat(60_000),
    }),
  ];

  const budgeted = await budgetToolResults(messages, runtime);
  const result = budgeted.find((message) =>
    message.role === "tool" && message.tool_call_id === "call_small"
  );

  assert.ok(result);
  assert.equal(result.role, "tool");
  assert.match(result.content, /small-result/);
  assert.doesNotMatch(result.content, /Full output path:/);
});

test("budgetToolResults skips tools without finite result caps", async () => {
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

  const budgeted = await budgetToolResults(messages, runtime);
  const readResult = budgeted.find((message) =>
    message.role === "tool" && message.tool_call_id === "call_read"
  );

  assert.ok(readResult);
  assert.equal(readResult.role, "tool");
  assert.match(readResult.content, /read-result/);
  assert.doesNotMatch(readResult.content, /<tool-result-budget>/);

  const otherResult = budgeted.find((message) =>
    message.role === "tool" && message.tool_call_id === "call_other"
  );
  assert.ok(otherResult);
  assert.equal(otherResult.role, "tool");
  assert.doesNotMatch(otherResult.content, /<tool-result-budget>/);
});

test("budgetToolResults keys decisions by local tool message id", async () => {
  const runtime = createRuntime({
    cwd: await mkdtemp(join(tmpdir(), "opencat-budget-local-id-")),
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

  const budgeted = await budgetToolResults(messages, runtime);
  const firstToolResult = budgeted[1];
  const secondToolResult = budgeted[3];

  assert.equal(firstToolResult?.role, "tool");
  assert.equal(secondToolResult?.role, "tool");
  assert.match(firstToolResult.content, /Full output path:/);
  assert.equal(secondToolResult.content, "small-result");
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


