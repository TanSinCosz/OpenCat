# 工具系统

`index.ts` 定义默认注册的 15 个工具；`executor.ts` 统一处理权限、输入校验、执行和结果。添加工具先看这两个文件，再参考一个现有工具。

各工具通常包含实现文件、`type.ts` 输入 / 输出 schema，以及 `prompt.ts` 模型说明。共用协议在 `types.ts`；核心消息和 Runtime / State 契约在 `../types/`。

| 功能 | 位置 |
| --- | --- |
| 文件读写与编辑 | `FileRead/`、`FileWrite/`、`FileEdit/` |
| 搜索与命令执行 | `Grep/`、`Glob/`、`Bash/` |
| 子智能体运行与协作 | `Agent/`、`SendMessage/` |
| 后台任务停止 | `TaskStop/`，与 Bash 后台任务状态配合 |
| 计划与任务状态 | `Plan/`、`TodoWrite/` |
| 技能加载 | `ReadSkill/`、`utils/discoverSkillsForReadPath.ts` |
| 文件记忆保存 | `MemorySave/` |
| 外部内容 | `WebSearch/`、`WebFetch/` |

`MemorySearch/` 是旧记忆检索工具，不在默认注册表中。MCP 工具由 `../mcp/config.ts` 加入，不能把默认工具数量当成最终可用工具数量。

工具操作应使用传入的 Runtime 工作目录与 State，避免读取 Web 全局状态。工具并发安全和权限策略由执行器统一遵守。测试入口为 `tests/tool-executor.test.ts`、`tests/tool-concurrency.test.ts` 和各工具的专项测试；协议详见 [工具文档](../../docs/tools.md)。
