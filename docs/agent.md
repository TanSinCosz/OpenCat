# 多智能体协作

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

---

← [返回 ARCHITECTURE.md 目录](../ARCHITECTURE.md)
