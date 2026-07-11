import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compactBulkyToolResults,
  enforceHistoryLimit,
  budgetToolResults,
  buildMessagesForQuery,
} from "../src/query/messages.js";
import { createMessage, type Message } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("enforceHistoryLimit does not snip around the old 260k char threshold", () => {
  const originalHardTokens = process.env.OPENCAT_HISTORY_SNIP_HARD_TOKENS;

  try {
    delete process.env.OPENCAT_HISTORY_SNIP_HARD_TOKENS;

    const messages = createMessages(30, 10_000);
    const limited = enforceHistoryLimit(messages);

    assert.equal(limited.length, messages.length);
    assert.equal(limited, messages);
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_HARD_TOKENS", originalHardTokens);
  }
});

test("enforceHistoryLimit still works as a hard fallback when explicitly configured", () => {
  const originalHardTokens = process.env.OPENCAT_HISTORY_SNIP_HARD_TOKENS;
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;

  try {
    process.env.OPENCAT_HISTORY_SNIP_HARD_TOKENS = "300";
    process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES = "3";

    const messages = createMessages(10, 500);
    const limited = enforceHistoryLimit(messages);

    assert.ok(limited.length < messages.length);
    assert.equal(limited[0]?.role, "system");
    assert.match(limited[1]?.content ?? "", /History snipped/);
    assert.ok(limited.length >= 5);
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_HARD_TOKENS", originalHardTokens);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
  }
});

test("buildMessagesForQuery records durable snip boundaries before hard snipping", async () => {
  const originalHardTokens = process.env.OPENCAT_HISTORY_SNIP_HARD_TOKENS;
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;

  try {
    process.env.OPENCAT_HISTORY_SNIP_HARD_TOKENS = "3500";
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

    // Second call reuses the recorded boundary for stable request building.
    await buildMessagesForQuery(runtime, state);

    assert.equal(state.historySnips.length, 1);
  } finally {
    restoreEnv("OPENCAT_HISTORY_SNIP_HARD_TOKENS", originalHardTokens);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
  }
});

test("buildMessagesForQuery does not mark snipped Read cache entries as partial views", async () => {
  const originalHardTokens = process.env.OPENCAT_HISTORY_SNIP_HARD_TOKENS;
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;
  const cwd = await mkdtemp(join(tmpdir(), "opencat-snip-read-"));
  const filePath = join(cwd, "old.ts");

  try {
    process.env.OPENCAT_HISTORY_SNIP_HARD_TOKENS = "3500";
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
    restoreEnv("OPENCAT_HISTORY_SNIP_HARD_TOKENS", originalHardTokens);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
  }
});

test("buildMessagesForQuery persists hard snip fallback boundaries", async () => {
  const originalHardTokens = process.env.OPENCAT_HISTORY_SNIP_HARD_TOKENS;
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;

  try {
    // Use a threshold low enough that selective candidates cannot satisfy the
    // removal target. The hard fallback is still recorded as a durable boundary
    // so subsequent turns keep the same prefix shape.
    process.env.OPENCAT_HISTORY_SNIP_HARD_TOKENS = "950";
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
    restoreEnv("OPENCAT_HISTORY_SNIP_HARD_TOKENS", originalHardTokens);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
  }
});


test("buildMessagesForQuery records durable snip boundaries for old attachment context", async () => {
  const originalHardTokens = process.env.OPENCAT_HISTORY_SNIP_HARD_TOKENS;
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
    process.env.OPENCAT_HISTORY_SNIP_HARD_TOKENS = "3500";
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
    restoreEnv("OPENCAT_HISTORY_SNIP_HARD_TOKENS", originalHardTokens);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
  }
});

test("buildMessagesForQuery keeps old user and assistant text as content-only history", async () => {
  const originalHardTokens = process.env.OPENCAT_HISTORY_SNIP_HARD_TOKENS;
  const originalTargetTokens = process.env.OPENCAT_HISTORY_SNIP_TARGET_TOKENS;
  const originalMinRecent = process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES;

  try {
    process.env.OPENCAT_HISTORY_SNIP_HARD_TOKENS = "1500";
    process.env.OPENCAT_HISTORY_SNIP_TARGET_TOKENS = "800";
    process.env.OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES = "5";

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
    restoreEnv("OPENCAT_HISTORY_SNIP_HARD_TOKENS", originalHardTokens);
    restoreEnv("OPENCAT_HISTORY_SNIP_TARGET_TOKENS", originalTargetTokens);
    restoreEnv("OPENCAT_HISTORY_SNIP_MIN_RECENT_MESSAGES", originalMinRecent);
  }
});

test("compactBulkyToolResults compacts older read-like outputs when the target pool is oversized", () => {
  const originalThreshold = process.env.OPENCAT_BULKY_TOOL_RESULT_TARGET_TOKENS;
  const originalKeepRecent = process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;

  try {
    process.env.OPENCAT_BULKY_TOOL_RESULT_TARGET_TOKENS = "3000";
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
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_TARGET_TOKENS", originalThreshold);
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT", originalKeepRecent);
  }
});

test("compactBulkyToolResults does not mark compacted Read cache entries as partial views", async () => {
  const originalThreshold = process.env.OPENCAT_BULKY_TOOL_RESULT_TARGET_TOKENS;
  const originalKeepRecent = process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;
  const cwd = await mkdtemp(join(tmpdir(), "opencat-partial-read-"));
  const oldFilePath = join(cwd, "old.ts");
  const recentFilePath = join(cwd, "recent.ts");

  try {
    process.env.OPENCAT_BULKY_TOOL_RESULT_TARGET_TOKENS = "3000";
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
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_TARGET_TOKENS", originalThreshold);
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT", originalKeepRecent);
  }
});

test("compactBulkyToolResults compacts read-like outputs under context pressure", () => {
  const originalThreshold = process.env.OPENCAT_BULKY_TOOL_RESULT_TARGET_TOKENS;
  const originalContextThreshold =
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS;
  const originalKeepRecent = process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;

  try {
    process.env.OPENCAT_BULKY_TOOL_RESULT_TARGET_TOKENS = "12500";
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS = "2500";
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
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_TARGET_TOKENS", originalThreshold);
    restoreEnv(
      "OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS",
      originalContextThreshold,
    );
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT", originalKeepRecent);
  }
});

test("compactBulkyToolResults defaults to context-pressure compact with five recent results kept", () => {
  const originalThreshold = process.env.OPENCAT_BULKY_TOOL_RESULT_TARGET_TOKENS;
  const originalContextThreshold =
    process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS;
  const originalKeepRecent = process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;

  try {
    delete process.env.OPENCAT_BULKY_TOOL_RESULT_TARGET_TOKENS;
    delete process.env.OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS;
    delete process.env.OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT;
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
          content: `read-${index}-head\n${"r".repeat(8_000)}\nread-${index}-tail`,
        })
      ),
    ];

    const compacted = compactBulkyToolResults(messages, runtime);
    const oldReadResult = compacted[2];
    const firstProtectedReadResult = compacted[6];

    assert.equal(oldReadResult?.role, "tool");
    assert.equal(firstProtectedReadResult?.role, "tool");
    assert.match(oldReadResult.content, /<tool-result-compact>/);
    assert.match(firstProtectedReadResult.content, /read-4-tail/);
  } finally {
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_TARGET_TOKENS", originalThreshold);
    restoreEnv(
      "OPENCAT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS",
      originalContextThreshold,
    );
    restoreEnv("OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT", originalKeepRecent);
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

function createMessages(count: number, charsPerMessage: number): Message[] {
  return [
    createMessage({
      role: "system",
      content: "stable system prompt",
    }),
    ...Array.from({ length: count }, (_, index) =>
      createMessage({
        role: "user" as const,
        content: `message ${index}\n${"x".repeat(charsPerMessage)}`,
      })
    ),
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
