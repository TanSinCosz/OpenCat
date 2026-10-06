# 持久化导航

这些模块保存不同对象。修改恢复行为前，先确定数据的来源和保存格式。

| 模块 | 保存什么 | 入口与验证 |
| --- | --- | --- |
| `src/transcript/` | 会话消息与 State 快照，恢复会话的来源 | `persistence.ts`；`tests/session-transcript.test.ts` |
| `src/tool-results/` | 较大工具结果的独立存档 | `storage.ts`；`tests/tool-result-persistence.test.ts` |
| `src/session-memory/` | 会话摘要与生成相关状态 | `index.ts`、`persistence.ts`；`tests/query-auto-compress.test.ts` |
| `src/plan/` | 计划内容的保存与恢复 | `persistence.ts`；`tests/plan-tool.test.ts` |
| `src/workspace/` | Git 补丁快照、当前差异、审批与应用 | `patch-snapshot.ts`；Web API 在 `interfaces/web/routes.ts` |
| `src/Memory/` | 跨会话文件记忆 | [记忆模块导航](../src/Memory/README.md) |
| `src/telemetry/` | 运行观测事件 | `observer.ts`、`jsonl.ts`；`tests/telemetry.test.ts` |

浏览器历史消息是 `presentation.ts` 生成的展示视图，不能用于替代 transcript 恢复 State。模型上下文也经过投影和注入，不等同于完整会话记录。

整理存储并实现历史节点分叉的具体改造顺序，见 [会话存储重构方案](session-storage-refactor.md)。Codex 的实际实现对照见 [上下文、持久化与分叉工程说明](codex-context-engineering.md)。
