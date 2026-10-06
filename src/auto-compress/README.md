# 上下文自动压缩

负责主循环触发的摘要压缩，以及压缩后必须恢复的信息。入口为 `index.ts`，核心执行为 `auto-compress.ts`。

`read-file-restore.ts` 恢复近期读取文件的线索；`invoked-skill-restore.ts` 恢复已经调用的技能。摘要生成和摘要持久化由 `../session-memory/` 配合完成。

消息投影中的工具结果预算、局部压缩和历史裁剪在 `../query/messages.ts`。这里不是所有压缩策略的唯一实现位置。调用顺序从 `../query.ts` 的 Phase B 读起，运行时上下文在压缩后注入。

依赖 State / Runtime、会话摘要和查询消息契约。详细说明见 [压缩文档](../../docs/compression.md)，验证入口为 `tests/query-auto-compress.test.ts`、`tests/read-file-restore.test.ts` 和 `tests/post-compress-context.test.ts`。
