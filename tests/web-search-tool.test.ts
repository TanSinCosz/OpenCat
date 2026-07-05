import assert from "node:assert/strict";
import { test } from "node:test";

import { createMemoryConfig } from "../src/Memory/config.js";
import { createDefaultTools } from "../src/Tools/index.js";
import { WebSearch } from "../src/Tools/WebSearch/WebSearch.js";
import { inputSchema } from "../src/Tools/WebSearch/type.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("WebSearch calls the DeepSeek Anthropic server tool and filters results", async () => {
  let requestedUrl = "";
  let requestedBody: Record<string, any> | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body));

    return new Response(JSON.stringify({
      id: "msg_test",
      model: "deepseek-v4-pro",
      stop_reason: "end_turn",
      content: [
        {
          type: "server_tool_use",
          id: "search_1",
          name: "web_search",
          input: { query: "DeepSeek models" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "search_1",
          content: [
            {
              title: "Official models",
              url: "https://api-docs.deepseek.com/api/list-models",
            },
            {
              title: "Duplicate",
              url: "https://api-docs.deepseek.com/api/list-models",
            },
            {
              title: "Filtered external result",
              url: "https://example.com/deepseek",
            },
          ],
        },
        {
          type: "text",
          text: "DeepSeek currently exposes V4 models.",
        },
      ],
      usage: {
        server_tool_use: {
          web_search_requests: 1,
        },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const tool = new WebSearch({
    fetchImpl,
    messagesUrl: "https://api.deepseek.test/anthropic/v1/messages",
  });
  const state = createState();
  const runtime = createRuntime({
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      maxTokens: 4_096,
    },
    MemoryConfig: createMemoryConfig(),
  });

  const output = await tool.call(
    {
      query: "DeepSeek models",
      allowed_domains: ["api-docs.deepseek.com"],
    },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(
    requestedUrl,
    "https://api.deepseek.test/anthropic/v1/messages",
  );
  assert.equal(requestedBody?.model, "deepseek-v4-pro");
  assert.equal(
    requestedBody?.tools?.[0]?.type,
    "web_search_20250305",
  );
  assert.deepEqual(
    requestedBody?.tools?.[0]?.allowed_domains,
    ["api-docs.deepseek.com"],
  );
  assert.deepEqual(output.results, [
    {
      title: "Official models",
      url: "https://api-docs.deepseek.com/api/list-models",
    },
  ]);
  assert.equal(output.filteredOutCount, 1);
  assert.equal(output.searchRequests, 1);
  assert.match(output.summary, /V4 models/);
});

test("WebSearch surfaces HTTP errors without leaking unbounded responses", async () => {
  const tool = new WebSearch({
    fetchImpl: async () =>
      new Response("upstream rejected request", { status: 400 }),
    messagesUrl: "https://api.deepseek.test/anthropic/v1/messages",
  });
  const state = createState();
  const runtime = createRuntime({
    deepSeekRuntimeConfig: {
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      maxTokens: 4_096,
    },
    MemoryConfig: createMemoryConfig(),
  });

  await assert.rejects(
    tool.call(
      { query: "test query" },
      runtime.toolUseContext,
      runtime,
      state,
    ),
    /WebSearch request failed \(400\): upstream rejected request/,
  );
});

test("WebSearch schema rejects conflicting domain filters", () => {
  const result = inputSchema().safeParse({
    query: "test query",
    allowed_domains: ["example.com"],
    blocked_domains: ["blocked.example"],
  });

  assert.equal(result.success, false);
});

test("WebSearch is included in the default tool list", () => {
  const tools = createDefaultTools();

  assert.ok(tools.some((tool) => tool instanceof WebSearch));
});

