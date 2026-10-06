# Codex 上下文压缩、持久化与历史分叉：工程说明

本文基于项目内 `codex/` 的提交 `b741e480e203f037ca726bc2a76d99a8e8668e66`。分析对象是 Rust core、app-server 和本地 thread-store；并不假定所有版本、云端实现或前端都有相同能力。示意代码省略了无关字段，不能直接作为完整协议对象执行。

`codex/` 是可选的本地参考克隆，已被 Git 忽略，不随 OpenCat 提交。下面的源码链接指向 GitHub 上固定的分析版本，阅读文档不需要先克隆它。

## 1. 先明确三个不同的对象

| 对象 | 核心类型 / 文件 | 管理的内容 |
| --- | --- | --- |
| 当前模型上下文 | `ContextManager`，`core/src/context_manager/history.rs` | 当前窗口内的消息、上下文比较基线、token 信息、窗口改写版本 |
| 持久化历史 | `RolloutLine` / `RolloutItem`，`history/src/lib.rs` | 消息、工具调用、回合事件、压缩检查点、设置与其他运行事实 |
| 用户界面的历史视图 | `thread_turns` / `thread_items`，SQLite 历史库 | 聊天回合、展示项、分页索引，以及回合在日志中的位置 |

`ContextManager.items` 是 `Arc<Vec<ResponseItemEnvelope>>`。只读快照可以共享列表，改写时再处理写时复制；压缩安装后，当前列表被新的窗口替换。当前上下文不会包含整份历史日志中的所有项。

Codex 的 `turn` 通常表示一次用户任务及其模型与工具循环，一轮可以包含多次模型请求。OpenCat 的 `runQueryLoop()` 中 `turn` 是每次模型回合，两个项目的这个名称不能直接对等。

源码入口：[ContextManager](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/context_manager/history.rs)、[历史类型](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/history/src/lib.rs)、[SQLite 初始结构](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/state/thread_history_migrations/0001_thread_history.sql)。

## 2. 持久化格式：保存的是有顺序的事实

`RolloutLine` 的外壳是：

```rust
struct RolloutLine {
    timestamp: String,
    ordinal: Option<u64>,
    item: RolloutItem, // 序列化时 flatten 到本行
}
```

`RolloutItem` 采用带 `type` 的联合类型，常见种类包括：

| 类型 | 含义 |
| --- | --- |
| `session_meta` | 当前 thread 的身份、来源、配置元数据、分叉来源和历史引用 |
| `response_item` | 模型输入或输出项，包括消息和工具调用、结果 |
| `event_msg` | `TurnStarted`、`TurnComplete`、`TurnAborted`、rollback 等事件 |
| `compacted` | 新上下文窗口的恢复检查点 |
| `turn_context` | 回合的上下文设置，供恢复和下一轮差量上下文生成使用 |
| `world_state` | 上下文比较所需的完整基线或后续更新 |
| `token_usage_record` | 使用量记录 |

JSONL 行的外形类似下面这样；`payload` 的具体结构因类型而异：

```json
{
  "timestamp": "...",
  "ordinal": 12,
  "type": "response_item",
  "payload": { "type": "message", "id": "...", "role": "user", "content": [] }
}
```

模型项与本地元数据分开：内存使用 `ResponseItemEnvelope { item, metadata }`；普通 `response_item` 行把模型项放在 `payload`，本地元数据放在同级 `metadata`。恢复时可以同时保留消息身份和原来的截断预算等信息，而不把这些字段混入模型协议。

分页模式使用递增 `ordinal`；旧 Legacy 模式允许没有 ordinal。不能用时间戳或消息文本代替记录序号：同一时刻可以产生多条不同类型的事件。

源码：[wire 序列化](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/history/src/rollout_payload.rs)、[ordinal 分配与恢复](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/rollout/src/ordinal.rs)。

## 3. 普通消息怎么写入

典型的消息写入调用链：

```text
Session::record_conversation_items
  → prepare_conversation_items_for_history
  → record_prepared_conversation_items
      → 分配 / 补齐消息身份与本地元数据
      → state.history.record_annotated_items
      → 包装成 RolloutItem::ResponseItem
      → Session::persist_rollout_items
          → LiveThread::append_items
          → LocalThreadStore::append_items
          → live_writer::write_and_project
              → durable_write
                  → RolloutRecorder::record_canonical_items
                  → RolloutRecorder::flush
              → materialize_to_sqlite（分页模式）
```

这里有四个具体的工程约束：

1. 日志是筛选并规范化后的持久化历史，不是每一个 UI delta、网络字节或未经处理的工具输出。`LiveThread` 与 store 的持久化策略会选择需要保留的记录。
2. `record_canonical_items()` 的返回只表示数据已经送入 `mpsc` 写入队列；单独调用它不能证明后台 writer 已完成写入。
3. `durable_write()` 的 append 路径在入队后显式等待 `flush()`。writer 按顺序处理命令，`Flush` 使用 oneshot 回应此前写入的完成结果。
4. 同一 live thread 的 `write_and_project()` 持有 writer lock，将日志写入和索引更新串行组织。

writer 保存 `pending_items`，只有记录成功写出后才移除队列前缀。发生 I/O 错误时会保留未成功写出的后缀、丢弃文件句柄，重新打开并重试；重试仍失败则返回错误。

这条路径显式使用 `write_all()` 和 `flush()`。不能仅凭这里的 `flush` 就声称实现了每条记录的 `fsync` 或跨 JSONL、SQLite 的原子事务。

需要区分日志中的原始模型项与当前窗口中的副本。`ContextManager::record_item_with_metadata()` 克隆项后，对工具输出副本执行 token 预算截断；`record_annotated_items()` 给外部 envelope 补元数据，但保留其原始 payload。Session 随后持久化这些外部 envelope，并保存当时的截断预算，冷恢复可以按原预算重建窗口。这里的“原始”是调用方传来的 ResponseItem，不能扩大解释为所有命令的无限完整 stdout、网络响应或 UI delta。部分展示用 `ItemCompleted` 事件还有独立的持久化大小限制，例如命令输出和 MCP 结果各有 64 KiB 限制。

新本地 rollout 的常见路径为 `CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`；归档、revert 和存储层文件压缩有另外的路径处理。这种文件压缩与模型上下文总结是两件事。

源码：[Session 写入](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/session/mod.rs)、[LiveThread](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/thread-store/src/live_thread.rs)、[store 写入顺序](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/thread-store/src/local/live_writer.rs)、[后台 writer](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/rollout/src/recorder.rs)。

## 4. SQLite 为什么不是第二份独立真相

分页模式的顺序是：先完成 JSONL 写入，再从日志增量构建 SQLite 历史视图。

`thread_history_projection_state` 保存：

```text
next_rollout_byte_offset  下一次开始读取日志的字节位置
next_rollout_ordinal      下一次预期的记录序号
```

`materialize_to_sqlite()` 从已保存的 offset 开始读新增记录；`apply_projection()` 在一个 `BEGIN IMMEDIATE` 事务中同时：

- 更新 `thread_turns`、`thread_items` 等历史视图。
- 推进 offset 和 ordinal 检查点。
- 提交事务。

如果事务失败，索引和检查点不会只推进一半。store 的写入路径允许 SQLite 投影失败后暂时落后于日志，下次再补建；不允许索引领先于尚未完成写入的日志。普通写入路径记录投影错误并继续，分叉准备流程则会等待必要的索引补建成功再定位边界。

这解决了两个问题：UI 可以分页读取已物化的回合；后续恢复和分叉可以将回合 ID 定位到日志位置，而不必靠搜索正文。

源码：[增量物化](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/thread-store/src/local/thread_history_materialization.rs)、[事务更新](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/thread-store/src/local/thread_history.rs)。

## 5. 上下文压缩什么时候触发

`context_window_token_status()` 计算当前窗口的 token 状态，而不是简单累加整场聊天所有历史请求的计费 token。

当前使用量依据最近模型响应的 `last_token_usage`，再估计其后新增项；在需要时还补计历史推理项。阈值有两种范围：

- `Total`：当前完整上下文的使用量。
- `BodyAfterPrefix`：当前窗口的使用量减去该窗口的初始 prefill 基线。

与此同时，模型可用上下文窗口仍是独立上限。`token_limit_reached` 会综合配置预算、fallback buffer 和完整窗口上限；配置还可以开启回合结束后的提前压缩阈值。

调用点包括请求前的 `run_pre_sampling_compact()`，以及工具续接过程中的 MidTurn 压缩；代码还支持手动压缩和配置控制的 PostTurn 压缩。这不是每次采样都无条件生成一次摘要。

### 5.1 实际阈值公式与默认值

记 `W = model_info.resolved_context_window()`，它先取 `context_window`，缺失时取 `max_context_window`。配置中的窗口 override 会先通过 models-manager 应用，不能拿模型最大容量直接代替正在使用的窗口。

`ModelInfo::auto_compact_token_limit()` 的计算是：

```text
已知 W：L_model = min(模型 / 配置的 auto_compact_token_limit（若有）, floor(W × 90%))
未知 W：L_model = 模型 / 配置的 auto_compact_token_limit（若有）

完整可用窗口 H = floor(W × effective_context_window_percent / 100)
effective_context_window_percent 的反序列化默认值为 95
```

`model_auto_compact_token_limit` 会覆盖 ModelInfo 对应字段，随后 `Total` 模式仍经过上述 90% 限制。`BodyAfterPrefix` 模式在 context-window 判断器中优先直接使用显式配置的 limit，所以它与 Total 的上限裁定不同；完整上下文 H 仍独立生效。

令 `U = active_context_tokens`，`P = 当前窗口 prefill 基线`：

```text
默认 Total：           S = U，L = L_model
BodyAfterPrefix：      S = saturating_sub(U, P)，L = 显式配置 limit 或 L_model
                     P 尚未建立时以 U 为基线，当前增量记为 0

B = fallback buffer；只有配置了 fallback prompt 才可能非 0

token_limit_reached = (L 存在 且 S >= L + B)
                  或 (H 存在 且 U >= H)
```

注意 buffer 在代码里是加到 scope limit 上，不能说成“统一减掉一段窗口”。常规无 fallback 配置时 `B = 0`。

`model_post_turn_compact_threshold_percent = Q` 默认是 0，表示不启用这个提前压缩策略。`Q > 0` 时，任务结束检查满足 `token_limit_reached` 或 `U × 100 >= H × Q` 即达到阈值；实际调用还要求未启用 TokenBudget、没有待处理输入、未取消。

### 5.2 具体数字

假设 W 为 272,000，使用默认 Total，没有显式 auto limit、fallback buffer 或 PostTurn 配置：

```text
常规自动压缩预算：244,800 = 272,000 × 90%
完整可用窗口：    258,400 = 272,000 × 95%

U = 240,000：未达到常规压缩预算
U = 244,800：达到预算，下一次符合条件的检查会触发
U = 252,000：超过预算，即使尚未达到完整窗口也会触发
```

这是用本地 catalog 窗口值构造的可复算例子，不是对本机某次聊天运行状态的测量。远程 catalog、用户配置与提供方能力都可能改变实际值。

配置 auto limit 为 200,000，则 Total 的预算为 200,000；配置为 300,000，则仍被裁定为 244,800。若另设 `Q = 80`，任务结束的提前阈值是 `258,400 × 80% = 206,720`。

BodyAfterPrefix 例子：`P = 80,000`、增量 limit 为 `100,000`、无 buffer，则 U 到 180,000 时增量预算达到阈值；如果显式增量 limit 很大，U 仍不能越过完整可用窗口 258,400。

### 5.3 在哪些时点执行检查

| 时点 | 触发条件与结果 |
| --- | --- |
| 新用户任务开始、普通采样前 | 已记录上下文达到阈值，执行 PreTurn 压缩 |
| 一次模型采样及工具执行结束后 | `needs_follow_up` 且达到阈值或收到新窗口请求，执行 MidTurn 压缩，再继续采样 |
| 用户任务准备结束 | Q 大于 0、达到对应阈值且其他条件允许，执行 PostTurn 压缩；失败通常保留已完成回答 |
| 模型切换 | 压缩兼容 hash 改变，或切换到更小窗口且旧上下文过大，可以先用上一模型压缩 |
| 手动 compact | 用户请求触发，不必等待 token 阈值 |

如果模型已完成任务、没有续接且 Q 为 0，即使此时达到常规预算，也不一定立即压缩；下次 PreTurn 检查可以触发。

`run_turn()` 明确在新用户消息及上下文更新写入前运行 PreTurn 检查。该处 TODO 提醒需要估计待加入输入：不能声称这版实现已经在每次普通请求前精确预测了包括新输入在内的完整大小。Guardian 还有专门的 overflow 处理路径，不能扩大为所有请求的通用保障。

源码：[模型阈值与 95% 默认](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/protocol/src/openai_models.rs)、[配置 override](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/models-manager/src/model_info.rs)、[scope 默认 Total](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/protocol/src/config_types.rs)、[PostTurn 与 buffer 配置](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/config/mod.rs)。

源码：[token 状态判断](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/session/context_window.rs)、[当前窗口使用量](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/context_manager/history.rs)、[触发与路由](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/session/turn.rs)。

## 6. 压缩怎么执行、如何安装

`run_auto_compact()` 根据特性和提供方能力分派。启用 `TokenBudget` 时有单独的窗口重置路径；下面说明通常的总结型压缩路径。

### 本地摘要路径

```text
run_inline_auto_compact_task
  → 使用 compact_prompt / SUMMARIZATION_PROMPT
  → 请求模型生成摘要
  → 收集真实用户消息
  → build_compacted_history
      → 按预算选择近期用户消息
      → 必要时截断文本并保留对应元数据
      → 在最后追加摘要
  → replace_compacted_history
```

本地构建用户消息部分的默认上限在该源码里是 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`。它并不承诺保留此前的每条 assistant 和工具结果；这些内容主要由摘要承接。压缩请求本身超过窗口时，会移除最旧输入并重试，其他失败有重试与取消分支。

“本地”指客户端组织总结请求，不是离线运行模型。默认提示要求生成供下一模型继续任务的交接摘要，覆盖进度、关键决定、约束和用户偏好、下一步以及必要资料；用户可以配置 `compact_prompt`。保留用户消息时从最近消息向前分配 20,000 token，再恢复原顺序。20,000 是保留用户消息部分的预算，不是最终新窗口或摘要的固定总长度。

总结用提示只添加到克隆的 history 中，未通过 Session 的正常消息持久化路径记录。非 PostTurn 的总结输出则会作为带 `compaction_output` 元数据的模型项记录；PostTurn 路径先在局部收集输出，成功后才安装检查点，减少失败时对已经完成的历史的影响。最后还会把带摘要前缀的 user-role 摘要写入 replacement history。

### 远程 V2 路径

这一版源码的具体链路是：

```text
run_remote_compact_v2_attempt
  → clone 当前 history
  → 需要时缩减工具输出，使压缩请求能装入窗口
  → 构建 Prompt
  → 在 input 末尾追加 ResponseItem::CompactionTrigger
  → ModelClientSession::stream
  → collect_compaction_output
      → 必须收到 response.completed
      → 必须恰好收到一个 ResponseItem::Compaction
  → build_v2_compacted_history
      → 按策略和预算保留部分输入项及元数据
      → 追加 compaction 输出项
  → replace_compacted_history
```

因此，分析这版代码时不能把远程压缩一概说成固定调用 `/responses/compact`。这里检查到的实现使用流式客户端和专门的触发 / 输出项。远程压缩项可以是不透明状态，不能按普通摘要正文解析。

该版 `ResponseItem::Compaction` 的字段包括 `encrypted_content: String`；客户端仓库展示了请求、校验、保留项构建及持久化，未展示服务端如何生成加密内容的内部算法。不能把它描述成已知的逐条消息压缩算法。

客户端保留真实用户 / Hook prompt 消息、特性允许的 client-authored developer 消息，以及符合条件的小型协作消息。保留部分由 `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000` 限定，近期项优先；摘要 / compaction 输出另行追加。因此，64,000 也不是最终窗口总预算，图片计费还受特性控制。`CompactionTrigger` 在返回前从请求输入副本中移除，持久化 policy 也明确拒绝把它保存成普通 ResponseItem。

`TokenBudget` 路径则跳过模型 / 服务端摘要：`start_new_context_window()` 重建初始上下文和 world-state，按特性保留部分 client developer 消息，仍通过 `replace_compacted_history()` 保存窗口检查点。若使用 Notes 等扩展，初始上下文可以再包含相关提示，但不能说旧聊天必定自动总结到新窗口。

### 两条路径共用的安装边界

`Session::replace_compacted_history()` 的实际顺序是：

1. 给新窗口内缺失 ID 的项补齐 ID。
2. 获取设置持久化锁，避免并发设置更新与检查点互相覆盖。
3. 持有 Session state 锁；保留压缩输入快照后新接受、且未被新窗口覆盖的 goal 更新。
4. 从最终消息列表克隆 `replacement_history`，将同一份内容安装到 `state.history`。
5. 构造 `CompactedItem`，包含消息列表、窗口编号与 ID、使用量记录、恢复元数据等。
6. 依次写入 `Compacted`，以及适用的 WorldState、TurnContext 和当前设置事件。
7. 调用方重新计算上下文使用量，并发出压缩完成事件。

安装发生在内存替换之后、持久化调用之前，内存与文件不是一个跨介质事务。`persist_rollout_items()` 可以返回 false，安装函数没有把这个结果转换成返回给调用方的错误；不能把“压缩完成事件”独立当成检查点必定持久化成功的证明。

`CompactedItem` 保存的是完整的新上下文窗口，不只是“哪些消息曾经压缩过”的标记。内存中它保存 `Vec<ResponseItemEnvelope>`；wire 格式将 `replacement_history` 与按位置对应的 `replacement_history_metadata` 分开保存。

关键恢复字段可以按下面的用途阅读；这是字段摘录，不是完整类型定义：

```rust
CompactedItem {
    message,                 // 本地摘要等路径的说明 / 摘要文本
    replacement_history,     // 安装后实际使用的新上下文项
    window_number,           // 当前窗口编号
    first_window_id,
    previous_window_id,
    window_id,               // 窗口身份及其关系
    compaction_response_id,  // 适用路径的服务端响应身份
    latest_token_usage_record,
    resume_metadata,         // multi_agent_version、last_started_turn_id、previous_turn_settings
    // guardian_history、retained_context、mcp_resource_origins 等辅助恢复数据
}
```

`message` 不能代替 `replacement_history`：远程 compaction 可能包含不透明状态，保留输入项的选择也已经体现在 replacement history 中。窗口 ID 与 token 使用量则解释“当前处于哪个窗口、这个窗口用了多少”，不能把旧计费累计值直接当作新窗口长度。

初始上下文的注入也有顺序约束：PreTurn / 手动路径可以清空参考基线，下一轮重新注入；MidTurn 路径会把必要初始上下文放到最后真实用户消息之前，使压缩项继续保持预期的末尾位置。

源码：[本地摘要](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/compact.rs)、[远程请求准备](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/compact_remote_v2_attempt.rs)、[远程输出校验与窗口构建](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/compact_remote_v2.rs)、[安装与持久化](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/session/mod.rs)、[检查点 wire 格式](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/history/src/rollout_payload.rs)。

## 7. 普通恢复：先确定窗口，再重放后缀

分页路径的读取流程：

```text
load_latest_model_context
  → 解析当前 rollout 与继承的 lineage
  → 从最新 segment 开始倒序扫描
  → 遇到可独立恢复的 Compacted 检查点时停止
  → 将收集到的检查点及其后缀恢复为时间正序
  → Session::reconstruct_history_from_rollout
```

`ModelContextScan` 的停止条件同时要求 `replacement_history` 和 `window_number` 存在。如果最新压缩项缺少这些字段，它会进入完整重放模式；不能跳过这个不完整项，只选更旧的检查点。core 对非分页旧格式还有 `resume_metadata` 等兼容判断。

重建时先安装选中检查点的 `replacement_history`，再重放之后的 ResponseItem、协作消息等增量；同时恢复窗口标识、参考上下文、world-state 基线和使用量等辅助状态。

存在 rollback 时，重建器还倒序识别回合段和被回滚的用户回合，选择仍然有效的检查点和上下文基线。不能把所有场景简化成“取文件最后一条 compacted 即可”。

模型恢复的典型成本是检查点及新后缀的读取与重建；没有可用检查点或遇到兼容情形时，仍可能完整重放。这与 UI 的全历史分页查询是不同读取路径。

几个异常必须分别处理：

| 情形 | 此处源码的处理 / 工程含义 |
| --- | --- |
| 最新压缩记录缺少完整恢复字段 | 完整重放，不能越过它直接使用更早检查点 |
| JSONL 写入失败 | writer 重试并返回写入结果；Session 的普通持久化包装会记录错误并返回 false |
| SQLite 物化失败 | 普通写入允许索引落后；分叉边界准备需要补建成功 |
| 内存已安装新窗口、检查点持久化失败 | 此路径没有跨内存与日志的回滚事务；完成事件不等同于持久化确认 |
| 有 rollback 事件 | core 重建器按有效回合段恢复，不能无条件采用最后一条压缩记录 |

源码：[model-context 读取](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/thread-store/src/local/model_context.rs)、[倒序停止条件](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/rollout/src/model_context.rs)、[实际重建](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/session/rollout_reconstruction.rs)。

## 8. 分叉 API：把用户选择转换为稳定边界

`ThreadForkParams` 提供三种边界选择：

| 参数 | 继承范围 | 校验 |
| --- | --- | --- |
| `lastTurnId` | 包含指定回合，排除后续历史 | 指定回合不能为 `inProgress` |
| `beforeTurnId` | 在指定回合开始前截止 | 与 `lastTurnId` 互斥；源码标为实验性 |
| 两者省略 | 使用当前已持久化的历史范围 | 未完成回合按中断快照语义处理 |

服务端入口为 `thread_processor::thread_fork_inner()`。它先读源 thread 的 history mode，再分派：

- Legacy：读取已有 rollout，调用 `truncate_rollout_after_turn_id` 或 `truncate_rollout_before_turn_id`，复制选定历史到新 thread。
- Paginated：调用 thread-store 的 `prepare_fork()`，构造引用式分叉。

Legacy 指定边界需要真正持久化的 `TurnStarted`。旧记录展示时临时生成的 turn ID，并不一定能作为可分叉的稳定边界。

新分支配置是独立派生的。模型历史受 cutoff 约束，但部分运行配置会有意继承源 thread 的最新设置，或接受调用方 override。不能把“从旧节点分叉”解释成对所有权限、模型和运行配置都做时间回滚。

源码：[协议参数](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)、[服务端分派](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/app-server/src/request_processors/thread_processor.rs)、[Legacy 截取](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/thread_rollout_truncation.rs)。

## 9. 分页分叉：turn ID 如何变成日志位置

`paginated_fork::prepare()` 的顺序：

1. 获取源 thread 的 lifecycle reservation，在分叉准备和引用物化期间保护源资源。
2. 对 live writer 执行 `persist_thread()`，再解析可引用的历史 lineage。
3. 指定历史节点时，补建涉及的祖先历史索引；补建源 rollout 的 SQLite 历史视图。
4. 持有源 writer lock，通过 `history_base_at_boundary()` 查询目标回合位置。
5. 固定 `HistoryPosition` 后释放该 writer lock，再从固定前缀加载模型上下文。
6. 返回 `PreparedFork`；其生命周期继续携带 source reservation，供新 thread 创建过程使用。

分叉位置信息是：

```rust
struct HistoryPosition {
    thread_id: ThreadId,
    end_ordinal_exclusive: u64,
    end_byte_offset: u64,
}
```

这里 `thread_id` 的历史字段名称容易误导：实际含义是被引用的 **rollout ID**。通常它等于 thread ID，但 `thread/revert` 可以让同一个稳定 thread ID 指向新的 rollout 文件，所以两个身份不能完全混用。

SQLite 的回合记录包含起止位置：

```text
rollout_ordinal             回合开始记录序号
rollout_byte_offset         回合开始字节位置
rollout_end_ordinal         回合终结记录序号
rollout_end_byte_offset     回合终结记录后的字节位置
```

`ThroughTurn` 取 `end_ordinal + 1` 和 `end_byte_offset`；`BeforeTurn` 取开始 ordinal 和开始 offset。记录序号用于逻辑范围和分页，字节 offset 让文件读取能直接停在该范围。

例如边界为 `{ rolloutId: A, endOrdinalExclusive: 20, endByteOffset: P }`，就只继承 A 中 cutoff 之前的范围；A 后续追加了 ordinal 20、21、22，也不会改变这个分叉的已冻结前缀。

源码：[准备、锁与边界换算](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/thread-store/src/local/paginated_fork.rs)、[HistoryPosition](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/protocol/src/protocol.rs)、[回合位置迁移](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/state/thread_history_migrations/0003_turn_rollout_positions.sql)。

## 10. 子文件不复制父历史：history_base 与 lineage

引用式分支的 `SessionMeta` 记录 `history_base`，并记录逻辑上的 `forked_from_id` 和 `forked_from_ordinal_exclusive`。这几项并不完全等同：history_base 是物理历史读取来源，forked_from 描述逻辑分叉来源。

`ThreadManager::fork_prepared_thread()` 创建 `ForkPersistence::Referenced`，其中包含 `history_base` 和 `inherited_item_count`。

启动子 thread 时：

```text
继承的模型上下文 → 用于恢复子 thread 内存
继承的日志项     → 从子 thread 待写入列表中 drain 掉
子设置、中断边界和后续新项 → 写入子 thread 自己的 rollout
```

所以子文件可以没有父用户消息正文，而子模型请求仍然能使用父消息。源码测试专门检查了这两个结果。

读取历史时，`resolve_rollout_lineage()` 沿 `history_base` 向祖先走，校验范围与环，生成有序 segment 列表。嵌套分叉可以表示为：

```text
A 的固定前缀
  ＋ B 的固定本地增量
  ＋ C 当前自己的增量
```

新子 rollout 的首条 SessionMeta 使用继承截止 ordinal，之后本地项递增；lineage 的本地历史 segment 从 SessionMeta 之后开始，避免把子元数据算入继承正文。

这节约复制开销，但带来真实引用依赖。删除路径检查外部分支引用，不能在仍被分支依赖时直接删除父 rollout。项目要采用同类机制，也必须同时设计删除、归档与引用管理。

源码：[ThreadManager 分叉](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/thread_manager.rs)、[子启动去除继承项](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/session/mod.rs)、[lineage 解析](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/thread-store/src/local/rollout_lineage.rs)、[删除引用校验](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/thread-store/src/local/delete_thread.rs)。

## 11. 压缩与历史分叉交叉时，如何避免带入未来信息

假设事件顺序为：

```text
T1 → T2 → T3 → C1（压缩 T1~T3）→ T4 → T5
```

从 T2 结束处分叉时，C1 在 cutoff 之后。不能复用最新 C1，即使它让当前上下文更短，因为摘要已经包含 T3 的信息。

分页代码的顺序是：

```text
load_for_fork(lineage, history_base)
  → lineage.truncate_at(history_base)
  → scan_model_context_from_lineage
      → ReverseJsonlScanner::new_at(end_byte_offset)
      → 从 cutoff 向前找可恢复的 Compacted 检查点
```

分叉在 C1 之前：找更早检查点，或者从起点恢复到 T2。

分叉在 T4 之后：可使用 C1，再重放它之后到 T4 截止范围内的记录。

因此，正确顺序是 **先固定历史范围，再选择该范围内的上下文检查点**。先恢复最新摘要再截断消息列表，无法移除摘要里已经包含的未来信息。

如果省略边界、源快照停在未完成回合，`ForkSnapshot::Interrupted` 会在子快照中追加中断上下文标记及 `TurnAborted`。它表达的是子分支继承了一个未完成任务；这段函数修改的是 fork history，不能据此声称已经真正取消源 thread 的运行。

下一次模型请求还有调用 / 结果配对归一化，不能仅按屏幕上的一条 assistant 文本截取工具循环。公开 API 的回合边界语义，也不等于支持在任意流式 token 中间精确分叉。

源码：[固定前缀后扫描](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/thread-store/src/local/model_context.rs)、[有截止 offset 的反向扫描器](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/rollout/src/reverse_jsonl_scanner.rs)、[子快照中断边界](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/thread_manager.rs)、[消息配对归一化](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/context_manager/history.rs)。

## 12. 对照 OpenCat：需要迁移的具体能力

OpenCat 当前也有消息日志和状态快照，方向相近，但 `loadStateFromTranscript()` 是读取记录、合并各字段的最新快照，再恢复整个会话。它没有在这个接口上接收历史 cutoff。

| 能力 | OpenCat 当前情况 | 要实现历史节点分叉需要补什么 |
| --- | --- | --- |
| 历史定位 | 有本地消息 ID 和快照，不能直接等同于 Codex 回合位置索引 | 持久化用户任务级 turn ID、开始和终结边界；先以日志序号定位即可 |
| 截止恢复 | 合并整份日志中各字段的最新快照 | 在读取 / 合并前应用 cutoff，只合并范围内的状态 |
| 上下文恢复基线 | 摘要、工具替换、historySnips 分别保存 | 为给定节点明确有效的摘要、替换表、裁剪边界；或新增完整上下文检查点 |
| 分支身份 | Agent fork 是执行模式，不能自动代替用户聊天分支协议 | 独立 session ID、来源 session 与稳定 cutoff，并接入 Web 会话管理 |
| 状态变更写入 | projection snapshot 目前按应用统计判断 | 依据状态是否实际变化决定写入，避免每轮重复保存相同替换表 |
| 历史共享 | 尚未采用同类引用式历史机制 | 初版可复制范围内的日志；有规模需求后再实现引用、归档和删除管理 |

推荐第一版先实现复制式分叉，复用现有 transcript 恢复能力。关键不是先引入 SQLite，而是实现可验证的截止恢复契约：

```ts
// 建议接口，尚未在当前 OpenCat 实现。
restoreSessionAt(sourceSessionId, cutoff)
forkSession({ sourceSessionId, cutoff, configOverrides })
```

`restoreSessionAt` 的消息、摘要、裁剪、工具替换、计划和 Todo 等会话状态，都要明确截止范围；MCP 客户端、连接、审批 Promise、正在运行的任务等瞬时资源则需为新 session 重新组装，不能直接复制活动 Runtime。

OpenCat 的 `query/turn-context.ts` 依然可以按现有 Phase A/B/C 构建请求。采用检查点并不要求马上把所有投影代码换成 Codex 的内部结构。

对应源码：[OpenCat 整体恢复](../src/transcript/persistence.ts)、[Query 上下文准备](../src/query/turn-context.ts)、[Web 会话组装](../src/interfaces/web/session-manager.ts)。

## 13. 源码中可对照的测试与我们需要的验收条件

本次检查阅读了相关实现与测试断言，没有执行 Codex Rust 测试，也没有测量其性能。源码提供这些值得参考的行为测试：

| 文件 / 测试 | 验证内容 |
| --- | --- |
| `core/tests/suite/compact_resume_fork.rs` · `compact_resume_and_fork_preserve_model_history_view` | 压缩、关闭、恢复、分叉后，模型历史前缀仍符合预期 |
| 同文件 · `compact_resume_after_second_compaction_preserves_history` | 分支再次压缩后再恢复，上下文仍正确 |
| `thread-store/src/local/model_context_tests.rs` · `fork_context_excludes_items_after_frozen_cutoff` | 捕获截止位置后父历史继续追加，新内容不进入分叉上下文 |
| 同文件 · `returns_scanned_full_history_for_unsupported_compaction` | 检查点缺字段时完整重放，不错误跳过新压缩 |
| 同文件 · `replays_nested_archived_lineage_from_frozen_prefix` | 嵌套与归档的引用历史仍按固定前缀组合 |
| `app-server/tests/suite/v2/thread_fork.rs` · `thread_fork_creates_reference_backed_paginated_thread` | 子文件不复制父正文，但模型请求仍包含继承上下文 |
| 同文件 · `paginated_thread_fork_at_named_boundaries_keeps_only_terminal_prefix` | 指定回合前后边界的截取与后续继续正确 |
| 同文件 · `thread_fork_freezes_active_paginated_turn_as_interrupted` | 未完成回合的分叉具有明确中断语义 |
| `rollout/src/recorder_tests.rs` · `writer_state_retries_write_error_before_reporting_flush_success` | writer 错误恢复与 flush 结果符合预期 |

OpenCat 初版至少应验证：从压缩前和压缩后各分叉一次；分支冷恢复前后模型输入相同；父会话后续消息不进入子会话；子写入不改变父状态；工具调用配对完整；模型及权限 override 按明确规则生效；日志或快照恢复失败时，不宣称分叉成功。

官方文档可补充查看 [App Server 的 thread/fork](https://learn.chatgpt.com/docs/app-server) 与 [Compaction](https://developers.openai.com/api/docs/guides/compaction)。具体实现以本文绑定的本地源码提交为准。

## 14. 临时上下文：什么进入日志，什么只存在于请求

“临时”至少有两种含义：内容会变化，或者只用于发出某一次请求。Codex 没有把两者统一视为“不存储”。应分别判断模型可见消息、恢复所需状态和请求控制。

| 内容 | 本地源码处理 | 冷恢复 / 后续请求的含义 |
| --- | --- | --- |
| 用户、assistant、工具调用与结果 | 普通 ResponseItem 持久化；工具窗口副本可按预算截断 | 重放会话事实，并重建模型可用历史 |
| AGENTS.md、环境、权限等上下文 | 渲染为带角色及内容类型的上下文消息，普通写入日志；另写 WorldState / TurnContext | 保留当时模型所见状态，恢复差量比较基线 |
| Skill / 插件注入消息 | `run_turn()` 把 injection_items 交给 record_conversation_items | 此类注入不因由系统生成就变成不可持久化内容 |
| Hook additionalContext | 构造 developer 消息，交给 record_conversation_items | Hook 的补充内容进入历史；HookStarted / HookCompleted 通知本身属于非持久化事件 |
| 客户端 additionalContext | 按 key 比较变化，转成 user / developer ResponseItem，再走正常输入记录 | 当前相同值不会由这个合并器重复生成；这是客户端补充上下文，不是所有上下文的统一存储算法 |
| 普通请求基础 instructions 和工具 schema | 作为 Prompt 字段；Responses Lite 会在请求 input 副本前插入重建的项 | 这条注入路径不会自动追加普通聊天日志；配置 / 工具状态另有管理路径 |
| 本地压缩专用提示 | 只加入克隆的 history | 控制一次总结，不作为真实用户要求持久保留 |
| 远程 CompactionTrigger | 请求末尾加入，返回前移除；policy 返回 false | 不进入未来普通对话 |
| 流式 delta、开始通知、审批请求等 | rollout policy 对这些 EventMsg 返回 None | 存最终结果或稳定事实，不把所有过程 UI 通知当历史 |

`record_context_updates_and_set_reference_context_item()` 的算法：

```text
没有 reference baseline：
  从本次 StepContext + WorldState 生成完整初始上下文
  → 记录模型可见消息
  → 写 WorldState full
  → 写 TurnContext

有 reference baseline：
  对比当前 WorldState 与旧 baseline
  → 只生成变化的模型可见片段
  → 记录这些片段
  → 写 WorldState merge patch（若有变化）
  → 按回合记录 TurnContext
```

world-state 可以改变而不产生可见消息，此时仍可能保存 patch，却不需要重复 TurnContext。模型采样步骤中的动态变化还有 `record_step_world_state_if_changed()`，同样先记录模型可见内容，再记录对应状态补丁。这里的 WorldState 是模型环境与规则等结构化状态，不是工作目录文件内容的完整备份。

比如 AGENTS.md 从“用 npm”变成“用 pnpm”，`AgentsMdState` 会发出明确的替换说明；删除文件时会发出旧规则不再适用的说明。它不是每轮无条件追加整份旧规则。日期、cwd 和权限等也各自有状态 diff。

### 14.1 压缩后如何避免规则丢失

PreTurn / 手动等 `DoNotInject` 路径清空 reference baseline，下一次正常上下文准备重新生成完整初始上下文。MidTurn 的 `BeforeLastUserMessage` 则立即使用当前捕获的 StepContext / WorldState 重建必要内容，并插入新窗口的最后真实用户消息之前。它不能等待下一次用户任务，否则当前工具循环续接会缺少规则。

因此“某个规则曾经落盘”和“现在还应继续生效”是不同问题。历史保留当时的规则，当前状态负责说明替换、撤销或重新注入；恢复过程也维护这套比较基线。

### 14.2 持久化不等于进入长期记忆

同一个 policy 文件有 `should_persist_response_item()` 和 `should_persist_response_item_for_memories()` 两种过滤：developer 消息可以写入会话 rollout，但不进入该长期记忆过滤器的消息集合；推理、压缩项等也有不同选择。不能把“存到文件”理解为“永久作为用户偏好参与以后所有会话”。

源码：[上下文构建与记录](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/session/mod.rs)、[AGENTS 状态替换](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/context/world_state/agents_md.rs)、[Hook 补充内容](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/hook_runtime.rs)、[additionalContext 比较](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/state/additional_context.rs)、[additionalContext 输入](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/session/turn_input.rs)、[请求专用前缀](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/client.rs)、[持久化与记忆过滤](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/rollout/src/policy.rs)、[TokenBudget reset](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/compact_token_budget.rs)。

## 15. 从触发到冷恢复的完整数字例子

以下数值是便于计算的示例，不是实际性能测量。采用 W = 272,000、Total、无 buffer、Q = 0，本地总结型压缩。

```text
当前上下文 U = 240,000
  → 工具返回等新增内容后，状态估算为 U = 252,000
  → 模型还需要继续处理，即 needs_follow_up = true
  → 252,000 >= 244,800，触发 MidTurn
  → 从当前窗口副本生成交接摘要
  → 假设保留用户消息约 18,000 token、摘要约 6,000
  → 重建必要规则 / 环境 / 基础指令等，假设合计另约 8,000
  → 最终新窗口估算约 32,000（实际以重算为准）
  → 安装 C1 replacement_history，保存检查点
  → 继续工具循环的下一次模型请求
```

磁盘和内存分别变为：

```text
JSONL：
  旧用户 / assistant / 工具记录
  已记录的上下文变化与状态
  本地压缩输出（按阶段）
  Compacted C1 { replacement_history, window IDs, resume metadata, ... }
  适用的 WorldState / TurnContext / Settings
  后续的新消息 N1、N2

当前内存：
  C1 的新上下文项
  后续的新消息 N1、N2
```

关闭后恢复：取可恢复的 C1，安装 replacement history，重放 N1、N2 及相关状态记录。压缩前历史用于全历史查询和历史节点分叉；没有被压缩操作覆盖删除。第二次压缩 C2 的输入通常是当前 C1 窗口加新内容，文件则继续追加 C2。

## 16. OpenCat 临时上下文的具体对照

当前 `runtimeContextMessages` 是待投影队列，新状态快照不再直接写这个字段；兼容类型仍可读取旧日志。但 `materializeRequestContext()` 会把计划、Todo、记忆与通知等拼成 `source: runtime` 的消息，追加到 `state.Messages`，并调用 `recordTranscriptMessage()`。所以不能说“我们已经完全不持久化运行上下文”：队列不写入，不代表它生成的模型可见附件不写入。

对 OpenCat 的建议是保存两层可区分的数据：需要恢复的结构化状态，以及必要时留存的实际上下文注入记录。可重建的可变块在请求中只应用当前版本；一次性任务完成通知应有持久化事实与明确的投递身份，避免冷恢复后反复投递或丢失。若要保留每次请求实际见到的上下文用于追踪，应另行界定请求审计记录，不让恢复流程把所有旧附件再累计注入。

这些是存储契约建议，不是已经实施的行为修改。

源码：[上下文附件物化及写入](../src/query/request-context.ts)、[通知出队与状态记录](../src/query/runtime-context.ts)、[新快照字段选择与旧格式兼容](../src/transcript/persistence.ts)。
