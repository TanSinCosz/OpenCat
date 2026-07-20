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

```typescript
export const FILE_MEMORY_BASE_DIR = ".opencat/memory";
export const FILE_MEMORY_ENTRYPOINT = "MEMORY.md";
export const FILE_MEMORY_LOGS_DIR = "logs";

const DEFAULT_MEMORY_TYPE: FileMemoryType = "user";
const MAX_SCANNED_MEMORY_FILES = 200;

const ENTRYPOINT_HEADER = [
  "# Long-term memory",
  "",
  "This file is an index. Keep each entry short and put memory details in topic files.",
  "",
].join("\n");
```

`getFileMemoryDir(runtime: Runtime): string` — 返回绝对路径：

1. 如果 `runtime.longTermMemoryConfig.fileMemoryDirectory` 已配置 → `resolve(configured)`
2. 否则 → `join(homedir(), FILE_MEMORY_BASE_DIR, "projects", createProjectMemoryKey(runtime.cwd))`

`getFileMemoryEntrypointPath(runtime)` → `join(memoryDir, "MEMORY.md")`

`getFileMemoryLogsDir(runtime)` → `join(memoryDir, "logs")`

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

**Frontmatter 解析**（`parseFrontmatter()`）：

```typescript
// 正则匹配 /^---\r?\n([\s\S]*?)\r?\n---/
// 然后逐行按 `:` 分割 key:value，value 经过 parseYamlScalar() 处理：
//   - 引号包裹的去引号
//   - "true"/"false" → 保持字符串（不做 boolean 转换）
//   - 数字 → 保持字符串
// 返回 Record<string, string>

// stripFrontmatter() 用 /^---\r?\n[\s\S]*?\r?\n---\r?\n?/ 删除 frontmatter
```

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

```typescript
export type FileMemoryType = "user" | "feedback" | "project" | "reference";

export type SaveFileMemoryInput = {
  memory: string;      // 记忆正文
  reason?: string;     // 保存原因
  type?: FileMemoryType; // 默认 "user"
};

export type SaveFileMemoryResult = {
  id: string;          // 文件名去 .md 后缀
  memory: string;
  metadata: {
    event: "ADD" | "EXISTS";  // ADD=新创建, EXISTS=已存在（去重命中）
    path: string;             // .md 文件绝对路径
    entrypointPath: string;   // MEMORY.md 绝对路径
    type: FileMemoryType;
    hash: string;             // SHA256 hex
    reason?: string;
  };
};

export type FileMemoryHeader = {
  filename: string;     // 相对路径，如 "memory-331717f4.md"
  path: string;         // 绝对路径
  name?: string;        // 来自 frontmatter name
  description?: string; // 来自 frontmatter description
  type?: FileMemoryType;
};

export type LoadedFileMemory = FileMemoryHeader & {
  content: string;      // strip frontmatter 后的正文
};

export type LoadedFileMemoryEntrypoint = {
  path: string;
  content: string;
};
```

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

#### 8.1.7 关键常量（`long-term-memory.ts` / `auto-dream.ts`）

```typescript
// long-term-memory.ts
const MEMORY_QUERY_RECENT_MESSAGES = 6;      // 构建查询用的最近消息数
const MEMORY_QUERY_MAX_CHARS = 4_000;        // 查询字符串最大长度
const MAX_RELEVANT_MEMORY_FILES = 5;          // 每次注入最多选中的文件
const MEMORY_SELECTOR_MAX_TOKENS = 512;       // 选择模型的输出 token 上限
const FILE_MEMORY_EXTRACTION_MAX_TURNS = 5;   // 提取子 agent 最大轮数
const RECENT_TOOL_NAMES_FOR_MEMORY_QUERY = 12; // 随 manifest 一起发给选择器的近期工具数

// auto-dream.ts
const MEMORY_DREAM_MAX_TURNS = 8;             // Dream 子 agent 最大轮数
const MEMORY_DREAM_RECENT_SESSION_LIMIT = 8;  // 纳入考虑的最近 transcript 数
```

---

### 8.2 配置

`LongTermMemoryRuntimeConfig`（`src/Memory/runtime.ts`）：

```typescript
export interface LongTermMemoryRuntimeConfig {
  enabled: boolean;                  // 默认 true
  autoInject: boolean;               // 默认 true — 每轮自动注入文件记忆
  autoExtract: boolean;              // 默认 false — 每轮结束后 fork agent 提取
  autoInjectTopK: number;            // 默认 6
  searchThreshold: number;           // 默认 0.1
  maxInjectedChars: number;          // 默认 8_000
  fileMemoryDirectory?: string;      // 覆盖默认路径
  userId: string;                    // 默认 "default-user"
  agentId: string;
  runId: string;
}
```

`createLongTermMemoryRuntimeConfig()` 从 options 和 identity 中合并默认值。`cli.ts` 和 `web-cli.ts` 中传递的配置：

```typescript
longTermMemoryConfig: {
  autoInject: true,   // 注入开启 — 每次用户消息时搜索相关文件记忆
  autoExtract: false, // 提取关闭 — 用户需要显式开启
}
```

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

```typescript
// long-term-memory.ts:35
export async function createLongTermMemoryContextMessage(
  runtime: Runtime,
  messages: readonly Message[],
): Promise<DeepSeekMessage | null> {
  // 1. 检查配置
  if (!config.enabled || !config.autoInject) return null;

  // 2. 构建查询
  const query = buildLongTermMemoryQuery(messages);
  if (!query) return null;

  // 3. 加载 MEMORY.md 入口
  const entrypoint = await loadFileMemoryEntrypoint(runtime);
  if (!entrypoint) return null;  // 没有索引文件 → 跳过

  // 4. 获取所有记忆文件的 headers
  const headers = await scanFileMemoryHeaders(runtime);

  // 5. 收集防重复信息
  const alreadySurfaced = collectSurfacedLongTermMemoryFiles(messages);
  const recentTools = collectRecentToolNames(messages);

  // 6. 用 DeepSeek 选择相关文件
  const selectedFiles = await selectRelevantFileMemories(
    runtime, query, headers, { alreadySurfaced, recentTools }
  );

  // 7. 加载被选中的文件内容
  const selectedMemories = await loadFileMemories(runtime, selectedFiles);

  // 8. 渲染为 XML，不超过 maxInjectedChars
  const content = renderLongTermMemoryFileContext(
    entrypoint, selectedMemories, config.maxInjectedChars
  );

  // 9. 发送遥测事件
  await emitRunEvent(runtime, {
    type: "long_term_memory_injected",
    queryChars: query.length,
    resultCount: selectedMemories.length,
    injectedChars: content.length,
  });

  return { role: "user", content };
  // 异常静默捕获，返回 null — 记忆注入失败不阻塞主流程
}
```

#### 8.3.3 `buildLongTermMemoryQuery()`

```typescript
// long-term-memory.ts:472
function buildLongTermMemoryQuery(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages
    .filter(isLongTermMemorySourceMessage)  // role: user/assistant, source: user/assistant, 有文本
    .slice(-MEMORY_QUERY_RECENT_MESSAGES)   // 最近 6 条
  ) {
    const text = getMessageText(message);
    if (text) parts.push(`${message.role}: ${text}`);
  }
  return truncate(parts.join("\n"), MEMORY_QUERY_MAX_CHARS).trim();
}

function getMessageText(message: Message): string {
  if (message.role === "user") return message.content;            // 用户消息直接取 content
  if (message.role === "assistant")
    return typeof message.content === "string" ? message.content : "";
  return "";  // tool 消息、system 消息等被过滤
}

function isLongTermMemorySourceMessage(message: Message): boolean {
  return (
    (message.role === "user" || message.role === "assistant") &&
    (message.source === "user" || message.source === "assistant") &&
    getMessageText(message).trim().length > 0
  );
}
```

#### 8.3.4 `selectRelevantFileMemories()` — 文件选择器

这是整个注入流程的核心：用一个轻量的 DeepSeek 调用从 manifest 中挑选相关文件。

```typescript
// long-term-memory.ts:91
async function selectRelevantFileMemories(
  runtime: Runtime,
  query: string,
  headers: readonly FileMemoryHeader[],
  options: {
    alreadySurfaced?: ReadonlySet<string>;  // 已经注入过的文件名，排除
    recentTools?: readonly string[];        // 最近使用的工具名
  } = {},
): Promise<string[]> {
  // 过滤掉本轮已经注入过的文件（防重复）
  const availableHeaders = headers.filter(
    (header) => !options.alreadySurfaced?.has(header.filename)
  );
  if (availableHeaders.length === 0) return [];

  const filenames = new Set(availableHeaders.map(h => h.filename));
  const manifest = formatFileMemoryManifest(availableHeaders);
  const toolsSection = options.recentTools?.length
    ? `\n\nRecently used tools: ${options.recentTools.join(", ")}`
    : "";

  // 调用 DeepSeek，用 JSON mode 做结构化选择
  const response = await runtime.deepSeekClient.create({
    model: "deepseek-v4-flash",  // 选择模型用 flash（便宜、快）
    max_tokens: MEMORY_SELECTOR_MAX_TOKENS,  // 512
    temperature: 0,
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You are selecting long-term memory files that will be useful to OpenCat as it processes the user's next request.",
          "You will be given the user's recent query context and a manifest of available memory files with their filenames, types, names, and descriptions.",
          `Return JSON only: {"selected_files":["relative/path.md"]}.`,
          `Return a list of filenames for memories that will clearly be useful to OpenCat as it processes the request, up to ${MAX_RELEVANT_MEMORY_FILES} files.`,
          "Only select filenames from the provided manifest.",
          "Select based on the manifest metadata. Do not invent filenames or rely on memories that are not listed.",
          "Only include memories you are certain will help. If you are unsure whether a memory is useful, do not include it.",
          "Be selective and discerning; keyword overlap alone is not enough.",
          "If recently used tools are provided, do not select ordinary usage reference memories for those tools because active tool output already provides usage context. Still select memories containing warnings, gotchas, or known issues about those tools.",
          "If no listed memory is clearly useful, return an empty list.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Query:\n${query}`,
          "",
          `Available memory files:\n${manifest}${toolsSection}`,
        ].join("\n"),
      },
    ],
  });

  // 解析 JSON → 过滤（只保留 manifest 中确实存在的文件名） → 截断到 MAX_RELEVANT_MEMORY_FILES
  const content = response.choices[0]?.message.content ?? "";
  const parsed = parseSelectedMemoryFiles(content);
  return parsed
    .filter((filename) => filenames.has(filename))
    .slice(0, MAX_RELEVANT_MEMORY_FILES);
}
```

**`parseSelectedMemoryFiles()`** — JSON 解析容错：

```typescript
function parseSelectedMemoryFiles(content: string): string[] {
  try {
    const parsed = JSON.parse(extractJsonObject(content)) as {
      selected_files?: unknown;
    };
    return Array.isArray(parsed.selected_files)
      ? parsed.selected_files.filter((v): v is string => typeof v === "string")
      : [];
  } catch { return []; }
}

function extractJsonObject(content: string): string {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  return start >= 0 && end >= start ? content.slice(start, end + 1) : content;
}
```

**防重复逻辑**：

- `collectSurfacedLongTermMemoryFiles()` — 扫描所有消息的 content 字段，用正则 `/<memory_file\s+path="([^"]+)"/g` 提取已注入过的文件名，返回 `Set<string>`
- `collectRecentToolNames()` — 从最近的消息中遍历 tool 消息和 assistant tool_calls，收集最近 12 个唯一的工具名，传给选择器避免选到冗余的工具参考记忆

#### 8.3.5 `renderLongTermMemoryFileContext()` — XML 渲染

```typescript
// long-term-memory.ts:501
function renderLongTermMemoryFileContext(
  entrypoint: { path: string; content: string },
  memories: readonly LoadedFileMemory[],
  maxChars: number,
): string {
  const lines = [
    "<long_term_memory>",
    "Relevant long-term memories for this request. Use them as context, but prefer newer user messages if there is a conflict.",
    "<memory_index>",
    `source=${entrypoint.path}`,
    entrypoint.content,          // MEMORY.md 全文
    "</memory_index>",
  ];

  if (memories.length > 0) {
    lines.push("<memory_files>");
    for (const memory of memories) {
      lines.push(
        `<memory_file path="${escapeAttribute(memory.filename)}"${
          memory.type ? ` type="${memory.type}"` : ""
        }>`,
        memory.content,
        "</memory_file>",
      );
    }
    lines.push("</memory_files>");
  }

  lines.push("</long_term_memory>");
  return truncate(lines.join("\n"), maxChars);
}
```

`escapeAttribute()` — `&` → `&amp;`, `"` → `&quot;`, `<` → `&lt;`, `>` → `&gt;`

`truncate()` — 如果总长度超过 `maxChars`，截断并追加 `\n[Long-term memory truncated]`

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

`MemorySave` 是 `alwaysLoad: true` 的 always-available 工具。其 schema：

```typescript
// 输入
z.strictObject({
  memory: z.string().min(1)
    .describe("The exact durable memory the user asked to add. Prefer one fact per call."),
  memoryType: z.enum(["user", "feedback", "project", "reference"]).optional()
    .describe("Optional memory category. Defaults to user."),
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

#### 8.4.2 `saveFileMemory()` 完整流程

```typescript
// file-memory.ts:59
export async function saveFileMemory(
  runtime: Runtime,
  input: SaveFileMemoryInput,
): Promise<{ results: SaveFileMemoryResult[] }> {
  // 1. 门检查
  if (!runtime.longTermMemoryConfig.enabled) return { results: [] };
  const memory = input.memory.trim();
  if (!memory) return { results: [] };

  // 2. 确保目录存在
  const memoryDir = getFileMemoryDir(runtime);
  await mkdir(memoryDir, { recursive: true });

  // 3. 去重检查
  const hash = hashMemory(memory);           // SHA256
  const existing = await findMemoryByHash(memoryDir, hash);
  const type = input.type ?? DEFAULT_MEMORY_TYPE;  // 默认 "user"
  const entrypointPath = getFileMemoryEntrypointPath(runtime);

  // 4. 已存在 → 只更新索引
  if (existing) {
    await ensureEntrypointHasLink(entrypointPath, existing, memory);
    return { results: [{
      id: basename(existing, ".md"), memory,
      metadata: { event: "EXISTS", path: existing, entrypointPath, type, hash,
                  ...(input.reason ? { reason: input.reason } : {}) },
    }] };
  }

  // 5. 不存在 → 创建新文件
  const filename = `${slugify(memory)}-${hash.slice(0, 8)}.md`;
  const path = join(memoryDir, filename);
  await writeFile(path, renderMemoryFile({
    name: titleFromMemory(memory),
    description: descriptionFromMemory(memory),
    type, memory, hash, reason: input.reason,
  }), "utf8");

  // 6. 更新 MEMORY.md 索引
  await ensureEntrypointHasLink(entrypointPath, path, memory);

  return { results: [{
    id: basename(path, ".md"), memory,
    metadata: { event: "ADD", path, entrypointPath, type, hash,
                ...(input.reason ? { reason: input.reason } : {}) },
  }] };
}
```

#### 8.4.3 结果格式化

```typescript
// MemorySave.formatResult()
formatResult({ output }: { output: MemorySaveOutput }): string {
  if (output.results.length === 0) return "No long-term memory was saved.";
  return [
    `Saved ${output.results.length} long-term memor${output.results.length === 1 ? "y" : "ies"}.`,
    ...output.results.map(result => `- ${result.id}: ${result.memory}`),
  ].join("\n");
}
```

---

### 8.5 调用链：自动提取（autoExtract）

#### 8.5.1 触发位置与条件

入口：`query.ts:220` — 模型本轮无工具调用时（即本轮可以结束）：

```typescript
// 当 toolCalls.length === 0, 本轮无更多工具调用
const extraction = await extractLongTermMemoryForCompletedQuery(
  runtime, state, { turnStartMessageId, turnStartedAt }
);
```

四道门（`long-term-memory.ts:233`）：

```typescript
export async function extractLongTermMemoryForCompletedQuery(
  runtime: Runtime,
  state: State,
  options: { turnStartMessageId?: MessageId; turnStartedAt?: number } = {},
): Promise<LongTermMemoryExtractionResult> {
  const config = runtime.longTermMemoryConfig;

  // 门 1: 只有主 Agent
  if (runtime.agentRole !== "main" ||
      !config.enabled ||
      !config.autoExtract) {
    return { status: "skipped", reason: "disabled" };
  }

  // 门 2: 本轮有新消息
  const turn = selectTurnMessagesFromMessages(state.Messages, options.turnStartMessageId);
  if (!turn || turn.newMessages.length === 0) {
    return { status: "skipped", reason: "no_extractable_messages" };
  }

  // 门 3: 本轮未显式保存过（互斥保护）
  if (hasMemorySaveSince(state.Messages, options.turnStartMessageId)) {
    return { status: "skipped", reason: "memory_saved_by_main_agent" };
  }

  // Fire-and-forget: 不 await
  void runFileMemoryExtractionAgent(runtime, state, {
    newMessageCount: turn.newMessages.length,
  }).catch((error) => {
    void emitRunEvent(runtime, {
      type: "long_term_memory_extracted",
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
  });

  return { status: "skipped", reason: "file_memory_extract_launched" };
}
```

辅助函数：

```typescript
function selectTurnMessagesFromMessages(
  messages: readonly Message[],
  turnStartMessageId: MessageId | undefined,
): { newMessages: Message[] } | null {
  // 从 turnStartMessageId 指定的位置开始（如果有）
  // 否则从最近一条用户消息开始（findLastUserMessageIndex）
  const startIndex = turnStartMessageId
    ? messages.findIndex(m => m.id === turnStartMessageId)
    : findLastUserMessageIndex(messages);
  if (startIndex < 0) return null;
  return { newMessages: messages.slice(startIndex).filter(isLongTermMemorySourceMessage) };
}

function hasMemorySaveSince(messages, turnStartMessageId): boolean {
  const startIndex = turnStartMessageId
    ? messages.findIndex(m => m.id === turnStartMessageId)
    : 0;
  return messages.slice(Math.max(0, startIndex)).some(m =>
    m.role === "assistant" &&
    (m.tool_calls ?? []).some(tc => tc.function.name === "MemorySave")
  );
}
```

#### 8.5.2 `runFileMemoryExtractionAgent()` — Fork 子 Agent

```typescript
// long-term-memory.ts:268
async function runFileMemoryExtractionAgent(
  runtime: Runtime,
  state: State,
  options: { newMessageCount: number },
): Promise<void> {
  const memoryDir = getFileMemoryDir(runtime);
  const logsDir = getFileMemoryLogsDir(runtime);
  await mkdir(logsDir, { recursive: true });

  const prompt = buildFileMemoryExtractionPrompt({
    memoryDir, logsDir,
    logPath: getDailyMemoryLogPath(logsDir),
    newMessageCount: options.newMessageCount,
  });

  const { runAgentTask } = await import("../Tools/Agent/runner.js");
  await runAgentTask({
    parentRuntime: runtime,
    parentState: state,
    agentDefinition: createFileMemoryExtractionAgentDefinition(),
    prompt,
    description: "Update file-based long-term memory",
    mode: "fork",                     // 继承父上下文
    isolation: "none",
    maxTurns: FILE_MEMORY_EXTRACTION_MAX_TURNS,  // 5
    recordTaskLifecycle: false,       // 不记录自己的 transcript
    agentRole: "session",
    forkContextMessages: state.Messages.map(m => ({ ...m })),
    canUseTool: createFileMemoryExtractionCanUseTool(logsDir),
  });
}
```

#### 8.5.3 Agent 定义与沙箱

```typescript
function createFileMemoryExtractionAgentDefinition(): AgentDefinition {
  return {
    agentType: "long_term_memory",
    category: "worker",
    source: "built-in",
    whenToUse: "Internal agent used to update file-based long-term memory.",
    tools: ["Read", "Grep", "Glob", "Edit", "Write"],
    disallowedTools: [
      "Agent", "Bash", "MemorySave", "SendMessage",
      "Plan", "TodoWrite", "WebSearch", "WebFetch", "ReadSkill",
    ],
    model: "inherit",
    permissionMode: "default",
    maxTurns: FILE_MEMORY_EXTRACTION_MAX_TURNS,
    getSystemPrompt: () => [
      "You are a forked long-term memory extraction agent.",
      "Append durable memory signals to the daily memory log only.",
      "Do not answer the user and do not modify project files.",
      "Save only durable cross-session information that is not derivable from the current project state.",
      "Do not edit MEMORY.md or topic memory files; a separate dream pass consolidates logs later.",
    ].join("\n"),
  };
}
```

**沙箱**（`createFileMemoryExtractionCanUseTool()`）：

```typescript
function createFileMemoryExtractionCanUseTool(logsDir: string): CanUseToolFn {
  const root = normalize(resolve(logsDir));
  return (tool, input) => {
    // Read/Grep/Glob → 允许任意路径
    if (tool.name === "Read" || tool.name === "Grep" || tool.name === "Glob")
      return { behavior: "allow" };
    // Write/Edit → 必须 path 在 logsDir 下
    if ((tool.name === "Write" || tool.name === "Edit") &&
        typeof input === "object" && input !== null &&
        "file_path" in input && typeof input.file_path === "string" &&
        isPathInside(input.file_path, root))
      return { behavior: "allow" };
    return { behavior: "deny", message: `...may only write inside ${logsDir}.` };
  };
}

function isPathInside(filePath: string, root: string): boolean {
  const candidate = normalize(resolve(filePath)).toLowerCase();
  const normalizedRoot = root.toLowerCase();
  return candidate === normalizedRoot ||
    candidate.startsWith(`${normalizedRoot}\\`) ||
    candidate.startsWith(`${normalizedRoot}/`);
}
```

#### 8.5.4 提取 Agent 的 Prompt（完整）

`buildFileMemoryExtractionPrompt()` 产出的 prompt：

```
Analyze the most recent ~N model-visible messages in the inherited conversation
and append durable memory signals if useful.

Memory directory: <memoryDir>
Daily logs directory: <logsDir>
Append-only log file for today: <logPath>

Allowed tools: Read, Grep, Glob, Edit, Write.
You may only Write/Edit files inside the daily logs directory. Other writes will be denied.
Do not edit MEMORY.md or topic memory files. A manual/automatic dream pass will
consolidate logs later.
If the log file already exists, append new bullets to the end.
  Do not rewrite or reorganize existing log entries.
If the log file does not exist, create it and parent directories as needed.

Log format:
```markdown
- HH:MM [type] Concise durable memory signal. Include Why/How to apply when useful.
```

Use current local time when available; otherwise use an approximate timestamp.

Log only information likely to be useful in future conversations:

- user: durable user role, goals, preferences, knowledge background.
- feedback: corrections or validated preferences about how to work.
  Include Why and How to apply when the conversation provides them.
- project: non-obvious project context, motivation, constraints, deadlines,
  or decisions not derivable from code/git. Convert relative dates to absolute dates.
- reference: pointers to external systems and where to look for up-to-date information.

What NOT to save:

- Code patterns, conventions, architecture, file paths, or project structure
- Git history, recent changes, or who changed what
- Debugging solutions or fix recipes
- Anything already documented in project files
- Ephemeral task details: in-progress work, temporary state, current conversation context
- Plans or task lists for the current conversation

These log entries are raw signal, not official memory. Be conservative:
if nothing durable appears, do not write anything.
If nothing should be saved, do not call any writing tools;
finish with a short note saying no durable memory was needed.

```

#### 8.5.5 日志路径

```typescript
function getDailyMemoryLogPath(logsDir: string, date = new Date()): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return resolve(logsDir, year, month, `${year}-${month}-${day}.md`);
}
// 例如: ~/.opencat/memory/.../logs/2026/01/2026-01-15.md
```

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

#### 8.6.2 Dream Prompt（完整）

`buildMemoryDreamPrompt()` 产出的完整 prompt：

```
# Dream: Memory Consolidation

You are performing a manual dream: a reflective pass over OpenCat's
file-based long-term memory. Synthesize recently logged memory signal
into durable, well-organized topic memories so future sessions can
orient quickly.

Memory directory: <memoryDir>
Daily logs directory: <logsDir>
Session transcripts directory: <transcriptDir>
Entrypoint index: MEMORY.md
Current date: <YYYY-MM-DD>

You may use Read, Grep, and Glob to inspect memory files.
You may use Edit/Write only inside the memory directory.
Read an existing file before editing or overwriting it.

## Existing memory manifest
<formatFileMemoryManifest 输出, 或 "(No topic memory files were found.)">

## Recent session transcripts
<formatMemoryDreamTranscriptManifest 输出, 或 "(No recent session transcript files were found.)">

## Phase 1 - Orient
- Inspect the memory directory and read MEMORY.md if it exists.
- Skim existing topic files so you update them instead of creating near-duplicates.
- If logs/ exists, review recent daily log entries. Logs are raw signal, not official memory.

## Phase 2 - Gather recent signal
Look for new information worth persisting. Sources in priority order:
1. Daily logs under logs/YYYY/MM/YYYY-MM-DD.md when present.
2. Existing memories that drifted, contradict newer facts, or need cleanup.
3. Recent session transcripts listed above, only when logs and topic files
   do not provide enough context.
- Look for user preferences, feedback, project context, and external references
  that will matter in future conversations.
- Do not exhaustively read transcript JSONL files. Search with narrow terms
  and inspect only the matching region.
- Do not preserve temporary task progress from transcripts unless it reveals
  a durable user preference or project rule.

## Phase 3 - Consolidate
- Write or update topic memory files at the top level of the memory directory.
- Use this frontmatter format:
  ```markdown
  ---
  name: {{memory name}}
  description: {{one-line description used for future relevance selection}}
  type: {{user | feedback | project | reference}}
  ---

  {{memory body}}
```

- Merge new signal into existing topic files rather than creating duplicates.
- Convert relative dates to absolute dates when possible.
- If a memory is stale, wrong, or superseded, fix or remove it.
- Keep feedback/project memories actionable; include Why and How to apply
  when the source provides them.

## What NOT to save

- Code structure, file paths, architecture facts, or project conventions
  derivable from the repository.
- Git history, recent changes, temporary task progress, current plans,
  or todo lists.
- Debugging recipes that belong in code, tests, commits, or documentation.
- Anything already documented in project files unless the user made it a
  cross-session preference.

## Phase 4 - Prune and index

- Update MEMORY.md as a concise index only.
- Each index entry should be one line: - [Title](file.md) - one-line hook.
- Never put full memory bodies in the index.
- Remove pointers to stale, wrong, deleted, or superseded memories.
- Keep the index short and useful for future relevance selection.

Return a brief summary of what you consolidated, updated, pruned,
or why nothing changed.

```

#### 8.6.3 锁机制

```typescript
async function acquireMemoryDreamLock(memoryDir: string): Promise<
  | { acquired: true; release(): Promise<void> }
  | { acquired: false }
> {
  const lockPath = resolve(memoryDir, MEMORY_DREAM_LOCK_FILE);  // ".dream.lock"
  try {
    await mkdir(memoryDir, { recursive: true });
    const handle = await open(lockPath, "wx");  // 独占创建, 已存在则抛错
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }, null, 2));
    await handle.close();
  } catch {
    return { acquired: false };
  }
  return {
    acquired: true,
    async release() { await rm(lockPath, { force: true }); },
  };
}
```

#### 8.6.4 Transcript 目录

```typescript
function getMemoryDreamTranscriptDir(runtime: Runtime): string {
  return join(runtime.cwd, ".opencat/transcripts");
}

function formatMemoryDreamTranscriptManifest(
  transcripts: readonly MemoryDreamTranscript[],
  transcriptDir: string,
): string {
  if (transcripts.length === 0)
    return "(No recent session transcript files were found.)";
  return transcripts.map(t => {
    const relativePath = relative(transcriptDir, t.path).replace(/\\/g, "/");
    return `- ${relativePath} (${t.sizeBytes} bytes, modified ${t.modifiedAt})`;
  }).join("\n");
}
```

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
