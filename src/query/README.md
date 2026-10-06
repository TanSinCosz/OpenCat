# Query 主循环导航

先读 [../query.ts](../query.ts)：它只编排一次用户查询。`query()` 为异步迭代器的每次恢复绑定 Runtime 的配置；内部的 `runQueryLoop()` 管理轮次、取消和异常。调用方继续从 `src/query.ts` 导入公开接口。

一次查询可以包含多个模型回合。每回合按下面的顺序执行；模型不再请求工具时，查询结束。

```text
prepareMessagesForTurn       准备最终模型输入
  → sampleAssistantTurn     流式响应、保存 assistant 消息
  → executeToolCallsForTurn 执行工具、保存配对结果
  → turn_end                通知调用方本回合结束
  → updateSessionMemoryAtSafeBoundary  按需更新会话摘要
  → 继续下一轮，或 finalizeQuery 收尾
```

## 想改什么，读哪个模块

| 模块 / 关键函数 | 职责与状态影响 |
| --- | --- |
| [turn-context.ts](turn-context.ts) · `prepareMessagesForTurn` | 串联 Phase A/B/C，保存上下文快照，返回本轮投影；是上下文准备的入口 |
| [compression.ts](compression.ts) · `getAutoCompressionRequest` | 根据投影预算判断是否压缩；`applyAutoCompressionWithTelemetry` 调用压缩并记录事件 |
| [request-context.ts](request-context.ts) · `materializeRequestContext` | 压缩后收集通知、技能、计划、Todo 和记忆，替换旧的可变块，追加本轮上下文并清空待注入队列 |
| [assistant-turn.ts](assistant-turn.ts) · `sampleAssistantTurn` | 保存 fork 输入前缀，调用流式响应与推理续接，写入 assistant 消息，响应后清理一次性上下文 |
| [tool-execution.ts](tool-execution.ts) · `executeToolCallsForTurn` | 将相邻并发安全工具分批运行；结果按模型调用顺序写入 State、transcript 和事件流 |
| [tool-permissions.ts](tool-permissions.ts) · `requestToolApprovalIfNeeded` | 启动计划审批并返回待决 Promise，先发审批事件再等待决定；管理查询级命令授权的清理 |
| [session-memory-update.ts](session-memory-update.ts) · `updateSessionMemoryAtSafeBoundary` | 工具结果完整写入后才更新摘要；同一 State 的更新排队，等待前次完成后再检查阈值 |
| [lifecycle.ts](lifecycle.ts) · `finalizeQuery` / `recordQueryFailure` | 正常完成时按需提取长期记忆，完成、轮次上限或失败时保存补丁并记录事件 |

这些是查询阶段的协调模块。更底层的实现继续放在下面的文件和对应业务目录中：

| 文件 | 职责 |
| --- | --- |
| `messages.ts` | 消息投影、工具结果预算、局部压缩、历史裁剪及工具调用配对 |
| `runtime-context.ts` | 上下文消息构造、任务通知与动态技能收集、一次性上下文生命周期 |
| `long-term-memory.ts` | 文件记忆召回、注入预算、查询完成后的提取调度；磁盘操作在 Memory 中 |
| `request.ts` | 把组装后的消息转换为模型请求 |
| `assistant-stream.ts` | 收集模型流式输出，构建 assistant 消息 |
| `reasoning-continuation.ts` | 输出截断后的推理续接 |
| `usage.ts`、`types.ts` | 使用量快照与查询事件、选项、权限契约 |

## 需要保留的顺序与边界

1. **Phase A → B → C**：父到子的指令先写入历史；随后投影并按需压缩；最后生成本轮可变上下文并重建投影。这样新注入的记忆、技能和计划不会被本轮自动压缩吞掉。
2. **业务历史与模型投影**：`State.Messages` 是业务记录，投影是本次模型看到的视图。`forkContextMessages` 是供子智能体继承和摘要使用的业务前缀，区别于包含系统提示等请求头的 `messages`。
3. **fork 首轮**：`usePreprojectedMessagesOnFirstTurn` 允许直接使用继承的投影，`skipRequestContextMaterialization` 控制跳过上下文生成；保留调用方指定的请求前缀。
4. **工具批次**：不安全工具构成串行边界，后面的安全工具不能跨过去。并行工具的完成先后不改变结果的对外顺序。
5. **收尾与清理**：只有正常完成才进行完成后的长期记忆提取；达到轮次上限会返回 `max_turns`，异常记录后原样抛出。正常结束、异常和调用方提前关闭迭代器均清理查询级命令授权。

这里依赖工具执行器、模型适配、记忆、压缩与持久化服务，核心代码不依赖 Web 的消息格式。

验证运行 `npm run test:query`，使用独立 YAML 配置与本地模型替身。生命周期测试覆盖取消、提前关闭、配置隔离、fork 前缀和并行工具结果顺序；其他测试覆盖压缩、上下文、审批、推理续接、通知、持久化及遥测。原理详见 [消息投影](../../docs/projection.md) 和 [上下文注入](../../docs/context-injection.md)。
