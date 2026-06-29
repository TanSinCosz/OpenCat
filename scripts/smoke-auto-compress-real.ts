import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

if (!apiKey) {
  throw new Error("Missing DEEPSEEK_API_KEY environment variable.");
}

process.env.OPENCAT_AUTO_COMPRESS_TRIGGER_TOKENS ??= "100";

const [{ query }, { createRuntime }, { createState }, { createMessage }] =
  await Promise.all([
    import("../src/query.js"),
    import("../src/types/runtime.js"),
    import("../src/types/state.js"),
    import("../src/types/messages.js"),
  ]);

const state = createState({
  messages: [
    createMessage({
      role: "user",
      content: [
        "We are running a real API smoke test for auto-compress.",
        "The session memory should summarize this short conversation.",
        "When you receive the final request, reply with exactly: OK",
      ].join("\n"),
    }),
    createMessage({
      role: "assistant",
      content:
        "Understood. I will preserve that this is an auto-compress smoke test.",
    }),
    createMessage({
      role: "user",
      content:
        "Trigger auto-compress through the low smoke-test threshold and verify the main request still works.",
    }),
  ],
});

const runtime = createRuntime({
  cwd: await mkdtemp(join(tmpdir(), "opencat-real-auto-compress-")),
  deepSeekRuntimeConfig: {
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
    maxTokens: Number(process.env.DEEPSEEK_MAX_TOKENS ?? 2048),
  },
  MemoryConfig: {
    embedder: {
      provider: "smoke",
      config: {},
    },
    vectorStore: {
      provider: "smoke",
      config: {},
    },
    llm: {
      provider: "smoke",
      config: {},
    },
  },
  messages: state.Messages,
});

let contextReadyCount = 0;
let finalReason = "";
let assistantText = "";
let assistantMessageContent = "";
let assistantReasoningContent = "";

for await (const event of query(runtime, state, { maxTurns: 1 })) {
  switch (event.type) {
    case "context_ready": {
      contextReadyCount++;
      console.log(
        JSON.stringify({
          event: "context_ready",
          messageCount: event.messages.length,
          hasSessionMemorySummary: event.messages.some(
            (message) =>
              message.role === "user" &&
              message.content.includes("<session_memory>"),
          ),
        }),
      );
      break;
    }
    case "assistant_text_delta": {
      assistantText += event.text;
      break;
    }
    case "assistant_message": {
      assistantMessageContent = event.message.content ?? "";
      assistantReasoningContent = event.message.reasoning_content ?? "";
      break;
    }
    case "done": {
      finalReason = event.reason;
      break;
    }
  }
}

console.log(
  JSON.stringify(
    {
      contextReadyCount,
      finalReason,
      assistantText: assistantText.trim(),
      assistantMessageContent: assistantMessageContent.trim(),
      assistantReasoningContent: assistantReasoningContent.trim(),
      sessionMemoryStatus: state.sessionMemory.status,
      sessionMemoryLength: state.sessionMemory.content.length,
      sessionMemoryFailureReason: state.sessionMemory.lastFailureReason,
      autoCompressSummaryCount: state.autoCompress.summaries.length,
      activeSummaryId: state.autoCompress.summaries.at(-1)?.id,
      triggerTokens: process.env.OPENCAT_AUTO_COMPRESS_TRIGGER_TOKENS,
    },
    null,
    2,
  ),
);
