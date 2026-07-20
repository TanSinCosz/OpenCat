# OpenCat — 编码 AI 智能体架构文档

## 项目概述

OpenCat 是一个基于 **DeepSeek** 大语言模型的编码 AI 智能体（Coding Agent），使用 TypeScript 编写，运行在 Node.js 环境中。它能够接收用户的自然语言编程任务，自主调用工具（读写文件、执行 Shell 命令、搜索代码、启动子智能体等），在工具结果与 LLM 推理之间循环迭代，直到任务完成。

### 核心能力一览

| 能力                       | 说明                                                                      |
| -------------------------- | ------------------------------------------------------------------------- |
| **文件操作**         | 读取、写入、搜索替换编辑文件                                              |
| **代码搜索**         | 正则搜索（Grep）、文件模式匹配（Glob）                                    |
| **Shell 执行**       | 在隔离的工作目录中执行 Bash 命令                                          |
| **==MCP== 协议** | 通过 stdio 或 HTTP 连接外部工具服务器                                     |
| **项目技能**         | 自动发现并加载项目中的`.claude/skills/` 技能文件                        |
| **上下文压缩**       | 当对话过长时自动压缩历史，控制 API 成本                                   |
| **上下文恢复**       | 从 JSONL 对话记录中恢复完整的会话状态                                     |
| **长期记忆**         | 基于文件系统的持久化记忆（Markdown + 索引），跨会话保留用户偏好和项目约定 |
| **多智能体协作**     | 主智能体可将任务委派给专用子智能体（支持 git worktree 隔离）              |
| **Web 调试界面**     | 内置 Web CLI，支持流式消息展示和历史会话管理                              |

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
│   ├── runtime-context.ts     #   运行时上下文注入
│   ├── long-term-memory.ts    #   长期记忆注入与提取
│   ├── assistant-stream.ts    #   流式响应处理
│   ├── reasoning-continuation.ts  # 推理续写
│   ├── types.ts               #   查询层类型定义
│   └── usage.ts               #   Token 用量统计
│
├── deepseek/                  # DeepSeek API 客户端
│   ├── client.ts              #   HTTP/SSE 流式客户端
│   ├── types.ts               #   API 类型定义
│   ├── runtime.ts             #   运行时配置
│   ├── errors.ts              #   错误处理
│   └── example.ts             #   使用示例
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
│   ├── MemorySearch/          #   长期记忆搜索
│   ├── ReadSkill/             #   读取项目技能
│   ├── SendMessage/           #   子 agent 通信
│   ├── TodoWrite/             #   任务列表
│   ├── Plan/                  #   计划模式
│   ├── WebSearch/             #   网页搜索
│   ├── WebFetch/              #   网页抓取
│   └── utils/                 #   工具辅助函数
│
├── mcp/                       # ★ MCP 协议支持
│   ├── types.ts               #   JSON-RPC 2.0 类型定义
│   ├── config.ts              #   MCP 配置与连接管理
│   ├── tool-adapter.ts        #   MCP 工具适配器
│   ├── stdio-client.ts        #   stdio JSON-RPC 客户端
│   ├── http-client.ts         #   HTTP SSE 客户端
│   └── index.ts               #   统一导出
│
├── auto-compress/             # ★ 上下文压缩
│   ├── auto-compress.ts       #   Auto Compress 持久化压缩
│   ├── index.ts               #   统一导出
│   ├── invoked-skill-restore.ts  # 压缩后技能恢复
│   └── read-file-restore.ts   # 压缩后文件读取缓存恢复
│
├── session-memory/            # 滚动会话笔记
│   ├── session-memory.ts      #   笔记读写与更新调度
│   ├── prompts.ts             #   更新提示词
│   ├── persistence.ts         #   JSON 持久化
│   └── index.ts               #   统一导出
│
├── Memory/                    # ★ 长期记忆系统
│   ├── file-memory.ts         #   文件记忆：Markdown 读写、索引维护、去重
│   ├── auto-dream.ts          #   Dream 合并：日志 → topic 文件
│   ├── runtime.ts             #   运行时配置（LongTermMemoryRuntimeConfig）
│   ├── config.ts              #   配置解析
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
┌──────────────────────────────────────────────────────────────────┐
│  query(runtime, state)   ← 主循环，最多 100 轮                  │
│                                                                  │
│  每一轮:                                                         │
│                                                                  │
│  Phase A: drainPendingAgentMessagesForRuntime()                  │
│     → 子 agent 排空父 agent 发来的待处理消息                     │
│                                                                  │
│  Phase B: 先投影，必要时压缩，再重建投影                          │
│                                                                  │
│  1. buildMessagesForQuery(runtime, state)                        │
│     ├─ applyAutoCompressSummary()     ← 应用已有压缩摘要         │
│     ├─ applyExistingToolResultBudget  ← 应用已有工具结果预算     │
│     ├─ applyExistingBulkyCompactions  ← 应用已有大体积压缩       │
│     ├─ applyHistorySnipBoundaries()   ← 应用已有历史截断         │
│     ├─ 转 DeepSeekMessage → 测量 Token                           │
│     ├─ 超 180K → createBulkyToolCompactions ← 创建新的压缩       │
│     └─ 超 80K 且 bulky compact 不够 → createHistorySnipBoundary │
│                                                                  │
│  2. getAutoCompressionRequest()                                  │
│     → 上下文 ≥ 180K tokens → 触发 auto-compress                  │
│                                                                  │
│  3. (若触发) applyAutoCompressionWithTelemetry()                 │
│     → auto-compress 永久压缩 state.Messages                      │
│     → 重新执行 buildMessagesForQuery() 以应用新压缩               │
│                                                                  │
│  Phase C: 投影后追加易失运行时上下文（在压缩之后，不被吞掉）      │
│                                                                  │
│  4. materializeRequestContext()                                  │
│     ├─ loadRuntimeContextForQuery()    ← 子 agent 通知           │
│     ├─ loadDynamicSkillContextForQuery() ← 动态技能通知           │
│     └─ materializeContextForQuery()                              │
│         ├─ removePreviousVolatileContextBlocks() ← 剥离旧块      │
│         ├─ 注入 Plan / Todo / 长期记忆                           │
│         ├─ 合并 runtimeContextMessages                           │
│         └─ 追加为单条 <opencat_context> 消息到 state.Messages    │
│                                                                  │
│  5. buildMessagesForQuery() ← 最终投影（含运行时上下文）          │
│                                                                  │
│  6. createStreamRequest() → DeepSeek API (SSE 流式)               │
│                                                                  │
│  7. 解析响应:                                                    │
│     ├─ 文本增量 → 前端流式渲染                                   │
│     ├─ 推理过程 → 前端折叠展示                                   │
│     └─ 工具调用 → handleToolUse()                                │
│                                                                  │
│  8. handleToolUse():                                             │
│     ├─ 执行工具调用 (tool.call)                                  │
│     ├─ 追加工具结果消息到 state.Messages                         │
│     └─ 如果是文件读取 → discoverSkillsForReadPath()              │
│                                                                  │
│  9. 无工具调用 → 结束本轮:                                       │
│     ├─ clearRuntimeContextAfterModelRequest()                    │
│     ├─ updateSessionMemoryAtSafeBoundary()                       │
│     ├─ 提取长期记忆 (autoExtract)                                │
│     └─ 返回 done 事件                                            │
└──────────────────────────────────────────────────────────────────┘
```

---

## 文档索引

各主题详细文档已拆分到 `docs/` 目录：

| 章节 | 文档 | 内容摘要 |
|------|------|----------|
| 三、工具系统 | [docs/tools.md](docs/tools.md) | 14 个内置工具详解（Read/Write/Edit/Grep/Glob/Bash/Agent/MemorySave/ReadSkill/WebSearch/WebFetch/SendMessage/TodoWrite/Plan）、Tool 接口设计、执行管道控制 |
| 四、MCP 协议 | [docs/mcp.md](docs/mcp.md) | Model Context Protocol 支持：Stdio 长连接子进程、HTTP Streamable 传输、JSON-RPC 2.0 握手、工具适配器、配置与工具合并 |
| 五、Skill 管理 | [docs/skill.md](docs/skill.md) | 项目技能自动发现与加载生命周期（6 阶段）、两种技能类型（Bundled/Dynamic）、注入位置与时机、压缩恢复机制 |
| 六+七、上下文压缩与恢复 | [docs/compression.md](docs/compression.md) | 四级压缩管道（Auto Compress Summary → Tool-result Budget → Bulky Compact → History Snip）、两轮循环 + 两阶段调用、压缩后的状态恢复 |
| 八、长期记忆 | [docs/long-term-memory.md](docs/long-term-memory.md) | 基于文件系统的持久化记忆（Markdown + MEMORY.md 索引）、注入流程、MemorySave 显式保存、autoExtract 自动提取、Dream 合并去重、Perfetto trace 可视化 |
| 九、多智能体协作 | [docs/agent.md](docs/agent.md) | 三种执行模式（sync/async/fork）、三种隔离模式（none/docker/worktree）、五个内置智能体、父-子通信、工具策略 |
| 十、消息投影管道 | [docs/projection.md](docs/projection.md) | buildMessagesForQuery() 四级投影管道详解、触发阈值一览、Phase A/B/C 三阶段执行流程、Runtime Context 投影、投影状态管理 |
| 十一、系统提示词 | [docs/system-prompt.md](docs/system-prompt.md) | 11 段系统提示词逐段详解（中英对照）、System/User Context 额外注入、前缀缓存优化策略 |
| 十六、评测系统 | [docs/eval.md](docs/eval.md) | SWE-bench Verified 自动化评测：两阶段流程（investigate→fix）、仓库准备、遥测指标、两种评测脚本对比 |

**当前全部阈值常量速查**（详细说明见各文档）：

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_AUTO_COMPRESS_TRIGGER_TOKENS` | 180K | auto-compress 触发阈值 |
| `DEFAULT_BULKY_TOOL_RESULT_COMPACT_CONTEXT_TOKENS` | 180K | bulky compact 触发阈值 |
| `DEFAULT_BULKY_TOOL_RESULT_COMPACT_TARGET_CONTEXT_TOKENS` | 80K | bulky compact 压缩目标 |
| `MAX_TOOL_RESULTS_PER_MESSAGE_TOKENS` | 50K | 单组 tool_result 预算上限 |
| `DEFAULT_HISTORY_SNIP_TARGET_TOKENS` | 80K | history snip 目标 token 数 |
| `DEFAULT_HISTORY_SNIP_CANCEL_CONTEXT_TOKENS` | 120K | snip 取消回退阈值 |
| `TARGET_RECENT_TAIL_TOKENS` | 30K | 尾部保留目标 |
| `MAX_RECENT_TAIL_TOKENS` | 40K | 尾部保留上限 |
| `LOCAL_COMPACT_MAX_TRANSCRIPT_CHARS` | 120K | 局部压缩最大字符数 |

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
│  Phase A: drainPendingAgentMessagesForRuntime()                 │
│     → 子 agent 排空父 agent 发来的待处理消息                     │
│                                                                 │
│  Phase B: 纯消息投影 + 压缩                                      │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐│
│  │  buildMessages│   │ auto-compress│   │  buildMessages       ││
│  │  ForQuery()   │──▶│ 检查 (180K)  │──▶│  ForQuery() (重建)   ││
│  │  - 应用摘要   │   │ - 触发压缩   │   │  - 应用新压缩        ││
│  │  - 工具预算   │   │ - 永久修改   │   │                      ││
│  │  - 大体积压缩 │   │   Messages   │   │                      ││
│  │  - 历史截断   │   └──────────────┘   └──────────────────────┘│
│  └──────────────┘                                                │
│                                                                 │
│  Phase C: 运行时上下文投影（在压缩之后）                          │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  materializeRequestContext()                                 ││
│  │  - loadRuntimeContextForQuery()     ← Agent 通知             ││
│  │  - loadDynamicSkillContextForQuery() ← 动态技能               ││
│  │  - materializeContextForQuery()                              ││
│  │    · removePreviousVolatileContextBlocks()                   ││
│  │    · Plan / Todo / 长期记忆 / runtimeContextMessages         ││
│  │    · 合并为 <opencat_context> 消息 → 追加到 state.Messages   ││
│  └──────────────────────────────────────────────────────────────┘│
│                            │                                     │
│  ┌──────────────┐         │                                     │
│  │  buildMessages│◀────────┘                                    │
│  │  ForQuery()   │  ← 最终投影（含运行时上下文）                  │
│  └──────┬───────┘                                               │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────────┐                                       │
│  │   DeepSeek API        │                                      │
│  │   - 流式请求          │                                      │
│  │   - 文本/推理/调用    │                                      │
│  └──────────┬───────────┘                                       │
│             │                                                   │
│  ┌──────────┴──────────┐                                        │
│  │   工具调用？         │                                        │
│  │                     │                                        │
│  ├─ 是 ──▶ handleToolUse() ──▶ 继续循环                        │
│  │           │                                                  │
│  │           ├─ FileRead  → 发现技能                            │
│  │           ├─ Agent     → 子智能体循环                        │
│  │           └─ 其他工具  → 追加结果                            │
│  │                                                              │
│  └─ 否 ──▶ 完成                                                │
│              │                                                  │
│  ┌───────────┴───────────┐                                      │
│  │                       │                                      │
│  ▼                       ▼                                      │
│  ┌──────────────┐       ┌──────────────┐                        │
│  │ SessionMemory│       │  长期记忆提取 │                        │
│  │   更新检查    │       │  自动保存     │                        │
│  └──────────────┘       └──────────────┘                        │
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

`state.Messages` 保存**完整的对话历史**（永不截断），而 `buildMessagesForQuery()` 生成发送给模型的**压缩视图**。这保证了：

- 对话的完整性和可恢复性
- API 调用的成本可控

### 13.2 消息来源追踪

每条 Message 带有 `source` 字段：

```
"user" | "assistant" | "agent_message" | "auto_compress"
| "runtime" | "dynamic_skill" | "long_term_memory" | ...
```

这让系统能够区分不同性质的消息，在投影时做出精确的保留/压缩决策。

### 13.3 基于文件系统的长期记忆

不再依赖数据库或向量存储。长期记忆完全基于 Markdown 文件 + MEMORY.md 索引，通过 `file-memory.ts` 和 `auto-dream.ts` 实现。记忆内容直接以人类可读的 Markdown 格式存储在 `.opencat/memory/` 目录下，无需 SQLite、Embedding 等外部依赖。

### 13.4 Fork 模式的上下文继承

子智能体的 fork 模式继承父智能体的消息历史、压缩状态、会话记忆和技能状态，但不直接修改父 State。子智能体通过 `createChildAgentRuntime` 获得克隆的 Runtime 引用。

### 13.5 递归子智能体限制

一般用途（general-purpose）和 worker 智能体的工具策略中限制了 Agent 工具，防止无限制的嵌套调用。

---

## 十四、技术栈

| 层级                       | 技术                                     |
| -------------------------- | ---------------------------------------- |
| **运行时**           | Node.js + TypeScript                     |
| **LLM 接口**         | DeepSeek API（HTTP + SSE 流式）          |
| **类型校验**         | Zod（运行时类型安全）                    |
| **==MCP== 协议** | JSON-RPC 2.0                             |
| **对话存储**         | JSONL（自定义格式）                      |
| **Web 界面**         | 内嵌 HTML/CSS/JS（无外部前端依赖）       |
| **进程管理**         | child_process（==MCP== stdio、Bash） |
| **文件搜索**         | ripgrep（Grep）、fast-glob（Glob）       |

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
| `src/Memory/file-memory.ts`                     | 长期记忆核心（Markdown 文件 + 索引） |
| `src/Memory/runtime.ts`                        | 长期记忆运行时集成         |
| `src/mcp/tool-adapter.ts`                      | ==MCP== 工具适配器     |
| `src/mcp/stdio-client.ts`                      | ==MCP== stdio 客户端   |
| `src/mcp/http-client.ts`                       | ==MCP== HTTP 客户端    |
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

| #  | 问题                      | 提问时间 | 回答 |
| -- | ------------------------- | -------- | ---- |
| — | _等待你的第一个问题..._ | —       | —   |

### 已解答

| # | 问题                                          | 提问时间   | 回答                                                                                                                                                                                                |
| - | --------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | `parentAgentId` 在 Runtime 中的作用是什么？ | 2026-07-02 | 用于追踪 agent 父子层级关系。父 agent spawn 子 agent 时，在`createChildAgentRuntime()` 中设置。被 transcript 持久化、telemetry 事件、Perfetto trace 可视化等模块消费，提供 agent 调用链溯源能力。 |
