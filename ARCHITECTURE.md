# OpenCat — 编码 AI 智能体架构文档

## 项目概述

OpenCat 是一个基于 **DeepSeek** 大语言模型的编码 AI 智能体（Coding Agent），使用 TypeScript 编写，运行在 Node.js 环境中。它能够接收用户的自然语言编程任务，自主调用工具（读写文件、执行 Shell 命令、搜索代码、启动子智能体等），在工具结果与 LLM 推理之间循环迭代，直到任务完成。

### 核心能力一览

| 能力                   | 说明                                                         |
| ---------------------- | ------------------------------------------------------------ |
| **文件操作**     | 读取、写入、搜索替换编辑文件                                 |
| **代码搜索**     | 正则搜索（Grep）、文件模式匹配（Glob）                       |
| **Shell 执行**   | 在隔离的工作目录中执行 Bash 命令                             |
| **MCP 协议**     | 通过 stdio 或 HTTP 连接外部工具服务器                        |
| **项目技能**     | 自动发现并加载项目中的`.claude/skills/` 技能文件           |
| **上下文压缩**   | 当对话过长时自动压缩历史，控制 API 成本                      |
| **上下文恢复**   | 从 JSONL 对话记录中恢复完整的会话状态                        |
| **长期记忆**     | 基于向量搜索的持久化记忆系统                                 |
| **多智能体协作** | 主智能体可将任务委派给专用子智能体（支持 git worktree 隔离） |
| **Web 调试界面** | 内置 Web CLI，支持流式消息展示和历史会话管理                 |

---

## 一、整体架构

### 1.1 目录结构

```
src/
├── index.ts                   # CLI 入口
├── query.ts                   # ★ 主请求循环（多轮对话引擎）
├── query/                     # 请求编排层
│   ├── messages.ts            #   消息投影与限制策略
│   ├── request.ts             #   DeepSeek API 请求构建
│   ├── events.ts              #   事件标准化
│   ├── runtime-context.ts     #   运行时上下文注入
│   └── long-term-memory.ts    #   长期记忆注入与提取
│
├── deepseek/                  # DeepSeek API 客户端
│   ├── client.ts              #   HTTP/SSE 流式客户端
│   ├── types.ts               #   API 类型定义
│   └── errors.ts              #   错误处理
│
├── Tools/                     # ★ 工具系统
│   ├── FileRead/              #   读取文件
│   ├── FileWrite/             #   写入文件
│   ├── FileEdit/              #   搜索替换编辑
│   ├── Grep/                  #   正则搜索
│   ├── Glob/                  #   文件模式匹配
│   ├── Bash/                  #   Shell 执行
│   ├── Agent/                 #   ★ 子智能体系统
│   ├── MemorySave/            #   长期记忆操作
│   ├── ReadSkill/             #   读取项目技能
│   └── utils/                 #   工具辅助函数
│
├── mcp/                       # ★ MCP 协议支持
│   ├── config.ts              #   MCP 配置与连接管理
│   ├── tool-adapter.ts        #   MCP 工具适配器
│   ├── stdio-client.ts        #   stdio JSON-RPC 客户端
│   └── http-client.ts         #   HTTP SSE 客户端
│
├── auto-compress/             # ★ 上下文压缩
│   └── auto-compress.ts       #   两层压缩策略
│
├── session-memory/            # 滚动会话笔记
│   ├── session-memory.ts      #   笔记读写
│   └── prompts.ts             #   更新提示词
│
├── Memory/                    # ★ 长期记忆系统
│   ├── Memory.ts              #   核心（搜索/添加/删除）
│   ├── runtime.ts             #   运行时集成
│   ├── config.ts              #   配置
│   ├── VectorStore/           #   向量存储（SQLite/Qdrant/pgvector）
│   └── utils/                 #   词形还原、实体提取
│
├── transcript/                # ★ 对话持久化
│   └── persistence.ts         #   JSONL 读写、状态恢复
│
├── types/                     # 核心类型定义
│   ├── runtime.ts             #   Runtime 运行时容器
│   ├── state.ts               #   State 会话状态
│   ├── messages.ts            #   Message 消息类型
│   ├── context.ts             #   压缩上下文类型
│   └── tools.ts               #   Tool 接口定义
│
├── telemetry/                 # 遥测事件
├── utils/                     # 通用工具
├── system-prompt.ts           # 系统提示词组装
└── web-cli.ts                 # Web 调试界面
```

### 1.2 核心设计模式：State 与 Runtime 分离

项目将运行时对象分为两类：

**`Runtime`（瞬时依赖）**— 不可持久化，每次运行重建：

- DeepSeek API 客户端实例
- 工具列表（Tool[]）
- 配置（模型、工作目录、权限模式）
- Observer（事件观察器）
- Usage 统计计数器

**`State`（可持久化数据）**— 可序列化到 JSONL 文件：

- Messages（完整对话历史）
- AutoCompress 状态（压缩摘要）
- SessionMemory 状态（滚动笔记）
- AgentTasks（子智能体任务）
- InvokedSkills（已激活技能）

这种分离使得序列化/反序列化变得极其简单——只需保存 State，恢复时重建 Runtime。

---

## 二、请求流：端到端追踪

```
用户输入 "帮我修复 config.ts 中的类型错误"
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  query(runtime, state)   ← 主循环，最多 100 轮         │
│                                                         │
│  每一轮:                                                │
│                                                         │
│  1. loadRuntimeContextForQuery()                        │
│     → 注入子智能体完成通知、长期记忆搜索结果            │
│                                                         │
│  2. buildMessagesForQuery()                             │
│     ├─ buildSystemPrompt()          ← 组装工具描述      │
│     ├─ projectMessagesWithAutoCompress() ← 压缩投影     │
│     ├─ 注入长期记忆搜索结果                             │
│     └─ applyToolResultBudget()      ← 限制工具结果大小  │
│                                                         │
│  3. createStreamRequest() → DeepSeek API (SSE 流式)      │
│                                                         │
│  4. 解析响应:                                           │
│     ├─ 文本增量 → 前端流式渲染                          │
│     ├─ 推理过程 → 前端折叠展示                          │
│     └─ 工具调用 → handleToolUse()                       │
│                                                         │
│  5. handleToolUse():                                    │
│     ├─ 执行工具调用 (tool.call)                         │
│     ├─ 追加工具结果消息到 state.Messages                │
│     └─ 如果是文件读取 → discoverSkillsForReadPath()     │
│                                                         │
│  6. 无工具调用 → 结束本轮:                              │
│     ├─ 检查是否需要上下文压缩                           │
│     ├─ 提取长期记忆                                     │
│     └─ 返回 done 事件                                   │
└─────────────────────────────────────────────────────────┘
```

---

## 三、工具系统（Tool System）

### 3.1 Tool 接口

每个工具实现统一的 `Tool<Input, Output>` 接口：

```typescript
interface Tool<Input = unknown, Output = unknown> {
  name: string;
  inputSchema: () => ZodSchema;      // 输入参数校验（Zod）
  outputSchema: ZodSchema;           // 输出类型校验
  strict: boolean;                   // 是否要求 DeepSeek 严格函数调用
  maxResultSizeChars?: number;       // 结果字符上限
  shouldDefer: boolean;              // 是否推迟到下一轮执行
  alwaysLoad: boolean;               // 是否始终加载
  isConcurrencySafe(): boolean;      // 是否并发安全
  description(): Promise<string>;    // 工具描述（写入系统提示词）
  prompt(): Promise<string>;         // 使用指南（写入系统提示词）
  call(input, context, runtime, state): Promise<Output>;
}
```

### 3.2 内置工具列表

| 工具                 | 功能                         | 特殊行为                      |
| -------------------- | ---------------------------- | ----------------------------- |
| **FileRead**   | 读取文件内容，支持图片和 PDF | 读取后自动发现项目技能        |
| **FileWrite**  | 创建或覆盖文件               | 更新文件读取缓存              |
| **FileEdit**   | 基于字符串搜索替换的精确编辑 | 支持`replace_all` 批量替换  |
| **Grep**       | 正则表达式搜索代码           | 并行搜索，支持文件类型过滤    |
| **Glob**       | 文件模式匹配                 | 按修改时间排序                |
| **Bash**       | 执行 Shell 命令              | 30s 超时，cwd 隔离，权限检查  |
| **Agent**      | 启动子智能体                 | 详见"多智能体协作"章节        |
| **MemorySave** | 长期记忆操作                 | 保存 / 搜索 / 获取 / 删除记忆 |
| **ReadSkill**  | 读取项目技能                 | 只能读取已发现的技能          |

### 3.3 工具中的并发控制

通过 `hasActiveUsage`（计数器）和 `isConcurrencySafe()` 协同控制：

- 并发不安全的工具在同一轮中只调用一次
- `shouldDefer: true` 的工具推迟到下一轮一起执行

---

## 四、MCP 协议支持（Model Context Protocol）

MCP 允许 OpenCat 连接外部工具服务器，将外部工具动态注入到智能体的工具列表中。涉及文件：

| 文件 | 职责 |
|------|------|
| `src/mcp/types.ts` | JSON-RPC 2.0 类型定义、服务器配置、工具定义 |
| `src/mcp/config.ts` | 配置加载（`.opencat/mcp.json`）、连接创建、工具合并 |
| `src/mcp/stdio-client.ts` | Stdio 传输：子进程 + 行分隔 JSON-RPC |
| `src/mcp/http-client.ts` | HTTP 传输：fetch + 会话管理 + SSE |
| `src/mcp/tool-adapter.ts` | `McpToolAdapter`：将 MCP 工具伪装成 OpenCat Tool |
| `src/mcp/index.ts` | 统一导出 |

### 4.1 整体架构

```
.opencat/mcp.json          ← 用户配置（服务器列表）
        │
        ▼
src/mcp/config.ts          ← 解析配置，发起连接
        │
   ┌────┴────┐
   ▼         ▼
stdio-client.ts   http-client.ts   ← 传输层
   │         │
   └────┬────┘
        ▼
src/mcp/tool-adapter.ts    ← McpToolAdapter 封装
        │
        ▼
src/Tools/index.ts          ← 与 12 个内置工具合并
src/query/request.ts        ← 转为 DeepSeek function calling schema
```

### 4.2 Stdio 传输（长连接子进程）

核心是 `McpStdioClient`，通过子进程 stdin/stdout 通信，**一次 spawn，持续复用**：

```
OpenCat ──spawn("node", ["codegraph.js", "serve", "--mcp"])──▶ MCP Server
   │                                                              │
   │  {"jsonrpc":"2.0","id":1,"method":"tools/list"}\n            │
   │─────────────────────────────────────────────────────────────▶│ stdin
   │                                                              │
   │         {"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}\n  │
   │◀─────────────────────────────────────────────────────────────│ stdout
```

**请求-响应匹配机制**：每个请求带自增 `id`，Promise 存入 `pending Map<id, {resolve, reject, timer}>`。stdout 逐行解析 JSON，按 `id` 匹配对应的 Promise，`resolve(result)` 或 `reject(error)`。30 秒超时兜底。

**生命周期**：
- `connect()` → spawn 子进程，建立 readline 接口，执行初始化握手，**仅此一次**
- 后续所有 `request()` / `notify()` → 往同一 `stdin` 写，从同一 `stdout` 读
- `close()` → 关 readline，`kill()` 子进程，`rejectAllPending()`

**安全模型**：无应用层认证。信任由操作系统提供——pipe 是点对点的父子进程通信，无中间人，无多租户。

### 4.3 HTTP 传输（Streamable HTTP）

`McpStreamableHttpClient`，每次请求独立 HTTP POST：

- **请求匹配**：`await fetch()` 天然同步，无需 pending Map
- **会话管理**：首次 `initialize` 响应返回 `mcp-session-id` 头，保存后后续请求全部携带
- **Bearer 认证**：`config.auth.type === "bearer"` 时自动附加 `Authorization: Bearer <token>`
- **SSE 支持**：响应 `content-type: text/event-stream` 时解析 `data:` 行，从中提取匹配 `id` 的 JSON-RPC 响应
- **关闭**：仅清空 `this.sessionId`，无持久连接

| 维度 | Stdio | HTTP |
|------|-------|------|
| 连接方式 | `spawn()` 子进程 | HTTP POST (`fetch`) |
| 请求匹配 | pending Map + ID | await fetch（天然同步） |
| 超时 | setTimeout 30s | fetch 自带 |
| 会话 | 无状态（进程即会话） | `mcp-session-id` header |
| 认证 | 无（OS 信任边界） | Bearer token |
| 流式响应 | 不支持 | SSE (`text/event-stream`) |
| 连接模式 | 长连接（一个进程） | 每次请求独立 |

### 4.4 初始化握手（两种传输相同）

```
客户端                                MCP 服务器
  │                                      │
  │── request("initialize", {            │  ① 客户端声明协议版本和能力
  │     protocolVersion: "2025-06-18",   │     服务器初始化内部状态
  │     clientInfo: {...}                │
  │   })                                 │
  │◀── { capabilities: {...} } ──────────│     服务端能力声明
  │                                      │
  │── notify("notifications/initialized")│  ② "可以开始干活了"
  │                                      │
  │── request("tools/list") ────────────│  ③ 获取工具列表
  │◀── { tools: [...] } ────────────────│
```

> **注意**：OpenCat 当前丢弃了 `initialize` 返回值中的 `capabilities`。因为目前只使用 `tools` 功能（`tools/list`），不检查能力不会有实际影响。后续若需支持 `resources` 或 `prompts`，需补上能力检查。

### 4.5 MCP 工具适配器（McpToolAdapter）

将 MCP 工具伪装成 OpenCat 的 `Tool` 接口，与内置工具完全平等：

```typescript
class McpToolAdapter implements Tool {
  name: string;              // "codegraph__codegraph_explore"（双下划线分隔）
  inputSchema;               // z.record(z.string(), z.unknown()) ← 宽松验证
  inputJsonSchema;           // MCP 服务器提供的精确 JSON Schema → 给模型看
  maxResultSizeChars = 100_000;

  description() { return `[MCP:${serverName}] ${definition.description}`; }
  async call(input) { return this.client.callTool(definition.name, input); }
}
```

**Schema 双轨制**：
- **模型侧**：使用 MCP 服务器提供的原始 JSON Schema（`inputJsonSchema`），原封不动传给 DeepSeek 的 function calling
- **验证侧**：使用宽松的 `z.record(z.string(), z.unknown())`，因为 MCP 服务器的 schema 格式可能不完全兼容 Zod，实际验证交还给服务器

**工具命名**：`{serverName}__{toolName}`，非法字符替换为 `_`，长度限制 64 字符。

### 4.6 配置与工具合并

配置文件 `.opencat/mcp.json`（可通过 `OPENCAT_MCP_CONFIG` 环境变量重写）：

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["vendor/codegraph/dist/bin/codegraph.js", "serve", "--mcp"],
      "env": { "CODEGRAPH_MCP_TOOLS": "explore,status,files" }
    }
  }
}
```

`createToolsWithConfiguredMcp()` 将 MCP 工具与内置工具合并：

```
内置工具 (12 个) + MCP 工具 (动态数量) → 统一 tools 数组
```

### 4.7 当前未实现的部分

| 待实现 | 说明 | 影响 |
|--------|------|------|
| `notifications/tools/list_changed` | MCP 协议允许服务端通知客户端工具列表变更，但 Stdio 客户端的 `handleLine` 只处理带 `id` 的响应（通知无 `id`，被丢弃），HTTP 客户端无长连接接收推送 | 工具列表只在连接时获取一次，运行时不变 |
| `.opencat/mcp.json` 热加载 | 配置文件只在启动时读取一次 | 运行时修改配置不生效 |
| 子进程崩溃自动重连 | `process.once("exit")` 后将 `this.process` 设为 `undefined`，但不自动重新 spawn | 崩溃后下次请求直接报错 |
| 服务端能力检查 | `initialize` 返回值中的 `capabilities` 被丢弃 | 当前无影响（只用 tools），未来需补 |
| HTTP SSE 实时流式消费 | 当前使用 `response.text()` 一次性读完再解析 | 无法实时展示长时间工具调用的中间进度 |
| Stdio stderr 处理 | 子进程 stderr 被静默忽略 | 调试困难

---

## 五、项目技能系统（Skills）

### 5.1 什么是 Skill

Skill 是项目目录下的 `.claude/skills/{name}/SKILL.md` 文件，包含：

- YAML frontmatter（名称、描述、激活条件）
- Markdown 正文（技能指令）

### 5.2 自动发现机制

```
FileRead 读取文件
  │
  └─→ discoverSkillsForReadPath(filePath)
        │
        ├─ 检查文件路径链上的 .claude/skills/ 目录
        ├─ 解析 SKILL.md 的 YAML frontmatter
        ├─ 条件性技能根据 paths 字段匹配文件后激活
        └─ 将新发现的技能写入 state.invokedSkills
```

### 5.3 技能使用流程

1. **发现阶段**：读取文件时自动发现相关技能
2. **通知阶段**：`loadDynamicSkillContextForQuery()` 将新技能通知模型
3. **读取阶段**：模型调用 `ReadSkill` 工具读取技能完整内容
4. **执行阶段**：模型根据技能指令调整行为

---

## 六、上下文压缩（Auto Compress）

当对话历史超过 DeepSeek 上下文窗口限制时，系统自动触发压缩，采用**两层压缩策略**。

### 6.1 层次一：Session Memory（主智能体）

**触发条件**：投影消息超过 80K tokens

**压缩流程**：

```
1. 启动 fork 模式的子智能体
2. 子智能体只能使用 Edit 工具操作 .opencat/session-memory/{sessionId}.md
3. 子智能体将对话历史总结为结构化笔记
4. 压缩后的投影 = <session_memory>总结</session_memory> + 最近尾部消息
```

### 6.2 层次二：Local Compact（子智能体内部）

**触发条件**：子智能体的自身上下文过大

**压缩流程**：

- 使用 LLM 生成结构化摘要
- 固定模板字段：Objective / Current State / Files / Tool Results / Decisions / Next Steps
- 摘要替换旧消息，保留最近尾部

### 6.3 压缩后的恢复

压缩时系统会自动保存关键状态：

- `restoreReadFileStateAfterAutoCompress()`：恢复文件读取缓存
- `restoreInvokedSkillsAfterAutoCompress()`：恢复已激活技能

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

## 八、长期记忆（Long-term Memory）

长期记忆是一个基于向量搜索的持久化知识库，使智能体能够跨会话记住用户偏好、项目约定和重要发现。

### 8.1 三层架构

```
MemoryTool (Memory.ts)
  ├── OpenAIEmbedder        ← 文本向量化（调用 OpenAI Embedding API）
  ├── OpenAIStructuredLLM   ← 结构化提取（调用 LLM 抽取记忆条目）
  ├── MemoryVectorStore     ← 向量存储后端
  │   ├── SQLite (better-sqlite3, 默认)
  │   ├── Qdrant (远程向量数据库)
  │   └── pgvector (PostgreSQL 扩展)
  └── EntityStore           ← 实体存储（独立 _entities.db）
```

### 8.2 搜索流程（7 步评分流水线）

```
用户查询 → search(query)
  │
  1. 查询预处理         ← 词形还原 + 实体提取
  2. 语义搜索           ← 向量相似度（余弦相似度）
  3. 关键词搜索         ← BM25 全文检索
  4. BM25 分数归一化    ← logistic sigmoid 压缩到 [0,1]
  5. 实体增强           ← entity boost 加成
  6. 候选集构建 + 评分  ← scoreAndRank 综合排序
  7. 结果格式化         ← 返回格式化的记忆片段
```

### 8.3 添加流程（8 阶段提取流水线）

```
新对话完成 → add()
  │
  1. 上下文收集         ← 提取最近 20 条消息
  2. 已有记忆检索       ← 避免重复
  3. LLM 结构化提取     ← 使用 ADDITIVE_EXTRACTION_PROMPT
  4. 批量嵌入           ← OpenAI Embedding API
  5. 哈希去重           ← 内容哈希
  6. 批量持久化         ← 写入向量存储
  7. 实体链接           ← 写入实体存储
  8. 返回保存结果
```

### 8.4 自动注入与提取

- **注入时机**：每轮对话开始前，自动搜索与当前问题相关的长期记忆
- **提取时机**：对话完成后，自动从本轮对话中提取可记忆内容
- **懒加载**：MemoryTool 在首次使用时才初始化，避免不必要的资源消耗

---

## 九、多智能体协作（Multi-Agent with Worktree）

这是项目中最复杂的子系统，允许主智能体将任务委派给专用的子智能体。

### 9.1 三种执行模式

| 模式            | 说明                                     | 典型场景            |
| --------------- | ---------------------------------------- | ------------------- |
| **sync**  | 同步执行，等待子智能体完成后返回结果     | 委派任务并获取结果  |
| **async** | 异步执行，立即返回 agentId，结果写入文件 | 后台任务            |
| **fork**  | 继承父智能体的完整上下文                 | Session Memory 更新 |

### 9.2 三种隔离模式

| 模式               | 说明                            |
| ------------------ | ------------------------------- |
| **none**     | 共享父智能体的工作目录          |
| **worktree** | 在隔离的`git worktree` 中运行 |

### 9.3 工作树隔离（Worktree Isolation）

```
1. git worktree add -b opencat-agent-{slug} {tmpdir} HEAD
2. 子智能体在隔离目录中自由修改文件
3. 完成时:
   ├─ 有修改 → 保留 worktree，通知父智能体
   ├─ 无修改 → git worktree remove --force + git branch -D
   └─ 失败   → 保留现场供检查
```

### 9.4 五个内置智能体

| 名称                      | 类型     | 允许的工具          | 适用场景             |
| ------------------------- | -------- | ------------------- | -------------------- |
| **general-purpose** | 通用     | 所有工具            | 通用任务             |
| **Explore**         | 只读探索 | Read/Grep/Glob/Bash | 分析代码库、搜索文件 |
| **Plan**            | 架构规划 | Read/Grep/Glob/Bash | 设计实现方案         |
| **verification**    | 验证     | Read/Grep/Glob/Bash | 验证实现正确性       |
| **worker**          | 专注实现 | 所有工具            | 聚焦实现指定任务     |

### 9.5 子智能体执行流程

```
Agent.call(taskDescription, { mode: "sync", isolation: "worktree" })
  │
  ├─ resolveAgentTools(definition)
  │   → 根据 AgentDefinition 的 tools/disallowedTools 过滤工具列表
  │
  ├─ createChildAgentState(parentState)
  │   → fork 模式继承父消息、压缩状态、会话记忆、技能
  │
  ├─ createChildAgentRuntime(parentRuntime)
  │   → 继承 DeepSeek 客户端、Usage 计数器、Observer
  │
  ├─ query(childRuntime, childState, { maxTurns: 30 })
  │   → 子智能体自主执行多轮对话
  │
  └─ completeAgentTask()
      → enqueueAgentNotification()
      → 父智能体在下一轮收到通知
```

### 9.6 父-子通信

```
父智能体                 子智能体
    │                        │
    ├── queueAgentMessage() ─→ 消息入队
    │                        ├── drainAgentMessages() ← 读取消息
    │                        ├── 继续执行
    │                        └── completeAgentTask()
    │                              │
    ├← enqueueAgentNotification() ┘
    │
    └── 下一轮迭代时 loadRuntimeContextForQuery() 读取通知
```

### 9.7 工具策略（Tool Policy）

每个智能体定义通过 `allowedTools` 和 `disallowedTools` 控制工具访问：

```typescript
interface AgentDefinition {
  name: string;
  tools: {
    allowedTools?: string[];     // 白名单
    disallowedTools?: string[];  // 黑名单
  };
}
```

- **Explore / Plan / verification** 禁止 Edit/Write/Agent，只允许只读操作
- **worker** 禁止 Agent（防止过度嵌套）
- **general-purpose** 可使用所有工具

---

## 十、消息投影与限制策略

### 10.1 核心概念

- **`state.Messages`**：权威的完整对话历史（从不截断）
- **投影消息**：发送给 DeepSeek API 的消息视图（经过压缩/截断）

### 10.2 限制策略分层

| 策略                   | 控制维度             | 阈值             |
| ---------------------- | -------------------- | ---------------- |
| **工具结果预算** | 每组工具结果的字符数 | 200K 字符/组     |
| **历史截断**     | 总消息字符数         | 260K 字符        |
| **最小保留**     | 最近消息数量         | 12 条 API 消息   |
| **压缩触发**     | 投影的 token 占比    | 上下文窗口的 70% |

### 10.3 工具结果预算

```
对于每组工具调用（同一个 assistant 消息的所有 tool_call）：
  1. 计算组内所有结果的总字符数
  2. 如果超过 200K:
     ├─ 找最大的结果
     ├─ 替换为 2K 字符预览
     └─ 重复直到满足预算
  3. 已替换的结果在后续轮次中始终保持替换状态
```

---

## 十一、系统提示词组装

`buildSystemPrompt()` 按以下结构动态构建，**顺序经过精心设计以优化 DeepSeek 前缀缓存命中率**——稳定内容在前，易变内容（工具列表）在后：

```
═══════════════════════════════════  稳定（缓存永远命中）
  # 角色介绍
  - 交互式编码代理定位
  - 安全使用声明（授权测试、CTF、教育场景）
  - 不猜测 URL
═══════════════════════════════════
  # 系统规则
  - 工具调用外文本展示给用户
  - 提示注入识别
  - AbortController 中断处理
  - 上下文 vs 用户指令区分
═══════════════════════════════════
  # 投影上下文标签
  - <long_term_memory>、<opencat_context>
  - <tool-result-budget>、<tool-result-compact>
  - [History snipped]、<session_memory>、<local_compact_summary>
═══════════════════════════════════
  # 软件工程工作规范
  - 先读后改、保留用户更改
  - 边界清晰、避免猜测性抽象
  - 最小化验证
═══════════════════════════════════
  # 沟通风格
  - 简洁温暖直接、不做讲座
  - 不主动使用 emoji
═══════════════════════════════════
  # 输出效率
  - 聚焦改动/验证/风险
  - 不倾倒文件内容
═══════════════════════════════════
  # 环境信息
  - CWD、Platform、Shell、Model
═══════════════════════════════════
  # 语言（可选）
  - "始终用中文回复"
═══════════════════════════════════
  # 输出风格（可选，子代理时出现）
═══════════════════════════════════  易变（工具变化时从此处失效）
  # 工具使用说明（getToolUseSection）
  - "Available tools: Agent, Bash, FileRead, ..."
  - 工具使用通用规则
═══════════════════════════════════
  # 工具详细指令（getToolPromptSection）
  - 每个工具的 description() + prompt()
  - 包含 MCP 工具（codegraph__codegraph_explore 等）
═══════════════════════════════════
```

### 设计要点

- **前缀缓存优化**：所有稳定章节（角色、规则、上下文、工程规范、沟通、效率、环境）放在工具章节之前。当 MCP 工具热加载导致工具列表变化时，只有末尾的工具章节缓存失效，前面的大段稳定内容继续命中缓存。
- **`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 已移除**：该标记原本是模板内容和运行时信息的纯文本分隔符，没有代码逻辑依赖，已从代码和提示词中完全删除。
- **各段以 `\n\n` 拼接**，作为单条 `role: "system"` 消息发送。

---

## 十二、数据流全景图

```
                           ┌─────────────┐
                           │   用户输入    │
                           └──────┬──────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                         query() 主循环                           │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐│
│  │ 运行时上下文  │   │  消息投影     │   │   DeepSeek API       ││
│  │ - Agent 通知  │──▶│ - 压缩处理   │──▶│   - 流式请求          ││
│  │ - 长期记忆    │   │ - 工具预算   │   │   - 文本/推理/调用    ││
│  │ - 动态技能    │   │ - 历史截断   │   │                      ││
│  └──────────────┘   └──────────────┘   └──────────┬───────────┘│
│                                                    │            │
│                          ┌─────────────────────────┘            │
│                          ▼                                      │
│              ┌─────────────────────┐                            │
│              │   工具调用？         │                            │
│              │                     │                            │
│              ├─ 是 ──▶ handleToolUse() ──▶ 继续循环            │
│              │           │                                      │
│              │           ├─ FileRead  → 发现技能                │
│              │           ├─ Agent     → 子智能体循环            │
│              │           └─ 其他工具  → 追加结果                │
│              │                                                  │
│              └─ 否 ──▶ 完成                                     │
│                          │                                      │
│              ┌───────────┴───────────┐                          │
│              │                       │                          │
│              ▼                       ▼                          │
│     ┌──────────────┐       ┌──────────────┐                    │
│     │  上下文压缩   │       │  长期记忆提取 │                    │
│     │  检查+执行    │       │  自动保存     │                    │
│     └──────────────┘       └──────────────┘                    │
│                                                                 │
│                          ▼                                      │
│                     ┌────────┐                                  │
│                     │  done   │                                  │
│                     └────────┘                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 十三、关键设计决策

### 13.1 双投影模式

`state.Messages` 保存**完整的对话历史**（永不截断），而 `projectMessagesWithAutoCompress()` 生成发送给模型的**压缩视图**。这保证了：

- 对话的完整性和可恢复性
- API 调用的成本可控

### 13.2 消息来源追踪

每条 Message 带有 `source` 字段：

```
"user" | "assistant" | "agent_message" | "auto_compress"
| "runtime" | "dynamic_skill" | "long_term_memory" | ...
```

这让系统能够区分不同性质的消息，在投影时做出精确的保留/压缩决策。

### 13.3 懒加载长期记忆

MemoryTool 在首次使用时才初始化，避免不必要的资源消耗（不创建 SQLite 文件、不初始化 Embedding 客户端）。

### 13.4 Fork 模式的上下文继承

子智能体的 fork 模式继承父智能体的消息历史、压缩状态、会话记忆和技能状态，但不直接修改父 State。子智能体通过 `createChildAgentRuntime` 获得克隆的 Runtime 引用。

### 13.5 递归子智能体限制

一般用途（general-purpose）和 worker 智能体的工具策略中限制了 Agent 工具，防止无限制的嵌套调用。

---

## 十四、技术栈

| 层级               | 技术                               |
| ------------------ | ---------------------------------- |
| **运行时**   | Node.js + TypeScript               |
| **LLM 接口** | DeepSeek API（HTTP + SSE 流式）    |
| **类型校验** | Zod（运行时类型安全）              |
| **向量存储** | better-sqlite3 / Qdrant / pgvector |
| **嵌入模型** | OpenAI Embedding API               |
| **MCP 协议** | JSON-RPC 2.0                       |
| **对话存储** | JSONL（自定义格式）                |
| **Web 界面** | 内嵌 HTML/CSS/JS（无外部前端依赖） |
| **进程管理** | child_process（MCP stdio、Bash）   |
| **文件搜索** | ripgrep（Grep）、fast-glob（Glob） |

---

## 十五、文件索快速查

| 文件路径                                         | 功能                       |
| ------------------------------------------------ | -------------------------- |
| `src/query.ts`                                 | 主请求循环（多轮对话引擎） |
| `src/query/messages.ts`                        | 消息投影与限制策略         |
| `src/query/request.ts`                         | DeepSeek API 请求构建      |
| `src/query/runtime-context.ts`                 | 运行时上下文投影           |
| `src/query/long-term-memory.ts`                | 长期记忆注入与提取         |
| `src/Tools/Agent/Agent.ts`                     | Agent 工具入口             |
| `src/Tools/Agent/runner.ts`                    | 子智能体执行引擎           |
| `src/Tools/Agent/built-in.ts`                  | 五个内置智能体定义         |
| `src/Tools/Agent/tool-policy.ts`               | 子智能体工具白名单/黑名单  |
| `src/auto-compress/auto-compress.ts`           | 上下文压缩（两层策略）     |
| `src/session-memory/session-memory.ts`         | 滚动会话笔记管理           |
| `src/Memory/Memory.ts`                         | 长期记忆核心               |
| `src/Memory/runtime.ts`                        | 长期记忆运行时集成         |
| `src/mcp/tool-adapter.ts`                      | MCP 工具适配器             |
| `src/mcp/stdio-client.ts`                      | MCP stdio 客户端           |
| `src/mcp/http-client.ts`                       | MCP HTTP 客户端            |
| `src/transcript/persistence.ts`                | 对话持久化与恢复           |
| `src/system-prompt.ts`                         | 系统提示词组装             |
| `src/types/runtime.ts`                         | Runtime 类型定义           |
| `src/types/state.ts`                           | State 类型定义             |
| `src/types/messages.ts`                        | Message 类型定义           |
| `src/Tools/utils/discoverSkillsForReadPath.ts` | 项目技能自动发现           |
| `src/deepseek/client.ts`                       | DeepSeek API 客户端        |
| `src/web-cli.ts`                               | Web 调试界面               |

---

## 十六、问题与答疑

> 此章节用于记录对架构文档的疑问与解答。欢迎提出任何关于设计决策、实现细节、或未来演进的问题。

### 待解答

| # | 问题 | 提问时间 | 回答 |
|---|------|----------|------|
| — | _等待你的第一个问题..._ | — | — |

### 已解答

| # | 问题 | 提问时间 | 回答 |
|---|------|----------|------|
| 1 | `parentAgentId` 在 Runtime 中的作用是什么？ | 2026-07-02 | 用于追踪 agent 父子层级关系。父 agent spawn 子 agent 时，在 `createChildAgentRuntime()` 中设置。被 transcript 持久化、telemetry 事件、Perfetto trace 可视化等模块消费，提供 agent 调用链溯源能力。 |
