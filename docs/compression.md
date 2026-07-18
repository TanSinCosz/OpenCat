# 上下文压缩与恢复

## 六、上下文压缩（Context Compression）

当对话历史超出 DeepSeek 上下文窗口限制时，`buildMessagesForQuery()`（`src/query/messages.ts`）中的四级压缩管道按优先级依次触发。涉及文件：

| 文件                                           | 行数 | 职责                                                      |
| ---------------------------------------------- | ---- | --------------------------------------------------------- |
| `src/query/messages.ts`                      | 1531 | 压缩管道主控：四级调度、Token 估算、消息投影核心逻辑      |
| `src/auto-compress/auto-compress.ts`         | 565  | Auto Compress：持久化摘要生成与激活                       |
| `src/auto-compress/read-file-restore.ts`     | 238  | 压缩后文件读取缓存恢复                                    |
| `src/auto-compress/invoked-skill-restore.ts` | 122  | 压缩后已激活技能恢复                                      |
| `src/session-memory/session-memory.ts`       | 280  | Session Memory：滚动会话笔记的读写与更新调度              |
| `src/session-memory/prompts.ts`              | 144  | Session Memory 更新提示词                                 |
| `src/session-memory/persistence.ts`          | 126  | Session Memory JSON 持久化                                |
| `src/types/context.ts`                       | 46   | 压缩相关类型（AutoCompressState, HistorySnipBoundary 等） |

### 6.1 四级压缩管道（两轮循环 + 两阶段调用）

四种压缩策略由 `buildMessagesForQuery()`（`src/query/messages.ts`）实现，按**两轮循环**组织——先应用已有投影状态，若仍超阈值则创建新的压缩并重跑。

**关键架构变更**：`buildMessagesForQuery()` 现在在 query.ts 主循环中被**多次调用**，分为 Phase B 和 Phase C 两阶段：

- **Phase B**（第 112-142 行）：先调用 `buildMessagesForQuery()` 做纯消息投影 → 检查是否需要 auto-compress → 若触发了压缩则再次调用 `buildMessagesForQuery()` 重建投影。这一阶段 auto-compress 可能永久修改 `state.Messages`（将旧消息替换为摘要）。
- **Phase C**（第 146-157 行）：先调用 `materializeRequestContext()` 追加易失运行时上下文到 `state.Messages` → 再调用 `buildMessagesForQuery()` 做最终投影。运行时上下文（长期记忆、技能通知、Plan/Todo 等）在压缩**之后**注入，确保不被压缩吞掉。

`buildMessagesForQuery()` 内部的四级管道：

```
buildMessagesForQuery(runtime, state)
  │
  │  ═══════════ 第1轮: 应用已有投影状态 ═══════════
  │
  ├─ ① applyAutoCompressSummary(state)
  │   触发: state.autoCompress.summaries 非空
  │   行为: 将持久化摘要作为 user 消息插入，throughMessageId 之前的旧消息全部删除
  │   尾部保护: TARGET_RECENT_TAIL_TOKENS = 30K, MAX_RECENT_TAIL_TOKENS = 40K
  │            MIN_RECENT_USER_CONTENT_MESSAGES = 3, MIN_RECENT_API_MESSAGES = 12
  │
  ├─ ② applyExistingToolResultBudgetWithStats(messages, runtime, state)
  │   触发: state.toolResultBudgetState.replacements 中有已持久化的替换
  │   行为: 将之前已持久化的大体积 tool_result 替换为预览块
  │         （持久化到 .opencat/tool-results/{sessionId}/ 目录）
  │   常量: MAX_TOOL_RESULTS_PER_MESSAGE_TOKENS = 50_000（单组触发阈值）
  │         TOOL_RESULT_PREVIEW_CHARS = 2_000（预览字符数）
  │   注意: 新预算替换的创建不在 buildMessagesForQuery 中，
  │         而是在 query.ts 主循环里通过 persistToolResultForBudget() 触发
  │
  │   Tool Result Budget 的排除逻辑（`budgetToolResultsWithStats()`, `messages.ts:623`）：
  │     以下工具被排除，不参与单组 50K 的阈值计算：
  │     const skipToolNames = new Set(
  │       runtime.tools
  │         .filter((tool) => tool.maxResultSizeChars === Infinity)
  │         .map((tool) => tool.name),
  │     );
  │     唯一 maxResultSizeChars === Infinity 的内置工具是 Read（FileRead）。
  │     设计意图：Read 自备 offset/limit 参数可防御性控制输出大小，
  │     用户调 Read 是"我要这份文件"的显式意图，不应被系统透明替换。
  │     其他工具的 maxResultSizeChars 均为有限值（Bash 30K，Grep/Memory 20K，
  │     Glob/Edit/Write/WebFetch/ReadSkill/Agent/TodoWrite/Plan/SendMessage 100K 等），
  │     全部参与 Budget 计算。
  │     实际影响：若一轮工具调用中 Read 占了大头，剩余工具的 token 总量
  │     可能达不到 50K 阈值，导致 Tool Result Budget 不触发。
  │
  ├─ ③ applyExistingBulkyToolCompactionsWithStats(messages, runtime, state)
  │   触发: state.toolResultBudgetState.replacements 中有已持久化的 bulky 压缩
  │   行为: 应用之前已创建的 smart truncation 替换
  │
  ├─ ④ applyHistorySnipBoundaries(state, messages)
  │   触发: state.historySnips 非空
  │   行为: 应用已持久化的 snip 边界：移除已标记的消息、降级已标记的 content-only 消息
  │
  ├─ ⑤ 转为 DeepSeekMessages → 测量 Token 总量
  │
  │  ═══════════ 第2轮: 创建新压缩（仅当第1轮后仍超阈值）═══════════
  │
  ├─ ⑥ if isContextOverBulkyCompactThreshold(deepSeekMessages):
  │     createBulkyToolCompactionsWithStats(visibleMessages, runtime, state, ...)
  │     触发: 全局上下文 ≥ DEFAULT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS (180K)
  │     目标: 压缩到 DEFAULT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS (80K)
  │     范围: BULKY_TOOL_NAMES = {Read, Edit, Write, Grep, Glob, WebFetch, ReadSkill}
  │           （Bash 排除，避免截断运行时关键输出）
  │     策略: 保留头尾各约一半目标字符，中间标记 <tool-result-compact>
  │
  ├─ ⑦ if shouldCreateHistorySnipBoundary(...):
  │     createHistorySnipBoundary(...) → 写入 state.historySnips[]
  │     触发: ⑥中 bulky compact 已被判定为 needed 且总 Token 仍 > 80K（bulky target）
  │     行为: 遍历保护尾部之前的旧消息：
  │           a) 可降级消息（旧 user/assistant 文本）→ 保留 content，剥离 tool_calls 和 reasoning
  │           b) 可移除消息（tool result, 可再生 runtime context）→ 完全删除
  │     排除: system 消息、plan mode / todo_list 相关消息、最近尾部保护区的所有消息
  │     target: DEFAULT_HISTORY_SNIP_TARGET_TOKENS = 80K
  │
  │  ═══════════ Snip 后重新投影（若创建了新 snip 边界）═══════════
  │
  └─ ⑧ 重新执行 ①→⑥（复用新写入的 snip 边界）
       → 返回 { systemPrompt, messages, forkContextMessages, stats }
```

**Auto-compress 的触发位置**：不在 `buildMessagesForQuery()` 内部，而是在 `query.ts` 的 Phase B 中，两次 `buildMessagesForQuery()` 调用之间：

```
Phase B:
  buildMessagesForQuery()  →  判断 getAutoCompressionRequest()
    → 若投影 token ≥ 180K → applyAutoCompression() 永久压缩 state.Messages
    → buildMessagesForQuery() 再次调用以应用新压缩
```

**尾部保护（两套同名常量）**：

`calculateProjectionRecentTailStart()`（`messages.ts:1020`）从消息列表末尾向前扫描，保护最近的消息不被压缩/移除：

```typescript
function isProjectionRecentTailLargeEnough(stats): boolean {
  return stats.tokens >= getProjectionRecentTailTargetTokens() &&   // 30K
    stats.apiMessages >= getProjectionRecentTailMinApiMessages() &&  // 12
    stats.textMessages >= getProjectionRecentTailMinTextMessages();  // 3
}
```

三个条件是 **AND 关系**，全部满足才停止扫描。如果遍历到消息列表头部仍未满足 → 完整保留所有消息。在三个条件都满足前，`stats.tokens >= getProjectionRecentTailMaxTokens()`（40K）也会强制中断扫描。

两套常量数值相同但分属不同模块：

| 模块                    | 变量名                                               | 值  | 用途                                       |
| ----------------------- | ---------------------------------------------------- | --- | ------------------------------------------ |
| `messages.ts:39-42`   | `DEFAULT_PROJECTION_RECENT_TAIL_TARGET_TOKENS`     | 30K | `buildMessagesForQuery` 中的投影尾部计算 |
| `messages.ts:40`      | `DEFAULT_PROJECTION_RECENT_TAIL_MAX_TOKENS`        | 40K | 同上                                       |
| `messages.ts:41`      | `DEFAULT_PROJECTION_RECENT_TAIL_MIN_API_MESSAGES`  | 12  | 同上                                       |
| `messages.ts:42`      | `DEFAULT_PROJECTION_RECENT_TAIL_MIN_TEXT_MESSAGES` | 3   | 同上                                       |
| `auto-compress.ts:31` | `TARGET_RECENT_TAIL_TOKENS`                        | 30K | auto-compress 内部的尾部计算               |
| `auto-compress.ts:32` | `MAX_RECENT_TAIL_TOKENS`                           | 40K | 同上                                       |
| `auto-compress.ts:33` | `MIN_RECENT_USER_CONTENT_MESSAGES`                 | 3   | 同上                                       |
| `auto-compress.ts:34` | `MIN_RECENT_API_MESSAGES`                          | 12  | 同上                                       |

此外，`calculateProtectedRecentTailStart()` 在 `calculateProjectionRecentTailStart()` 基础上还调了 `moveToSafeBusinessTailBoundary()`，避免切断在用户消息中间或 assistant 工具调用序列中。

### 6.2 第1级详解：Auto Compress Summary（持久化压缩）

**入口**：`applyAutoCompression()`（`auto-compress.ts:57`），由 `query.ts` 中的 `applyAutoCompressionWithTelemetry()` 包装调用。内部按 agent 角色分流为三条路径：

```
applyAutoCompression(runtime, state, options)
  ├─ agentRole === "session"  → skip (session agent 不做压缩)
  ├─ agentRole !== "main"     → applySubagentLocalCompression()  ← 子 agent 路径
  └─ agentRole === "main"     → applyMainSessionMemoryCompression() ← 主 agent 路径
```

**触发条件**（`query.ts:828` 中的 `getAutoCompressionRequest()`）：

1. `canRuntimeAutoCompress()` — `agentRole !== "session"` 且 `agentType !== "session_memory"`
2. `estimateMessagesForQueryTokens(messagesForQuery) ≥ getAutoCompressTriggerTokens()`（默认 180K，可通过 `OPENCAT_AUTO_COMPRESS_TRIGGER_TOKENS` 环境变量覆盖）

**主 agent 路径**（`applyMainSessionMemoryCompression`）——**不 fork 子 agent，直接使用已有的 Session Memory 内容**：

1. `loadPersistedSessionMemory()` → 从 `.opencat/session-memory/{sessionId}.json` 加载
2. `resetSessionMemoryUpdateFlagIfSummaryHasTail()` → 如果 summary 不覆盖最新消息，重置标志以触发后续 Session Memory 更新
3. 检查 `doesSessionMemoryCoverMessage()` — Session Memory 的 `lastSummarizedMessageId` 必须 ≥ `snippedContentThroughMessageId`，否则 skip
4. `createSessionMemoryAutoCompressSummary(state)` → 从 `state.sessionMemory.content` 生成 `AutoCompressSummary`：
   - 条件：`sessionMemory.status === "ready"`、`lastSummarizedMessageId` 非空、content 非空
   - 通过 `renderSessionMemorySummary()` 渲染为 XML 格式
5. `activateAutoCompressSummary(autoCompress, summary)` → 写入 `state.autoCompress.summaries[]`
6. `recordSnippedContentCompactionBoundary()` → 记录 snipped 边界
7. `restorePostAutoCompressContext()` → 恢复 readFileState 和 invokedSkills
8. 下一次 `buildMessagesForQuery()` 时 `applyAutoCompressSummary()` 将 summary 注入为 `source: "auto_compress"` 的 user 消息，throughMessageId 之前的消息被移除

**子 agent 路径**（`applySubagentLocalCompression`）——**调用 LLM 生成局部摘要（非 fork agent，是单次模型调用）**：

1. `getActiveAutoCompressSummary()` → 如果已有最新 summary 则复用
2. `createLocalAutoCompressSummary()` → `calculateRecentTailStartFromEnd()` 确定尾部起点 → 截取尾部之前的消息 → `summarizeLocalCompactMessages()` 调用 LLM 生成摘要（上限 `LOCAL_COMPACT_MAX_TRANSCRIPT_CHARS = 120_000` 字符）
3. `activateAndRestoreAutoCompressSummary()` → 写入 state + 恢复上下文

**关键常量**（`auto-compress.ts:31-35`）：

- `TARGET_RECENT_TAIL_TOKENS = 30_000` — 尾部目标 Token 数
- `MAX_RECENT_TAIL_TOKENS = 40_000` — 尾部最大 Token 数
- `MIN_RECENT_USER_CONTENT_MESSAGES = 3` — 尾部至少保留的用户消息数
- `MIN_RECENT_API_MESSAGES = 12` — 尾部至少保留的 API 消息数
- `LOCAL_COMPACT_MAX_TRANSCRIPT_CHARS = 120_000` — 子 agent 局部摘要的最大 transcript 字符数

**Session Memory 与 Auto Compress 的协作**（`session-memory.ts`）：

- Auto Compress 执行后重置 `sessionMemoryUpdated: false`，触发新一轮 Session Memory 更新
- Session Memory fork 子 agent（`session_memory` 类型）编辑 `.opencat/session-memory/{sessionId}.md`，维护滚动结构化笔记
- `shouldUpdateSessionMemory()` 的触发条件：
  - 首次：消息 Token ≥ `minimumMessageTokensToInit`（10,000）
  - 后续：Token 增量 ≥ `minimumTokensBetweenUpdate`（5,000）且满足安全断点（tool 调用数 ≥ `toolCallsBetweenUpdates` 或最近轮无 tool call）

### 6.3 第3级详解：Bulky Tool Result Compact

对以下 7 种工具的结果做智能截断（`BULKY_TOOL_NAMES`）：

- Read, Edit, Write, Grep, Glob, WebFetch, ReadSkill
- Bash 被**排除**（避免截断运行时副作用的关键输出）

**触发**：第1轮后 `isContextOverBulkyCompactThreshold() ≥ 180K` → 进入 `createBulkyToolCompactionsWithStats()`。

**截断策略**（`renderHeadTailToolResultPreview()`）：

- 按 `BULKY_TOOL_RESULT_COMPACT_PREVIEW_TOKENS = 1_000` tokens（≈ 4,000 字符）为上限
- 取内容头尾各一半字符，中间标记 `[N characters omitted from the middle]`
- 输出包裹在 `<preview_head>` / `<preview_tail>` 中

**替换格式**（`buildBulkyToolResultReplacement()`）：

```
<tool-result-compact>
Tool result from {toolName} was compacted in this request because this tool commonly produces large, regenerable outputs.
tool_call_id: ...
original_size: ... characters
estimated_tokens: ...
persisted_path: .opencat/tool-results/{sessionId}/{id}
sha256: ...
The original result was persisted once and was not re-executed.
<preview_head>...</preview_head>
[N chars omitted from the middle]
<preview_tail>...</preview_tail>
</tool-result-compact>
```

**持久化**：`buildBulkyToolResultReplacement()` 现在调用 `persistToolResultContent()`（`src/tool-results/storage.ts`）将原内容落盘到 `.opencat/tool-results/{sessionId}/{id}`，替换消息中写入 `persisted_path` 和 `sha256`。之前的纯内存 SHA256 哈希逻辑已替换为磁盘持久化 + 路径引用。

**候选选择**（`createBulkyToolCompactionsWithStats()`）：

- 从 `collectBulkyToolResultCandidates()` 收集所有 bulky 工具的非 tool_result
- 保护尾部候选（`calculateProjectionRecentTailStart()` 之后的，或通过 `OPENCAT_BULKY_TOOL_RESULT_KEEP_RECENT` 环境变量指定保留最近 N 个）
- 余下的按最旧优先处理，跳过 size ≤ 1K tokens 的结果
- 已达 context target (80K) 后停止

### 6.4 第4级详解：History Snip

**触发条件**（`shouldCreateHistorySnipBoundary()`，`messages.ts:893`）：

```typescript
// ① 如果本消息已有一个 snip 边界 → 跳过
// ② bulkyCompactNeeded 必须为 true（意味着 bulky compact 无法将上下文压到目标以下）
// ③ 总 Token 数 > getBulkyToolResultCompactTargetContextTokens() (80K)
```

即：**bulky compact 被判定为 needed 后仍超 80K** 才触发 snip。

**两阶段处理**：

1. `createHistorySnipBoundary()` — 遍历保护尾部之前的消息，收集决策：

   - `selectHistorySnipDecision()` 按最旧优先，目标移除足够的 Token 使总量降到 `getDesiredHistorySnipTokens()` (80K)
   - 先尝试降级（content-only），降级不够再移除
   - 写入 `state.historySnips[]`
2. `applyHistorySnipBoundaries()` — 在后续投影中应用已存边界：

   - removedMessageIds → 删除整条消息
   - contentOnlyMessageIds → 保留 content，剥离 tool_calls / reasoning_content

**可移除的消息类型**（`isHistorySnipRemovableMessage()`）：

- 所有 tool 角色消息
- assistant 消息（tool_calls 属性被剥离）
- 可直接重生的 runtime context（`<long_term_memory>`, `*_restore`, `agent_notification`, `agent_message` 等）

**可降级为 content-only 的消息**（`createHistorySnipContentOnlyMessage()`）：

- 旧用户消息（保留 content，移除所有元数据）
- 旧 assistant 文本消息（保留 content，剥离 tool_calls 和 reasoning_content）

**不可触碰的消息**：

- system 消息（系统提示词）
- plan mode / todo_list 相关消息
- 最近尾部保护区内所有消息（`calculateProjectionRecentTailStart()` 之后）

**边界记录**：`HistorySnipBoundary`（id, removedMessageIds, contentOnlyMessageIds, reason: "prompt_budget", createdAt, createdAtMessageId），写入 `state.historySnips[]`。

### 6.5 压缩后的恢复

Auto Compress 后自动恢复关键状态：

- **文件读取缓存**（`restoreReadFileStateAfterAutoCompress()`）：从 `readFileState` dump/load 机制恢复，确保 Edit 工具的 "先读后改" 约束不因压缩失效
- **已激活技能**（`restoreInvokedSkillsAfterAutoCompress()`）：将 compression 前已 invoke 的技能内容重新注入到投影中，防止技能信号丢失

---

## 七、上下文恢复（Context Restoration）

### 7.1 对话持久化格式

对话以 **JSONL** 格式存储：

```
.opencat/transcripts/
├── {sessionId}.jsonl                    # 主智能体对话
├── {sessionId}/
│   ├── session-agents/
│   │   └── agent-{agentId}.jsonl       # Session Memory 智能体对话
│   └── subagents/
│       └── agent-{agentId}.jsonl       # 子智能体对话
```

### 7.2 条目类型

每条 JSONL 行有两种类型：

**`TranscriptMessageEntry`**：携带单条消息

```json
{"type":"message","message":{"id":"...","role":"user","content":"..."}}
```

**`TranscriptStateSnapshotEntry`**：携带状态快照

```json
{"type":"snapshot","autoCompress":{...},"sessionMemory":{...},"invokedSkills":[...],"agentTasks":{...}}
```

### 7.3 恢复模式

| 模式           | 行为                               |
| -------------- | ---------------------------------- |
| **full** | 恢复所有消息（包含已压缩的历史）   |
| **auto** | 跳过已压缩的消息（仅恢复活跃部分） |

### 7.4 恢复流程

```
loadStateFromTranscript(sessionId)
  │
  ├─ 读取 JSONL 文件
  ├─ 逐行解析消息和状态快照
  ├─ 重建 state.Messages
  ├─ 重建 state.autoCompress
  ├─ 重建 state.sessionMemory
  ├─ 重建 state.invokedSkills
  └─ 返回完整的 State 对象
```

---

---

← [返回 ARCHITECTURE.md 目录](../ARCHITECTURE.md)
