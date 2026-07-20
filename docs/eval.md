# 评测系统

## 十六、评测系统（Evaluation System）

OpenCat 内置了对 **SWE-bench Verified** 数据集的自动化评测能力，用于衡量 Agent 修复真实世界 GitHub issue 的能力。

涉及文件：

| 文件                                     | 职责                                     |
| ---------------------------------------- | ---------------------------------------- |
| `scripts/eval-swe-serial.ts`           | 主评测脚本（两阶段：investigate → fix） |
| `scripts/eval-swe-verified-cache.ts`   | 备选评测脚本（多轮累积上下文）           |
| `scripts/load_swe_verified_dataset.py` | Python 数据集加载脚本                    |
| `src/swe/workspace.ts`                 | SWE 工作区管理（bare clone + worktree）  |
| `src/telemetry/jsonl.ts`               | `JsonlRunObserver`：遥测事件写入 JSONL |
| `src/telemetry/events.ts`              | `EvaluationEvent` 类型定义             |

---

### 16.1 整体流程

```
SWE-bench 数据集（JSONL 文件，每条一个 GitHub issue）
        │
        ▼
┌────────────────────────────────────────────────────────┐
│  Step 1: 准备仓库（prepareSweWorkspace）                │
│    → bare clone（--mirror）到本地缓存 (~/.opencat/swe-repos) │
│    → git worktree add --detach 切到 base_commit        │
│    → 同一 repo 的多个 instance 共享一个 bare clone      │
└────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────┐
│  Step 2: 注入问题（renderPrompt）                       │
│    → 把 instance_id + problem_statement 拼入提示词       │
│    → 包装为 <swe_task> XML                            │
│    → 如是两阶段模式，第一阶段要求 "只调查不修改"         │
└────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────┐
│  Step 3: 启动 OpenCat Agent（query()）                 │
│    → createRuntime({ cwd: worktree 路径 })              │
│    → tools: createDefaultTools() → 默认过滤 WebSearch/WebFetch │
│    → reasoningEffort: "max"                             │
│    → JsonlRunObserver 记录所有遥测事件                   │
└────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────┐
│  Step 4: 收集产物                                       │
│    → git diff --binary → patch.diff                     │
│    → 遥测事件流 → events.jsonl                          │
│    → 统计聚合 → summary.json                            │
│    → 全部放在 outputRoot/<instance_id>/ 下               │
└────────────────────────────────────────────────────────┘
```

---

### 16.2 两个评测脚本的对比

|                      | `eval-swe-serial.ts`                                                                                               | `eval-swe-verified-cache.ts`                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **执行模式**   | 两阶段（investigate → fix），同一 session 内分两次`query()` 调用                                                  | 可配置轮次（默认 1 轮），每轮追加一条 user 消息后`query()`                                                                    |
| **仓库管理**   | `prepareSweWorkspace()`：bare clone + git worktree                                                                 | 手动`git clone --mirror` + `git clone --no-hardlinks`                                                                       |
| **数据集加载** | 直接读取`.jsonl` 文件（JSONL 或 JSON 数组）                                                                        | Python 脚本`scripts/load_swe_verified_dataset.py` 拉取                                                                        |
| **提示词风格** | 第一阶段`"Do not modify files. Do not call Edit or Write."`，第二阶段 `"implement the smallest correct fix now"` | 单轮模式：`"Modify the checkout-out repository to fix the issue"`；多轮模式：R1=调查、R2=实现、R3=验证                        |
| **遥测指标**   | 基础：token、缓存命中率、工具调用数、压缩/压缩计数                                                                   | 更细：额外包含`hardHistorySnipCount`、`toolResultCharsBeforeBudget`/`AfterBudget`/`AfterCompact`、`contextReadyCount` |
| **工具过滤**   | 由`allowWebTools` 控制是否包含 WebSearch/WebFetch（默认 false）                                                    | 同                                                                                                                              |
| **输出子目录** | `<instance_id>/` 下：`repo-<instance_id>/`（worktree）、`events.jsonl`、`patch.diff`                         | `<instance_id>/` 下：`repo/`（完整 clone）、`events.jsonl`、`patch.diff`、`summary.json`                              |

**推荐使用 serial 版**：worktree 方式磁盘占用少（同一 repo 的多个 instance 只存一份 bare clone），两阶段分离让模型有明确的"先看后改"节奏。

---

### 16.3 仓库准备详解（`prepareSweWorkspace`）

`src/swe/workspace.ts:181`。核心步骤：

1. **检查状态**：`getSweWorkspaceStatus()` 查工作区是否已存在
   - `"ready"`：HEAD 匹配 base_commit 且干净 → 直接复用
   - `"dirty"`：HEAD 对但工作区脏 → 如未开启 `allowDirtyWorkspaces` 则跳过
   - `"wrong-head"`：HEAD 不匹配 → 视为缺失
   - `"missing"`：需要创建
2. **创建 worktree**：
   - 先 `ensureSweRepoCache()`：本地找 bare clone（`reposDir/<org>__<repo>/`），没有则 `git clone --mirror`
   - `git worktree add --force --detach <path> <base_commit>`
   - 写入 `meta.json`（含 instanceId、sessionId、时间戳）
3. **缓存复用**：同一个 repo（如 `django/django`）的多个 instance 共享一个 `~/.opencat/swe-repos/django__django.git` bare clone，每个 instance 是独立的 worktree

路径约定：

| 用途            | 路径                                                            |
| --------------- | --------------------------------------------------------------- |
| Bare clone 缓存 | `~/.opencat/swe-repos/<org>__<repo>.git`                      |
| Worktree 工作区 | `~/.opencat/swe-workspaces/<instance_id>/repo-<instance_id>/` |

#### 16.3.1 裸仓库缓存（`ensureSweRepoCache`）— 只 clone 一次

SWE-bench 里同一个 repo（如 `django/django`）有几十甚至几百个 instance。如果每个 instance 都 `git clone` 一次，磁盘和网络开销不可接受。`ensureSweRepoCache` 解决了这个问题：**同一个 repo 全数据集只 clone 一次**。

核心逻辑（`src/swe/workspace.ts:229`）：

```
ensureSweRepoCache(repo, baseCommit, options)
  │
  ├─ 1. 计算缓存路径: ~/.opencat/swe-repos/django__django.git
  │
  ├─ 2. 已在内存 set 中且是 bare 仓库 → 直接返回（最快路径）
  │
  ├─ 3. 磁盘上已是 bare 仓库:
  │      ├─ baseCommit 已存在 → 加入 set，返回
  │      └─ baseCommit 不存在 → git fetch --all --prune → 拉取新 commit
  │
  ├─ 4. 本地有仓库镜像（reposDir 配置）:
  │      → git clone --mirror <本地路径> → 秒级完成
  │
  └─ 5. 开启 allowNetworkClone:
         → git clone --mirror https://github.com/django/django.git → 网络下载
```

**`--mirror` 的含义**：`git clone --mirror` 创建一个 **bare 仓库**（没有工作目录），并且：

- 拉取**所有**分支和 tag（`refs/heads/*`、`refs/tags/*` 等）
- 设置 `fetch = +refs/*:refs/*`——后续 `git fetch` 会同步所有引用
- 结果就是一个完整的、只存 `.git` 内部对象的目录

```
普通 clone:                        bare --mirror clone:
django/                            django.git/
├── .git/    ← 仓库数据           ├── HEAD
├── django/  ← 源码（工作目录）    ├── config
├── tests/                        ├── objects/    ← 所有 commit/tree/blob
└── ...                           ├── refs/       ← 所有分支/tag 引用
                                  └── packed-refs
                                  （没有工作目录，不能直接编辑代码）
```

**本地仓库发现**（`findLocalRepo`）：如果你电脑上已经 clone 过 django，不需要再从 GitHub 拉。在 `reposDir` 下按三种命名尝试匹配：

```
reposDir/
├── django__django/     ← 优先匹配（org__repo 格式）
├── django/             ← 其次（只用 repo 名）
└── django/django       ← 最后（完整 org/repo 路径）
```

#### 16.3.2 Worktree 机制 — 一个 bare clone 支撑 N 个不同 commit

bare clone 没有工作目录，不能直接编辑代码。`git worktree` 解决了这个问题：**从一个 bare 仓库创建多个独立的工作目录，每个可以 checkout 到不同的 commit**。

关键命令（`prepareSweWorkspace:206-216`）：

```bash
# 从 bare clone 创建一个新的 worktree，直接 checkout 到指定 commit（detached HEAD）
git --git-dir ~/.opencat/swe-repos/django__django.git \
    worktree add --force --detach \
    ~/.opencat/swe-workspaces/django__django-12345/repo-django__django-12345 \
    abc123def456
```

`--detach` 的含义：不是基于某个 branch 创建，而是直接在**指定的 commit hash** 上进入 detached HEAD 状态。这正是 SWE-bench 需要的——每个 instance 有一个特定的 `base_commit`，Agent 从这个 commit 开始修 bug。

完成后磁盘布局如下：

```
~/.opencat/swe-repos/                              ← 裸仓库缓存（只读，共享）
├── django__django.git/                             ← 一份 bare clone，包含完整历史
├── sympy__sympy.git/
└── scikit-learn__scikit-learn.git/

~/.opencat/swe-workspaces/                          ← worktree 工作区（读写，独立）
├── django__django-12345/
│   ├── meta.json                                   ← 元数据（instanceId, sessionId...）
│   └── repo-django__django-12345/                  ← Agent 的工作目录，checkout 到 commit abc123
│       ├── .git → 指向 bare clone 的引用
│       ├── django/                                 ← 源码文件
│       └── tests/
├── django__django-67890/
│   └── repo-django__django-67890/                  ← 同一个 bare clone，checkout 到 **另一个** commit def456
└── ...
```

**为什么用 worktree 而不是多个 clone：**

| 方案              | django/django 的 N 个 instance                                      |
| ----------------- | ------------------------------------------------------------------- |
| 逐个`git clone` | N × ~500MB = 几十 GB                                               |
| worktree          | 1 × ~500MB（bare clone）+ N × 几 MB（每个 worktree 只是一个指针） |
| checkout 速度     | `clone` = 几分钟；`worktree add` = 几秒（对象已在本机）         |

**`detached HEAD` 说明**：SWE-bench 不需要基于分支名工作——只需要基于一个特定的历史 commit。`--detach` 直接把 HEAD 指向该 commit hash，不需要创建本地分支。Agent 在这个 worktree 里做的所有修改（`git diff` 产出 patch）不影响 bare clone，也不影响其他 worktree。

---

### 16.4 两阶段提示词（serial 版）

**Phase "investigate"**（只调查不修改）：

```
You are working on a SWE-bench Verified issue in OpenCat.
First investigate only. Do not modify files yet. Do not call Edit or Write.
Read the issue, inspect the checked-out repository, identify the likely root cause,
and explain the smallest code change you would make next.
Use tools to inspect relevant files. Do not fetch unrelated web content unless the
repository itself requires it.
End with a concise investigation summary: root cause, relevant files/functions,
proposed fix, and tests to run.

<swe_task>
<instance_id>django__django-12345</instance_id>
<repo>django/django</repo>

<problem_statement>
[SWE-bench 数据集中的问题描述]
</problem_statement>
</swe_task>
```

**Phase "fix"**（实现修复）：

```
Based on the investigation from the previous turn, implement the smallest correct
fix now. Modify only the checked-out SWE workspace for this item. Re-read any file
you edit before changing it. After editing, run the most relevant tests you can.
If tests cannot run, explain exactly why and what you verified instead.
Finish with a concise summary of changed files, the behavior fixed, and verification results.

<swe_task_followup>
<instance_id>django__django-12345</instance_id>
</swe_task_followup>
```

关键设计：第一阶段**不累积 inventory 消息**——两个阶段的 `query()` 调用共用同一个 `state`，对话上下文自然延续（模型能看到第一阶段的调查结果）。

---

### 16.5 工具过滤

两个脚本默认都过滤掉 `WebSearch` 和 `WebFetch`，通过 `allowWebTools` 配置项控制。理由：SWE-bench 任务修改的是本地仓库代码，不应依赖网络搜索。

```typescript
function createSweEvalTools(): Tools {
  const tools = createDefaultTools();
  return allowWebTools
    ? tools
    : tools.filter(t => t.name !== "WebSearch" && t.name !== "WebFetch");
}
```

---

### 16.6 遥测指标

`summarizeEvents()` 从 `EvaluationEvent[]` 聚合以下统计：

| 指标                                                      | 事件类型                   | 含义                                   |
| --------------------------------------------------------- | -------------------------- | -------------------------------------- |
| `promptTokens` / `completionTokens` / `totalTokens` | `model_usage`            | 该 instance 累计 token 消耗            |
| `cacheHitRate`                                          | `model_usage`            | 前缀缓存命中率 =`hit / (hit + miss)` |
| `maxPromptTokens`                                       | `model_usage`            | 单次请求最大 prompt token 数           |
| `maxEstimatedTokens`                                    | `context_ready`          | 单次投影后最大估计 token 数            |
| `toolCallCount`                                         | `tool_call_started`      | 工具调用总数                           |
| `toolCounts`                                            | `tool_call_started`      | 各工具调用次数分布                     |
| `autoCompressCount`                                     | `auto_compress_finished` | auto compress 触发次数                 |
| `historySnipCount`                                      | `context_ready`          | history snip 累计层数                  |
| `bulkyToolCompactCount`                                 | `context_ready`          | bulky compact 累计压缩次数             |

cache 版本额外记录：`hardHistorySnipCount`、`toolResultBudgetReplacementCount`、`toolResultCharsBeforeBudget`/`AfterBudget`/`AfterCompact`、`contextReadyCount`。

---

### 16.7 配置

两个脚本通过环境变量或 `config.json` 配置。以 serial 版为例：

| 环境变量                              | `config.json` 字段     | 默认值                                                        | 说明                       |
| ------------------------------------- | ------------------------ | ------------------------------------------------------------- | -------------------------- |
| `DEEPSEEK_API_KEY`                  | —                       | 必填                                                          | API Key                    |
| `SWE_SERIAL_CONFIG`                 | —                       | `.opencat/evals/swe-serial/config.json`                     | 配置文件路径               |
| `SWE_SERIAL_RUN_ID`                 | `runId`                | `swe_serial_<timestamp>`                                    | 运行标识                   |
| `SWE_SERIAL_DATASET`                | `datasetPath`          | `.opencat/evals/swe-verified-cache/swe_verified_full.jsonl` | 数据集路径                 |
| `SWE_SERIAL_LIMIT`                  | `limit`                | 100                                                           | 最多评测几个 instance      |
| `DEEPSEEK_MODEL`                    | `model`                | `deepseek-v4-pro`                                           | 模型选择                   |
| `SWE_SERIAL_OUTPUT_DIR`             | `outputDir`            | `.opencat/evals/swe-serial/<runId>/`                        | 输出目录                   |
| `SWE_SERIAL_PHASES`                 | `phases`               | `["investigate", "fix"]`                                    | 执行哪些阶段               |
| `SWE_SERIAL_ALLOW_NETWORK_CLONE`    | `allowNetworkClone`    | `false`                                                     | 允许从 GitHub 在线 clone？ |
| `SWE_SERIAL_ALLOW_WEB_TOOLS`        | `allowWebTools`        | `false`                                                     | 允许 WebSearch/WebFetch？  |
| `SWE_SERIAL_ALLOW_DIRTY_WORKSPACES` | `allowDirtyWorkspaces` | `false`                                                     | 允许复用脏工作区？         |
| `OPENCAT_SWE_WORKSPACE_DIR`         | `workspaceRoot`        | `~/.opencat/swe-workspaces`                                 | worktree 根目录            |
| `OPENCAT_SWE_REPO_CACHE_DIR`        | `repoCacheRoot`        | `~/.opencat/swe-repos`                                      | bare clone 缓存根目录      |

---

### 16.8 输出结构

```
.opencat/evals/swe-serial/<runId>/
├── summary.json                    ← 所有 instance 的聚合结果
├── django__django-12345/           ← 每个 instance 一个子目录
│   ├── events.jsonl                ← 完整遥测事件流（每行一个 EvaluationEvent JSON）
│   ├── patch.diff                  ← git diff --binary 的完整输出
│   └── repo-django__django-12345/  ← 修改后的 worktree
├── sympy__sympy-67890/
│   ├── events.jsonl
│   ├── patch.diff
│   └── repo-sympy__sympy-67890/
...
```

---

### 16.9 与 OpenCat Agent 循环的关系

评测脚本完全复用 OpenCat 的标准 Agent 循环（`query()`），不做任何特殊处理：

```
eval-swe-serial.ts
  → createRuntime({ cwd: worktreePath, reasoningEffort: "max", ... })
  → createState()
  → for each phase:
      state.Messages.push(createMessage({ role: "user", content: prompt }))
      for await (const event of query(runtime, state)):
        ...  // 正常的 Agent 循环
```

这意味着评测中也会触发完整的 auto-compress、history snip、bulky compact 流程——遥测指标直接反映 OpenCat 在这些极端场景下的表现。

---
