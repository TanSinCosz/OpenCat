# Skill 管理

## 五、Skill 管理（Skill Management）

### 5.0 Skill 是什么

**Skill 不是一个协议，而是一个社区约定。** 它由 Anthropic 的 Agent Skills 规范定义，是一种用文件告诉 AI "怎么做事"的标准化方式。

> 通俗比喻：如果工具（Tool）是"锤子/改锥/扳手"，那 Skill 就是**"操作说明书"**——它不干活，它告诉 AI：干这个活应该用哪个工具、按什么顺序、注意什么坑。

**Skill 的核心机制**：每个 Skill 是一个目录，里面放一个 `SKILL.md` 文件。该文件通过 **YAML frontmatter + Markdown 正文** 描述一个领域的知识和操作流程。AI 看到 Skill 后，能按 Skill 指导的专业方式来完成特定任务——相当于给通用 AI 装了一个"专业领域上岗培训包"。

**Skill 和 Tool 的根本区别**：

|          | Tool                                             | Skill                                                      |
| -------- | ------------------------------------------------ | ---------------------------------------------------------- |
| 做什么   | **执行具体操作**（读文件、改代码、跑命令） | **指导行为方式**（用什么工具、按什么流程、注意什么） |
| 谁定义的 | 代码（MCP Server 或内置工具类）                  | 文件（`SKILL.md`，开发者手写）                           |
| 何时触发 | 模型通过 function calling 选择调用               | 模型通过匹配 Skill 的 description 文字来判断是否适用       |
| 生命周期 | 每次调用即执行即结束                             | 被发现后持续存在于上下文，贯穿整个会话                     |

**渐进加载（Progressive Disclosure）**：Skill 最精巧的设计——不是一次性把所有内容塞给模型，而是分三层逐步展开：

| 级别                  | 内容                                       | 何时加载                              | 参考大小 |
| --------------------- | ------------------------------------------ | ------------------------------------- | -------- |
| **1. 元数据**   | `name` + `description`                 | 始终在上下文中浮动                    | ~100 词  |
| **2. 正文**     | `SKILL.md` 全部 Markdown 内容            | 模型觉得匹配后，用 ReadSkill 工具读取 | <5000 词 |
| **3. 打包资源** | `scripts/`、`references/`、`assets/` | 模型按需执行或进一步读取              | 无限制   |

模型先看到第 1 层——一堆 Skill 的 name 和 description 浮在上下文中。当用户说"帮我设计一个登录页面"，模型匹配到 `frontend-design` 的 description，调用 ReadSkill 读它的 `SKILL.md`（第 2 层），看到里面说"用 `scripts/generate-component.py`"，然后执行脚本（第 3 层）。每一步只加载需要的，不浪费上下文。

**三种 Skills 类型**（社区分类）：

| 类型                         | 特征                                                                      | 适用场景                                         |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| **Script Skill**       | 含入口脚本（`scripts/main.py`），Agent 传 JSON 参数，脚本执行并返回结果 | 确定性、可重复的任务（代码生成、文件转换）       |
| **CLI Wrapper Skill**  | 只有 SKILL.md，告诉 Agent 怎么用某个 CLI 工具                             | 包装已有的命令行工具（ffmpeg、imagemagick）      |
| **Multi-Script Skill** | 多个脚本各自是独立工具，命名`skill_name__script_name`                   | 相关操作集合（一个 Skill 管整个 API 的增删改查） |

**三种类型的简化实例**：

**实例 1：Script Skill — `pdf-editor`**

目录结构：

```
pdf-editor/
├── SKILL.md
└── scripts/
    └── merge.py       ← 唯一的入口脚本
```

SKILL.md：

```markdown
---
name: pdf-editor
description: |
  Merge, split, or extract pages from PDF files. Use when the user
  asks to combine multiple PDFs, split a PDF into separate pages,
  or extract specific page ranges.
---

# PDF Editor

## Quick Start
pip install pypdf  (one-time)

## Operations
- Merge: tell the agent "merge a.pdf and b.pdf" — it runs `python scripts/merge.py`
- Split: the agent invokes the same script with `--mode split`
- Extract: `--mode extract --pages 1-5`
```

Agent 使用时的过程：

1. 用户说"帮我把这 3 个 PDF 合并"
2. Agent 匹配到 `pdf-editor` 的 description，ReadSkill 加载
3. 看到"跑 `python scripts/merge.py`"，Agent 执行 Bash：`python scripts/merge.py a.pdf b.pdf c.pdf -o output.pdf`
4. 脚本跑完，Agent 告诉用户"合并完成"

**精髓**：Skill 不写具体的 Python 代码，只告诉 Agent"入口是这个脚本、参数怎么传"。Agent 负责翻译用户的自然语言到命令行参数，脚本负责干活。

**实例 2：CLI Wrapper Skill — `ffmpeg-converter`**

目录结构：

```
ffmpeg-converter/
└── SKILL.md           ← 没有 scripts/，纯文档
```

SKILL.md：

```markdown
---
name: ffmpeg-converter
description: |
  Convert, compress, or resize media files using ffmpeg. Use when
  the user asks to change video/audio formats, reduce file size,
  or extract audio from video.
---

# FFmpeg Converter

## Prerequisites
ffmpeg must be installed: `brew install ffmpeg` or `apt install ffmpeg`.

## Common Commands

### Convert video format
ffmpeg -i input.mp4 output.webm

### Compress video (lower bitrate)
ffmpeg -i input.mp4 -b:v 1M output_compressed.mp4

### Extract audio from video
ffmpeg -i video.mp4 -q:a 0 -map a audio.mp3

### Resize video
ffmpeg -i input.mp4 -vf scale=1280:720 output_720p.mp4

## Important Notes
- Always use `-y` to overwrite existing files without prompting.
- The `-b:v` flag controls video bitrate (lower = smaller file, lower quality).
```

Agent 使用时的过程：

1. 用户说"帮我把这个 mov 转成 mp4，顺便压到 720p"
2. Agent 匹配到 `ffmpeg-converter`，ReadSkill 加载
3. Agent 自己拼命令：`ffmpeg -i video.mov -vf scale=1280:720 -b:v 1M -y output.mp4`
4. Agent 执行 Bash，完成

**精髓**：没有一行脚本代码——Skill 只是把 ffmpeg 的使用知识编码成了文档。Agent 读到后自己组合参数、自己拼命令。适用于任何已有 CLI 工具。

**实例 3：Multi-Script Skill — `github-repo-manager`**

目录结构：

```
github-repo-manager/
├── SKILL.md
└── scripts/
    ├── create_repo.py     ← 独立工具 1
    ├── list_issues.py     ← 独立工具 2
    └── manage_collab.py   ← 独立工具 3
```

SKILL.md：

```markdown
---
name: github-repo-manager
description: |
  Manage GitHub repositories, issues, and collaborators. Use
  when the user asks to create repos, list issues, or manage
  collaborator access.
---

# GitHub Repo Manager

Requires: `GITHUB_TOKEN` environment variable.

## Tools

### create_repo.py
Create a new GitHub repository. The agent passes the repo name and visibility.
Input format: `{"name": "my-repo", "private": false, "description": "..."}`

### list_issues.py
List issues for a repository with optional state/label filters.
Input format: `{"repo": "owner/repo", "state": "open", "labels": ["bug"]}`

### manage_collab.py
Add or remove collaborators. Requires admin access.
Input format: `{"repo": "owner/repo", "username": "alice", "action": "add"}`
```

**精髓**：多个独立脚本共用一个 Skill 目录，每个脚本是一个独立工具（命名 `github-repo-manager__create_repo`）。适用于一个领域下有多个正交操作的情况——不必拆成 3 个 Skill。

**`SKILL.md` 文件格式**：

```
skill-name/                  ← 目录名就是 Skill 名
├── SKILL.md                 ← 唯一必需文件
├── scripts/                 ← 可选：可执行脚本
├── references/              ← 可选：参考文档（模型按需加载）
└── assets/                  ← 可选：模板、资源文件等
```

```markdown
---
name: frontend-design
description: |
  Create distinctive, production-grade frontend interfaces.
  Use when the user asks to build web components, pages,
  or applications. Generates creative, polished code that
  avoids generic AI aesthetics.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Frontend Design Skill

## Overview
...

## Quick Start
...

## Common Workflows
...
```

**Frontmatter 字段**：

| 字段              | 必填 | 说明                                                                                                                                                                                                                          |
| ----------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | ✅   | 唯一标识，kebab-case                                                                                                                                                                                                          |
| `description`   | ✅   | **唯一的触发机制**。描述何时应使用此技能。必须用第三人称，尽可能精确——模型靠这段文字来判断"当前任务需不需要这个 Skill"。                                                                                              |
| `allowed-tools` | ❌   | 读取该 Skill 后，本轮请求内临时加入工具自动允许规则；请求开始和结束都会清理，不跨轮持久化。                                                                                                                                   |
| `context`       | ❌   | 当值为 `fork` 时，ReadSkill 会把 Skill 正文和本次任务要求发送给 fork 子 Agent 执行；主 Agent 只接收子 Agent 的结果。                                                                                                          |
| `paths`         | ❌   | Glob 模式列表。技能在`.claude/skills/` 目录被扫描到后，先进入"条件待命"状态（conditionalSkills）。只有当 Agent 读取的文件相对路径匹配此 glob 时，技能才被激活移到 dynamicSkills。控制的是**激活条件**，而非发现条件。 |

> **`description` 是 Skill 最关键、最容易出错的字段。** 模型不是"调用" Skill——它是通过文字匹配来决定适用性。写法好坏直接决定 Skill 会不会被正确触发。好的 description：具体列出触发场景、用第三人称、覆盖同义词；坏的 description：模糊、第一人称、只有一句话。

### 5.1 核心概念

Skill 是项目目录下的 `.claude/skills/{name}/SKILL.md` 文件，包含：

- **YAML frontmatter**：`description`（描述）、`paths`（可选的 glob 激活条件）、`allowed-tools`（工具白名单）、`context`（设为 `"fork"` 时在隔离子 Agent 执行）
- **Markdown 正文**：技能指令内容

`SkillCommand` 类型（`src/Tools/types.ts`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 技能目录名 |
| `description` | string | frontmatter 描述 |
| `content` | string | Markdown 正文 |
| `allowedTools` | string[]? | `allowed-tools` 解析结果 |
| `executionContext` | `"fork"`? | frontmatter `context: fork` 时设置 |
| `paths` | string[]? | `paths` glob 列表 |
| `skillDir` | string? | 技能目录绝对路径 |
| `skillPath` | string? | SKILL.md 文件绝对路径 |

**`allowed-tools` 工作机制**：当 Skill 被 ReadSkill 读取后，其 `allowedTools` 会被注入到 `toolPermissionContext.alwaysAllowRules.command` 中作为临时规则。这些规则在 executor 的 `applyToolPermission` 中优先于普通 `canUseTool` 回调生效，支持精确匹配（`Read`）和参数模式匹配（`Bash(git status:*)`）。每轮 query 开始时和结束时由 `clearTemporaryCommandAllowRules` 自动清理。

**`isConcurrencySafe`**：ReadSkill 的 `isConcurrencySafe()` 返回 `false`，因为 forked 执行需要修改 `toolPermissionContext`（激活 allowed-tools），必须串行避免竞态。

涉及文件：

| 文件                                             | 职责                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `src/Tools/utils/discoverSkillsForReadPath.ts` | 技能发现引擎（核心）                                                     |
| `src/Tools/ReadSkill/ReadSkill.ts`             | ReadSkill 工具入口                                                       |
| `src/Tools/ReadSkill/prompt.ts`                | 工具描述和 prompt                                                        |
| `src/Tools/ReadSkill/type.ts`                  | 输入/输出 Zod schema（含 `args`、`status`、`agentId` 字段） |
| `src/Tools/ReadSkill/state.ts`                 | 内容渲染 + 调用记录                                                      |
| `src/Tools/types.ts`                           | `SkillRuntimeState`、`SkillCommand` 类型（含 `allowedTools`、`executionContext`） |
| `src/query/runtime-context.ts`                 | 注入逻辑：收集技能 → 渲染 XML → 追加到`state.runtimeContextMessages` |
| `src/auto-compress/invoked-skill-restore.ts`   | 压缩后技能恢复                                                           |
| `src/Tools/executor.ts`                        | 权限控制：`isAllowedByTemporaryCommandRule` 检查临时允许规则            |
| `src/query.ts`                                 | `clearTemporaryCommandAllowRules` 每轮清理临时规则                      |

### 5.2 两种技能类型

| 类型                 | frontmatter 特征 | 激活时机                              | 存储位置                                                |
| -------------------- | ---------------- | ------------------------------------- | ------------------------------------------------------- |
| **动态技能**   | 无`paths` 字段 | 发现后立即可用                        | `skillRuntime.dynamicSkills`                          |
| **条件性技能** | 有`paths` 字段 | 访问的文件匹配`paths` glob 后才激活 | 先存`conditionalSkills`，匹配后移到 `dynamicSkills` |

路径匹配支持三种模式：精确匹配（`src/Tools/FileRead/foo.txt`）、目录通配（`src/components/**`）、前缀通配（`src/components/*`）。

### 5.3 完整生命周期（6 阶段）

```
┌─────────────────────────────────────────────────────────────────┐
│ 阶段 1：发现                                                    │
│   FileRead / FileWrite / FileEdit 操作文件                       │
│     → discoverSkillsForReadPath(filePath, context)               │
│       → 沿目录链向上扫描 .claude/skills/ 目录                    │
│       → 解析 SKILL.md（YAML frontmatter + Markdown 正文）        │
│       → 无 paths → 直接进入 dynamicSkills                        │
│       → 有 paths → 进入 conditionalSkills（待匹配激活）           │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 阶段 2：注入（每轮 Query Phase C）                              │
│   loadDynamicSkillContextForQuery(runtime, state)                │
│     → collectActiveDynamicSkills() 收集所有 dynamicSkills        │
│       （不同于旧版的 collectUnsentDynamicSkills，不再一次性）     │
│     → 每次最多 8 个，总计不超过 32K 字符                          │
│     → 渲染为 <dynamic_skills> XML，放入 runtimeContextMessages   │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 阶段 3：合并（materializeContextForQuery，Phase C）                │
│   materializeContextForQuery(runtime, state)                     │
│     → removePreviousVolatileContextBlocks(state)                  │
│       → 遍历 state.Messages，正则剥离旧的                          │
│         <context_block source="dynamic_skill">...</context_block>│
│         <context_block source="todo_list">...</context_block>    │
│         <context_block source="plan_mode">...</context_block>    │
│       → 如果删除后 <opencat_context> 为空，移除整个消息          │
│     → 收集长期记忆 + Plan/Todo + runtimeContextMessages           │
│     → 合并为一个 <opencat_context> 消息                          │
│     → state.Messages.push(contextMessage)                        │
│     → state.runtimeContextMessages = []                          │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 阶段 4：模型读取（ReadSkill.call）                               │
│   模型看到 <dynamic_skills> 元数据后                              │
│     → 调用 ReadSkill(name="frontend-design", args="...")         │
│       → 从 skillRuntime.dynamicSkills 中按名或路径查找             │
│       → renderSkillContentForModel() 渲染完整技能内容             │
│         → 替换 ${OPENCAT_SKILL_DIR} / ${CLAUDE_SKILL_DIR} 占位符 │
│       → 上限 64K 字符（超出截断并标注 truncated）               │
│       → 根据 executionContext 分两条路径：                        │
│                                                                   │
│       ┌─ executionContext === "fork" ─────────────────────────┐   │
│       │ → executeForkedSkill()                                 │   │
│       │   → activateSkillAllowedTools() 临时开放 allowed-tools │   │
│       │   → runAgentTask({ mode: "fork", maxTurns: 20 })       │   │
│       │   → AgentDefinition: category="worker", tools=allowed  │   │
│       │   → Prompt = <skill>正文</skill> + <task>参数</task>   │   │
│       │   → 主 Agent 收 result，返回 status="forked"           │   │
│       │   → finally: restoreAppState() 清理临时规则             │   │
│       └───────────────────────────────────────────────────────┘   │
│       ┌─ 普通 Skill（无 context: fork）───────────────────────┐   │
│       │ → recordInvokedSkill() 记录到 state.invokedSkills      │   │
│       │ → activateSkillAllowedTools() 临时开放 allowed-tools   │   │
│       │ → 返回 status="inline"，模型继续参考技能指令执行       │   │
│       └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 阶段 5：执行                                                    │
│   模型根据技能指令调整行为                                       │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 阶段 6：压缩后恢复（auto-compress 触发时）                       │
│   restorePostAutoCompressContext(runtime, state, summaryId)       │
│     → applyAutoCompressSummary(state) 获取尾部保留消息            │
│     → restoreInvokedSkillsAfterAutoCompress(runtime, state,       │
│         summaryId, preservedMessages)                             │
│       → selectPostCompactInvokedSkills() 筛选需要恢复的技能       │
│         • agentId 匹配当前 agent                                  │
│         • 不在 preservedMessages 的 ReadSkill 结果中（防重复）    │
│         • 按 invokedAt 降序，取最近 5 个                          │
│       → limitInvokedSkillsForRestore() 控制体积                   │
│         • 单个最多 16K 字符                                       │
│         • 总计最多 48K 字符                                       │
│       → 渲染为 <post-compact-invoked-skills> XML                  │
│       → 追加到 state.runtimeContextMessages                       │
│       → 每个 summaryId 只恢复一次（防重复）                      │
└─────────────────────────────────────────────────────────────────┘
```

### 5.4 注入位置详解

技能通知在每一轮 Query 的 **Phase C**（`materializeRequestContext` 内）被注入。Phase C 在纯消息投影和 auto-compress **之后**执行，确保运行时上下文不会被压缩吞掉：

**Phase A 入口**：
```
query() → _query()
  → clearTemporaryCommandAllowRules(runtime)   ← 每轮开始清理上一轮的临时允许规则
  → 主循环...
  → finally: clearTemporaryCommandAllowRules() ← 每轮结束再次清理
```

**Phase B/C 流程**：
```
Phase B: buildMessagesForQuery()              ← 纯消息投影
  → getAutoCompressionRequest()               ← 检查是否需要压缩
  → (若触发) applyAutoCompression()           ← 永久压缩 state.Messages
  → buildMessagesForQuery()                   ← 重建投影
  ↓
Phase C: materializeRequestContext()           ← 开始追加运行时上下文
  ↓
loadDynamicSkillContextForQuery()              ← Step 1: 收集技能通知
  → collectActiveDynamicSkills()              ← 每轮全量收集
  → 渲染 <dynamic_skills> XML
  → appendRuntimeContextMessages(state, messages) ← 暂存到 runtimeContextMessages[]
  ↓
loadRuntimeContextForQuery()                   ← Step 2: 收集智能体通知
  ↓
materializeContextForQuery()                   ← Step 3: 合并为一条消息
  → removePreviousVolatileContextBlocks(state) ← 剥离旧的易失块
  → shouldAttachLongTermMemory() 检查是否需要注入
  → createLongTermMemoryContextMessage()       ← 文件记忆注入
  → Plan/Todo + 长期记忆 + runtimeContextMessages[] → <opencat_context>
  → state.Messages.push(contextMessage)       ← 追加到末尾
  ↓
buildMessagesForQuery()                        ← Step 4: 最终投影（含上下文消息）
```

**最终消息结构**：

```
... (旧消息历史，可能已被 auto-compress 压缩) ...
[user: <opencat_context>                              ← Phase C 新追加
  <context_block source="long_term_memory">...</context_block>
  <context_block source="dynamic_skill">
    <dynamic_skills>
      <skill name="frontend-design">...</skill>
    </dynamic_skills>
  </context_block>
  <context_block source="agent_notification">...</context_block>
</opencat_context>]
```

关键设计决策：

- **每轮注入**（`collectActiveDynamicSkills` 无去重逻辑），确保技能通知在压缩后不会丢失
- **先剥离再追加**（`removePreviousVolatileContextBlocks`），防止历史中 `<opencat_context>` 消息堆积；剥离目标包括 `dynamic_skill`、`todo_list`、`plan_mode` 三种易失块
- **剥离是正则操作**：`/<context_block source="dynamic_skill">[\s\S]*?<\/context_block>/g`（同样模式用于 todo_list 和 plan_mode），不做 DOM 解析
- **Phase C 在压缩之后**：运行时上下文在 auto-compress 之后才注入 `state.Messages`，确保模型能看到，不会被压缩摘要吞掉

### 5.5 压缩恢复机制

auto-compress 压缩后，包含 ReadSkill 结果的旧消息可能被摘要替换，模型会丢失技能指令。恢复链路：

```
applyAutoCompression(runtime, state)
  → 压缩完成
  → restorePostAutoCompressContext(runtime, state, summaryId)
      → applyAutoCompressSummary(state)               // 获取尾部保留的消息
      → restoreReadFileStateAfterAutoCompress()        // 恢复 ReadFile 缓存
      → restoreInvokedSkillsAfterAutoCompress()        // 恢复技能内容
          → selectPostCompactInvokedSkills()
          → limitInvokedSkillsForRestore()
          → state.runtimeContextMessages.push(...)     // 注入恢复的 XML
```

恢复的 XML 格式：

```xml
<post-compact-invoked-skills>
The following skill instructions were read before auto-compress
and have been restored into the current context.

<skill name="frontend-design">
  <description>Create distinctive, production-grade frontend...</description>
  <skill_dir>/project/.skill/frontend-design</skill_dir>
  <content>
  完整的 SKILL.md 正文...
  </content>
</skill>
</post-compact-invoked-skills>
```

**恢复条件**：

1. 技能必须曾被模型调用过 `ReadSkill`（即 `state.invokedSkills` 中有记录）
2. 该技能不在尾部保留消息中已存在的 ReadSkill 结果里（防重复）
3. 属于当前 agent 调用的（`agentId` 匹配）

**恢复限制**：

| 参数           | 值                           |
| -------------- | ---------------------------- |
| 最多恢复技能数 | 5                            |
| 单技能最大字符 | 16,000                       |
| 总计最大字符   | 48,000                       |
| 防重复         | 每个`summaryId` 只恢复一次 |

### 5.6 已修复：技能通知被压缩后丢失

**旧行为**（`collectUnsentDynamicSkills`）：

- 每个技能通知只发一次，`sentDynamicSkillNames` 永久标记
- 如果压缩删除了通知且模型未调用 ReadSkill → 技能永久丢失
- 两条恢复路径都走不通：重新通知被标记阻止，压缩恢复依赖 `invokedSkills`（未读就没有）

**新行为**（`collectActiveDynamicSkills`）：

- 每轮全量收集所有 dynamicSkills，不再依赖一次性标记
- `removePreviousVolatileContextBlocks` 剥离旧的易失块（dynamic_skill、todo_list、plan_mode），避免堆积
- 压缩后如果技能仍在 `dynamicSkills` 中，下一轮自然重新注入

### 5.7 当前项目中的 Skill

| 路径                                            | 类型   | context  | 用途                                                           |
| ----------------------------------------------- | ------ | -------- | -------------------------------------------------------------- |
| `.claude/skills/file-read-path-rule/SKILL.md` | 条件性 | —     | 测试用：匹配`src/Tools/FileRead/skill-rule-test.fixture.txt` |
| `.skill/frontend-design/SKILL.md`             | 动态   | —     | 前端设计指南                                 |

### 5.8 当前未实现

| 项目               | 描述                                                            |
| ------------------ | --------------------------------------------------------------- |
| 条件性技能的热卸载 | 技能激活后没有"逆激活"机制（匹配文件被删除后技能仍保持 active） |
| 技能依赖/继承      | 不存在 SKILL.md 之间的引用或继承关系                            |
| 跨会话技能抑制     | 无"关闭某个技能"的用户命令或 UI                                 |
| `agent` 字段      | frontmatter `agent:` 指定 fork 的子 Agent 类型，暂未解析       |
| `model` 字段      | frontmatter `model:` 覆盖 fork Agent 的模型选择，暂未解析      |
| `hooks` 字段      | frontmatter `hooks:` 生命周期钩子，暂未解析                    |

---

← [返回 ARCHITECTURE.md 目录](../ARCHITECTURE.md)
