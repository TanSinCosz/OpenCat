# 长期记忆

当前主路径为文件型长期记忆。**会话摘要属于 `../session-memory/`，不是这个模块。**

| 文件 | 当前职责 |
| --- | --- |
| `file-memory.ts` | 目录与索引、daily log 信号、topic 文件读写与扫描 |
| `auto-dream.ts` | 从日志和 transcript 整理正式记忆，管理 Dream 游标与锁 |
| `runtime.ts` | 长期记忆开关、注入预算与身份配置 |
| `config.ts` | 将统一 YAML 配置适配给旧记忆接口 |
| `../query/long-term-memory.ts` | 主循环中的记忆召回、注入和后台提取 |
| `../Tools/MemorySave/MemorySave.ts` | 模型显式保存记忆信号的工具 |

## 旧检索方案

`Memory.ts`、`type.ts`、`Embedding/`、`VectorStore/`、`LLM/` 和部分 `utils/` 保留数据库 / 向量检索方案。它们仍有 Runtime 类型、适配接口或测试调用，不能仅依据默认工具列表删除。

旧 `HistoryStore/` 和 `promptCN.ts` 已删除：没有入口或兼容工具调用它们。向量记忆实际使用 `VectorStore/` 的 SQLite 存储；当前会话持久化使用 `../transcript/`，不依赖旧 HistoryStore。

`../Tools/MemorySearch/` 使用旧检索方案，但不在默认工具注册表中。它在首次调用时创建向量服务，保存在 `runtime.legacyMemory`；自定义旧配置通过可选的 `runtime.legacyMemoryConfig` 注入。普通会话不需要组装这两个字段。当前文件记忆注入不经过向量搜索。

详细说明：[当前长期记忆](../../docs/long-term-memory.md)、[旧方案](../../docs/long-term-memory-legacy.md)。验证入口：`tests/long-term-memory.test.ts`、`tests/memory-config.test.ts`；Dream 手动入口：`scripts/run-memory-dream.ts`。
