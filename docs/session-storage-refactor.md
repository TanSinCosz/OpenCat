# 会话存储整理与历史节点分叉方案

本文是针对当前 OpenCat 的存储改造设计，不代表这些接口已经实现。目标是支持从已完成的用户任务节点创建独立聊天，同时保存该节点之前的消息、附件和恢复状态。

**范围约束：不修改任何现有上下文压缩逻辑。** 保留压缩触发条件、SessionMemory 更新时机、摘要生成与尾部保留、historySnips、工具结果替换、文件和技能回填，以及 Query 各阶段的顺序。保留 `State.Messages` 和现有投影列表的职责；不在压缩后用投影列表替换 `State.Messages`，不引入内存窗口缩减。下面的改动限于持久化记录、历史读取、按范围恢复及聊天分叉。

## 1. 当前缺口

| 当前实现 | 分叉受到的影响 |
| --- | --- |
| `TranscriptEntry` 主要是 message 和 reason-scoped state_snapshot | 缺少持久化用户任务边界、记录序号及分支来源 |
| `loadStateFromTranscript()` 合并整份日志中的各字段最新快照 | 无法要求“只恢复到某个历史位置”；未来摘要和状态可能污染旧节点 |
| `State.Messages` 兼顾运行历史、上下文投影输入和 Web 展示来源 | 内存列表长度不能稳定定位历史；Web 应有独立的日志查询入口 |
| SessionMemory JSON 覆盖保存最新版本，而 transcript 保存版本快照 | 历史分叉不能使用父会话最新 JSON 作为历史版本 |
| `GET /api/session/messages` 从 State.Messages 取最多 200 项 | 默认压缩恢复后，旧历史未必出现在页面中 |
| `normalizeSessionHistoryMessage()` 输出中没有消息 ID | 前端无法用稳定身份提出历史节点分叉请求 |
| WebSessionManager 只有创建、恢复、替换与重置 | 缺少聊天级 fork；Agent fork 是执行任务机制，不能直接复用其共享任务表 |

对应源码：[日志与恢复](../src/transcript/persistence.ts)、[Query 阶段](../src/query/turn-context.ts)、[Web 历史路由](../src/interfaces/web/routes.ts)、[展示转换](../src/interfaces/web/presentation.ts)、[会话管理](../src/interfaces/web/session-manager.ts)、[Agent 子状态](../src/Tools/Agent/runner.ts)。

## 2. 三个职责与保持不变的运行逻辑

1. **ConversationStore**：完整、按顺序持久化的会话事实；为历史查询、节点定位及恢复提供来源。
2. **现有 State 与上下文投影**：保持 `State.Messages`、压缩状态和请求投影的现有关系；存储模块记录结果，不接管压缩决策。
3. **现有 RequestContext**：继续在压缩后构建附件、清理旧的可变块；历史保存生成的正文，后续请求仍执行现有清理和注入规则。

会话中可恢复的状态继续保存，但与 MCP 客户端、AbortController、审批 Promise、SessionMemory 更新队列中的 Promise 等活动 Runtime 资源分开。这些对象在新会话重新创建。

## 3. V2 日志的最小数据契约

```ts
// 设计摘录，不是当前已实现类型。
type EntryBase = {
  version: 2;
  entryId: string;
  seq: number;
  sessionId: string;
  turnId?: string;
};

// 与现有 Message/source 一起保存身份，不把所有 role:user 都当真实用户任务。
type EntryKind =
  | "session_meta"
  | "turn_started"
  | "message"
  | "state_patch"
  | "restore_checkpoint"
  | "turn_finished";

type ForkSource = {
  sessionId: string;
  endSeqExclusive: number;
};
```

turn 表示一次用户提交及其完整工具循环，不能直接使用 Query for 循环里的模型回合数。先落 turn_started，再落用户消息与过程记录，结束状态写为 completed、interrupted、failed 或 max_turns，并保存相关恢复状态后形成稳定边界。异常、停止和生成器提前关闭都必须结束生命周期；进程崩溃留下的未结束 turn 需要明确标记或恢复规则。

每个日志文件使用单一有序 writer，在入队时确定序号和记录内容快照，不让异步 mkdir、并行工具或通知造成编号与物理写入顺序不一致。提供 flush / 固定读取截止范围的契约，只有写入成功的前缀可以作为分叉来源。损坏记录或未完成尾行不能被悄悄忽略后继续宣称恢复完全正确。

第一版先用持久化 seq 定位，必要时由文件扫描建立 turn 索引；字节 offset 和 SQLite 可以后续引入。

## 4. 恢复算法

```text
restoreSessionAt(source, endSeqExclusive)
  → 固定源日志读取范围
  → 只取 seq < endSeqExclusive 的记录
  → 在该范围内选择有效检查点
  → 恢复已有消息与会话状态；可选检查点只加速读取
  → 重放检查点后、截止位置前的消息与状态变化
  → 校验工具调用配对和状态引用
```

第一阶段没有新检查点时，可以复用现有消息和快照恢复：先限定 entries 范围，再执行 mergePersistedStateSnapshots 和消息 hydrate。保留现有摘要、historySnips、工具结果替换、sessionMemory 及消息标准化逻辑。还需验证日志中的原始附件和运行时已清理的有效附件之间的差异，不能仅凭截取消息就宣称精确复现运行状态。

禁止先加载整份日志的最新状态、再截断 Messages。状态快照的写入位置也必须属于截止范围；仅校验 summary.throughMessageId 不足以替代完整的范围限制。

## 5. SessionMemory 必须保存完整状态及历史版本

当前实际调用链如下：

```text
Query 完成 assistant 与本轮工具结果
  → updateSessionMemoryAtSafeBoundary
  → shouldUpdateSessionMemory 检查现有更新条件
  → 内部 SessionMemory agent 在继承的上下文中 Edit 记忆文件
  → 成功后更新 state.sessionMemory
  → 覆盖保存 session-memory/<sessionId>.json
  → 追加 transcript 的 session_memory 状态快照

主会话触发自动压缩
  → loadPersistedSessionMemory（已有 ready 正文时跳过加载）
  → 检查记忆是否可用、是否覆盖需要压缩的消息
  → 从已有记忆渲染压缩摘要
  → 应用已有摘要、尾部和压缩后回填规则
```

依据：[安全边界更新](../src/query/session-memory-update.ts)、[记忆生成](../src/session-memory/session-memory.ts)、[缓存读写](../src/session-memory/persistence.ts)、[主会话压缩](../src/auto-compress/auto-compress.ts)。主会话压缩本身复用已有记忆，不在这里额外调用模型生成新记忆；子智能体的本地摘要机制另行保留。

`sessionMemory` 是压缩的输入状态，不是可以任意丢弃的缓存。持久化完整 [SessionMemoryState](../src/types/session-memory.ts)：

- `content`：完整滚动笔记；压缩摘要是它的渲染、截断视图，不能替代原笔记。
- `lastSummarizedMessageId`、`lastUpdateMessageId`：记忆覆盖范围及更新位置。
- `initialized`、`status`：是否初始化、是否可用于压缩；失败后不能擅自改成 ready。
- `tokensAtLastUpdateAttempt`、`tokensAtLastExtraction`：现有更新频率判断的依据。
- 成功/失败时间、失败原因及 `config`：恢复状态与配置来源；配置合并保留现有规则。

三份存储承担不同职责：

| 位置 | 当前作用 | 历史恢复定位 |
| --- | --- | --- |
| `.opencat/session-memory/<sessionId>.md` | 内部 agent 编辑的工作文件，每次更新前写入当前笔记 | 不是历史版本库；失败时可能留下编辑中的内容 |
| 同目录 `<sessionId>.json` | 覆盖保存最新成功更新的完整状态 | 最新缓存，不能证明旧节点当时使用哪个版本 |
| transcript 的 `state_snapshot.sessionMemory` | 在日志位置追加状态版本 | 分叉时的历史版本来源，必须先限制日志范围 |

分叉使用截止范围内合并出的完整状态，并检查覆盖的消息是否存在于该范围。快照本身的记录位置也必须早于截止位置：后来生成、只覆盖旧消息的记忆也不能带回过去。没有历史版本时沿用未初始化状态，不在恢复时偷偷生成摘要。

新分支使用新的 session ID 与独立记忆文件路径；如果创建 JSON 缓存，应从选中的历史状态创建，不复制父会话最新缓存。这样现有 `loadPersistedSessionMemory()` 按 session ID 读取文件的逻辑可以保持不变。当前缓存加载函数没有历史截止参数，不能在父 Runtime 上先补载最新 JSON 再分叉。

例如 T1 后记忆为 M1、T3 后记忆为 M2，从 T1 后分叉只能恢复 T1 边界前已写入的 M1。即使父 JSON 已变为 M2，子会话也不能读取它。若 M1 在 T1 边界之后才落日志，则不能假定 T1 已拥有 M1；任务结束边界需要包含应提交的状态写入。

已有 `autoCompress`、`historySnips`、工具结果替换、invokedSkills、计划、Todo 与通知状态同样按截止范围恢复。可选 `restore_checkpoint` 只记录已有状态以加速读取，不生成摘要、不安装新的压缩窗口。需要记录消息清理时，可保存当前有效 `State.Messages` 的只读快照或等价修订记录，区分原始附件与已清理的有效内容；采集不回写运行状态，恢复仍保留现有标准化和请求处理规则。

状态 patch 必须区分字段缺失和显式清空。写入记录时固定数据副本，避免等待异步 I/O 时读取到后来修改的对象。

## 6. 第一版复制式聊天分叉

```text
forkSession({ sourceSessionId, afterTurnId })
  → 定位已完成用户任务的结束边界
  → restoreSessionAt(source, cutoff)
  → 创建新 session ID
  → 写分支来源和截止位置
  → 复制 / 重新编码截止范围内的日志，分配子日志 seq，保留消息身份与来源
  → 组装独立 State、Runtime 和恢复状态
  → 验证并完成必要持久化
  → 最后切换页面到新会话
```

也可提供 beforeTurnId 表示任务开始之前，两个参数互斥。初版以已完成任务为主要分叉节点；进行中工具循环的中断快照语义单独实现，不靠删掉不匹配工具消息来掩盖不完整历史。

Agent fork 的共享任务表是父子执行协调机制，聊天分支应使用独立注册表。父后台任务不复制运行，新分支保留必要历史事实并将不可继承的活动任务转换为明确状态。任务完成通知需有稳定身份与投递记录。

计划内容和 SessionMemory 取截止范围内版本，保存到子会话自己的文件路径。工具结果存档及其他继承资源要复制或采用明确的不可变共享资源契约，不能仅复制 JSONL 就宣称所有外部依赖已经独立。配置按明确继承 / override 规则创建；临时命令授权与待审批请求不继承。

聊天历史分叉与工作区回滚是两个操作。初版共享当前工作区；需要同一代码历史的独立执行环境时，再接入已有 worktree / patch 能力。

## 7. Web 的必要改动

- 历史接口从 ConversationStore 读取，支持稳定 cursor 和分页；展示完整会话不依赖内存窗口。
- 保留 messageId、turnId 和节点边界，输出 canFork / 不可用原因。
- 新增会话分叉接口，初版参数使用 sourceSessionId 与 afterTurnId / beforeTurnId。
- 在可分叉节点展示“从这里开启新聊天”；新会话展示来源，父会话仍可继续。
- 新会话创建失败时不替换当前会话；旧会话连接在替换成功后按生命周期释放。

## 8. 对话附件保存正文，使用规则保持不变

当前附件走两个阶段，不能混为一谈：

1. `runtimeContextMessages` 是待注入队列。当前新快照不保存这个队列；它本身不应成为独立的重复聊天历史。
2. [materializeRequestContext](../src/query/request-context.ts) 将队列与计划、Todo、召回记忆合并成 `opencat_context` 消息，加入 `State.Messages`，再调用 `recordTranscriptMessage()`。**这些已生成附件正文当前已经落入 transcript，应该继续保留。**

| 附件来源 | 应保存什么 | 原因及后续使用 |
| --- | --- | --- |
| `file_restore` | 当次生成的正文、路径、partial 信息及消息身份 | 回填会读取当时磁盘内容并加行号、截断；后来文件变化，只有路径无法还原这次附件 |
| `agent_notification` / `task_notification` | 实际通知正文、任务身份及消费状态 | 结果可能只送达一次；不能只保存“已消费”而丢正文 |
| `long_term_memory` | 当次选中的记忆正文及 surfacedFiles 状态 | 外部记忆文件可变化，重新选择也可能不同；全局记忆库本身仍独立存储 |
| `dynamic_skill` | 已生成附件正文；已调用技能另保存现有 invokedSkills 内容 | 发现的技能目录信息与压缩后回填的完整技能指导共用此来源，不能一概认为可重新扫描得到 |
| `plan_file` / `plan_mode` / `todo_list` | 结构化状态版本及当次附件正文 | 状态用于继续执行，正文用于保留这次注入内容；后续仍按现有规则刷新 |
| `agent_task_status` / `background_task_status` | 当次状态附件及必要任务状态 | 记录当时状态，不把父会话的活动任务进程复制运行 |

依据：[文件回填](../src/auto-compress/read-file-restore.ts)、[已调用技能回填](../src/auto-compress/invoked-skill-restore.ts)、[通知和技能目录](../src/query/runtime-context.ts)、[长期记忆召回](../src/query/long-term-memory.ts)。

保存附件不等于确认模型已经收到：附件写入后，模型调用仍可能失败。若需要证明某次请求的完整输入，应另记录最终投影与请求状态；原始 transcript 消息也可能在最终投影中被裁剪，不能冒充最终发送内容。

保留现有附件生命周期：`removePreviousVolatileContextBlocks()` 清理旧的长期记忆、dynamic_skill、Todo、plan_mode、plan_file、agent_task_status 块；现有冷恢复还清理 dynamic_skill。持久化旧正文不意味着下一轮把所有旧附件重新注入，也不意味着删除历史正文。现有 `source:runtime` 消息继续兼容读取。

长期记忆模块注释中“transient”的描述不能代替调用链判断：其返回内容实际上被上述 materialize 路径合并并落盘。[现有测试](../tests/session-transcript.test.ts) 也区分“待注入队列不保存”和“已生成附件落盘后，恢复保留长期记忆块、移除 dynamic_skill 块”。

待注入内容如果来自一次性事件，仍需有可靠的恢复来源：保存事件事实，或保存带身份的待投递记录，防止进程崩溃导致丢失。无需序列化 Promise 或把队列作为第二份模型消息历史。大附件后续可做不可变内容去重，但存储读取必须还原现有压缩函数所接受的 Message，不改变可见正文与截断规则。

跨会话文件记忆和工作目录内容具有外部可变性。历史恢复应说明哪些内容来自截止范围、哪些来自当前外部环境，不宣称获得了整个环境的历史快照。

## 9. 当前需验证的持久化一致性问题

- 记忆更新成功后先覆盖 JSON，再追加 transcript 快照，二者没有跨文件事务。失败路径还会修改状态和尝试计数，但该函数不立即写同样的快照。分叉边界需提交真实状态版本，不能用成功缓存代替失败后的当前状态；这些是存储一致性问题，不应通过改变更新阈值或压缩策略解决。
- 通知先从队列移除、更新消费状态并保存快照，之后才由 materialize 写附件。中途崩溃可能留下“通知已消费、正文未落盘”的记录。后续持久化实现需把事件身份、正文与消费状态纳入一致的提交/恢复契约，不承诺网络模型调用的 exactly-once。
- dynamic_skill 同时表示可重新发现的目录信息和压缩后完整技能回填。冷恢复会清理该来源，而回填有 `invokedSkillsRestoredForSummaryId` 防重标记。恢复后正文与标记能否保持一致需要集成测试验证；这是源码识别出的待验证场景，本方案不直接修改技能回填或消息清理逻辑。
- 运行时会原地清理旧附件，而日志保留原正文。精确历史恢复必须记录这种有效内容变化或只读状态快照，并与现有 hydrate 行为做一致性验证；仅合并状态快照和原始消息不能证明逐字相同的模型输入。

## 10. 交付顺序与验收

1. V2 writer、用户任务边界、V1 兼容读取、范围恢复与日志历史查询。
2. 复制式分叉、独立状态与资源、Web 接口和节点操作。
3. 补齐记忆版本提交、附件/通知一致性及必要的只读恢复检查点；保留全部压缩与投影逻辑。
4. 有规模需求时，再实现引用式历史、祖先索引及删除 / 归档依赖管理。

不以缩减内存作为此次目标。旧日志只有能证明恢复边界的节点才提供分叉，不通过虚构历史 turn ID 承诺完整状态恢复。

至少覆盖：压缩前与压缩后分叉；未来记忆 / 摘要 / Todo / 工具替换不进入旧节点；父日志继续追加不改变子范围；子操作不修改父记忆、计划和注册表；没有历史记忆时不加载父最新 JSON；失败记忆状态与更新计数恢复；附件正文在外部文件改变后仍可读；通知消费与正文一致；技能回填标记与正文一致；冷恢复前后模型输入的核心语义一致；工具调用配对；资源依赖可读；复制或 flush 失败不发布成功分支；V1 普通恢复保持兼容。

现有压缩测试必须继续通过，并比较同一运行状态在存储改造前后的触发决策、摘要和最终投影。本文修订只改变设计说明，没有修改运行代码，也没有执行上述尚未实现的分叉验收。
