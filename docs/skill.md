# Skill 管理

## 五、Skill 管理（Skill Management）

### 5.1 核心概念

Skill 是项目目录下的 `.claude/skills/{name}/SKILL.md` 文件，包含：

- **YAML frontmatter**：`description`（描述）、`paths`（可选的 glob 激活条件）
- **Markdown 正文**：技能指令内容

涉及文件：

| 文件                                             | 职责                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `src/Tools/utils/discoverSkillsForReadPath.ts` | 技能发现引擎（核心）                                                     |
| `src/Tools/ReadSkill/ReadSkill.ts`             | ReadSkill 工具入口                                                       |
| `src/Tools/ReadSkill/prompt.ts`                | 工具描述和 prompt                                                        |
| `src/Tools/ReadSkill/type.ts`                  | 输入/输出 Zod schema                                                     |
| `src/Tools/ReadSkill/state.ts`                 | 内容渲染 + 调用记录                                                      |
| `src/Tools/types.ts`                           | `SkillRuntimeState`、`SkillCommand` 类型                             |
| `src/query/runtime-context.ts`                 | 注入逻辑：收集技能 → 渲染 XML → 追加到`state.runtimeContextMessages` |
| `src/auto-compress/invoked-skill-restore.ts`   | 压缩后技能恢复                                                           |

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
│ 阶段 4：模型读取                                                │
│   模型看到 <dynamic_skills> 元数据后                              │
│     → 调用 ReadSkill(name="frontend-design")                     │
│       → 从 skillRuntime.dynamicSkills 中按名查找                 │
│       → renderSkillContentForModel() 渲染完整技能内容             │
│         → 替换 ${OPENCAT_SKILL_DIR} / ${CLAUDE_SKILL_DIR} 占位符 │
│       → 上限 64K 字符（超出截断并标注 truncated）               │
│       → recordInvokedSkill() 记录到 state.invokedSkills          │
│       → 返回给模型                                               │
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

| 路径                                            | 类型   | 用途                                                           |
| ----------------------------------------------- | ------ | -------------------------------------------------------------- |
| `.claude/skills/file-read-path-rule/SKILL.md` | 条件性 | 测试用：匹配`src/Tools/FileRead/skill-rule-test.fixture.txt` |
| `.skill/frontend-design/SKILL.md`             | 动态   | 前端设计指南（无 paths，发现即激活）                           |

### 5.8 当前未实现

| 项目               | 描述                                                            |
| ------------------ | --------------------------------------------------------------- |
| 条件性技能的热卸载 | 技能激活后没有"逆激活"机制（匹配文件被删除后技能仍保持 active） |
| 技能依赖/继承      | 不存在 SKILL.md 之间的引用或继承关系                            |
| 跨会话技能抑制     | 无"关闭某个技能"的用户命令或 UI                                 |

---

← [返回 ARCHITECTURE.md 目录](../ARCHITECTURE.md)
