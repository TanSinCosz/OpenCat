import assert from "node:assert/strict";
import test from "node:test";

import { MemoryVectorStore } from "../src/Memory/VectorStore/VectorStore.js";
import { extractEntities } from "../src/Memory/utils/entity_extraction.js";
import { lemmatizeForBm25 } from "../src/Memory/utils/lemmatize.js";

test("BM25 preprocessing keeps Chinese and mixed-language keywords", () => {
  const normalized = lemmatizeForBm25(
    "我喜欢北京大学的机器学习课程，也常用DeepSeek和TypeScript。",
  );

  assert.match(normalized, /北京大学/);
  assert.match(normalized, /机器/);
  assert.match(normalized, /学习/);
  assert.match(normalized, /课程/);
  assert.match(normalized, /deepseek/);
  assert.match(normalized, /typescript/);
});

test("keyword search can match Chinese memories through BM25 tokens", async () => {
  const store = new MemoryVectorStore({ dimension: 2, dbPath: ":memory:" });

  await store.insert(
    [
      [1, 0],
      [0, 1],
    ],
    ["memory_cn", "memory_other"],
    [
      {
        user_id: "user-1",
        data: "用户喜欢北京大学的机器学习课程。",
        textLemmatized: lemmatizeForBm25("用户喜欢北京大学的机器学习课程。"),
      },
      {
        user_id: "user-1",
        data: "用户喜欢周末跑步。",
        textLemmatized: lemmatizeForBm25("用户喜欢周末跑步。"),
      },
    ],
  );

  const results = await store.keywordSearch(
    lemmatizeForBm25("北京大学机器学习"),
    5,
    { user_id: "user-1" },
  );

  assert.equal(results?.[0]?.id, "memory_cn");
  assert.ok((results?.[0]?.score ?? 0) > 0);
});

test("entity extraction includes Chinese entity candidates", () => {
  const entities = extractEntities(
    "用户喜欢北京大学的机器学习课程，也常用DeepSeek重构DSAgent项目。",
  ).map((entity) => entity.text.toLowerCase());

  assert.ok(entities.includes("北京大学"));
  assert.ok(entities.some((entity) => entity.includes("机器学习")));
  assert.ok(entities.includes("deepseek"));
  assert.ok(entities.includes("dsagent"));
});
