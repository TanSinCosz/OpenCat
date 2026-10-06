import { createYamlConfigValues } from "./yaml-config-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMessagesForQuery } from "../src/query/messages.js";
import { createMessage } from "../src/types/messages.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

const configValues = createYamlConfigValues();

test("no-projection benchmark leaves persisted projection state unapplied", async () => {
  const oldMessage = createMessage({
    role: "user",
    content: "old context that should remain visible in the baseline",
  });
  const latestMessage = createMessage({
    role: "user",
    content: "continue the benchmark",
  });
  const state = createState({
    messages: [oldMessage, latestMessage],
    historySnips: [{
      id: "history_snip_benchmark_state",
      removedMessageIds: [oldMessage.id],
      contentOnlyMessageIds: [],
      createdAtMessageId: latestMessage.id,
      reason: "prompt_budget",
      createdAt: Date.now(),
    }],
  });
  const runtime = createRuntime({
    modelRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    contextCompressionConfig: { enableProjection: false },
    transcriptStore: false,
    tools: [],
  });

  const result = await buildMessagesForQuery(runtime, state);

  assert.equal(
    result.forkContextMessages.some((message) => message.id === oldMessage.id),
    true,
  );
  assert.equal(result.stats.toolResultBudgetReplacementCount, 0);
  assert.equal(result.stats.bulkyToolCompactCount, 0);
  assert.equal(result.stats.historySnipCount, 0);
});

test("buildMessagesForQuery preserves an assistant/tool pair from an old content-only boundary", async () => {
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
    modelRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    transcriptStore: false,
    tools: [],
  });

  const result = await buildMessagesForQuery(runtime, state);

  assert.equal(result.messages.some((message) => message.role === "tool"), true);
  assert.equal(
    result.messages.some((message) =>
      message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0
    ),
    true,
  );
});

test("buildMessagesForQuery preserves an assistant/tool pair from an old removed boundary", async () => {
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
    modelRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
    },
    transcriptStore: false,
    tools: [],
  });

  const result = await buildMessagesForQuery(runtime, state);

  assert.equal(result.messages.some((message) => message.role === "tool"), true);
  assert.equal(
    result.messages.some((message) =>
      message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0
    ),
    true,
  );
});

test("buildMessagesForQuery does not snip business messages when bulky compact misses target", async () => {
  const originalTargetTokens = configValues["compression.historySnipTargetTokens"];
  const originalMinRecent = configValues["compression.historySnipMinRecentMessages"];
  const originalBulkyTargetTokens = configValues["compression.bulkyToolResultCompactContextTokens"];
  const originalBulkyCompactTargetTokens =
    configValues["compression.bulkyToolResultCompactTargetContextTokens"];
  const originalKeepRecent = configValues["compression.bulkyToolResultKeepRecent"];

  try {
    configValues["compression.historySnipTargetTokens"] = "800";
    configValues["compression.historySnipMinRecentMessages"] = "4";
    configValues["compression.bulkyToolResultCompactContextTokens"] = "500";
    configValues["compression.bulkyToolResultCompactTargetContextTokens"] = "2000";
    configValues["compression.bulkyToolResultKeepRecent"] = "0";

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
      modelRuntimeConfig: {
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        maxTokens: 1024,
      },
      transcriptStore: false,
      tools: [],
    });

    // User, assistant, and tool messages remain structurally intact even when
    // bulky compact cannot reach the configured context target.
    const first = await buildMessagesForQuery(runtime, state);

    assert.equal(state.historySnips.length, 0);
    assert.equal(first.stats.historySnipCount, 0);
    assert.equal(
      first.messages.some((message) =>
        message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0
      ),
      true,
    );
    assert.ok(first.messages.some((message) => message.role === "tool"));

    // Second call reuses the recorded boundary for stable request building.
    await buildMessagesForQuery(runtime, state);

    assert.equal(state.historySnips.length, 0);
  } finally {
    restoreConfigValue("compression.historySnipTargetTokens", originalTargetTokens);
    restoreConfigValue("compression.historySnipMinRecentMessages", originalMinRecent);
    restoreConfigValue("compression.bulkyToolResultCompactContextTokens", originalBulkyTargetTokens);
    restoreConfigValue(
      "compression.bulkyToolResultCompactTargetContextTokens",
      originalBulkyCompactTargetTokens,
    );
    restoreConfigValue("compression.bulkyToolResultKeepRecent", originalKeepRecent);
  }
});

test("buildMessagesForQuery does not mark snipped Read cache entries as partial views", async () => {
  const originalMinRecent = configValues["compression.historySnipMinRecentMessages"];
  const cwd = await mkdtemp(join(tmpdir(), "opencat-snip-read-"));
  const filePath = join(cwd, "old.ts");

  try {
    configValues["compression.historySnipMinRecentMessages"] = "4";

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
      modelRuntimeConfig: {
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        maxTokens: 1024,
      },
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
    restoreConfigValue("compression.historySnipMinRecentMessages", originalMinRecent);
  }
});

test("buildMessagesForQuery keeps business messages after repeated bulky compact misses", async () => {
  const originalTargetTokens = configValues["compression.historySnipTargetTokens"];
  const originalMinRecent = configValues["compression.historySnipMinRecentMessages"];
  const originalBulkyTargetTokens = configValues["compression.bulkyToolResultCompactContextTokens"];
  const originalBulkyCompactTargetTokens =
    configValues["compression.bulkyToolResultCompactTargetContextTokens"];
  const originalKeepRecent = configValues["compression.bulkyToolResultKeepRecent"];

  try {
    // Use a target low enough that bulky compact alone cannot satisfy the
    // removal target. The snip is still recorded as a durable boundary so
    // subsequent turns keep the same prefix shape.
    configValues["compression.historySnipTargetTokens"] = "500";
    configValues["compression.historySnipMinRecentMessages"] = "4";
    configValues["compression.bulkyToolResultCompactContextTokens"] = "500";
    configValues["compression.bulkyToolResultCompactTargetContextTokens"] = "2000";
    configValues["compression.bulkyToolResultKeepRecent"] = "0";

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
      modelRuntimeConfig: {
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        maxTokens: 1024,
      },
      transcriptStore: false,
      tools: [],
    });

    const first = await buildMessagesForQuery(runtime, state);

    assert.equal(state.historySnips.length, 0);
    assert.equal(first.stats.historySnipCount, 0);
    assert.equal(
      first.messages.some((message) =>
        message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0
      ),
      true,
    );
    assert.ok(first.messages.some((message) => message.role === "tool"));

    const second = await buildMessagesForQuery(runtime, state);

    assert.equal(state.historySnips.length, 0);
    assert.equal(second.stats.historySnipCount, 0);
    assert.equal(
      second.messages.some((message) =>
        message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0
      ),
      true,
    );
  } finally {
    restoreConfigValue("compression.historySnipTargetTokens", originalTargetTokens);
    restoreConfigValue("compression.historySnipMinRecentMessages", originalMinRecent);
    restoreConfigValue("compression.bulkyToolResultCompactContextTokens", originalBulkyTargetTokens);
    restoreConfigValue(
      "compression.bulkyToolResultCompactTargetContextTokens",
      originalBulkyCompactTargetTokens,
    );
    restoreConfigValue("compression.bulkyToolResultKeepRecent", originalKeepRecent);
  }
});

test("buildMessagesForQuery records durable snip boundaries for old attachment context", async () => {
  const originalTargetTokens = configValues["compression.historySnipTargetTokens"];
  const originalMinRecent = configValues["compression.historySnipMinRecentMessages"];
  const originalBulkyTargetTokens = configValues["compression.bulkyToolResultCompactContextTokens"];
  const originalBulkyCompactTargetTokens =
    configValues["compression.bulkyToolResultCompactTargetContextTokens"];
  const originalKeepRecent = configValues["compression.bulkyToolResultKeepRecent"];
  const attachmentSources = [
    "runtime",
    "long_term_memory",
    "file_restore",
    "dynamic_skill",
  ] as const;

  try {
    configValues["compression.historySnipTargetTokens"] = "800";
    configValues["compression.historySnipMinRecentMessages"] = "4";
    configValues["compression.bulkyToolResultCompactContextTokens"] = "500";
    configValues["compression.bulkyToolResultCompactTargetContextTokens"] = "4000";
    configValues["compression.bulkyToolResultKeepRecent"] = "0";

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
        modelRuntimeConfig: {
          apiKey: "test-key",
          model: "deepseek-v4-flash",
          maxTokens: 1024,
        },
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
    restoreConfigValue("compression.historySnipTargetTokens", originalTargetTokens);
    restoreConfigValue("compression.historySnipMinRecentMessages", originalMinRecent);
    restoreConfigValue("compression.bulkyToolResultCompactContextTokens", originalBulkyTargetTokens);
    restoreConfigValue(
      "compression.bulkyToolResultCompactTargetContextTokens",
      originalBulkyCompactTargetTokens,
    );
    restoreConfigValue("compression.bulkyToolResultKeepRecent", originalKeepRecent);
  }
});

test("buildMessagesForQuery keeps old user and assistant messages intact", async () => {
  const originalTargetTokens = configValues["compression.historySnipTargetTokens"];
  const originalMinRecent = configValues["compression.historySnipMinRecentMessages"];
  const originalBulkyTargetTokens = configValues["compression.bulkyToolResultCompactContextTokens"];
  const originalBulkyCompactTargetTokens =
    configValues["compression.bulkyToolResultCompactTargetContextTokens"];
  const originalKeepRecent = configValues["compression.bulkyToolResultKeepRecent"];

  try {
    configValues["compression.historySnipTargetTokens"] = "800";
    configValues["compression.historySnipMinRecentMessages"] = "5";
    configValues["compression.bulkyToolResultCompactContextTokens"] = "500";
    configValues["compression.bulkyToolResultCompactTargetContextTokens"] = "1200";
    configValues["compression.bulkyToolResultKeepRecent"] = "0";

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
      modelRuntimeConfig: {
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        maxTokens: 1024,
      },
      transcriptStore: false,
      tools: [],
    });

    const first = await buildMessagesForQuery(runtime, state);
    const serialized = JSON.stringify(first.messages);
    const projectedAssistant = first.messages.find((message) =>
      message.role === "assistant" &&
      message.content === oldAssistant.content
    );

    assert.equal(state.historySnips.length, 0);
    assert.match(serialized, /old user content that should remain visible/);
    assert.match(serialized, /old assistant answer that should remain visible/);
    assert.match(serialized, /<tool-result-compact>/);
    assert.equal(projectedAssistant?.role, "assistant");
    assert.equal(projectedAssistant?.tool_calls?.length, 1);

    await buildMessagesForQuery(runtime, state);

    assert.equal(state.historySnips.length, 0);
  } finally {
    restoreConfigValue("compression.historySnipTargetTokens", originalTargetTokens);
    restoreConfigValue("compression.historySnipMinRecentMessages", originalMinRecent);
    restoreConfigValue("compression.bulkyToolResultCompactContextTokens", originalBulkyTargetTokens);
    restoreConfigValue(
      "compression.bulkyToolResultCompactTargetContextTokens",
      originalBulkyCompactTargetTokens,
    );
    restoreConfigValue("compression.bulkyToolResultKeepRecent", originalKeepRecent);
  }
});

test("buildMessagesForQuery skips history snip when bulky compact reaches the target", async () => {
  const originalHistoryTargetTokens = configValues["compression.historySnipTargetTokens"];
  const originalBulkyTargetTokens = configValues["compression.bulkyToolResultCompactContextTokens"];
  const originalBulkyCompactTargetTokens =
    configValues["compression.bulkyToolResultCompactTargetContextTokens"];
  const originalKeepRecent = configValues["compression.bulkyToolResultKeepRecent"];

  try {
    configValues["compression.historySnipTargetTokens"] = "5000";
    configValues["compression.bulkyToolResultCompactContextTokens"] = "500";
    configValues["compression.bulkyToolResultCompactTargetContextTokens"] = "5000";
    configValues["compression.bulkyToolResultKeepRecent"] = "0";

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
      modelRuntimeConfig: {
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        maxTokens: 1024,
      },
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
    restoreConfigValue("compression.historySnipTargetTokens", originalHistoryTargetTokens);
    restoreConfigValue("compression.bulkyToolResultCompactContextTokens", originalBulkyTargetTokens);
    restoreConfigValue(
      "compression.bulkyToolResultCompactTargetContextTokens",
      originalBulkyCompactTargetTokens,
    );
    restoreConfigValue("compression.bulkyToolResultKeepRecent", originalKeepRecent);
  }
});

test("buildMessagesForQuery keeps bulky compaction when no snip candidate is removable", async () => {
  const originalHistoryTargetTokens = configValues["compression.historySnipTargetTokens"];
  const originalMinRecent = configValues["compression.historySnipMinRecentMessages"];
  const originalBulkyTargetTokens = configValues["compression.bulkyToolResultCompactContextTokens"];
  const originalBulkyCompactTargetTokens =
    configValues["compression.bulkyToolResultCompactTargetContextTokens"];
  const originalCancelTokens = configValues["compression.historySnipCancelContextTokens"];
  const originalKeepRecent = configValues["compression.bulkyToolResultKeepRecent"];

  try {
    configValues["compression.historySnipTargetTokens"] = "80";
    configValues["compression.historySnipMinRecentMessages"] = "0";
    configValues["compression.bulkyToolResultCompactContextTokens"] = "500";
    configValues["compression.bulkyToolResultCompactTargetContextTokens"] = "80";
    configValues["compression.historySnipCancelContextTokens"] = "1";
    configValues["compression.bulkyToolResultKeepRecent"] = "0";

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
      modelRuntimeConfig: {
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        maxTokens: 1024,
      },
      transcriptStore: false,
      tools: [],
    });

    const result = await buildMessagesForQuery(runtime, state);
    const hasCompactedToolResult = result.forkContextMessages.some((message) =>
      message.role === "tool" && message.content.includes("<tool-result-compact>")
    );

    assert.equal(state.historySnips.length, 0);
    assert.equal(result.stats.historySnipCount, 0);
    assert.ok(state.toolResultBudgetState.seenIds.size > 0);
    assert.ok(state.toolResultBudgetState.replacements.size > 0);
    assert.equal(hasCompactedToolResult, true);
  } finally {
    restoreConfigValue("compression.historySnipTargetTokens", originalHistoryTargetTokens);
    restoreConfigValue("compression.historySnipMinRecentMessages", originalMinRecent);
    restoreConfigValue("compression.bulkyToolResultCompactContextTokens", originalBulkyTargetTokens);
    restoreConfigValue(
      "compression.bulkyToolResultCompactTargetContextTokens",
      originalBulkyCompactTargetTokens,
    );
    restoreConfigValue("compression.historySnipCancelContextTokens", originalCancelTokens);
    restoreConfigValue("compression.bulkyToolResultKeepRecent", originalKeepRecent);
  }
});

function restoreConfigValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete configValues[name];
    return;
  }

  configValues[name] = value;
}
