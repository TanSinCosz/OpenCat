import assert from "node:assert/strict";
import { test } from "node:test";

import { createMemoryConfig } from "../src/Memory/config.js";
import { createDefaultTools } from "../src/Tools/index.js";
import { WebFetch } from "../src/Tools/WebFetch/WebFetch.js";
import { inputSchema } from "../src/Tools/WebFetch/type.js";
import { createRuntime } from "../src/types/runtime.js";
import { createState } from "../src/types/state.js";

test("WebFetch fetches HTML and extracts readable text", async () => {
  let requestedUrl = "";
  const tool = new WebFetch({
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return new Response(
        [
          "<!doctype html>",
          "<html>",
          "<head><title>Example</title><style>.hidden{display:none}</style></head>",
          "<body>",
          "<script>window.secret = 'ignore me'</script>",
          "<main><h1>Example &amp; Test</h1><p>Hello <strong>world</strong>.</p></main>",
          "</body>",
          "</html>",
        ].join(""),
        {
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    },
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
      url: "https://example.com/page",
      prompt: "extract the title",
    },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(requestedUrl, "https://example.com/page");
  assert.equal(output.finalUrl, "https://example.com/page");
  assert.equal(output.code, 200);
  assert.equal(output.contentType, "text/html; charset=utf-8");
  assert.match(output.text, /Example & Test/);
  assert.match(output.text, /Hello world/);
  assert.doesNotMatch(output.text, /window\.secret/);
  assert.doesNotMatch(output.text, /display:none/);
  assert.equal(output.redirected, false);
  assert.equal(output.truncated, false);
  assert.match(output.note ?? "", /prompt was not applied/);
});

test("WebFetch reports cross-host redirects without following them", async () => {
  const tool = new WebFetch({
    fetchImpl: async () =>
      new Response("", {
        status: 302,
        statusText: "Found",
        headers: { Location: "https://other.example/new-page" },
      }),
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
      url: "https://example.com/old-page",
      prompt: "fetch the page",
    },
    runtime.toolUseContext,
    runtime,
    state,
  );

  assert.equal(output.code, 302);
  assert.equal(output.finalUrl, "https://other.example/new-page");
  assert.equal(output.redirected, true);
  assert.match(output.text, /REDIRECT DETECTED/);
  assert.match(output.text, /https:\/\/other\.example\/new-page/);
});

test("WebFetch rejects non-http URLs in the schema", () => {
  const result = inputSchema().safeParse({
    url: "file:///tmp/secret.txt",
    prompt: "read this",
  });

  assert.equal(result.success, false);
});

test("WebFetch is included in the default tool list", () => {
  const tools = createDefaultTools();

  assert.ok(tools.some((tool) => tool instanceof WebFetch));
});
