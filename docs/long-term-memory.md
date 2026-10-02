# 长期记忆

## 八、长期记忆（Long-term Memory）

长期记忆基于**文件系统**（Markdown 文件 + 索引），跨会话保留用户偏好、项目约定和重要发现。

旧版数据库/向量检索方案仍保留部分兼容代码，但不参与当前主循环的文件型长期记忆注入；详见
[已废弃的长期记忆方案](long-term-memory-legacy.md)。

涉及文件：

| 文件                              | 行数 | 职责                                                                |
| --------------------------------- | ---- | ------------------------------------------------------------------- |
| `src/Memory/file-memory.ts`     | —   | 核心：daily log 追加、正式 topic 文件读写和 MEMORY.md 索引维护      |
| `src/Memory/auto-dream.ts`      | —   | 手动 Dream：从 daily log 和近期 transcript 整合 topic 文件          |
| `src/Memory/runtime.ts`         | —   | 配置默认值（`LongTermMemoryRuntimeConfig`）                       |
| `src/query/long-term-memory.ts` | —   | Query 循环层：注入构建、后台提取调度、文件选择                      |
| `src/Tools/MemorySave/`         | ~50  | MemorySave 工具：Agent 调用 →`appendFileMemorySignal()` 暂存信号 |

---

### 8.1 数据结构

#### 8.1.1 磁盘布局

```
~/.opencat/memory/projects/<project-key>/   ← getFileMemoryDir()
├── MEMORY.md                               ← 索引文件（entrypoint）
├── logs/                                   ← 自动提取的原始信号
│   └── YYYY/MM/YYYY-MM-DD.md
├── <slug>-<hash8>.md                       ← topic 记忆文件
├── .dream-state.json                       ← 最近一次成功 Dream 的时间游标
└── .dream.lock                             ← Dream 并发锁（任务结束后移除）
```

`project-key` 由 `cwd` 路径通过 `createProjectMemoryKey()` 转换得来：将绝对路径中的盘符、分隔符替换为可读的 key 名。例如 `C:\Users\Administrator\Desktop\opencat-typescirpt` → `C-Users-Administrator-Desktop-opencat-typescirpt-854479bd`（末尾 8 位是路径 hash 的截断）。如果配置了 YAML 的 `memory.directory`，则直接使用该路径，不推导 project key。

#### 8.1.2 基础常量（`file-memory.ts`）

| 常量                         | 值                    | 说明                     |
| ---------------------------- | --------------------- | ------------------------ |
| `FILE_MEMORY_BASE_DIR`     | `".opencat/memory"` | 长期记忆根目录           |
| `FILE_MEMORY_ENTRYPOINT`   | `"MEMORY.md"`       | 索引文件名               |
| `FILE_MEMORY_LOGS_DIR`     | `"logs"`            | 日志子目录               |
| `DEFAULT_MEMORY_TYPE`      | `"user"`            | 默认记忆类型             |
| `MAX_SCANNED_MEMORY_FILES` | `200`               | 单次最多扫描的记忆文件数 |
| `MAX_FILE_MEMORY_LINES`    | `200`               | 单个召回文件最多读取行数 |
| `MAX_FILE_MEMORY_BYTES`    | `4,096`             | 单个召回文件最多注入字节 |

`ENTRYPOINT_HEADER` — MEMORY.md 模板内容：

```

# Long-term memory

This file is an index. Keep each entry short and put memory details in topic files.
```

路径辅助函数：

- `getFileMemoryDir(runtime)` — 绝对路径。若 `runtime.longTermMemoryConfig.fileMemoryDirectory` 已配置 → 使用配置值；否则 → `join(homedir(), FILE_MEMORY_BASE_DIR, "projects", createProjectMemoryKey(runtime.cwd))`
- `getFileMemoryEntrypointPath(runtime)` — `join(memoryDir, "MEMORY.md")`
- `getFileMemoryLogsDir(runtime)` — `join(memoryDir, "logs")`

#### 8.1.3 记忆文件格式

YAML frontmatter + Markdown 正文。`renderMemoryFile()` 拼接：

```markdown
---
name: "简短标题"
description: "一行描述，用于后续相关性选择"
type: user | feedback | project | reference
metadata:
  node_type: memory
  type: user | feedback | project | reference
  originSessionId: <source session id>
---
记忆正文内容。
```

`hash` 和 `reason` 可能出现在 `MemorySave` 的返回元数据中，但不会被写入正式 memory 文件的 frontmatter。`originSessionId` 用于追溯记忆的来源会话。

辅助函数：

- `hashMemory(memory)` → SHA256 hex
- `slugify(memory)` → 取正文的前 80 个字符，保留 CJK/字母/数字，空格和标点换成 `-`，去首尾连字符，转小写
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

**Frontmatter 解析**（`parseFrontmatter()`）：

- 用正则 `/^---\r?\n([\s\S]*?)\r?\n---/` 匹配 frontmatter 块
- 逐行按 `:` 分割 key:value
- value 经 `parseYamlScalar()` 处理：引号包裹的去掉引号，`"true"`/`"false"` 保持字符串不做 boolean 转换，数字保持字符串
- 返回 `Record<string, string>`
- `stripFrontmatter()` 用 `/^---\r?\n[\s\S]*?\r?\n---\r?\n?/` 删除 frontmatter 块，返回正文

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

#### 8.1.5 核心类型（`file-memory.ts`）

| 类型                           | 关键字段                                                       | 说明                                                              |
| ------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `FileMemoryType`             | —                                                             | `"user" \| "feedback" \| "project" \| "reference"`                 |
| `SaveFileMemoryInput`        | `memory`, `reason?`, `type?`, `operation?`             | MemorySave 输入；operation 为 save/correct/forget                 |
| `SaveFileMemoryResult`       | `id`, `memory`, `metadata`                               | `metadata.event`: `"ADD"` 表示新建，`"EXISTS"` 表示去重命中 |
| `FileMemoryHeader`           | `filename`, `path`, `name?`, `description?`, `type?` | 扫描时从 frontmatter 解析的元数据                                 |
| `LoadedFileMemory`           | 继承`FileMemoryHeader` + `content`                         | 加载后的记忆正文（已 strip frontmatter）                          |
| `LoadedFileMemoryEntrypoint` | `path`, `content`                                          | MEMORY.md 的加载结果                                              |

#### 8.1.6 文件扫描与去重

**`scanFileMemoryHeaders()`** — 递归扫描所有 `.md` topic 文件（排除 `MEMORY.md` 和 `logs/` 目录），解析 frontmatter 和 mtime，按修改时间降序返回 `FileMemoryHeader[]`，最多 200 条。

**`findMemoryByHash()`** — 去重核心：遍历 `memoryDir` 下所有 `.md` 文件（排除 `MEMORY.md`），读取内容，检查 `content.includes(\`hash: ${hash}\`)`。命中 → 返回已存在的文件路径，调用方只更新索引链接，不创建新文件。

**`formatFileMemoryManifest(headers)`** — 将 `FileMemoryHeader[]` 渲染为供选择模型使用的文本清单：

```text
- [user] memory-331717f4.md (2026-07-27T10:00:00.000Z): 用户喜欢樊文华。
```

#### 8.1.7 Memory manifest

Memory manifest 是每次长期记忆召回时临时生成的**候选文件元数据清单**。它的用途
是让 selector 在不读取所有正文的情况下，先判断哪些正式 topic memory 与当前
用户请求相关。

每一行只包含：

| 字段            | 来源                                     | 用途                                    |
| --------------- | ---------------------------------------- | --------------------------------------- |
| `type`        | topic 文件 frontmatter 的`type`        | 区分 user、feedback、project、reference |
| `filename`    | 相对 memory 目录的文件名                 | selector 返回的稳定文件标识             |
| `modifiedAt`  | 文件系统 mtime                           | 新文件优先排序，并用于已召回版本去重    |
| `description` | topic 文件 frontmatter 的`description` | 供 selector 判断相关性                  |

Manifest **不包含 topic 正文**，也不包含 daily log 内容。生成过程如下：

1. `scanFileMemoryHeaders()` 扫描正式 topic 文件，排除 `MEMORY.md` 和 `logs/`。
2. 按文件修改时间从新到旧排序，最多保留 200 个候选文件。
3. 排除当前 session 已经展示过且 mtime 没有变化的文件。
4. `formatFileMemoryManifest()` 将剩余 header 渲染成文本清单。
5. 系统将“当前真实用户消息 + manifest + 近期成功工具名”发送给 selector。
6. selector 返回最多 5 个文件名，系统随后才读取这些文件的正文。

Manifest 的生命周期只覆盖本次 selector 请求：它不会写入磁盘，不会放进正式
conversation transcript，也不会完整注入主模型上下文。每次召回都会根据当前
文件系统重新生成。

它与 `MEMORY.md` 的区别：

| 对象            | 形态                                | 维护者           | 使用位置                         |
| --------------- | ----------------------------------- | ---------------- | -------------------------------- |
| Memory manifest | 临时生成的元数据文本                | 查询时由程序生成 | 只提供给 selector                |
| `MEMORY.md`   | 磁盘上的人工可读索引                | 手动 AutoDream   | 整理和审计，不参与普通召回注入   |
| Topic memory    | 带 frontmatter 的正式 Markdown 文件 | 手动 AutoDream   | 被 selector 选中后按需注入主模型 |

**`loadFileMemories(runtime, filenames)`** — 批量加载指定文件名的记忆：

1. 先调 `scanFileMemoryHeaders()` 获取有效文件列表（防止注入非法路径）
2. 对每个 filename，在 headers 中查找 → 读取文件 → `stripFrontmatter()`
3. 每个文件最多保留 200 行 / 4,096 UTF-8 bytes，超限时添加完整的截断提示

#### 8.1.8 关键常量（`long-term-memory.ts` / `auto-dream.ts`）

| 常量                                   | 值     | 说明                               |
| -------------------------------------- | ------ | ---------------------------------- |
| `MEMORY_QUERY_MAX_CHARS`             | 4,000  | 查询字符串最大长度                 |
| `MAX_RELEVANT_MEMORY_FILES`          | 5      | 每次注入最多选中的文件数           |
| `MEMORY_SELECTOR_MAX_TOKENS`         | 256    | 选择模型的输出 token 上限          |
| `FILE_MEMORY_EXTRACTION_MAX_TURNS`   | 5      | 提取子 agent 最大轮数              |
| `RECENT_TOOL_NAMES_FOR_MEMORY_QUERY` | 12     | 随 manifest 发给选择器的近期工具数 |
| `MAX_MEMORY_INJECTION_SESSION_BYTES` | 60 KiB | 单个 session 累计召回正文上限      |
| `STALE_MEMORY_AGE_MS`                | 24 h   | 超过该年龄显示过期核验提示         |
| `MEMORY_DREAM_MAX_TURNS`             | 8      | Dream 子 agent 最大轮数            |
| `MEMORY_DREAM_RECENT_SESSION_LIMIT`  | 8      | 纳入考虑的最近 transcript 数       |

---

### 8.2 配置

`LongTermMemoryRuntimeConfig`（`src/Memory/runtime.ts`）：

| 字段                     | 类型        | 默认值             | 说明                                         |
| ------------------------ | ----------- | ------------------ | -------------------------------------------- |
| `enabled`              | `boolean` | `true`           | 长期记忆总开关                               |
| `autoInject`           | `boolean` | `false`          | runtime 工厂默认关闭；CLI/Web 入口显式开启   |
| `autoExtract`          | `boolean` | `false`          | 每轮结束后 fork agent 提取（需用户显式开启） |
| `autoInjectTopK`       | `number`  | `6`              | 自动注入的记忆条目数                         |
| `searchThreshold`      | `number`  | `0.1`            | 搜索相关性阈值                               |
| `maxInjectedChars`     | `number`  | `40,000`         | 注入内容的最大字符数                         |
| `fileMemoryDirectory?` | `string`  | —                 | 覆盖默认`~/.opencat/memory/` 路径          |
| `userId`               | `string`  | `"default-user"` | 用户标识                                     |
| `agentId`              | `string`  | —                 | Agent 标识                                   |
| `runId`                | `string`  | —                 | 运行标识                                     |

`createLongTermMemoryRuntimeConfig()` 从 options 和 identity 中合并默认值。运行时工厂默认 `autoInject: false`、`autoExtract: false`；当前 `cli.ts` 和 `web-cli.ts` 从统一 YAML 的 `memory.autoInject`、`memory.autoExtract` 读取这两个值。因此是否启用自动注入和自动提取取决于宿主入口的配置，不能只看 runtime 工厂默认值。

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

#### 8.3.2 `createLongTermMemoryContextMessage()` 完整流程

`long-term-memory.ts:35`，执行以下步骤：

1. **检查配置** — 若 `enabled` 或 `autoInject` 为 false，返回 `null`
2. **构建查询** — `buildLongTermMemoryQuery(messages)` 只读取当前真实 user 消息，最长 4,000 字符；投影附件和历史消息不进入查询
3. **获取 headers** — `scanFileMemoryHeaders(runtime)` 获取最多 200 个正式 topic 文件的元数据；普通召回不加载 `MEMORY.md`
4. **应用持久化去重** — 比较 `state.longTermMemory.surfacedFiles[filename].modifiedAtMs`；相同版本不重复注入，文件更新后可以重新召回
5. **收集工具提示** — 仅收集上一轮中成功且没有随后失败的近期工具，避免普通工具文档抢占召回名额
6. **选择文件** — `selectRelevantFileMemories()` 用 DeepSeek 从 manifest 中挑选 ≤5 个相关文件
7. **加载并限额** — 每个 topic 最多 200 行 / 4,096 bytes；同时受单次 `maxInjectedChars` 和 session 累计 60 KiB 约束
8. **渲染 XML** — 只渲染完整的 `<memory_file>` 块；不会从 XML 中间截断。超过 24 小时的文件带核验提示
9. **记录状态和遥测** — 更新 surfaced file/version/bytes，发出 `long_term_memory_injected`
10. 返回瞬态 `{ role: "user", content }`；任何异常返回 `null`，不会阻塞主流程

#### 8.3.3 `buildLongTermMemoryQuery()`

`buildLongTermMemoryQuery()` 从尾部向前找到当前真实用户消息
（`role=user && source=user`），读取其文本并截断到 4,000 字符。系统生成的
runtime context、历史 assistant 内容和 tool result 都不会进入 selector 查询。

#### 8.3.4 `selectRelevantFileMemories()` — 文件选择器

这是整个注入流程的核心：用一个轻量的 DeepSeek 调用从 manifest 中挑选相关文件。

`long-term-memory.ts:91`，执行以下步骤：

1. 从 headers 中排除当前 session 已注入过且 mtime 未变化的文件
2. 若无可用文件 → 返回空数组
3. 调用 `formatFileMemoryManifest()` 将 headers 渲染为文本清单
4. 若提供了近期工具名，追加 `Recently used tools: ...` 提示
5. 调用 DeepSeek（`deepseek-v4-flash`，temperature=0，JSON mode，`thinking: disabled`，max_tokens=256），传入：

   **System prompt：**

   ```
   You are selecting memories that will be useful to OpenCat as it processes a user's query.
   You will be given the user's query and a list of available memory files with their filenames and descriptions.
   Return JSON only: {"selected_memories":["relative/path.md"]}.
   Return up to 5 filenames for memories that will clearly be useful while processing the query.
   Only select filenames from the provided manifest.
   Only include memories that you are certain will be helpful based on their name and description.
   If you are unsure whether a memory will be useful, do not select it. Be selective and discerning.
   If no listed memory is clearly useful, return an empty list.
   If recently used tools are provided, do not select ordinary usage reference or API documentation for those tools because the active conversation already contains their working context.
   Still select memories containing warnings, gotchas, or known issues about those tools.
   ```

   **User prompt：** 包含查询文本、可用文件 manifest、以及工具提示。
6. 解析 JSON 的 `selected_memories`（兼容旧字段 `selected_files`）→ 过滤（只保留 manifest 中确实存在的文件名）→ 截断到最多 `MAX_RELEVANT_MEMORY_FILES`（5）个

**辅助函数：**

- `parseSelectedMemoryFiles(content)` — 优先读取 `selected_memories`，兼容旧的 `selected_files`，取 string[] 部分，解析失败返回空数组
- `extractJsonObject(content)` — 取 `{` 到 `}` 之间的子串
- `collectCurrentSurfacedMemoryFiles(memoryState, headers)` — 用持久化文件版本判断是否已经展示
- `collectSurfacedLongTermMemoryFiles(messages)` — 仅用于没有状态对象时兼容旧 transcript
- `collectRecentSuccessfulToolNames(messages)` — 收集上一轮中成功、且未出现失败结果的工具名

#### 8.3.5 `renderLongTermMemoryFileContext()` — XML 渲染

将选中的正式 topic 组装为 XML：

1. 生成 `<long_term_memory>` 和“记忆可能过期、当前证据优先”的提示
2. 每个文件渲染为完整的 `<memory_file path="..." type="..." source_path="..." modified_at="...">`
3. 超过 24 小时的文件附加 freshness warning，要求先核验当前代码和用户消息
4. 普通召回不注入 `MEMORY.md`，也不会为了满足总预算而截断半个 XML 块

`escapeAttribute()` 对 `&` `"` `<` `>` 做 XML 转义。

#### 8.3.6 注入的 XML 最终形态

```xml
<long_term_memory>
Relevant long-term memories for this request.
Treat memory as background context that may be stale. Verify it against current user messages and current project state.
<memory_files>
<memory_file path="memory-331717f4.md" type="user"
             source_path="C:\Users\...\memory-331717f4.md"
             modified_at="2026-07-27T10:00:00.000Z">
用户喜欢樊文华。
</memory_file>
</memory_files>
</long_term_memory>
```

该块被 `createProjectionContextStateMessage()` 包装进 `<opencat_context>` 的 `<context_block source="long_term_memory">` 中，与其他运行时上下文（Plan、Todo、Agent 通知）一起追加到 `state.Messages` 末尾。整个注入链路中任何异常都被静默捕获。

---

### 8.4 调用链：MemorySave（显式保存）

#### 8.4.1 工具定义

`MemorySave` 是 `alwaysLoad: true` 的 always-available 工具。其 schema：

```typescript
// 输入
z.strictObject({
  memory: z.string().min(1)
    .describe("The exact durable memory the user asked to add. Prefer one fact per call."),
  memoryType: z.enum(["user", "feedback", "project", "reference"]).optional()
    .describe("Optional memory category. Defaults to user."),
  operation: z.enum(["save", "correct", "forget"]).optional()
    .describe("Whether this signal adds, corrects, or invalidates memory."),
  reason: z.string().optional()
    .describe("Short reason this memory should be durable, when useful for auditing."),
});

// 输出
z.object({
  results: z.array(z.object({
    id: z.string(), memory: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
  })),
});
```

工具 prompt 明确约束：

> "Use this only when the user explicitly asks you to remember, save, or add something to memory."
> "Do not call this for ordinary conversation, transient task progress, or memory lookup."
> "Do not save secrets or sensitive information unless the user explicitly asks."

#### 8.4.2 `appendFileMemorySignal()` 完整流程

`MemorySave` 不直接维护正式记忆，而是：

1. **门检查** — 若长期记忆关闭或 `memory` 为空，返回空结果
2. **定位当日日志** — `logs/YYYY/MM/YYYY-MM-DD.md`
3. **生成信号** — 写入 type、operation、originSessionId、signalId、reason 和正文
4. **精确去重** — 相同 signal hash 已存在时返回 `event: "EXISTS"`
5. **append-only 写入** — 只追加 daily log，不创建 topic、不更新 `MEMORY.md`
6. **等待手动 Dream** — `runMemoryDream()` 负责验证、合并、纠错、遗忘和正式索引更新

`saveFileMemory()` 仍作为 AutoDream/测试使用的正式文件辅助函数存在，但不在
`MemorySave` 用户调用链上。

#### 8.4.3 结果格式化

```typescript
// MemorySave.formatResult()
formatResult({ output }: { output: MemorySaveOutput }): string {
  if (output.results.length === 0) return "No long-term memory signal was staged.";
  return `Staged ${output.results.length} long-term memory signal(s) for manual AutoDream consolidation.`;
}
```

---

### 8.5 调用链：自动提取（autoExtract）

#### 8.5.1 触发位置与条件

入口：`query.ts:220` — 模型本轮无工具调用时（即本轮可以结束），调用 `extractLongTermMemoryForCompletedQuery(runtime, state, { turnStartMessageId, turnStartedAt })`。

四道门（`long-term-memory.ts:233`）：

1. **门 1: 只有主 Agent** — `agentRole !== "main"`、`enabled` 为 false、或 `autoExtract` 为 false → 跳过
2. **门 2: 本轮有新消息** — `selectTurnMessagesFromMessages()` 从 `turnStartMessageId` 或最近一条用户消息开始提取，若无新消息 → 跳过
3. **门 3: 本轮未直接写入过正式 memory** — `hasMemoryWriteSince()` 检查从本轮起点以来是否有主 Agent 对 memory 目录执行 `Write/Edit`；若有 → 跳过（互斥保护，避免主 Agent 和后台 Agent 重复写入）
4. **Fire-and-forget** — 不 await，直接调用 `runFileMemoryExtractionAgent()`；异常通过遥测事件上报

**辅助函数：**

- `selectTurnMessagesFromMessages()` — 从 `turnStartMessageId` 或最近用户消息位置开始切片，用 `isLongTermMemorySourceMessage()` 过滤
- `hasMemoryWriteSince()` — 从起始位置检查 assistant 消息中的 `Write/Edit` 是否命中了当前 memory 目录

#### 8.5.2 `runFileMemoryExtractionAgent()` — Fork 子 Agent

`long-term-memory.ts:268`，执行以下步骤：

1. 获取 `memoryDir`，通过 `getFileMemoryDailyLogPath()` 生成
   `logs/YYYY/MM/YYYY-MM-DD.md`，并确保当天日志的父目录存在
2. 调用 `buildFileMemoryExtractionPrompt()` 构建提取 prompt（详见 8.5.4）
3. 动态 import `runAgentTask`，以 fork 模式启动子 agent：
   - `agentDefinition`: `createFileMemoryExtractionAgentDefinition()`（详见 8.5.3）
   - `maxTurns`: 5
   - `mode`: `"fork"`，`isolation`: `"none"`（继承父上下文）
   - `agentRole`: `"session"`，`recordTaskLifecycle`: `false`
   - `forkContextMessages`: 父 state 中全部消息的浅拷贝
   - `canUseTool`: 沙箱限制读写只能针对当天一个 daily-log 文件

#### 8.5.3 Agent 定义与沙箱

**Agent 定义**（`createFileMemoryExtractionAgentDefinition()`）：

| 属性                | 值                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `agentType`       | `"long_term_memory"`                                                                                                    |
| `category`        | `"worker"`，`source`: `"built-in"`                                                                                  |
| `tools`           | `Read`, `Edit`, `Write`                                                                                             |
| `disallowedTools` | `Agent`, `Bash`, `MemorySave`, `SendMessage`, `Plan`, `TodoWrite`, `WebSearch`, `WebFetch`, `ReadSkill` |
| `model`           | `"inherit"`                                                                                                             |
| `permissionMode`  | `"default"`                                                                                                             |
| `maxTurns`        | `FILE_MEMORY_EXTRACTION_MAX_TURNS`（5）                                                                                 |

System prompt 核心指令：只追加日志、不回答用户、不修改项目文件、不编辑 MEMORY.md 或 topic 文件（留给 Dream 整合）。

**沙箱**（`createFileMemoryExtractionCanUseTool(dailyLogPath, originSessionId)`）：

- `Read` → 只允许读取当天的 daily-log 文件
- `Write` → 只允许写当天的 daily-log；文件已存在时，新内容必须完整保留旧内容作为前缀
- `Edit` → 只允许编辑当天的 daily-log；必须用“原末尾 + 新条目”替换文件末尾，禁止 `replace_all`
- 每次新增内容必须携带当前 `originSessionId`
- 其他 → deny

#### 8.5.4 提取 Agent 的 Prompt（完整）

`buildFileMemoryExtractionPrompt()` 产出的 prompt：

~~~~text
分析继承对话中最近约 N 条模型可见消息，如有价值则追加持久记忆信号。

记忆目录：<memoryDir>
当天追加日志文件：<logPath>
当前时间：<currentTimestamp>
来源会话：<originSessionId>

可用工具：Read、Edit、Write。
只能读写当天这一个日志文件，其他读写将被拒绝。
不要编辑 MEMORY.md 或 topic 记忆文件，后续的手动/自动 Dream 流程会整合日志。
如果日志文件已存在，在末尾追加新的条目。不要重写或重新整理已有条目。
如果日志文件不存在，创建它及必要的父目录。

日志格式：
```markdown
- HH:mm | type: <user|feedback|project|reference> | originSessionId: <session-id>
  简洁的持久记忆信号。
  **Why:** 原因（来源明确时）
  **How to apply:** 后续应用方式（可操作时）
```

尽可能使用当前本地时间，否则使用近似时间戳。

只记录对未来对话可能有用的信息：

- user：持久的用户角色、目标、偏好、知识背景。
- feedback：关于工作方式的修正或经过验证的偏好。
  当对话中提供了 Why 和 How 时一并记录。
- project：非显而易见的项目上下文、动机、约束、截止日期，
  或无法从代码/git 中推导的决策。将相对日期转换为绝对日期。
- reference：指向外部系统的指针以及在哪里查找最新信息。

不应保存的内容：

- 代码模式、约定、架构、文件路径或项目结构
- Git 历史、最近的变更记录或谁改了什么
- 调试方案或修复配方
- 项目文件中已有文档记录的任何内容
- 临时任务细节：进行中的工作、临时状态、当前对话上下文
- 当前对话的计划或任务清单

这些日志条目是原始信号，不是正式记忆。保持保守：
如果没有持久性的内容出现，不要写入任何内容。
如果无需保存任何内容，不要调用任何写入工具，
用简短说明表示不需要持久记忆即可结束。

~~~~

#### 8.5.5 日志路径

`getDailyMemoryLogPath(logsDir, date)` — 将日期格式化为 `logsDir/YYYY/MM/YYYY-MM-DD.md` 路径。

例如 `~/.opencat/memory/.../logs/2026/01/2026-01-15.md`

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
   ├─ 4. listRecentMemoryDreamTranscripts(runtime, limit, lastCompletedAt)
   │      → 从 runtime.cwd/.opencat/transcripts/ 读取上次成功 Dream 之后更新的 .jsonl
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
  │      canUseTool: Read/Grep/Glob 不限; Write/Edit 只能写 memoryDir 下，
  │                  且禁止修改 logs/ 下的 append-only 原始日志
  │
   ├─ 6. Dream 成功后写 .dream-state.json.lastCompletedAt
   │
   ├─ 7. 返回 MemoryDreamResult:
  │      { status: "completed", result, agentId, messageCount }
  │      或 { status: "failed", reason }
  │
   └─ 8. finally: lock.release() → rm .dream.lock

```

`.dream.lock` 只用于防止多个 Dream 同时运行；进程不存在或锁超过 1 小时后可回收。
`.dream-state.json.lastCompletedAt` 是成功运行的时间游标，用来过滤候选 transcript。
它不是 daily log 的行号、字节 offset 或 entry ID checkpoint。

#### 8.6.2 日志保留和重复运行

daily log 是追加式原始证据，AutoDream 可以在同一天执行多次。每次 Dream 都可能重新读取已有日志，再通过更新已有 topic 文件、合并近似记忆和清理过期内容来保持结果幂等。

当前策略是：

- 提取 Agent 只向当天的 `logs/YYYY/MM/YYYY-MM-DD.md` 追加内容；
- AutoDream 读取日志，但禁止修改、重写、移动或删除日志；
- Dream 成功后不会删除 daily log；
- `.dream.lock` 在任务结束后删除，只释放并发锁；
- 如果 Dream 中途失败，日志仍然保留，下一次可以重新处理。

因此，多次 Dream 通过成功时间游标减少重复 transcript 扫描；daily log 仍依靠不可变
日志、`originSessionId`、已有 topic memory 和幂等合并处理重复。若未来需要严格的
日志增量处理，可把 `.dream-state.json` 扩展为每个日志文件的
`processedThroughEntryId` 或 byte offset，并只在正式文件全部更新成功后推进。

#### 8.6.3 Dream Prompt（完整）

`buildMemoryDreamPrompt()` 产出的完整 prompt：

~~~~text

# Dream：记忆整合

你正在执行一次手动 Dream：对 OpenCat 文件式长期记忆进行的反思整理。
将最近记录的记忆信号合成为持久、组织良好的 topic 记忆，
使后续会话能够快速定位上下文。

记忆目录：<memoryDir>
每日日志目录：<logsDir>
会话 transcript 目录：<transcriptDir>
入口索引：MEMORY.md
当前日期：<YYYY-MM-DD>

你可以使用 Read、Grep、Glob 来检查记忆文件。
只能对记忆目录内且不属于 logs/ 的正式记忆文件进行 Edit/Write 操作。
daily logs 是不可变的原始证据。
编辑或覆盖已有文件前必须先读取该文件。

## 已有记忆清单

<formatFileMemoryManifest 输出，或 "(没有找到 topic 记忆文件。)" >

## 最近的会话 transcript

<formatMemoryDreamTranscriptManifest 输出，或 "(没有找到最近的会话 transcript 文件。)" >

## 阶段 1 - 定位

- 检查记忆目录，如存在则读取 MEMORY.md。
- 浏览已有 topic 文件，以便进行更新而非创建近似重复项。
- 如果存在 logs/，查看最近的每日日志条目。日志是原始信号，不是正式记忆。

## 阶段 2 - 收集最近的信号

寻找值得持久化的新信息。按优先级排列的来源：

1. logs/YYYY/MM/YYYY-MM-DD.md 下的每日日志（如存在）。
2. 已有记忆中变得陈旧、与较新事实矛盾或需要清理的部分。
3. 上述最近的会话 transcript，仅当日志和 topic 文件提供的信息不足时使用。

- 寻找对未来对话有价值的用户偏好、反馈、项目上下文和外部引用。
- 不要穷举式地阅读 transcript JSONL 文件。使用精准关键词搜索，
  仅检查匹配区域。
- 不要保留 transcript 中的临时任务进度，除非它揭示了持久的用户偏好或项目规则。

## 阶段 3 - 整合

- 在记忆目录顶层写入或更新 topic 记忆文件。
- 使用以下 frontmatter 格式：

  ```markdown
  ---
  name: {{记忆名称}}
  description: {{用于后续相关性选择的一行描述}}
  type: {{user | feedback | project | reference}}
  metadata:
    node_type: memory
    type: {{与顶层 type 相同}}
    originSessionId: {{主要来源日志条目的 session id}}
  ---

  {{记忆正文}}
  ```
- 将新信号合并到已有 topic 文件中，而非创建重复项。
- 新记忆从主要来源的 daily-log 条目继承 `originSessionId`；更新已有记忆时保留原始 `originSessionId`。
- 尽可能将相对日期转换为绝对日期。
- 如果记忆已过时、错误或被替代，修正或删除它。
- 保持 feedback/project 记忆具有可操作性；当来源提供了 Why 和 How 时一并包含。

## 不应保存的内容

- 可从仓库中推导的代码结构、文件路径、架构事实或项目约定。
- Git 历史、最近的变更、临时任务进度、当前计划或待办清单。
- 属于代码、测试、提交或文档范畴的调试配方。
- 项目文件中已有文档记录的任何内容，除非用户将其作为跨会话偏好明确提出。

## 阶段 4 - 清理与索引

- 将 MEMORY.md 更新为简洁的索引。
- 每条索引占一行：- [标题](文件.md) - 一行概要。
- 永远不要将完整记忆正文放入索引。
- 移除指向过时、错误、已删除或被替代记忆的指针。
- 保持索引简短并对后续相关性选择有用。

返回你整合、更新、清理了哪些内容的简要总结，或说明为什么没有变化。

~~~~

#### 8.6.4 锁机制

`acquireMemoryDreamLock(memoryDir)` — 用文件锁防止并发 Dream：

1. 确保 `memoryDir` 存在
2. 用 `fs.open(lockPath, "wx")` 尝试独占创建 `.dream.lock`
3. 写入 PID 和开始时间（ISO 格式 JSON）
4. 若文件已存在（创建失败）→ 返回 `{ acquired: false }`
5. 若创建成功 → 返回 `{ acquired: true, release() }`，其中 `release()` 调用 `rm(lockPath, { force: true })` 删除锁文件

#### 8.6.5 Transcript 目录

- `getMemoryDreamTranscriptDir(runtime)` → 返回 `runtime.cwd/.opencat/transcripts`
- `formatMemoryDreamTranscriptManifest(transcripts, transcriptDir)`:
  - 若 transcript 列表为空 → 返回 `"(No recent session transcript files were found.)"`
  - 否则每条格式化为 `- relative/path (size bytes, modified timestamp)`

---

### 8.7 数据流全景图

```

    用户说“记住 xxx”
             │
             ▼
    ┌──────────────────────────────────────┐
    │ MemorySave                            │
    │ → hash 去重                           │
    │ → 追加 daily log                      │
    └──────────────────┬───────────────────┘
             │
             ▼
    ┌──────────────────────────────────────┐
    │ 文件型长期记忆目录                    │
    │ MEMORY.md / topic files / daily logs  │
    └──────────────────┬───────────────────┘
                       │
                       ▼
    ┌──────────────────────────────────────┐
    │ 每轮注入（autoInject）                │
    │ → 扫描 topic manifest                │
    │ → selector 选择最多 5 个文件          │
    │ → 按文件和 session 预算读取正文       │
    └──────────────────┬───────────────────┘
                       │
                       ▼
    ┌──────────────────────────────────────┐
    │ 每轮结束（autoExtract，可选）         │
    │ → fork Agent                          │
    │ → 只向 daily log 追加信号             │
    └──────────────────┬───────────────────┘
                       │
                       ▼
    ┌──────────────────────────────────────┐
    │ 手动 AutoDream                        │
    │ → 读取日志和已有 topic                │
    │ → 合并、纠错、删除正式记忆            │
    │ → 更新 MEMORY.md 索引                 │
    └──────────────────────────────────────┘

```

---

### 8.8 与技能通知系统的区别

| 维度     | 技能通知（`<dynamic_skills>`）                          | 长期记忆（`<long_term_memory>`）                 |
| -------- | --------------------------------------------------------- | -------------------------------------------------- |
| 数据来源 | 项目中的`.claude/skills/SKILL.md`                       | `~/.opencat/memory/` 下的 Markdown 文件          |
| 触发方式 | FileRead/Write/Edit 后扫描文件系统发现                    | 每轮用户消息时自动注入（`autoInject`）           |
| 注入选择 | 全量（所有活跃技能都注入）                                | DeepSeek 模型选择 ≤5 个最相关的文件               |
| 内容性质 | 技能指令（操作指南、约束规则）                            | 事实性记忆（偏好、决策、知识点）                   |
| 写入方式 | 手动创建/编辑 SKILL.md                                    | MemorySave/autoExtract 追加日志，手动 Dream 写正式记忆 |
| 跨会话   | 取决于项目文件是否存在                                    | 持久化（在 home 目录，跨项目独立）                 |
| 注入位置 | `state.runtimeContextMessages` → `<opencat_context>` | `<opencat_context>` 中独立的 `<context_block>` |

---

### 8.9 当前未实现

| 待实现               | 说明                                                                           |
| -------------------- | ------------------------------------------------------------------------------ |
| 精确日志 checkpoint   | 已有成功 Dream 时间游标，但尚未记录每个 daily log 的行号、offset 或 entry ID |
| Dream 自动调度       | `runMemoryDream()` 必须显式调用，没有 cron、timer 或 turn-count 触发         |
| autoExtract 入口差异 | runtime 工厂默认 `autoExtract: false`，但当前 CLI/Web 入口显式开启 `autoExtract: true` |
| 跨记忆引用           | topic 文件之间没有引用关系；Dream 发现两个文件应该合并时，需要手动判断         |

---

← [返回 ARCHITECTURE.md 目录](../ARCHITECTURE.md)
