## 八、长期记忆（Long-term Memory）

长期记忆是一个基于向量搜索的持久化知识库，使智能体能够跨会话记住用户偏好、项目约定和重要发现。涉及文件：

| 文件 | 职责 |
|------|------|
| `src/Memory/Memory.ts`（970 行） | 核心引擎：搜索（11 步）+ 添加（8 阶段） |
| `src/Memory/type.ts` | 类型定义：MemoryConfig、MemoryItem、实体 |
| `src/Memory/runtime.ts` | 运行时层：懒加载、搜索适配、身份过滤 |
| `src/Memory/config.ts` | 配置层：embedder/vectorStore/LLM 参数解析 |
| `src/query/long-term-memory.ts`（292 行） | 查询循环层：注入构建、提取调度 |
| `src/Memory/Embedding/openai.ts` | OpenAI 兼容 Embedding 客户端 |
| `src/Memory/Embedding/entity-store.ts` | 实体存储（独立 `_entities.db`） |
| `src/Memory/Embedding/scoring.ts` | 评分函数（BM25 归一化、综合 ranking） |
| `src/Memory/Embedding/nlp-utils.ts` | NLP 工具：分词、词形还原 |

### 8.1 三层架构

```
query/long-term-memory.ts        ← 查询循环层：注入 & 提取的入口
         │
         ▼
Memory/runtime.ts                ← 运行时层：懒加载、搜索适配、身份过滤
         │
         ▼
Memory/Memory.ts (970行)         ← 核心引擎：搜索（11步）/ 添加（8阶段）
         │
    ┌────┼────┐
    ▼    ▼     ▼
OpenAIEmbedder  OpenAIStructuredLLM  MemoryVectorStore
  (嵌入向量)      (LLM提取记忆)      (SQLite向量存储)
                                    + EntityStore (实体存储)
```

### 8.2 配置结构

**存储层**（`Memory/config.ts`）：

| 组件 | 默认值 | 说明 |
|------|--------|------|
| embedder | `text-embedding-3-small` via OpenAI API | 文本 → 1536 维向量 |
| vectorStore | SQLite（`better-sqlite3`），路径 `.opencat/memory/vector_store.db` | 向量 + 负载持久化 |
| LLM | `deepseek-chat` | 结构化提取：从对话中抽取记忆条目 |

**行为层**（`LongTermMemoryRuntimeConfig`）：

| 参数 | 默认值 | 作用 |
|------|--------|------|
| `enabled` | `true` | 总开关 |
| `autoInject` | `true` | 每轮自动搜索相关记忆并注入上下文 |
| `autoExtract` | `true` | 每轮结束后自动从对话中提取新记忆 |
| `autoInjectTopK` | `6` | 每次注入最多几条 |
| `searchThreshold` | `0.1` | 最低相似度阈值 |
| `maxInjectedChars` | `8000` | 注入内容总字符上限 |
| `userId` | 环境变量 `OPENCAT_MEMORY_USER_ID` 或 `default-user` | 记忆归属（跨会话隔离） |

### 8.3 注入流程（每轮对话前自动执行）

入口：`materializeContextForQuery()` → `createLongTermMemoryContextMessage()`

```
1. 从最近 6 条 user/assistant 消息中构建搜索查询
   → buildLongTermMemoryQuery()：取最近 6 条 → 拼成 "user: ...\nassistant: ..."
   → 上限 4000 字符

2. 调用 searchLongTermMemory(runtime, query, { topK: 6, threshold: 0.1 })
   → 多路搜索 + 评分（详见 8.4）
   → 按 user_id 过滤（scope="user"）

3. 渲染结果：
   <long_term_memory>
   Relevant long-term memories retrieved for this request.
   Use them as context, but prefer newer user messages if there is a conflict.
   - id=xxx score=0.929: 记忆内容...
   - id=yyy score=0.865: 记忆内容...
   </long_term_memory>

4. 包装进 <opencat_context>，追加到 state.Messages 末尾
```

每当 `state.Messages` 的最后一条是真实的用户消息（`source === "user"`）时触发。注入失败静默忽略，不阻塞主流程。

### 8.4 搜索流程（Memsearch — 11 步评分流水线）

```
用户查询: "我们之前讨论过 skill 通知的 gap 吗？"
  │
  ├─ Step 1: 预处理
  │   → lemmatizeForBm25(query)  ← 词形还原
  │   → extractEntities(query)   ← 提取实体（人名、术语、文件名等）
  │
  ├─ Step 2: 嵌入查询向量
  │   → embedder.embed(query) → 1536 维向量
  │
  ├─ Step 3: 语义搜索
  │   → vectorStore.search(embedding, limit=topK*4, filters)
  │   → 余弦相似度，过取 4 倍为后续重排提供候选池
  │
  ├─ Step 4: 关键词搜索
  │   → vectorStore.keywordSearch(queryLemmatized, limit, filters)
  │   → BM25 全文检索
  │
  ├─ Step 5: BM25 分数归一化
  │   → normalizeBm25(rawScore, midpoint, steepness)
  │   → logistic sigmoid 压缩到 [0, 1]
  │
  ├─ Step 6: 实体增强（entity boost）
  │   → 对查询中的每个实体（最多 8 个），在 EntityStore 中搜索
  │   → 找到的实体 → 获取 linkedMemoryIds → 给这些记忆加分
  │   → boost = similarity × ENTITY_BOOST_WEIGHT × memoryCountWeight
  │
  ├─ Step 7: 构建候选集
  │   → 语义搜索结果作为基础候选
  │
  ├─ Step 8: 综合评分（scoreAndRank）
  │   → semantic + bm25 + entityBoost → 最终分数
  │   → 按 threshold 过滤 → 按分数降序 → 取 topK
  │
  └─ Step 9: 格式化结果
      → 过滤 payload → 提取 data/id/score/metadata
      → 返回 { results: MemoryItem[] }
```

**三大评分维度**：

| 维度 | 来源 | 权重 | 说明 |
|------|------|------|------|
| 语义相似度（semantic） | 向量余弦距离 | 主要 | 捕捉同义词和语义关联 |
| 关键词匹配（BM25） | 全文检索 | 补充 | 捕捉精确术语匹配 |
| 实体增强（entity boost） | 实体 ↔ 记忆关联图 | 加成 | 通过实体作为桥接链接相关记忆 |

### 8.5 添加流程（8 阶段提取流水线）

```
messages: [
  { role: "user", content: "skill 通知已被压缩会被永久丢失" },
  { role: "assistant", content: "是的，这是一个真实的 gap..." },
]
  │
  ├─ Phase 1: 检索已有记忆
  │   → 搜索相关已有记忆，提供上下文用于 LLM 去重判断
  │
  ├─ Phase 2: LLM 结构化提取
  │   → ADDITIVE_EXTRACTION_PROMPT
  │   → LLM 输出 JSON: [{ id, text, attributed_to, linked_memory_ids }]
  │   → Zod schema 校验（AdditiveExtractionSchema）
  │
  ├─ Phase 3: 批量嵌入
  │   → embedder.embedBatch(texts) — 减少 API 调用
  │   → 失败回退到逐条 embed()
  │
  ├─ Phase 4-5: 哈希去重
  │   → MD5 哈希 → 与已有记忆比对 → 跳过重复
  │
  ├─ Phase 6: 批量持久化
  │   → vectorStore.insert(vectors, ids, payloads)
  │   → payload: data, hash, textLemmatized, createdAt, user_id, agent_id, run_id
  │
  ├─ Phase 7: 实体链接（7a → 7b → 7c）
  │   → extractEntitiesBatch(texts) — 每段文字提取实体
  │   → 全局去重：unique entities across all memories
  │   → 批量嵌入实体 → EntityStore 搜索 → 更新/插入
  │   → linkedMemoryIds 关联记忆，形成实体 ↔ 记忆图
  │   → 相似度 >= 0.95 视为同一实体，合并 linkedMemoryIds
  │
  └─ Phase 8: 返回结果
```

**LLM 提取输出结构**：每条记忆包含 `id`、`text`（记忆正文）、`attributed_to`（归属于 user 或 assistant）、`linked_memory_ids`（与已有记忆的关联）。提取是一次性增量式的——LLM 只从本轮新消息中提取**新出现**的知识点。

### 8.6 提取调度

入口：`query.ts` → 当模型本轮**无工具调用**时触发 `extractLongTermMemoryForCompletedQuery()`

```
1. resolveLongTermMemoryTurnMessages(state, turnStartIndex)
   → 从 state.Messages 中找到本轮开始之后的新消息
   → 只取 role: "user"/"assistant" 且 source: "user"/"assistant"
   → 如果 state 已被压缩（消息丢失），回退到 transcript JSONL 全量恢复

2. 分成两组：
   → newMessages: 本轮新消息（要提取的源数据）
   → contextMessages: 本轮之前的最近 20 条（提供上下文给 LLM 去重）

3. 调用 memory.add(newMessages, {
      infer: true,
      userId, agentId, runId,
      contextMessages,
    })
```

### 8.7 懒加载设计

```typescript
// Memory/runtime.ts
function getOrCreateLongTermMemory(runtime) {
  if (!runtime.longTermMemoryConfig.enabled) return null;
  runtime.longTermMemory ??= new MemoryTool(runtime.MemoryConfig);
  //                      ↑ 第一次真正使用时才初始化
  return runtime.longTermMemory;
}
```

不创建 SQLite 文件、不实例化 Embedding/LLM 客户端，直到第一次 `search()` 或 `add()` 调用。

### 8.8 与技能通知系统的区别

| 维度 | 技能通知（`<dynamic_skills>`） | 长期记忆（`<long_term_memory>`） |
|------|------|------|
| 数据来源 | 项目文件系统（`.claude/skills/SKILL.md`） | 对话历史的语义提取 |
| 触发方式 | FileRead/Write/Edit 后自动发现 | 每轮语义搜索（基于向量 + BM25 + 实体） |
| 注入频率 | 每轮（所有活跃技能全部重新注入） | 每轮（基于搜索查询动态变化） |
| 内容性质 | 技能指令（操作指南、约束规则） | 事实性记忆（偏好、决策、知识点） |
| 存储位置 | 项目文件系统 | SQLite 向量数据库（`.opencat/memory/`） |
| 跨会话 | 取决于文件是否存在于项目中 | 持久化，跨会话保留 |

### 8.9 当前未实现的部分

| 待实现 | 说明 |
|--------|------|
| 记忆更新/删除 API | 目前只能 add 和 search，无法通过 MemorySave 工具修改或删除已有记忆 |
| EntityStore 健康检查 | `_entities.db` 与主 `vector_store.db` 的一致性无校验 |
| 嵌入模型本地化 | 强依赖 OpenAI Embedding API，无本地 embedder 回退 |

---
