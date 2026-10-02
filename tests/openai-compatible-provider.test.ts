import assert from "node:assert/strict";
import test from "node:test";

import {
  createImageBase64ContentPart,
  createImageUrlContentPart,
  createTextContentPart,
} from "../src/openai-compatible/content.js";
import { createOpenAICompatibleClient } from "../src/openai-compatible/model-client.js";
import { normalizeModelRuntimeSettings } from "../src/types/config.js";
import type { ModelCreateRequest } from "../src/openai-compatible/types.js";
import { createOpenAICompatibleSdkClient } from "../src/openai-compatible/transport.js";

test("SDK configuration does not inherit environment base URL or account headers", () => {
  const keys = ["OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"] as const;
  const previous = keys.map((key) => process.env[key]);
  try {
    process.env.OPENAI_BASE_URL = "https://environment.example/v1";
    process.env.OPENAI_ORG_ID = "environment-org";
    process.env.OPENAI_PROJECT_ID = "environment-project";
    const client = createOpenAICompatibleSdkClient({ provider: "openai-compatible", apiKey: "yaml-key" });
    assert.equal(client.baseURL, "https://api.openai.com/v1");
    assert.equal(client.organization, null);
    assert.equal(client.project, null);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test("SDK request headers come from explicit configuration rather than environment", async () => {
  const previous = process.env.OPENAI_CUSTOM_HEADERS;
  let headers: Headers | undefined;
  try {
    process.env.OPENAI_CUSTOM_HEADERS = "X-Environment: unexpected";
    const client = createOpenAICompatibleClient({
      config: { provider: "openai-compatible", apiKey: "yaml-key", model: "model", maxTokens: 32, headers: { "X-Yaml": "configured" } },
      fetchImpl: async (_input, init) => {
        headers = new Headers(init?.headers);
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }] }), { headers: { "Content-Type": "application/json" } });
      },
    });
    await client.create({ model: "model", messages: [{ role: "user", content: "hello" }] });
    assert.equal(headers?.get("X-Yaml"), "configured");
    assert.equal(headers?.get("X-Environment"), null);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_CUSTOM_HEADERS;
    else process.env.OPENAI_CUSTOM_HEADERS = previous;
  }
});

test("DeepSeek profile preserves documented DeepSeek request extensions", async () => {
  const capture = createFetchCapture();
  const client = createOpenAICompatibleClient({
    config: {
      provider: "deepseek",
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      maxTokens: 1024,
    },
    fetchImpl: capture.fetchImpl,
  });

  await client.create(createExtendedRequest());

  assert.equal(capture.url, "https://api.deepseek.com/chat/completions");
  assert.equal(capture.body.user_id, "cache-worker-1");
  assert.deepEqual(capture.body.thinking, { type: "enabled" });
  assert.equal(capture.body.reasoning_effort, "max");
  assert.equal(capture.body.messages[0].prefix, true);
  assert.equal(capture.body.messages[0].reasoning_content, "prior reasoning");
});

test("Volcengine profile sends only the shared OpenAI request fields", async () => {
  const capture = createFetchCapture();
  const client = createOpenAICompatibleClient({
    config: {
      provider: "volcengine",
      apiKey: "test-key",
      model: "ark-endpoint-id",
      maxTokens: 1024,
    },
    fetchImpl: capture.fetchImpl,
  });

  await client.create(createExtendedRequest("ark-endpoint-id"));

  assert.equal(
    capture.url,
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
  );
  assert.equal(capture.body.model, "ark-endpoint-id");
  assert.equal("user_id" in capture.body, false);
  assert.equal("thinking" in capture.body, false);
  assert.equal("reasoning_effort" in capture.body, false);
  assert.equal("prefix" in capture.body.messages[0], false);
  assert.equal("reasoning_content" in capture.body.messages[0], false);
});

test("generic OpenAI-compatible profile uses the configured endpoint", async () => {
  const capture = createFetchCapture();
  const client = createOpenAICompatibleClient({
    config: {
      provider: "openai-compatible",
      apiKey: "test-key",
      baseUrl: "https://gateway.example/v1",
      model: "custom-model",
      maxTokens: 1024,
    },
    fetchImpl: capture.fetchImpl,
  });

  await client.create({
    model: "custom-model",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(capture.url, "https://gateway.example/v1/chat/completions");
  assert.equal(capture.body.model, "custom-model");
});

test("normalizes OpenAI cached token details into cache hit metrics", async () => {
  const capture = createFetchCapture({
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 110,
    prompt_tokens_details: { cached_tokens: 70 },
  });
  const client = createOpenAICompatibleClient({
    config: {
      provider: "volcengine",
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      maxTokens: 1024,
    },
    fetchImpl: capture.fetchImpl,
  });

  const response = await client.create({
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(response.usage?.prompt_cache_hit_tokens, 70);
  assert.equal(response.usage?.prompt_cache_miss_tokens, 30);
  assert.deepEqual(response.usage?.prompt_tokens_details, {
    cached_tokens: 70,
  });
});

test("preserves DeepSeek cache hit and miss metrics", async () => {
  const capture = createFetchCapture({
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 110,
    prompt_cache_hit_tokens: 80,
    prompt_cache_miss_tokens: 20,
  });
  const client = createOpenAICompatibleClient({
    config: {
      provider: "deepseek",
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      maxTokens: 1024,
    },
    fetchImpl: capture.fetchImpl,
  });

  const response = await client.create({
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(response.usage?.prompt_cache_hit_tokens, 80);
  assert.equal(response.usage?.prompt_cache_miss_tokens, 20);
});

test("Volcengine profile preserves OpenAI-compatible image content parts", async () => {
  const capture = createFetchCapture();
  const client = createOpenAICompatibleClient({
    config: {
      provider: "volcengine",
      apiKey: "test-key",
      model: "doubao-vision-endpoint",
      maxTokens: 1024,
    },
    fetchImpl: capture.fetchImpl,
  });

  await client.create({
    model: "doubao-vision-endpoint",
    messages: [
      {
        role: "user",
        content: [
          createTextContentPart("Compare these images."),
          createImageUrlContentPart("https://example.com/input.png", {
            detail: "high",
          }),
          createImageBase64ContentPart(
            new Uint8Array([0, 1, 2]),
            "image/png",
          ),
        ],
      },
    ],
  });

  assert.deepEqual(capture.body.messages[0], {
    role: "user",
    content: [
      {
        type: "text",
        text: "Compare these images.",
      },
      {
        type: "image_url",
        image_url: {
          url: "https://example.com/input.png",
          detail: "high",
        },
      },
      {
        type: "image_url",
        image_url: {
          url: "data:image/png;base64,AAEC",
        },
      },
    ],
  });
});

test("DeepSeek profile rejects image input before sending the request", async () => {
  const capture = createFetchCapture();
  const client = createOpenAICompatibleClient({
    config: {
      provider: "deepseek",
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      maxTokens: 1024,
    },
    fetchImpl: capture.fetchImpl,
  });

  await assert.rejects(
    client.create({
      model: "deepseek-v4-pro",
      messages: [
        {
          role: "user",
          content: [
            createTextContentPart("Describe this image."),
            createImageUrlContentPart("https://example.com/input.png"),
          ],
        },
      ],
    }),
    /DeepSeek Chat API does not support user content part 'image_url'/,
  );

  assert.equal(capture.url, "");
});

test("missing credentials identify the unified YAML API key field", async () => {
  const client = createOpenAICompatibleClient({
    config: {
      provider: "volcengine",
      apiKey: "",
      model: "deepseek-v4-pro",
      maxTokens: 1024,
    },
  });

  await assert.rejects(
    client.create({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
    }),
    /Missing Volcengine Ark credentials.*model.apiKey/,
  );
});

test("runtime normalization resolves providers without replacing model settings", () => {
  const volcengine = normalizeModelRuntimeSettings({
    provider: "volcengine",
    apiKey: "test-key",
    model: "ark-endpoint-id",
    maxTokens: 4096,
    reasoningEffort: "high",
  });
  assert.equal(volcengine.model, "ark-endpoint-id");
  assert.equal(volcengine.reasoningEffort, "high");

  const deepseek = normalizeModelRuntimeSettings({
    provider: "deepseek",
    apiKey: "test-key",
    model: "another-model",
    maxTokens: 4096,
    reasoningEffort: "high",
  });
  assert.equal(deepseek.model, "another-model");
  assert.equal(deepseek.reasoningEffort, "high");
});

function createExtendedRequest(
  model = "deepseek-v4-pro",
): ModelCreateRequest {
  return {
    model,
    user_id: "cache-worker-1",
    thinking: { type: "enabled" },
    reasoning_effort: "max",
    messages: [
      {
        role: "assistant",
        content: "continued answer",
        prefix: true,
        reasoning_content: "prior reasoning",
      },
    ],
  };
}

function createFetchCapture(usage: Record<string, unknown> = {
  prompt_tokens: 1,
  completion_tokens: 1,
  total_tokens: 2,
}): {
  fetchImpl: typeof fetch;
  url: string;
  body: Record<string, any>;
} {
  const capture = {
    url: "",
    body: {} as Record<string, any>,
    fetchImpl: undefined as unknown as typeof fetch,
  };

  capture.fetchImpl = async (input, init) => {
    capture.url = input instanceof Request ? input.url : String(input);
    capture.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: capture.body.model,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "ok",
          },
        },
      ],
      usage,
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  return capture;
}
