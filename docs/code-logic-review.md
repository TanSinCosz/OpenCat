# 代码逻辑与冗余审查

审查与清理日期：2026-10-05。先阅读下面的清理结果；后续编号章节保留清理前的审查记录，其中的旧名称与诊断数量不代表当前实现。

## 已实施的清理

- 删除无调用者的私有函数、未使用类型、导入与参数；参数删除同步覆盖入口、脚本和测试。Query 压缩模块仅删除两个没有调用者的私有辅助函数，实际压缩决策与算法不变。
- 删除 `contextProjectionState` / `recentMessageCount`、空 Tokenizer 接口、`mainLoopModel` / `thinkingConfig` / `isNonInteractiveSession` 的无效传递链。`ToolUseContext.options` 只剩有效的 agent 定义，因此收平为 `agentDefinitions`。
- 删除技能上的 `sentDynamicSkillNames`、`activatedConditionalSkillNames`；实际激活仍由 `dynamicSkills` 与 `conditionalSkills` 完成。删除工具上的 `searchHint`、`shouldDefer`、`alwaysLoad` 与 `userFacingName()`，它们没有功能消费者。
- 删除 Edit / Write / Grep / Glob 未接入执行流程的 `validateInput()` 及专用辅助声明。保留 call 中实际运行的 Edit / Write 文件保护与 Bash 校验；Edit 测试改为验证实际调用。
- 工具局部类型从 `typeInput` / `typeOutput` 改为工具名加 `Input` / `Output`；内部 `_query()` 改为 `runQueryLoop()`，公开 `query()` 不变。
- 普通 Runtime 不再要求旧向量记忆配置。兼容工具 MemorySearch 首次调用时初始化服务；其可选注入字段改为 `legacyMemoryConfig` / `legacyMemory`，主会话的文件记忆逻辑不变。
- 删除冗余的审批 `requested: true` 标签；删除没有生成者或业务读取的 `ToolResultId` 类型与字段。转换模型消息时仍剥离旧日志可能携带的 `toolResultId`，避免送入 API。
- 从依赖清单与锁文件删除未引用的 `web-tree-sitter` / `tree-sitter-wasms`。启用 TypeScript `noUnusedLocals` / `noUnusedParameters`，阻止同类内部声明继续堆积。

## 保留与兼容边界

第二轮又删除了无调用方的旧 `Memory/HistoryStore/`、中文旧提示词 `promptCN.ts`、空 `types/tools.ts` 和五个未使用的工具再导出文件。实际 VectorStore、默认工具注册与 transcript 不依赖这些文件，继续保留。

权限状态从只有一个字段的 `AppState` 包装收平为 `runtime.toolUseContext.permissionContext`，删除 get/set 闭包和子 Agent 的外层包装函数。保留临时允许规则、权限模式继承、技能授权后的恢复和查询结束清理；未被执行器读取的 `additionalWorkingDirectories`、`alwaysDenyRules`、`alwaysAskRules` 已删除。真实拒绝与审批仍由现有权限回调和计划流程负责。

第二轮还删除了只记录/清空、没有读取方的 `dynamicSkillDirTriggers`、四个未使用缓存方法、`telemetryId`、无人使用的函数/类型/常量、重复的 `SearchMemoryOptions` 和未被调用的 `MemoryConfigSchema`。Read / Edit 提示词中的固定分支和空字符串包装已简化；发给模型的文字保持一致。审批类型改为 `ToolApprovalDecision` / `ToolApprovalRequest`，与执行器的权限回调类型区分。

`State.Messages`、SessionMemory、附件、摘要与恢复标记继续保留原存储方式。`autoCompress.sessionMemoryUpdated`、长期记忆的 `injectedBytes` 和 `toolResultBudgetState` 共享入口也保留，避免清理改变压缩、预算或旧会话恢复；State 与 Runtime 已补充必要的所有权注释。

旧 YAML 的 `memory.autoInjectTopK` 继续被 schema 接受，但不再进入 Runtime，也从新配置示例移除；文件记忆仍按现有规则最多选择五个相关文件。`searchThreshold` 仅影响旧 MemorySearch。旧向量实现仍被兼容工具及测试使用，未删除该能力。

第一节的两个 Web 生命周期问题仍待修复。本轮以冗余删除与可读性为范围，没有调整其行为。

## 清理后验证

启用未使用声明检查后的 TypeScript 检查与构建通过。完整本地回归 197 项通过、0 失败，涵盖 Query 压缩、SessionMemory、附件恢复、transcript、工具、技能、Agent、MCP、Web 与评测看板。补充了旧工具结果 ID 的日志兼容和旧记忆搜索过滤范围测试；没有调用真实模型做实验。

## 清理前的审查记录

## 范围与约束

对 `src/` 的 194 个 TypeScript 文件运行类型检查和未使用声明检查；重点阅读入口、Runtime/State、Query、工具执行、Agent、记忆、transcript、Web 会话生命周期，以及评测服务组装。引用查找包括 `src/`、`scripts/`、`tests/`。这是核心调用链审查与全目录静态检查，没有逐行审查所有页面脚本、旧检索算法和外部依赖实现。

本次不改上下文压缩、SessionMemory 更新策略、附件清理或回填逻辑。没有修改运行代码；用临时脚本、本地模型替身与测试配置验证了两个 Web 生命周期问题，没有连接真实模型或 MCP 服务。

## 1. 已验证的行为问题，优先于命名清理

### 1.1 Web 的 busy 检查不能阻止同时进入的查询

位置：[query-handler.ts](../src/interfaces/web/query-handler.ts)。

`handleQuery()` 先读取 `activeSession.busy`，随后 `await readJsonBody()`，最后设置 `busy = true`。两份请求体同时等待读取时，两次处理都能通过第一次检查。请求体准备好后，两者分别进入同一个 Runtime/State 的查询。

本地诊断构造两份同时释放请求体的请求，并让模型替身等待同一个响应门闩，结果：

```json
{"check":"concurrent_query","maxActiveModels":2,"responses":[200,200],"userMessages":2}
```

这会交错修改消息、取消控制器、审批与运行状态，也使“同一会话串行执行”的前提失效。已有 Web 测试先设置 `busy = true` 再发请求，只覆盖已忙碌场景。

建议：读取并验证请求体后，在同一同步步骤中检查和占用会话；占用后立即进入有 `finally` 的生命周期。前置检查可用于快速拒绝，最终占用时仍需检查。会话切换期间的请求归属也应保持明确。这项修复在 Web 边界进行，不改 Query 压缩流程。

### 1.2 会话切换失败会留下连接已关闭的旧会话

位置：[session-manager.ts](../src/interfaces/web/session-manager.ts)。

`replace()` 在新会话创建完成前关闭空闲旧会话的 MCP 连接。新会话创建如果抛出异常，`current` 仍指向旧会话，但旧连接已经关闭。

本地诊断用可计数的连接替身，并在创建新会话时注入失败，结果：

```json
{"check":"replace_failure","oldSessionRetained":true,"oldConnectionCloses":1}
```

建议：先创建候选会话，成功后交换引用，再按旧会话的执行状态释放资源；创建失败时清理候选资源，保留旧会话可用性。替换操作本身也需考虑并发，避免异步创建时旧会话已发生变化。

## 2. 编译器确认的 16 处未使用声明

检查命令：

```text
node --preserve-symlinks --preserve-symlinks-main node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters
```

普通类型检查通过。增加未使用检查后有以下 16 处诊断；它们包含函数、参数、类型和导入，不是 16 个函数。

| 位置 | 未使用声明 | 建议 |
| --- | --- | --- |
| [evaluation/workspace.ts](../src/evaluation/workspace.ts) | `createSweWorkspaceOptions()` 的 `datasetDir` | 参数没有参与计算，内部调用可以简化；先确认是否原本遗漏了目录选择逻辑 |
| [interfaces/web/swe-dataset.ts](../src/interfaces/web/swe-dataset.ts) | `createSweWorkspaceOptions()` 的 `datasetDir` | 同上；传入不同值目前不会改变返回配置 |
| [Memory/Memory.ts](../src/Memory/Memory.ts) | 第一组模型客户端导入 | 当前实现不使用，清理导入 |
| [openai-compatible/model-client.ts](../src/openai-compatible/model-client.ts) | `toOpenAIToolCall()` | 无调用者的内部转换函数 |
| [query/messages.ts](../src/query/messages.ts) | `compactBulkyToolResultsWithStats()` | 无调用者的旧包装函数；实际调用应用已有替换、创建新替换两个函数。本次保留整个压缩模块不改 |
| [swe/workspace.ts](../src/swe/workspace.ts) | `isGitRepository()` | 无调用者的内部函数 |
| [telemetry/observer.ts](../src/telemetry/observer.ts) | `RuntimeEventFields` | 未使用的内部类型 |
| [Tools/Agent/runner.ts](../src/Tools/Agent/runner.ts) | `createChildAgentRuntime()` 的 `childState` | 当前创建 Runtime 不读取此参数 |
| [Tools/Bash/background.ts](../src/Tools/Bash/background.ts) | `killBackgroundTasksForAgent()` 的 `state` | 操作实际使用 handles 中的状态；导出接口及调用方需一起检查 |
| [Tools/FileEdit/type.ts](../src/Tools/FileEdit/type.ts) | `InputSchema` | 未使用的内部类型别名 |
| 同文件 | `OutputSchema` | 未使用的内部类型别名 |
| [Tools/FileRead/FileRead.ts](../src/Tools/FileRead/FileRead.ts) | `OFFSET_INSTRUCTION_DEFAULT` 导入 | 导入未使用；不等于其定义可以连同其他调用方删除 |
| [Tools/FileWrite/FileWrite.ts](../src/Tools/FileWrite/FileWrite.ts) | `PreparedEdit` | Write 内残留的 Edit 类型 |
| [Tools/FileWrite/type.ts](../src/Tools/FileWrite/type.ts) | `InputSchema` | 未使用的内部类型别名 |
| [Tools/Glob/type.ts](../src/Tools/Glob/type.ts) | `InputSchema` | 未使用的内部类型别名 |
| [Tools/utils/discoverSkillsForReadPath.ts](../src/Tools/utils/discoverSkillsForReadPath.ts) | `dynamicSkills` 类型别名 | 未使用，且与有效状态字段同名，增加辨认成本 |

未使用参数需要先判断是否漏实现；导出 API、配置和历史字段需要兼容处理。不能把编译器的“未使用”统一理解成“直接删除整个模块”。

## 3. 静态检查未报错，但没有实际消费者的字段

TypeScript 允许接口字段或导出类型无人使用。这部分要检查创建、传递、读取与持久化，而不是只看编译结果。

| 字段 | 当前实际情况 | 处理建议 |
| --- | --- | --- |
| `Runtime.contextProjectionState` / `recentMessageCount` | Runtime 创建和子 Runtime 继承会传递对象；没有投影算法读取 `recentMessageCount` | 作为无效兼容入口审查，停止继续添加依赖；不把它解释成当前尾部数量配置 |
| `autoCompress.sessionMemoryUpdated` | 初始化和兜底为 false，尾部变化时再次写 false；没有 true 写入或决策读取。测试曾保存 true | 历史残留候选；当前压缩冻结范围内保持原样，未来迁移需兼容旧 transcript |
| `ToolMessage.toolResultId` / `ToolResultId` | 定义、导出，并在转模型消息时剥离；没有生成和业务读取 | 未完成的身份体系。当前本地消息 ID 与 API tool_call_id 都已有明确用途，避免新增第三套无用途身份 |
| `SkillRuntimeState.sentDynamicSkillNames` | 仅定义和创建空集合 | 可清理候选 |
| `SkillRuntimeState.activatedConditionalSkillNames` | 技能激活时 add，没有业务读取；激活本身通过移到 dynamicSkills、从 conditionalSkills 删除实现 | 只写状态，可清理候选；保留实际技能发现和激活流程 |
| `SurfacedLongTermMemoryFile.injectedBytes` | 每次注入写入，无单文件读取；会话总预算读取的是独立累计 `surfacedBytes` | 非决策元数据候选；不能将累计总量改成当前文件表求和，那会改变重复注入预算语义 |
| `ToolUseContext.tokenizer` | 创建与父子传递，没有 encode 调用 | 无效扩展入口，当前估算走 size-estimate；删接口前检查调用方 |
| `ToolUseContext.options.mainLoopModel` | 创建、传入，没有实际读取 | 模型来源实际为 Runtime 的模型配置；可缩减重复配置入口 |
| `ToolUseContext.options.thinkingConfig` / `isNonInteractiveSession` | 创建与父子传递，没有功能决策读取 | 空传递链，容易让人误以为它们已经控制模型思考或交互行为 |
| `PendingToolApproval.requested` | 非 null 对象始终为 true，调用方只用它判断是否有审批 | null 与对象已经能表达是否请求审批，这个字段可以简化 |

相关定义：[Runtime](../src/types/runtime.ts)、[上下文状态](../src/types/context.ts)、[消息](../src/types/messages.ts)、[State](../src/types/state.ts)、[工具上下文](../src/Tools/types.ts)、[审批](../src/query/tool-permissions.ts)。这些是候选，不是已删除字段；外部调用、旧数据兼容与冻结范围分别处理。

## 4. 配置与工具接口表达的能力比实际实现多

### 4.1 autoInjectTopK 不控制当前文件记忆选择数量

[配置 schema](../src/config/schema.ts) 和 [Memory Runtime](../src/Memory/runtime.ts) 都保存 `autoInjectTopK`，示例 YAML 也提供它，但当前 [文件记忆召回](../src/query/long-term-memory.ts) 使用 `MAX_RELEVANT_MEMORY_FILES = 5`。查找未发现该配置值的业务读取。

旧向量搜索读取 `searchThreshold`，主会话的文件选择器不读取这个搜索阈值。二者现在放在同一个 memory 配置分组内，读者容易误以为都会影响主会话召回。

建议：明确当前文件记忆参数和旧检索兼容参数；对不生效字段先标注弃用或限定用途。不能在清理时直接让 TopK 生效，那是行为变化；也不能直接移除 strict schema 字段，使已有 YAML 启动失败。

`compression.snippedContentAutoCompressTriggerTokens` 也需要标注范围：实验脚本读取它，当前 Query 的触发判断没有读取它。本次不调整其行为。

### 4.2 工具 metadata 和 validateInput 的契约不一致

`searchHint`、`shouldDefer`、`alwaysLoad` 在很多工具上被设置，测量脚本会复制这些属性，但当前 Query 没有据此实现工具搜索或延迟加载。模型工具列表主要由 `runtime.tools`、description 与 input schema 构建。

`Tool` 接口不声明 `validateInput()`，executor 只做 schema 校验。Bash 在自己的 `call()` 中执行 `validateInput()`；Edit、Write、Grep、Glob 的同名方法没有接入通用 executor。Edit 的测试会直接调用它，Edit/Write 的 `call()` 还保留实际读写保护。

建议：先明确“schema 校验”和“执行前环境校验”各自的位置。可以保留 call 内的现有检查、删除真正冗余的方法；若改为统一 executor 钩子，需要单独评估行为，避免双重读取或改变检查时机。不能把 `validateInput()` 这个名字当成已执行的保证，更不能删掉 call 内的读后再写与修改时间检查。

## 5. 状态归属与旧实现混杂

### 5.1 toolResultBudgetState 的两个入口需要说明所有权

它同时出现在 Runtime 与 State，但现有 [messages.ts](../src/query/messages.ts) 有 State 时把 Runtime 字段指向 State 的同一个对象；无 State 时创建 Runtime 的 fallback。自动压缩后也同步别名。

因此不能直接断言有两份独立状态。问题是“一个业务状态有两个入口，且允许 fallback”，读者难判断谁负责恢复、替换和继承。建议明确 State 为恢复来源、Runtime 字段为兼容别名，日后再评估缩减入口。本次不改预算和继承逻辑。

### 5.2 三种记忆的命名需要分开

| 当前名称 | 实际职责 |
| --- | --- |
| `state.sessionMemory` | 当前会话滚动笔记，主会话压缩输入 |
| `state.longTermMemory` | 当前会话的召回预算、已注入文件、提取游标；不保存全局记忆库 |
| `runtime.longTermMemory` / `MemoryConfig` | 旧向量检索服务和配置的兼容入口 |

当前默认 MemorySave 写文件信号，主会话召回走文件记忆；MemorySearch 没有注册为默认工具。旧 MemoryTool、Embedding、VectorStore 等仍通过兼容模块和测试被引用，不能把整目录当无用代码删除。

建议把旧检索兼容接口从当前文件记忆配置组装中分离，让主入口不必理解旧 embedder/vectorStore 配置。是否保留旧能力应作为独立范围决定；不能通过改名顺手迁移压缩或记忆算法。

### 5.3 tree-sitter 依赖仍留在 package.json

当前 `src/`、`scripts/`、`tests/` 未找到 `web-tree-sitter`、`tree-sitter-wasms` 使用；`Tokenizer.ts` 现在只有一个 encode 接口。此前删除示例目录后，根 package.json 的两个依赖还在。可以单独核对包配置、锁文件和部署入口后清理；本次没有更改依赖。

## 6. 看起来重复，但应该保留的内容

- `MessagesForQuery.messages` 是最终 API 消息；`forkContextMessages` 保留投影后业务消息的本地 ID 等信息，供 Agent 和记忆更新继承。它们不是可随意合并的两份相同数组。
- `SampledAssistantTurn.message` 是模型响应；`persistedMessage` 带本地消息身份、用量和上下文 token 数，承担存储与后续判断。
- `runtime.lastModelRequestContextMessages` 保存父请求的实际业务前缀。工具执行后 State 已变化，重新投影不一定得到同一前缀；它有缓存复用和 fork 用途。
- `query()` 与内部生成器分别承担配置作用域和主循环。异步生成器每次 next()/return() 都要恢复正确作用域；不能简单删掉包装层。不过 `_query` 当前只有包装层调用，可以收窄 export、改为清楚的内部函数名。
- SessionMemory 的 initialized、更新尝试计数、成功计数和游标会参与决策；`lastUpdateMessageId` 与 `lastSummarizedMessageId` 在成功时相同，也分别承担更新频率与覆盖范围判断，当前不合并。
- `contextTokenCount` 表示最近实际上下文规模；usage 可累计多次 reasoning continuation 的计费用量，二者不能直接替换。
- `readFileStateRestoredForSummaryId`、`invokedSkillsRestoredForSummaryId` 防止同一摘要重复回填；不能删除以减少字段数。
- `runtimeContextMessages` 是待注入队列，已生成 `opencat_context` 是持久消息。保留二者的阶段关系与现有清理规则。
- QueryEvent 和遥测事件面向不同消费者。统计字段有 Web 与评测读取，不能因主循环不读取就认定无用。

## 7. 命名与拆分建议

| 当前命名或组织 | 阅读成本 | 建议 |
| --- | --- | --- |
| `State.Messages` 与其他 camelCase 字段混用 | 同一个状态对象遵循两套命名 | 未来独立迁移为 messages；涉及历史/调用接口时保留兼容，不混入压缩重构 |
| `MemoryConfig` 是变量字段又是类型名 | 看不出它是旧检索配置 | 明确兼容用途，之后采用 legacyMemoryConfig 等准确命名 |
| `typeInput` / `typeOutput` | 阅读多个工具时不易定位含义 | FileEditInput、FileEditOutput、FileWriteInput、FileWriteOutput |
| `SkillRuntimeState: SkillRuntimeState` | 值参数与类型同名且大写 | 值参数改为 skillRuntime |
| `runtimeContextMessages` | 名字没有表达它尚未注入 | 内部可用 pendingContextMessages；持久化旧字段兼容单独处理 |
| `state.longTermMemory` | 容易被理解为记忆正文或服务 | 在类型与字段注释中明确这是召回/提取状态 |
| `CreateRuntimeOptions.modelRuntimeConfig?` | 类型声明允许缺省，createRuntime 却立即抛错 | 在构造契约中声明必填，尽早发现调用错误；保留当前模型选择行为 |

Query 主循环目前已按准备上下文、模型回合、工具批次、记忆更新、收尾拆分，阶段函数有明确职责，不建议继续机械地拆成更多一两行函数。

后续真正值得整理的是 `query/messages.ts` 中多个投影策略、`query/long-term-memory.ts` 中召回与提取协调、`Tools/Agent/runner.ts` 中上下文继承与生命周期、`transcript/persistence.ts` 中编码与恢复。拆分时移动现有逻辑并记录副作用，避免拆分同时修改算法。

例如不要用一个通用“消息修复”函数替代不同边界的处理：Query 修复工具消息配对，而 Agent fork 会过滤未完成调用，两者的选择规则不同。

注释优先解释状态所有者、修改时机、保存格式与调用前提。尤其要修正长期记忆函数里“不是 transcript 的一部分”的描述：函数返回值不直接修改 State，但调用者会把正文合并成附件并落盘。只解释函数局部行为会误导对整体存储的判断。

## 8. 建议的清理顺序

1. 修复 Web 查询占用和会话切换失败的资源生命周期，增加覆盖真实交错条件的测试。
2. 清理确定无调用者的内部声明；压缩模块维持冻结，其他参数先判断是否漏实现。
3. 处理未使用集合、无效传递链及不生效配置，区分内部删除、接口兼容和历史日志兼容。
4. 分开文件记忆与旧检索兼容入口，说明预算状态所有权，统一局部类型与参数命名。
5. 再整理较大模块。阶段函数保留，避免一边改布局一边改算法。

清理后启用 noUnusedLocals / noUnusedParameters，防止内部声明继续堆积；接口字段和配置仍需引用审查。运行普通类型检查及改动相关的本地回归；只做命名或删除死代码时，验证现有输入、输出、持久化格式和压缩决策保持一致。

本轮验证范围：普通类型检查通过；严格未使用检查得到上面的 16 处诊断；两个临时 Web 诊断确认了所述行为。没有运行全部回归、真实模型实验，也没有修复上述问题。
