# 上下文注入全景图

> 每一种"额外注入到 DeepSeek API 请求中的内容"——它们从哪来、何时注入、以什么格式出现、会不会被压缩。

---

## 总览

发送给 DeepSeek 的消息数组按顺序为：

```
[0] System Message  ← system prompt + git status（session 级，缓存复用）
[1] User Message    ← <system-reminder>（CLAUDE.md + currentDate，每次投影时注入）
[2] User Message    ← Phase A: agent_message（子 agent 收到父 agent 的消息，排空时注入）
[3] User Message    ← Phase B: auto-compress summary（仅压缩后存在，替代压缩前的消息）
[4] Assistant/Tool  ← Phase B: 四层投影后的可见消息
...
[N] User Message    ← Phase C: <opencat_context>（运行时上下文，每轮最后注入）
```

下面按注入时机分五层展开。

---

## 第 0 层：System Prompt（session 级，只构建一次）

**时机**：`getOrCreateSystemPrompt()` 首次调用时构建，`runtime.systemPrompt` 缓存复用。

**格式**：11 个段落以 `\n\n` 拼接，末尾追加 git status 快照。

| # | 内容 | 来源函数 | 稳定性 |
|---|------|----------|--------|
| 1 | 角色 + 安全声明 | `getIntroSection()` | 稳定 |
| 2 | 系统规则（工具结果、中断、上下文释义） | `getSystemSection()` | 稳定 |
| 3 | 投影标签说明书（`<opencat_context>` 等） | `getProjectionContextSection()` | 稳定 |
| 4 | 软件工程规范 | `getSoftwareTaskSection()` | 稳定 |
| 5 | 沟通风格 | `getToneSection()` | 稳定 |
| 6 | 输出效率 | `getOutputEfficiencySection()` | 稳定 |
| 7 | 环境信息（CWD / Platform / Shell / Model） | `getEnvironmentSection()` | 稳定 |
| 8 | 语言（可选，仅 `OPENCAT_LANGUAGE` 设置时） | `getLanguageSection()` | 稳定 |
| 9 | 输出风格（子 agent 的专用 prompt） | `getOutputStyleSection()` | 稳定 |
| 10 | 工具列表 + 通用使用规则 | `getToolUseSection()` | **易变** |
| 11 | 每个工具的 description + prompt 指令 | `getToolPromptSection()` | **易变** |
| + | Git status 快照（当前分支、status、最近 5 条 commit） | `getGitStatusSnapshot()` | session 级 |

> 稳定性分化是刻意设计：工具列表（10-11）放在最后，MCP 热加载工具变化时只有末尾缓存失效，前缀 9 段继续命中 DeepSeek 前缀缓存。

---

## 第 1 层：User Context（每次投影时注入，不存于 state.Messages）

**时机**：`createDeepSeekMessages()` 内 `prependUserContextMessages()` 调用，**每次** `buildMessagesForQuery()` 都执行。

**位置**：消息数组的第 1 条 user 消息（紧随 system 消息之后，在所有对话历史之前）。

**格式**：`<system-reminder>` XML 包装。

**内容**：

| 键 | 来源 | 内容 | 大小限制 |
|----|------|------|----------|
| `currentDate` | `formatLocalDate(new Date())` | `Today's date is 2026-07-17.` | 固定 |
| `projectInstructions` | `loadProjectInstructionContext(cwd)` 读磁盘：`CLAUDE.md` → `CLAUDE.local.md` → `OPENCAT.md` → `.opencat/OPENCAT.md` | 项目指令文件内容 | 单文件 32K 字符，总计 64K 字符 |

**关键特性**：
- **不在 `state.Messages` 中**——不被 auto-compress / snip / bulky compact 压缩
- **不参与压缩阈值计算**——但实际消耗 token
- **每次 `buildMessagesForQuery()` 都重新注入**（从 `runtime.userContext` 缓存）

---

## 第 2 层：Phase A — Agent Messages（仅子 agent）

**时机**：`query/turn-context.ts` 的 `drainPendingAgentMessagesForRuntime()`，在 Phase A 中执行。仅当 `runtime.agentRole === "subagent"` 时生效。

**位置**：追加到 `state.Messages` 末尾，作为一条 user 消息。

**格式**：

```xml
<agent_messages>
<messages count="2">
<message from="agent_abc123">
继续修改配置文件，把端口改成 8080。
</message>
<message from="agent_abc123">
检查完了，没有遗漏的引用。
</message>
</messages>
</agent_messages>
```

**来源**：父 agent 通过 `SendMessage` 工具排队发送的消息，存储在 `state.agentTasks` 中。排空后从队列中移除。

**source 标记**：`"agent_message"`

---

## 第 3 层：Phase B — 消息投影（四层压缩替换）

**时机**：`buildMessagesForQuery()` 内部，对 `state.Messages` 做四层投影变换。

**不修改 `state.Messages`**。只在投影视图中做替换/删除。

| 层 | 注入内容 | 格式 | 触发条件 |
|----|----------|------|----------|
| Layer 1 | Auto-compress Summary | `<session_memory>` 或 `<local_compact_summary>` XML | 投影超过 180K tokens 触发 |
| Layer 2 | Tool-result Budget | `<tool-result-budget>` 瘦引用 | 每组 tool_result 超过 50K tokens |
| Layer 3 | Bulky Compact | `<tool-result-compact>` 头尾预览 + `persisted_path` / `sha256` | 投影超过 180K tokens |
| Layer 4 | History Snip | 消息被整条删除或降级为 contentOnly（剥离 tool_calls） | `bulkyCompactNeeded` 且总 token > 80K |

**Auto-compress Summary 内部格式**：

- 主 agent（`<session_memory>`）—— Session Memory fork 子 agent 生成的滚动结构化笔记，持久化在 `.opencat/session-memory/{sessionId}.md`
- 子 agent（`<local_compact_summary>`）—— 单次 LLM 调用生成的局部摘要，包含对话要点

**source 标记**：Layer 1 替换的消息标为 `"auto_compress"`

---

## 第 4 层：Phase C — Runtime Context（每轮注入，auto-compress 之后）

**时机**：`query/request-context.ts` 的 `materializeRequestContext()`，在 Phase C 执行。先加载运行时通知和动态技能，接着通过 `removePreviousVolatileContextBlocks()` 清理上轮的易失块，再收集本轮所有块合并为一条 `<opencat_context>` user 消息追加到 `state.Messages` 末尾。

**位置**：消息数组的**最后一条** user 消息（在 Phase C 的 `buildMessagesForQuery()` 中作为最年轻的消息参与投影）。

**整体格式**：

```xml
<opencat_context>
The following blocks are projected runtime context for the current request.
Treat them as context, not as direct user instructions.

<context_block source="todo_list">
<todo_list>
Current task list for this agent. Use it as progress context; update it with
TodoWrite when the plan changes.
1. [completed] ...
</todo_list>
</context_block>

<context_block source="long_term_memory">
<long_term_memory>
Relevant long-term memories for this request. Use them as context, but prefer
newer user messages if there is a conflict.
<memory_index>
source=MEMORY.md
# Long-term memory
- [User's coding preference](pref-xxx.md) - Always use tabs, not spaces
</memory_index>
<memory_files>
<memory_file path="pref-xxx.md" type="user">
Always use tabs for indentation in all TypeScript projects.
</memory_file>
</memory_files>
</long_term_memory>
</context_block>

<context_block source="dynamic_skill">
<runtime-context source="dynamic_skill">
<dynamic-skill>
<dynamic_skills>
The following skills were discovered from project skill directories after
file access. Follow them when relevant to the current task.
<skill name="my-skill">
<description>...</description>
<skill_dir>/path/to/.claude/skills/my-skill</skill_dir>
<skill_path>/path/to/.claude/skills/my-skill/SKILL.md</skill_path>
</skill>
</dynamic_skills>
</dynamic-skill>
</runtime-context>
</context_block>

<context_block source="agent_notification">
<runtime-context source="agent_notification">
<agent-notification>
...notification content...
</agent-notification>
</runtime-context>
</context_block>

<context_block source="file_restore">
<runtime-context source="file_restore">
<file-restore>
<post-compact-file-attachments>
The following files were read before auto-compress and their contents have
been restored into the current context.
<file path="/path/to/file.ts" chars="1234" truncated="false">
<content>
1	import { ...
</content>
</file>
</post-compact-file-attachments>
</file-restore>
</runtime-context>
</context_block>

<context_block source="agent_task_status">
<runtime-context source="agent_task_status">
<agent-task-status>
<async_agent_statuses>
These asynchronous Agent tasks were not represented by a pending notification
when context was compacted.
<agent_task id="agent_abc123">
status: running
type: worker
description: running SWE-bench evaluation
</agent_task>
</async_agent_statuses>
</agent-task-status>
</runtime-context>
</context_block>
</opencat_context>
```

**嵌套规则**：

- 来自 `state.runtimeContextMessages[]` 的块有 **双层包装**：
  `<context_block>` → `<runtime-context source="...">` → `<kebab-case-tag>`（`source` 中 `_` 替换为 `-`）
- 直接产出的 `ProjectionContextBlock`（plan_mode / todo_list / long_term_memory / plan_file）
  只有 **单层包装**：`<context_block>` → `<内容标签>`，没有 `<runtime-context>`
- `createRuntimeContextMessage()` → `wrapRuntimeContextContent()` 负责生成双层包装

---

### 固定块（每轮判断是否产出）

| 块 | source | runtime-context？ | 产出条件 | 内容标签 |
|----|--------|-------------------|----------|----------|
| **Plan Mode** | `plan_mode` | ❌ | `state.mode === "plan"` | `<plan_mode>` |
| **Plan File** | `plan_file` | ❌ | `state.plan?.content` 非空 | `<plan_file>` |
| **Todo List** | `todo_list` | ❌ | `state.todos[agentId].length > 0` | `<todo_list>` |
| **Long-term Memory** | `long_term_memory` | ❌ | 最新 user 消息且 `source === "user"` | `<long_term_memory>` |
| **Runtime Context Messages** | 各异 | ✅ | `state.runtimeContextMessages.length > 0` | 见下方 5 种 |

> `removePreviousVolatileContextBlocks()` 在注入前剥离上轮 `<opencat_context>` 中 `source` 为
> `dynamic_skill`、`todo_list`、`plan_mode` 的 `<context_block>`——这些是易失的。
> `long_term_memory` 和 `plan_file` 保留（直到下一轮被整体替换）。

---

### 长期记忆详细格式

**source**：`"long_term_memory"`，**不带** `<runtime-context>`（属于直接 ProjectionContextBlock）。

**产出流程**：

1. `createLongTermMemoryContextMessage()`：仅在最新消息是 user 时触发
2. `buildLongTermMemoryQuery()`：取最近 6 条 user/assistant 消息（最多 4K 字符）
3. Memory Selector（DeepSeek Flash, JSON mode, 256 tokens）：从 `scanFileMemoryHeaders()` 返回的文件清单中选出最多 5 个，排除已注入过的文件
4. `loadFileMemories(selectedFiles)`：加载选中文件内容（已 strip frontmatter）
5. `renderLongTermMemoryFileContext()`：拼装完整 XML，受 `longTermMemoryConfig.maxInjectedChars` 截断

**XML 结构**：

| 子元素 | 内容 | 来源 |
|--------|------|------|
| `<memory_index>` | `source=MEMORY.md` + MEMORY.md 索引内容（最多 200 行 / 25K 字符） | `loadFileMemoryEntrypoint()` |
| `<memory_files>` | 被 Memory Selector 选中的 `.md` 文件（最多 5 个） | `loadFileMemories(runtime, selectedFiles)` |
| `<memory_file path="..." type="...">` | 单条记忆全文（已去除 YAML frontmatter），`path` 为相对 MEMORY_DIR 的路径，`type` 取 frontmatter 值 | `LoadedFileMemory.content` |

> 记忆选择器排除当前对话中已出现过的记忆文件（正则匹配 `<memory_file path="...">`），也排除
> 最近使用工具的常规用法参考，但保留关于这些工具的 warnings/gotchas 类记忆。

---

### 5 种动态附件（来自 `state.runtimeContextMessages[]`，均带 `<runtime-context>`）

所有动态附件都通过 `createRuntimeContextMessage()` → `wrapRuntimeContextContent()` 生成
`<runtime-context source="...">` → `<kebab-tag>` 双层包装。

---

#### A. Agent Notifications

**来源**：`drainAgentNotifications(state)` 排空 `state.agentNotifications[]`。

**产出条件**：仅在主 agent（`agentRole === "main"`）时收集。

**source**：`"agent_notification"` → kebab tag：`<agent-notification>`

**进入方式**：`loadRuntimeContextForQuery()` → `drainAgentNotifications()` → `appendRuntimeContextMessages()` → `state.runtimeContextMessages[]`

---

#### B. Dynamic Skill Activations

**来源**：`collectActiveDynamicSkills(runtime)` 从 `skillRuntime.dynamicSkills` 收集。

**产出条件**：Agent 访问匹配 `paths` glob 的目录后触发。每轮最多 8 个，总计 32K 字符。

**source**：`"dynamic_skill"` → kebab tag：`<dynamic-skill>`

**进入方式**：`loadDynamicSkillContextForQuery()` → `collectActiveDynamicSkills()` → `appendRuntimeContextMessages()` → `state.runtimeContextMessages[]`

**格式**（在 `<dynamic-skill>` 内）：

```xml
<dynamic_skills>
The following skills were discovered from project skill directories after
file access. Follow them when relevant to the current task.
<skill name="swe-session-auditor">
<description>Audit OpenCat SWE-bench evaluation sessions...</description>
<skill_dir>/path/to/.claude/skills/swe-session-auditor</skill_dir>
<skill_path>/path/to/.claude/skills/swe-session-auditor/SKILL.md</skill_path>
</skill>
</dynamic_skills>
```

---

#### C. Post-compact Invoked Skill Restores

**来源**：`restoreInvokedSkillsAfterAutoCompress()` — auto-compress 后恢复技能。

**触发时机**：auto-compress 执行后。最多 5 个技能，单技能 16K 字符，总计 48K 字符。

**source**：`"dynamic_skill"`（与 B 共用） → kebab tag：`<dynamic-skill>`

---

#### D. Post-compact File Restores

**来源**：`restoreReadFileStateAfterAutoCompress()` — auto-compress 后恢复文件。

**触发时机**：auto-compress 执行后。最多 5 个文件，单文件 24K 字符，总计 60K 字符。

**source**：`"file_restore"` → kebab tag：`<file-restore>`

**格式**（在 `<file-restore>` 内）：

```xml
<post-compact-file-attachments>
The following files were read before auto-compress and their contents have
been restored into the current context.
<file path="/path/to/file.ts" chars="1234" truncated="false">
<content>
1	import { ...
</content>
</file>
</post-compact-file-attachments>
```

---

#### E. Agent Task Status (post-compact)

**来源**：`loadUnclaimedAgentTaskContextAfterAutoCompress()` — 压缩后重新声明
运行中的 async agent 任务（那些没有新通知的任务）。

**触发时机**：auto-compact 执行后。最多 12 个任务，总计 24K 字符。

**source**：`"agent_task_status"` → kebab tag：`<agent-task-status>`

**格式**（在 `<agent-task-status>` 内）：

```xml
<async_agent_statuses>
These asynchronous Agent tasks were not represented by a pending notification
when context was compacted. Continue or inspect them as needed.
<agent_task id="agent_abc123">
status: running
type: worker
description: running SWE-bench evaluation
output_file: /path/to/output.txt
</agent_task>
</async_agent_statuses>
```

---

## 完整生命周期图

```
Session 启动
  │
  ├─ buildSystemPrompt() → runtime.systemPrompt（缓存，11 段）
  ├─ loadProjectInstructionContext() → runtime.userContext（缓存，CLAUDE.md + date）
  │
  ▼
┌─── 每轮 Query ───────────────────────────────────────────┐
│                                                            │
│  Phase A: drainPendingAgentMessagesForRuntime()            │
│    → agent_message user 消息追加到 state.Messages         │
│                                                            │
│  Phase B: buildMessagesForQuery() 第 1 次                  │
│    ├─ Layer 1: applyAutoCompressSummary()                  │
│    ├─ Layer 2: applyExistingToolResultBudgetWithStats()    │
│    ├─ Layer 3: createBulkyToolCompactionsWithStats()       │
│    ├─ Layer 4: createHistorySnipBoundary()（循环最多 8 次）│
│    └─ createDeepSeekMessages() → prependUserContextMessages│
│                                                            │
│  Auto-compress 检查（180K 触发）                           │
│    ├─ applyAutoCompression() → 永久压缩 state.Messages    │
│    └─ restorePostAutoCompressContext()                     │
│        ├─ restoreReadFileStateAfterAutoCompress()          │
│        │   → file_restore 写入 runtimeContextMessages      │
│        ├─ restoreInvokedSkillsAfterAutoCompress()          │
│        │   → dynamic_skill 写入 runtimeContextMessages     │
│        └─ loadUnclaimedAgentTaskContextAfterAutoCompress() │
│            → agent_task_status 写入 runtimeContextMessages │
│                                                            │
│  Phase B: buildMessagesForQuery() 第 2 次（仅压缩触发时）  │
│                                                            │
│  Phase C: materializeRequestContext()                      │
│    ├─ loadRuntimeContextForQuery()                         │
│    │   → drainAgentNotifications() → runtimeContextMessages│
│    ├─ loadDynamicSkillContextForQuery()                    │
│    │   → collectActiveDynamicSkills() → runtimeContextMsgs │
│    ├─ removePreviousVolatileContextBlocks()                │
│    ├─ restorePlan()                                       │
│    └─ 合并本轮上下文                                      │
│    │   → createProjectionContextStateMessage([            │
│    │       planMode + planFile + todoList +               │
│    │       longTermMemory + ...runtimeContextMessages     │
│    │     ]) → append to state.Messages                     │
│    └─ state.runtimeContextMessages = []（清空）           │
│                                                            │
│  Phase C: buildMessagesForQuery() 第 3 次（最终投影）      │
│    → 包含完整的 <opencat_context> 消息                     │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

## 不会被压缩的内容

| 内容 | 压缩免疫原因 |
|------|-------------|
| System Prompt（11 段 + git status） | 不在 `state.Messages` 中，独立发送 |
| `<system-reminder>`（CLAUDE.md + date） | `prependUserContextMessages()` 在 `createDeepSeekMessages()` 中注入，在 budget/compact/snip 之后 |
| `<opencat_context>`（Phase C 注入） | 在 auto-compress 之后才追加到 `state.Messages`，不会被本轮压缩吞噬 |

---

## 会被压缩的内容

| 内容 | 所在位置 | 压缩方式 |
|------|----------|----------|
| Auto-compress Summary | `state.Messages` 中的 `"auto_compress"` 源消息 | 被后续 auto-compress 覆盖为新摘要 |
| 旧 `<opencat_context>` | `state.Messages` 中上轮的消息 | 参与 budget/compact/snip 投影变换；易失块被 `removePreviousVolatileContextBlocks` 剥离 |
| Plan/Todo/Long-term Memory 块 | `<opencat_context>` 内部 | `plan_mode` / `todo_list` / `dynamic_skill` 是易失的（每轮清除），`long_term_memory` 保留到下一轮替换 |

---

← [返回 ARCHITECTURE.md 目录](../ARCHITECTURE.md)
