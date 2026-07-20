# 长期记忆

## 八、长期记忆（Long-term Memory）

长期记忆基于**文件系统**（Markdown 文件 + 索引），跨会话保留用户偏好、项目约定和重要发现。

涉及文件：

| 文件                              | 行数 | 职责                                                 |
| --------------------------------- | ---- | ---------------------------------------------------- |
| `src/Memory/file-memory.ts`     | 360  | 核心：Markdown 读写、MEMORY.md 索引维护、SHA256 去重 |
| `src/Memory/auto-dream.ts`      | 354  | Dream 合并：从日志到 topic 文件的整理流程            |
| `src/Memory/runtime.ts`         | 103  | 配置默认值（`LongTermMemoryRuntimeConfig`）        |
| `src/query/long-term-memory.ts` | 556  | Query 循环层：注入构建、自动提取调度、文件选择       |
| `src/Tools/MemorySave/`         | ~50  | MemorySave 工具：Agent 调用 →`saveFileMemory()`   |

---

### 8.1 数据结构

#### 8.1.1 磁盘布局

```
~/.opencat/memory/projects/<project-key>/   ← getFileMemoryDir()
├── MEMORY.md                               ← 索引文件（entrypoint）
├── logs/                                   ← 自动提取的原始信号
│   └── YYYY/MM/YYYY-MM-DD.md
├── <slug>-<hash8>.md                       ← topic 记忆文件
└── .dream.lock                             ← Dream 并发锁
```

`project-key` 由 `cwd` 路径通过 `createProjectMemoryKey()` 转换得来：将绝对路径中的盘符、分隔符替换为可读的 key 名。例如 `C:\Users\Administrator\Desktop\opencat-typescirpt` → `C-Users-Administrator-Desktop-opencat-typescirpt-854479bd`（末尾 8 位是路径 hash 的截断）。如果配置了 `fileMemoryDirectory` 环境变量，则直接使用该路径，不推导 project key。

#### 8.1.2 基础常量（`file-memory.ts`）

系统默认将记忆存储在 `~/.opencat/memory/<project-key>/` 下。相关常量：

| 常量                         | 值                  | 含义           |
| ---------------------------- | ------------------- | -------------- |
| `FILE_MEMORY_BASE_DIR`     | `.opencat/memory` | 记忆根目录     |
| `FILE_MEMORY_ENTRYPOINT`   | `MEMORY.md`       | 索引文件名     |
| `FILE_MEMORY_LOGS_DIR`     | `logs`            | 日志目录       |
| `DEFAULT_MEMORY_TYPE`      | `"user"`          | 默认记忆类型   |
| `MAX_SCANNED_MEMORY_FILES` | 200                 | 最大扫描文件数 |

索引文件由 `ENTRYPOINT_HEADER` 模板生成，包含标题 "Long-term memory" 和一行使用说明。

路径计算：

- `getFileMemoryDir(runtime)`：如配置了 `fileMemoryDirectory` 则直接用；否则推导为 `~/.opencat/memory/projects/<project-key>`
- `getFileMemoryEntrypointPath(runtime)` → `<memoryDir>/MEMORY.md`
- `getFileMemoryLogsDir(runtime)` → `<memoryDir>/logs`

#### 8.1.3 记忆文件格式

YAML frontmatter + Markdown 正文。`renderMemoryFile()` 拼接：

```markdown
---
name: "简短标题"
description: "一行描述，用于后续相关性选择"
type: user | feedback | project | reference
hash: <SHA256 of memory content>
reason: "保存原因（可选）"
---
记忆正文内容。
```

辅助函数：

- `hashMemory(memory: string)` → `createHash("sha256").update(memory).digest("hex")`
- `slugify(memory: string)` → 取正文的前 80 个字符，保留 CJK/字母/数字，空格和标点换成 `-`，去首尾连字符，转小写
- `titleFromMemory(memory)` → 取正文的第一句（以 `.`、`！`、`?`、`\n` 等分隔），最长 120 字符
- `descriptionFromMemory(memory)` → 与 title 相同（简洁的一行）
- 文件名 = `${slugify(memory)}-${hash.slice(0, 8)}.md`

四种类型：

| 类型          | 含义                                         |
| ------------- | -------------------------------------------- |
| `user`      | 用户角色、偏好、背景                         |
| `feedback`  | 对工作方式的修正（含 Why + How）             |
| `project`   | 非代码可推导的项目上下文（动机、约束、决策） |
| `reference` | 外部系统指针                                 |

**Frontmatter 解析**：用正则 `/^---\r?\n([\s\S]*?)\r?\n---/` 匹配 YAML 头，逐行按 `:` 分割 key:value。`parseYamlScalar()` 去引号、保持字符串（不做 boolean/数字转换）。`stripFrontmatter()` 用同样的正则删除 frontmatter，提取正文。

#### 8.1.4 MEMORY.md 索引格式

```markdown
# Long-term memory

This file is an index. Keep each entry short and put memory details in topic files.
- [用户喜欢樊文华。](memory-331717f4.md) - 用户喜欢樊文华。
```

`ensureEntrypointHasLink()` 维护该索引：

1. 读 `MEMORY.md`，不存在则用 `ENTRYPOINT_HEADER` 模板创建
2. 计算 `relative(entrypointDir, memoryPath)` 得到相对路径 link
3. 用 `content.includes(\`](${link})\`)` 检查链接是否已存在（简单 substring 匹配）
4. 不存在 → 追加 `\n- [title](link) - description\n`

#### 8.1.5 核心类型

| 类型                           | 关键字段                                                         | 说明                                                                       |
| ------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `FileMemoryType`             | `"user"` \| `"feedback"` \| `"project"` \| `"reference"` | 记忆分类                                                                   |
| `SaveFileMemoryInput`        | `memory`(必填), `reason?`, `type?`                         | MemorySave 工具的输入                                                      |
| `SaveFileMemoryResult`       | `id`, `memory`, `metadata`                                 | 保存结果。`metadata.event` = `"ADD"`(新创建) 或 `"EXISTS"`(去重命中) |
| `FileMemoryHeader`           | `filename`, `path`, `name?`, `description?`, `type?`   | 扫描得到的记忆文件元信息                                                   |
| `LoadedFileMemory`           | 继承`FileMemoryHeader` + `content`                           | 加载后含已剥离 frontmatter 的正文                                          |
| `LoadedFileMemoryEntrypoint` | `path`, `content`                                            | MEMORY.md 索引文件的内容                                                   |

#### 8.1.6 文件扫描与去重

**`scanFileMemoryHeaders()`** — 递归扫描所有 `.md` topic 文件（排除 `MEMORY.md` 和 `logs/` 目录），解析每个文件的 frontmatter，返回 `FileMemoryHeader[]`，最多 200 条。`listMarkdownMemoryFiles()` 递归遍历目录，跳过 `logs` 子目录，按文件名排序。

**`findMemoryByHash()`** — 去重核心：遍历 `memoryDir` 下所有 `.md` 文件（排除 `MEMORY.md`），读取内容，检查 `content.includes(\`hash: ${hash}\`)`。命中 → 返回已存在的文件路径，调用方只更新索引链接，不创建新文件。

**`formatFileMemoryManifest(headers)`** — 将 `FileMemoryHeader[]` 渲染为供选择模型使用的文本清单：

```
- [user] memory-331717f4.md: 用户喜欢樊文华。 - 用户喜欢樊文华。
```

**`loadFileMemories(runtime, filenames)`** — 批量加载指定文件名的记忆：

1. 先调 `scanFileMemoryHeaders()` 获取有效文件列表（防止注入非法路径）
2. 对每个 filename，在 headers 中查找 → 读取文件 → `stripFrontmatter()` → 返回 `LoadedFileMemory[]`

#### 8.1.7 关键常量

| 常量                                   | 值   | 来源                | 含义                           |
| -------------------------------------- | ---- | ------------------- | ------------------------------ |
| `MEMORY_QUERY_RECENT_MESSAGES`       | 6    | long-term-memory.ts | 构建查询用的最近消息数         |
| `MEMORY_QUERY_MAX_CHARS`             | 4000 | long-term-memory.ts | 查询字符串最大长度             |
| `MAX_RELEVANT_MEMORY_FILES`          | 5    | long-term-memory.ts | 每轮注入最多选中的文件数       |
| `MEMORY_SELECTOR_MAX_TOKENS`         | 512  | long-term-memory.ts | 选择模型输出 token 上限        |
| `FILE_MEMORY_EXTRACTION_MAX_TURNS`   | 5    | long-term-memory.ts | 提取子 agent 最大轮数          |
| `RECENT_TOOL_NAMES_FOR_MEMORY_QUERY` | 12   | long-term-memory.ts | 发给选择器的近期工具数         |
| `MEMORY_DREAM_MAX_TURNS`             | 8    | auto-dream.ts       | Dream 子 agent 最大轮数        |
| `MEMORY_DREAM_RECENT_SESSION_LIMIT`  | 8    | auto-dream.ts       | Dream 考虑的最近 transcript 数 |

---

### 8.2 配置

`LongTermMemoryRuntimeConfig`（`src/Memory/runtime.ts`）：

| 字段                    | 类型    | 默认值             | 说明                           |
| ----------------------- | ------- | ------------------ | ------------------------------ |
| `enabled`             | boolean | `true`           | 总开关                         |
| `autoInject`          | boolean | `true`           | 每轮自动注入文件记忆           |
| `autoExtract`         | boolean | `false`          | 每轮结束后 fork agent 提取信号 |
| `autoInjectTopK`      | number  | 6                  | 保留字段                       |
| `searchThreshold`     | number  | 0.1                | 保留字段                       |
| `maxInjectedChars`    | number  | 8000               | 注入记忆的最大字符数           |
| `fileMemoryDirectory` | string? | —                 | 覆盖默认记忆存储路径           |
| `userId`              | string  | `"default-user"` | 用户标识                       |
| `agentId`             | string  | —                 | Agent 标识                     |
| `runId`               | string  | —                 | 运行标识                       |

`createLongTermMemoryRuntimeConfig()` 从 options 和 identity 合并默认值。CLI 入口中 `autoInject` 为 `true`（注入开启），`autoExtract` 为 `false`（提取需显式开启）。

---

### 8.3 调用链：注入（每轮 query 时）

#### 8.3.1 完整函数调用路径

```
query()                                          // query.ts:76
  → _query()                                     // query.ts:84  (主循环)
    → materializeContextForQuery()                // query.ts:548
      → shouldAttachLongTermMemory(state)         // query.ts:673
          return lastMessage?.role === "user"
              && lastMessage.source === "user"
          // 只在收到真实用户消息时才注入，runtime/system 消息不触发
      → createLongTermMemoryContextMessage(
          runtime, visibleMessages)              // long-term-memory.ts:35
      → createProjectionContextStateMessage()    // runtime-context.ts:88
      → state.Messages.push(contextMessage)      // query.ts:579
```

#### 8.3.2 `createLongTermMemoryContextMessage()` — 9 步流程

`src/query/long-term-memory.ts:35`。该函数从消息历史中提取上下文，查询文件记忆，渲染为 XML 块返回。异常静默捕获——记忆注入失败不阻塞主流程。

1. **检查配置**：`enabled && autoInject` 都为 true 才继续
2. **构建查询**：调用 `buildLongTermMemoryQuery()`，从最近消息提取查询字符串
3. **加载索引**：读 `MEMORY.md`，不存在则跳过
4. **扫描文件**：`scanFileMemoryHeaders()` 获取所有记忆文件的元信息
5. **收集防重复信息**：`collectSurfacedLongTermMemoryFiles()` 提取已注入过的文件名，`collectRecentToolNames()` 收集最近 12 个工具名
6. **选择相关文件**：`selectRelevantFileMemories()` 用 DeepSeek（JSON mode, 512 tokens）从 manifest 中选 ≤5 个文件
7. **加载内容**：`loadFileMemories()` 读取选中文件
8. **渲染 XML**：`renderLongTermMemoryFileContext()` 生成 `<long_term_memory>` 块
9. **发送事件**：`emitRunEvent()` 记录遥测（查询大小、结果数、注入字符数）

#### 8.3.3 `buildLongTermMemoryQuery()`

从消息数组中提取最近 6 条 user/assistant 消息的文本，拼接为 `role: content` 格式，截断到 4000 字符。过滤条件：消息 `role` 为 `"user"` 或 `"assistant"`，`source` 为 `"user"` 或 `"assistant"`，有非空文本内容。

#### 8.3.4 `selectRelevantFileMemories()` — 文件选择器（核心）

用轻量 DeepSeek 调用从 manifest 中挑选相关文件：

- **模型**：`deepseek-v4-flash`（便宜、快）
- **响应格式**：`json_object`（`{"selected_files":["path.md"]}`）
- **输出上限**：512 tokens
- **温度**：0

System prompt 约束：只从提供的 manifest 中选择文件名，不确定就不选，keyword 重叠不等于相关。如提供了近期工具名，不选这些工具的普通参考记忆（但保留警告/已知问题）。结果经过 `parseSelectedMemoryFiles()` 容错解析——`extractJsonObject()` 提取 JSON 子串，失败返回空数组。最终过滤并截断到 ≤5 个文件。

**防重复逻辑**：

- `collectSurfacedLongTermMemoryFiles()`：正则 `/<memory_file\s+path="([^"]+)"/g` 扫描消息，提取已注入文件名
- `collectRecentToolNames()`：从最近消息中收集 12 个唯一工具名，传给选择器避免冗余

#### 8.3.5 `renderLongTermMemoryFileContext()` — XML 渲染

生成如下结构（XML 转义用 `escapeAttribute()`，超长用 `truncate()` 截断）：

#### 8.3.6 注入的 XML 最终形态

```xml
<long_term_memory>
Relevant long-term memories for this request.
Use them as context, but prefer newer user messages if there is a conflict.
<memory_index>
source=C:\Users\...\MEMORY.md
# Long-term memory

This file is an index. Keep each entry short and put memory details in topic files.
- [用户喜欢樊文华。](memory-331717f4.md) - 用户喜欢樊文华。
</memory_index>
<memory_files>
<memory_file path="memory-331717f4.md" type="user">
用户喜欢樊文华。
</memory_file>
</memory_files>
</long_term_memory>
```

该块被 `createProjectionContextStateMessage()` 包装进 `<opencat_context>` 的 `<context_block source="long_term_memory">` 中，与其他运行时上下文（Plan、Todo、Agent 通知）一起追加到 `state.Messages` 末尾。整个注入链路中任何异常都被静默捕获。

---

### 8.4 调用链：MemorySave（显式保存）

#### 8.4.1 工具定义

`MemorySave` 是 `alwaysLoad: true` 的 always-available 工具。输入：`memory`（必填，一个事实一条）、`memoryType`（可选，默认 `"user"`）、`reason`（可选）。输出：`results[{id, memory, metadata}]`，其中 `metadata.event` = `"ADD"` 或 `"EXISTS"`。

工具 prompt 约束：仅在用户明确要求记忆时调用；不用于普通对话/任务进度/记忆查寻；不保存敏感信息除非用户明确要求。

#### 8.4.2 `saveFileMemory()` — 6 步流程

`src/Memory/file-memory.ts:59`。核心保存逻辑：

1. **门检查**：`enabled` 为 true 且 memory 非空
2. **确保目录存在**：`mkdir(memoryDir, { recursive: true })`
3. **SHA256 去重**：`hashMemory(memory)` → `findMemoryByHash()` 检查是否已存在
4. **已存在**：只更新 `MEMORY.md` 索引链接 → 返回 `{ event: "EXISTS" }`
5. **新创建**：`renderMemoryFile()` 生成 YAML frontmatter 格式的 `.md` 文件 → `writeFile()`
6. **更新索引**：`ensureEntrypointHasLink()` 在 `MEMORY.md` 追加一行链接

文件名 = `slugify(memory)-{hash前8位}.md`。

#### 8.4.3 结果格式化

`formatResult()` 将输出渲染为简短描述：`Saved N long-term memories.` + 逐行 `- id: memory`。

---

### 8.5 调用链：自动提取（autoExtract）

#### 8.5.1 触发位置与条件

入口：`query.ts:220` — 模型本轮无工具调用时调用 `extractLongTermMemoryForCompletedQuery()`。

**四道门**（`long-term-memory.ts:233`）：

| 门 | 条件                                                                      | 失败原因                           |
| -- | ------------------------------------------------------------------------- | ---------------------------------- |
| 1  | `agentRole === "main"` 且 `enabled` 且 `autoExtract`                | `"disabled"`                     |
| 2  | 本轮有新消息（从`turnStartMessageId` 或最近用户消息开始）               | `"no_extractable_messages"`      |
| 3  | 本轮未调用过 MemorySave（互斥保护）                                       | `"memory_saved_by_main_agent"`   |
| 4  | 通过后 fire-and-forget：`void runFileMemoryExtractionAgent()`，不 await | `"file_memory_extract_launched"` |

辅助函数：

- `selectTurnMessagesFromMessages()`：从 `turnStartMessageId` 或最近用户消息开始截取本轮的 source 消息
- `hasMemorySaveSince()`：检查本轮是否已有 MemorySave 调用（遍历 assistant 消息的 tool_calls）

#### 8.5.2 `runFileMemoryExtractionAgent()` — Fork 子 Agent

`src/query/long-term-memory.ts:268`。核心流程：

1. 确保 `logsDir` 目录存在
2. `buildFileMemoryExtractionPrompt()` 构建 prompt
3. 动态 import `runAgentTask`，以 fork 模式启动子 agent（`maxTurns: 5`，`recordTaskLifecycle: false`，`isolation: "none"`）
4. 沙箱通过 `createFileMemoryExtractionCanUseTool(logsDir)` 限制写入

#### 8.5.3 Agent 定义与沙箱

提取 Agent 的类型为 `"long_term_memory"`，category 为 `"worker"`。允许工具：`Read, Grep, Glob, Edit, Write`。禁止工具：`Agent, Bash, MemorySave, SendMessage, Plan, TodoWrite, WebSearch, WebFetch, ReadSkill`。

**沙箱规则**：Read/Grep/Glob 不限路径；Write/Edit 只能操作 `logsDir` 下的文件（`isPathInside()` 做路径规范化比较）。

#### 8.5.4 提取 Agent 的 Prompt

`buildFileMemoryExtractionPrompt()` 产出的 prompt（中文译版）：

> 分析继承对话中最近 ~N 条模型可见的消息，如有持久价值则追加记忆信号。
>
> 记忆目录：`<memoryDir>`
> 日志目录：`<logsDir>`
> 今日追加日志文件：`<logPath>`
>
> 允许工具：Read, Grep, Glob, Edit, Write。
> 只能在日志目录内进行写入。其他路径的写入会被拒绝。
> 不要编辑 MEMORY.md 或 topic 记忆文件——后续的 dream 流程会统一合并。
> 如果日志文件已存在，在末尾追加新条目，不要重写或重组已有条目。
> 如果日志文件不存在，按需创建文件及父目录。
>
> 日志格式：`- HH:MM [type] 简洁的持久记忆信号。如对话提供了 Why/How，一并记入。`
> 使用当前本地时间；不可用时使用近似时间戳。
>
> **应该记录**（对未来对话有参考价值的信息）：
> - `user`：用户角色、目标、偏好、背景知识
> - `feedback`：关于工作方式的修正或已确认的偏好。如对话提供了原因，记录 Why + How
> - `project`：非代码可推导的项目上下文——动机、约束、截止日期、决策。将相对日期转为绝对日期
> - `reference`：外部系统指针、何处获取最新信息
>
> **不应该记录**：
> - 代码模式、约定、架构、文件路径、项目结构
> - Git 历史、最近变更、谁改了什么
> - Debug 方案或修复配方
> - 项目文件中已有的任何文档
> - 临时任务细节：进行中的工作、临时状态、当前对话上下文
> - 当前对话的 Plan 或 task list
>
> 日志条目是原始信号而非正式记忆。保守为上：如果没有持久的信号，不要写任何东西。如果不需要保存，不要调用任何写入工具，直接输出"无需持久记忆"。

#### 8.5.5 日志路径

`getDailyMemoryLogPath(logsDir)` 返回 `resolve(logsDir, YYYY, MM, YYYY-MM-DD.md)`。例如：`~/.opencat/memory/.../logs/2026/01/2026-01-15.md`。

---

### 8.6 调用链：Dream 合并（手动）

#### 8.6.1 完整流程

入口：`runMemoryDream()`（`auto-dream.ts:52`）：

```

runMemoryDream(runtime, state, { recentSessionLimit?: number })
  │
  ├─ 1. !enabled → skip (reason: "disabled")
  │
  ├─ 2. acquireMemoryDreamLock(memoryDir)
  │      → fs.open(lockPath, "wx") — 独占创建
  │      → 写入 PID + startedAt JSON
  │      → 已存在 → skip (reason: "locked")
  │
  ├─ 3. scanFileMemoryHeaders(runtime) → 现有 topic 文件清单
  │
  ├─ 4. listRecentMemoryDreamTranscripts(runtime, limit)
  │      → 从 runtime.cwd/.opencat/transcripts/ 读取 .jsonl 文件
  │      → 按 mtime 降序排序 → 取最近 8 个
  │      → 返回 { filename, path, modifiedAt, sizeBytes }[]
  │
  ├─ 5. runAgentTask():
  │      agentType: "memory_dream"
  │      maxTurns: MEMORY_DREAM_MAX_TURNS (8)
  │      mode: "fork"
  │      isolation: "none"
  │      recordTaskLifecycle: false
  │      agentRole: "session"
  │      prompt: buildMemoryDreamPrompt(...)  ← 四阶段
  │      agentDefinition:
  │        tools: ["Read", "Grep", "Glob", "Edit", "Write"]
  │        disallowed: ["Agent","Bash","MemorySave","SendMessage",
  │                      "Plan","TodoWrite","WebSearch","WebFetch","ReadSkill"]
  │        model: "inherit"
  │        systemPrompt: "You are a forked memory dream agent.
  │                        Your only job is to consolidate file-based long-term memory.
  │                        Do not answer the user and do not modify project files.
  │                        Write only inside the memory directory."
  │      canUseTool: Read/Grep/Glob 不限; Write/Edit 只能写 memoryDir 下
  │
  ├─ 6. 返回 MemoryDreamResult:
  │      { status: "completed", result, agentId, messageCount }
  │      或 { status: "failed", reason }
  │
  └─ 7. finally: lock.release() → rm .dream.lock

```

#### 8.6.2 Dream Prompt

`buildMemoryDreamPrompt()` 产出的 prompt（中文译版）：

> # Dream：记忆合并
>
> 你现在执行一次手动 dream：对 OpenCat 基于文件的长期记忆进行一次反思。将最近记录的
> 记忆信号合成为持久、组织良好的 topic 记忆，让后续会话能快速定位。
>
> 记忆目录：`memoryDir` / 日志目录：`logsDir` / transcript 目录：`transcriptDir`
> 索引文件：`MEMORY.md` / 当前日期：`YYYY-MM-DD`
>
> 可用 Read、Grep、Glob 查看记忆文件。只能对记忆目录内进行 Edit/Write。编辑前先读取已有文件。
>
> ## 已有记忆清单
> `formatFileMemoryManifest 输出` 或 `"(未找到 topic 记忆文件。)"`
>
> ## 最近会话 transcript
> `formatMemoryDreamTranscriptManifest 输出` 或 `"(未找到近期的 transcript 文件。)"`
>
> ## Phase 1 — 定位
> - 查看记忆目录，读取 MEMORY.md（如存在）
> - 浏览已有 topic 文件，确保更新而非创建近似重复
> - 如果 logs/ 存在，查看最近的日志条目（日志是原始信号，非正式记忆）
>
> ## Phase 2 — 收集近期信号
> 寻找值得持久化的新信息。来源优先级：
> 1. `logs/YYYY/MM/YYYY-MM-DD.md`（如存在）
> 2. 已有记忆是否偏离、与较新事实矛盾、或需要清理
> 3. 上述近期 transcript 文件（仅在日志和 topic 文件不足以提供上下文时）
>
> - 寻找后续对话中有参考价值的用户偏好、反馈、项目上下文、外部引用
> - 不要逐行通读 transcript JSONL 文件——用精确关键词搜索，只细读匹配区域
> - 不要从 transcript 中保留临时任务进度，除非揭示了持久偏好或项目规则
>
> ## Phase 3 — 合并
> - 在记忆目录顶层写入或更新 topic 记忆文件
> - frontmatter 格式：
>   ```
>   ---
>   name: {记忆名称}
>   description: {用于后续相关性判断的一行描述}
>   type: user | feedback | project | reference
>   ---
>   {记忆正文}
>   ```
> - 将新信号合并到已有 topic 文件，不创建近似重复
> - 尽可能将相对日期转为绝对日期
> - 如记忆过时、错误或已被替代，修正或移除
> - feedback/project 类记忆应可执行：来源提供了 Why/How 时一并记录
>
> ## 不应该保存的内容
> - 代码结构、文件路径、架构事实、项目约定
> - Git 历史、最近变更、当前任务进度和计划
> - Debug 方案（属于代码、测试或文档）
> - 项目文件中已有记录的内容（除非用户将其设为跨会话偏好）
>
> ## Phase 4 — 清理与索引
> - 仅更新 MEMORY.md 为简洁的索引
> - 每条索引一行：`- [Title](file.md) — 一行摘要`
> - 从不将完整记忆正文放入索引
> - 移除指向过时、错误、已删除或被替代记忆的指针
> - 保持索引简短、对相关性选择有价值
>
> 返回合并、更新、清理的简要概述，或说明为何没有变更。

#### 8.6.3 锁机制

`acquireMemoryDreamLock(memoryDir)` 用 `fs.open(lockPath, "wx")` 独占创建 `.dream.lock` 文件，写入 PID 和 startedAt。已存在则返回 `{ acquired: false }`。`release()` 删除锁文件。防止并发 Dream 运行。

#### 8.6.4 Transcript 目录

Dream 从 `runtime.cwd/.opencat/transcripts/` 读取最近的 `.jsonl` 文件（最多 8 个，按 mtime 降序）。`formatMemoryDreamTranscriptManifest()` 将其渲染为列表供 Agent 参考。

---

### 8.7 数据流全景图

```
                         ┌──────────────────────┐
                         │   用户说 "记住xxx"    │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │  MemorySave.call()   │
                         │  → saveFileMemory()  │
                         │  → SHA256 去重       │
                         │  → 写 .md + 更新索引 │
                         └──────────┬───────────┘
                                    │
                                    ▼
     ┌──────────────────────────────────────────────────────────┐
     │              ~/.opencat/memory/projects/<key>/           │
     │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
     │  │ MEMORY.md   │  │ *.md topic   │  │ logs/YYYY/MM/  │  │
     │  │ (索引)      │  │ files        │  │ YYYY-MM-DD.md  │  │
     │  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘  │
     └─────────┼────────────────┼──────────────────┼───────────┘
               │                │                  │
    ┌──────────▼────────────────▼──────────────────▼───────────┐
    │                    每轮注入 (autoInject)                  │
    │  createLongTermMemoryContextMessage()                    │
    │    → 读 MEMORY.md                                       │
    │    → DeepSeek (JSON mode) 选 ≤5 个相关文件               │
    │    → loadFileMemories() 读取正文                        │
    │    → 渲染 <long_term_memory> XML                        │
    │    → 注入到 <opencat_context>                          │
    └──────────────────────────────────────────────────────────┘
                                    │
    ┌───────────────────────────────▼──────────────────────────┐
    │              每轮结束 (autoExtract, 默认关闭)             │
    │  extractLongTermMemoryForCompletedQuery()                │
    │    → fork agent (Read+Grep+Glob+Edit+Write)              │
    │    → 仅追加到 logs/YYYY/MM/YYYY-MM-DD.md                │
    │    → fire-and-forget, 不阻塞主流程                       │
    └──────────────────────────────────────────────────────────┘
                                    │
    ┌───────────────────────────────▼──────────────────────────┐
    │              Dream 合并 (手动: runMemoryDream)            │
    │  fork agent → 四阶段:                                    │
    │    Phase 1: Orient (读现有文件)                          │
    │    Phase 2: Gather (日志 → 新信号)                       │
    │    Phase 3: Consolidate (合并/新建 topic .md)            │
    │    Phase 4: Prune (更新 MEMORY.md 索引)                  │
    └──────────────────────────────────────────────────────────┘
```

---

### 8.8 与技能通知系统的区别

| 维度     | 技能通知（`<dynamic_skills>`）                          | 长期记忆（`<long_term_memory>`）                 |
| -------- | --------------------------------------------------------- | -------------------------------------------------- |
| 数据来源 | 项目中的`.claude/skills/SKILL.md`                       | `~/.opencat/memory/` 下的 Markdown 文件          |
| 触发方式 | FileRead/Write/Edit 后扫描文件系统发现                    | 每轮用户消息时自动注入（`autoInject`）           |
| 注入选择 | 全量（所有活跃技能都注入）                                | DeepSeek 模型选择 ≤5 个最相关的文件               |
| 内容性质 | 技能指令（操作指南、约束规则）                            | 事实性记忆（偏好、决策、知识点）                   |
| 写入方式 | 手动创建/编辑 SKILL.md                                    | MemorySave 工具 / autoExtract / Dream              |
| 跨会话   | 取决于项目文件是否存在                                    | 持久化（在 home 目录，跨项目独立）                 |
| 注入位置 | `state.runtimeContextMessages` → `<opencat_context>` | `<opencat_context>` 中独立的 `<context_block>` |

---

### 8.9 当前未实现

| 待实现               | 说明                                                                           |
| -------------------- | ------------------------------------------------------------------------------ |
| 记忆更新/删除        | `saveFileMemory` 只能 add 不能 modify/delete；需手动编辑 .md 或等 Dream 清理 |
| Dream 自动调度       | `runMemoryDream()` 必须显式调用，没有 cron、timer 或 turn-count 触发         |
| autoExtract 默认关闭 | 自动提取需要用户显式开启`autoExtract: true`；大多数用户不会主动开            |
| 跨记忆引用           | topic 文件之间没有引用关系；Dream 发现两个文件应该合并时，需要手动判断         |

---

---

← [返回 ARCHITECTURE.md 目录](../ARCHITECTURE.md)
