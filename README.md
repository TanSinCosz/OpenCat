# OpenCat

![OpenCat project preview](./项目展示.png)

一个基于 **DeepSeek** 的编码 AI 智能体（Coding Agent），TypeScript 编写，Node.js 运行时。它能接收自然语言编程任务，自主调用工具（读写文件、执行 Shell、搜索代码、启动子智能体等），在工具结果与 LLM 推理之间循环迭代，直到任务完成。

---

## 核心能力

| 能力                     | 说明                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **编码智能体循环** | Phase A/B/C 三阶段：排空 agent 消息 → 消息投影 + 上下文压缩 → 运行时上下文注入                                     |
| **15 个内置工具**  | Read, Write, Edit, Bash, Grep, Glob, Agent, MemorySave, ReadSkill, WebSearch, WebFetch, SendMessage, TodoWrite, TaskStop, Plan |
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

所有应用配置统一从 YAML 读取，完整示例见 [config/example.yaml](config/example.yaml)。

```bash
mkdir -p .opencat
cp config/example.yaml .opencat/config.yaml
# 编辑 .opencat/config.yaml，填写 model.apiKey
npm run build
npm start
```

默认先找启动目录的 `.opencat/config.yaml`，再找 `~/.opencat/config.yaml`；
也可以使用 `--config` 指定一份文件。环境变量不再覆盖配置。

```bash
npm run web -- --config .opencat/config.yaml
npm run eval:swe-serial -- --config .opencat/config.yaml
```

MCP 服务器也配置在同一 YAML 的 `mcp.stdio` / `mcp.http` 中，
不再单独读取 `mcp.json`。详细字段与迁移说明见 [统一配置](docs/configuration.md)。

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
│  → createStreamRequest() → 兼容模型 API (SSE)         │
│  → executeToolCallsForTurn() → 工具执行 → 结果追加    │
└──────────────────────────────────────────────────────┘
```

核心设计：**State / Runtime 分离**。`State` 持有可序列化的数据（消息历史、压缩状态），`Runtime` 持有瞬时依赖（模型客户端、工具列表、技能运行时）。序列化/反序列化只需保存 State，恢复时重建 Runtime。

---

## 项目结构

```text
OpenCat/
├── src/
│   ├── main.ts、cli.ts          ← 命令行启动与交互
│   ├── web-cli.ts              ← Web 启动入口
│   ├── interfaces/web/         ← Web 会话、路由、查询与页面资源
│   ├── interfaces/evaluation/  ← SWE 看板路由、启动与页面资源
│   ├── evaluation/             ← 评测产物、指标与历史结果服务
│   ├── query.ts、query/         ← 智能体主循环与上下文组装
│   ├── Tools/                  ← 工具注册与执行、子智能体、技能
│   ├── Memory/                 ← 文件长期记忆与旧检索兼容接口
│   ├── auto-compress/          ← 自动压缩与恢复
│   ├── session-memory/         ← 会话摘要
│   ├── openai-compatible/      ← 模型适配与流式传输
│   ├── mcp/                    ← 外部工具协议适配
│   ├── transcript/             ← 会话持久化与恢复
│   ├── tool-results/           ← 工具结果存档
│   ├── plan/、workspace/       ← 计划持久化与补丁管理
│   ├── config/、types/         ← 配置与核心契约
│   ├── telemetry/              ← 运行观测
│   ├── swe/                    ← SWE 工作区管理
│   ├── eval-dashboard.ts       ← 评测看板启动入口
│   └── system-prompt.ts        ← 系统提示词组装
├── tests/                      ← 本地回归测试
├── scripts/                    ← 评测、记忆整理和真实模型实验
├── docs/                       ← 专题文档
└── ARCHITECTURE.md              ← 功能入口、模块职责与阅读路线
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

回顾项目先读 [项目导航](ARCHITECTURE.md)：按功能查找代码入口、区分当前与兼容实现。
修改智能体循环先读 [Query 模块导航](src/query/README.md)，其中列出了每个阶段的关键函数、状态影响与顺序约束。
修改 Web 功能先读 [Web 模块导航](src/interfaces/web/README.md)，各主题原理文档在 `docs/`。
修改评测功能先读 [评测服务导航](src/evaluation/README.md)；看板页面与 API 见 [看板导航](src/interfaces/evaluation/README.md)。
研究上下文压缩、持久化和历史节点分叉，见 [Codex 源码工程说明](docs/codex-context-engineering.md)，其中包含实际调用链、检查点格式和与 OpenCat 的对照。

本地验证：

```bash
npm run check
npm run test:query
npm run test:web
npm run test:dashboard
npm run build
```

`test:query` 使用独立测试配置与本地模型替身，验证主循环、取消、配置隔离、上下文、压缩、审批、工具并发和持久化。
`test:web` 使用独立测试配置与本地模型替身，验证 Web 路由、事件流、审批、会话恢复和上下文压缩。
`test:dashboard` 使用临时评测产物，验证指标聚合、历史结果回退、会话展示、看板路由和端口重试。

---

## License

MIT
