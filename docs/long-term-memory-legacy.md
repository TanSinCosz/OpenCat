g

# 已废弃的长期记忆方案

本文记录 OpenCat 早期的数据库/向量检索型长期记忆方案。相关代码目前仍保留在
`src/Memory/` 中，主要用于兼容、测试或手动调用，但它已经不是当前主循环的长期
记忆注入方案。

当前方案请阅读 [long-term-memory.md](long-term-memory.md)：文件型 Markdown
topic memory、daily log、selector 按需召回，以及手动 AutoDream。

## 1. 旧方案的核心思路

旧方案把每条记忆当成数据库中的一条记录，而不是一个独立的 Markdown topic 文件。
写入时通常会经历：

1. 接收用户或 Agent 提供的记忆文本。
2. 使用 LLM 对消息进行增量式记忆提取。
3. 为记忆文本生成 embedding。
4. 将文本、hash、时间、scope 和 embedding 写入 VectorStore。
5. 查询时同时执行语义检索、关键词检索和实体检索。
6. 合并多种分数后返回最相关的记忆。

主要入口：

| 模块                         | 职责                                         |
| ---------------------------- | -------------------------------------------- |
| `src/Memory/Memory.ts`     | `MemoryTool` 的写入、提取、检索和删除逻辑  |
| `src/Memory/Embedding/`    | 调用 embedding API 生成向量                  |
| `src/Memory/VectorStore/`  | 保存向量、payload 和 BM25 关键词数据         |
| `src/Memory/runtime.ts`    | 记忆开关、预算和身份配置                     |
| `src/Tools/MemorySearch/`  | 旧版主动搜索、向量服务延迟初始化和范围过滤   |

旧 `HistoryStore/` 曾提供独立的历史辅助存储，但没有接入现存调用链，已删除。保留的 VectorStore 实现有自己的 SQLite 表。没有加载方的中文旧提示词 `promptCN.ts` 也已删除。

## 2. 旧版写入流程

旧版 `MemoryTool.add()` 支持两种模式：

- `infer = false`：直接把输入消息作为记忆写入数据库。
- `infer = true`：先读取相关旧记忆和最近上下文，再通过一次 LLM 调用抽取、合并或关联记忆。

在 `infer = true` 时，内部大致是以下阶段：

```text
当前消息 + 最近最多 20 条上下文
        |
        v
用 embedding 查找相似旧记忆
        |
        v
LLM 生成结构化记忆数组
        |
        v
为新记忆批量生成 embedding
        |
        v
hash 去重 + UUID 映射 + linked_memory_ids
        |
        v
写入 VectorStore
```

旧版会把数据库中已有的 UUID 映射为较短的数字 ID，再交给 LLM 使用，目的是减少
模型直接伪造数据库 ID 的可能性。提取结果使用类似下面的结构：

```json
{
  "memory": [
    {
      "id": "0",
      "text": "用户偏好简洁的实现说明。",
      "attributed_to": "user",
      "linked_memory_ids": []
    }
  ]
}
```

## 3. 旧版检索流程

旧版 `MemoryTool.search()` 不是简单的向量相似度查询，而是组合多个信号：

```text
query
  |
  +--> embedding 语义检索
  |
  +--> BM25 关键词检索
  |
  +--> 实体提取 -> entity vector 检索 -> entity boost
  |
  v
综合打分和 threshold 过滤
  |
  v
返回 topK 条 MemoryItem
```

综合评分包含：

- semantic score：向量相似度。
- BM25 score：关键词匹配分数，经过归一化。
- entity boost：查询实体与记忆实体的关联加分。
- threshold：低于阈值的结果被过滤。
- scope filters：使用 `user_id`、`agent_id` 或 `run_id` 隔离范围。

旧版默认配置中还保留了：

```text
autoInjectTopK = 6
searchThreshold = 0.1
```

这些字段属于旧检索配置。当前文件型 selector 使用的是“最多选择 5 个文件”，而
不是旧版的 topK 条目注入。

## 4. `MemorySearch` 工具

旧版通过 `src/Tools/MemorySearch/` 提供主动搜索工具。它的输入包括：

```json
{
  "query": "需要查询的长期记忆内容",
  "topK": 8,
  "scope": "user",
  "threshold": 0.1
}
```

工具调用后返回匹配的记忆文本和分数，例如：

```text
Found 2 matching long-term memories.
1. [memory-id score=0.912] 用户偏好简洁的实现说明。
2. [memory-id score=0.731] 项目使用 TypeScript。
```

它与当前 selector 召回有本质区别：

| 对比项   | 旧版 MemorySearch               | 当前文件型召回                        |
| -------- | ------------------------------- | ------------------------------------- |
| 触发方式 | 主模型主动调用工具              | 当前用户请求时由系统选择性召回        |
| 存储     | VectorStore / SQLite            | Markdown topic 文件                   |
| 选择单位 | 单条数据库记忆                  | 一个 topic 文件                       |
| 召回方式 | embedding + BM25 + entity boost | manifest + selector LLM               |
| 结果范围 | `topK` 条记录                 | 最多 5 个文件                         |
| 正文限制 | 由工具结果和数据库结果控制      | 单文件 200 行 / 4 KiB，session 60 KiB |
| 来源追踪 | metadata 中的 scope 和时间字段  | frontmatter 中的`originSessionId`   |
| 冲突处理 | 依赖提取 LLM 和 hash/linked IDs | AutoDream 显式纠正、合并或删除 topic  |

当前默认工具列表没有把 `MemorySearch` 注册为主模型工具，因此它不会像普通工具一
样自动出现在当前主循环的 tool schema 中。

## 5. 为什么废弃这条方案

### 5.1 基础设施和依赖更重

旧方案需要同时维护：

- embedding API 配置和调用失败处理。
- VectorStore 和 SQLite 文件生命周期。
- 数据库 schema、向量维度和模型切换兼容。
- BM25、分词、实体抽取和多路分数融合。
- scope filter 与数据库记录清理。

这让一个本来可以通过 Markdown 文件完成的能力，引入了较重的数据库和模型依赖。

### 5.2 记忆不容易人工审查

一条记忆主要存在向量库 payload 中。开发者想查看、修改、合并或删除某条记忆时，
需要通过工具或数据库 API，而不是直接打开一个文件。

### 5.3 冲突和过期处理不够明确

向量相似度只能说明“可能相关”，不能决定哪一条事实更新，也不能天然表达：

- 新事实覆盖旧事实。
- 用户要求忘记某条记忆。
- 某条记忆只适用于某个项目。
- 某条记忆的来源 session 是什么。

旧版虽然有 hash、scope 和 linked memory 辅助字段，但缺少一个清晰、可审计的正式
记忆维护流程。

### 5.4 自动注入边界不够清晰

旧版配置中的 `autoInjectTopK` 和 `searchThreshold` 容易让人误以为所有相关数据库
记录都应该直接进入主模型上下文。长期记忆一旦被错误召回，就会形成隐性的上下文
污染，且不容易知道它为什么被选中。

### 5.5 不利于与 AutoDream 对齐

当前设计需要把“信号收集”和“正式记忆整理”分开：

```text
MemorySave / background extraction
        |
        v
append-only daily log
        |
        v
manual AutoDream
        |
        v
topic memory + MEMORY.md
        |
        v
manifest selector 按需召回
```

旧版的写入流程更接近“收到消息后立即抽取并写入数据库”，没有天然的 daily log
中间层，也不符合当前手动 AutoDream 的维护边界。

## 6. 为什么暂时保留代码

目前没有直接删除 `src/Memory/Memory.ts`、VectorStore、Embedding 和
`MemorySearch`，主要原因是：

- 避免破坏已有测试和外部调用。
- 保留历史实现，方便对比数据库检索和文件检索的性能。
- 允许未来做 benchmark 或迁移工具。
- 旧 runtime helper 仍可能被少量兼容代码引用。

但维护新功能时，应优先修改以下当前链路：

- `src/Memory/file-memory.ts`
- `src/query/long-term-memory.ts`
- `src/Tools/MemorySave/`
- `src/Memory/auto-dream.ts`

不要把新的自动召回逻辑重新接回旧的 `MemoryTool.search()`，除非明确要做独立的
检索 benchmark 或兼容 API。

## 7. 迁移关系

旧版概念与当前方案的对应关系如下：

| 旧版                                   | 当前方案                                        |
| -------------------------------------- | ----------------------------------------------- |
| VectorStore 中的一条记忆               | 一个正式 topic Markdown 文件                    |
| embedding 检索                         | topic frontmatter manifest + selector           |
| `MemorySearch` 工具                  | 系统级按需召回；仍可保留独立工具做兼容或实验    |
| LLM 立即抽取并写库                     | daily log 暂存，手动 AutoDream 整理             |
| `user_id / agent_id / run_id` filter | project memory directory + frontmatter metadata |
| hash/linked memory 去重                | topic 合并、来源追踪和手动纠错                  |
| 数据库 payload metadata                | YAML frontmatter +`originSessionId`           |

## 8. 结论

旧方案不是“完全错误”，它适合需要高召回、语义检索和结构化数据库查询的场景。
但对当前 OpenCat 的长期记忆目标而言，文件型方案更容易：

- 查看和人工修改。
- 保存来源和项目范围。
- 处理纠错、遗忘和过期信息。
- 通过 daily log 与 AutoDream 解耦写入和整理。
- 对主模型上下文设置明确的文件级和 session 级预算。

因此，当前项目将旧向量方案定位为兼容/实验路径，将 Markdown + daily log + 手动
AutoDream 作为主路径。
