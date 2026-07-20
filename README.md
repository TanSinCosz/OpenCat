# OpenCat

一个基于 **DeepSeek** 的编码 AI 智能体（Coding Agent），TypeScript 编写，Node.js 运行时。它能接收自然语言编程任务，自主调用工具（读写文件、执行 Shell、搜索代码、启动子智能体等），在工具结果与 LLM 推理之间循环迭代，直到任务完成。

---

## 核心能力

| 能力                     | 说明                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **编码智能体循环** | Phase A/B/C 三阶段：排空 agent 消息 → 消息投影 + 上下文压缩 → 运行时上下文注入                                     |
| **14 个内置工具**  | Read, Write, Edit, Bash, Grep, Glob, Agent, MemorySave, ReadSkill, WebSearch, WebFetch, SendMessage, TodoWrite, Plan |
| **四级上下文压缩** | Auto Compress → Tool-result Budget → Bulky Compact → History Snip，处理超长对话不爆上下文                         |
| **MCP 协议**       | Stdio（管道长连接）+ HTTP Streamable 传输，支持第三方 MCP Server 工具热加载                                          |
| **多智能体协作**   | 三种执行模式（sync/async/fork），三种隔离模式（none/docker/worktree），五个内置子智能体                              |
| **Skill 管理**     | 基于文件的渐进加载技能系统，支持`context: fork` 隔离子智能体执行                                                   |
| **长期记忆**       | 文件系统持久化（Markdown + MEMORY.md 索引），支持显式保存（MemorySave）、自动提取（autoExtract）、Dream 合并         |
| **SWE-bench 评测** | 内置评测管道：bare clone 缓存 + git worktree 多版本并行，自动化评测修 bug 能力                                       |

---

## 快速开始

### 安装

```bash
git clone <repo-url>
cd opencat-typescirpt
npm install
```

### 配置

通过环境变量或 `.opencat/` 下的配置文件设置：

```bash
export DEEPSEEK_API_KEY=sk-your-key-here
```

可选配置：

```bash
export DEEPSEEK_MODEL=deepseek-v4-pro          # 模型选择
export DEEPSEEK_BASE_URL=https://api.deepseek.com
export OPENCAT_MAX_TOKENS=32000                 # 单次最大输出 token
```

### 运行

```bash
# 启动交互式 CLI
npm start
```

### MCP Server 集成

在 `.opencat/mcp.json` 中配置：

```json
{
  "servers": [
    {
      "name": "codegraph",
      "type": "stdio",
      "command": "node",
      "args": ["path/to/codegraph-mcp.js"]
    },
    {
      "name": "remote-tools",
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer your-token" }
    }
  ]
}
```

---

## 架构概览

```
用户输入
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  query() — 主循环，最多 100 轮                        │
│                                                      │
│  Phase A: drainPendingAgentMessages()                │
│    → 子 agent 排空父 agent 发来的待处理消息           │
│                                                      │
│  Phase B: 纯消息投影 → auto-compress → 重建投影       │
│    → 四级压缩管道（180K 触发）                        │
│                                                      │
│  Phase C: 运行时上下文注入（压缩之后，不被吞掉）       │
│    → 长期记忆 / 动态技能 / Plan / Todo / Agent 通知   │
│                                                      │
│  → createStreamRequest() → DeepSeek API (SSE)         │
│  → handleToolUse() → 工具执行 → 结果追加              │
└──────────────────────────────────────────────────────┘
```

核心设计：**State / Runtime 分离**。`State` 持有可序列化的数据（消息历史、压缩状态），`Runtime` 持有瞬时依赖（DeepSeek 客户端、工具列表、技能运行时）。序列化/反序列化只需保存 State，恢复时重建 Runtime。

---

## 项目结构

```
opencat-typescirpt/
├── src/
│   ├── query.ts                  ← 主循环（Phase A/B/C）
│   ├── query/                    ← 消息投影、运行时上下文、长期记忆注入
│   ├── Tools/                    ← 14 个内置工具
│   ├── mcp/                      ← MCP 协议客户端（stdio + HTTP）
│   ├── Skills/                   ← Skill 发现与解析
│   ├── Memory/                   ← 长期记忆（file-memory、auto-dream）
│   ├── auto-compress/            ← 上下文压缩与恢复
│   ├── swe/                      ← SWE-bench 评测工作区管理
│   ├── system-prompt.ts          ← DeepSeek 系统提示词组装（11 段）
│   └── types/                    ← State、Runtime、消息类型定义
├── tests/                        ← 测试文件
├── scripts/                      ← 评测脚本（eval-swe-serial.ts）
├── docs/                         ← 详细文档
│   ├── tools.md                  ← 工具系统详解
│   ├── mcp.md                    ← MCP 协议详解
│   ├── skill.md                  ← Skill 管理详解
│   ├── compression.md            ← 上下文压缩与恢复
│   ├── long-term-memory.md       ← 长期记忆详解
│   ├── agent.md                  ← 多智能体协作
│   ├── projection.md             ← 消息投影管道
│   ├── system-prompt.md          ← 系统提示词详解（中英对照）
│   └── eval.md                   ← 评测系统详解
└── ARCHITECTURE.md               ← 架构总览 + 文档索引
```

---

## 关键技术

- **Runtime**: Node.js (≥18)
- **Language**: TypeScript
- **LLM**: DeepSeek (支持 reasoning + prefix cache)
- **MCP**: Model Context Protocol (Stdio + Streamable HTTP)
- **校验**: Zod（运行时类型校验，LLM 输出自动修正）
- **技能格式**: Agent Skills 规范（SKILL.md + YAML frontmatter）
- **记忆存储**: 文件系统（Markdown + MEMORY.md 索引）
- **评测**: SWE-bench Verified 数据集

---

## 文档

完整架构文档见 [ARCHITECTURE.md](ARCHITECTURE.md)，各主题详细文档在 `docs/` 目录。

---

## License

MIT
