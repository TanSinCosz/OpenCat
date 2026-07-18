# 工具系统

## 三、工具系统（Tool System）

### 3.1 文件与职责

| 文件                        | 职责                                                                             |
| --------------------------- | -------------------------------------------------------------------------------- |
| `src/Tools/types.ts`      | `Tool` 接口、`ToolUseContext`、`FileStateCache`、`SkillRuntimeState`     |
| `src/Tools/executor.ts`   | 工具执行管道：查找 → 解析 → 校验 → 权限 → 调用 → 格式化                     |
| `src/Tools/index.ts`      | 内置 14 工具的注册数组，MCP 工具合并                                             |
| 各`src/Tools/{ToolName}/` | 每个工具独立目录：`{ToolName}.ts` + `prompt.ts` + `type.ts` + `state.ts` |

### 3.2 Tool 接口

每个工具实现统一的 `Tool<TInput, TOutput>` 泛型接口：

```typescript
interface Tool<
    TInput = Record<string, unknown>,
    TOutput = ToolExecutionValue,
    TInputSchema extends ToolInputSchema = ToolInputSchema,
    TOutputSchema extends ToolOutputSchema = ToolOutputSchema,
> {
    name: string;
    inputSchema: TInputSchema;         // Zod schema，用于参数校验+function calling
    outputSchema: TOutputSchema;       // Zod schema，输出类型校验
    inputJsonSchema?: JSONSchemaObject; // 可选的 JSON Schema（MCP 工具的 schema 双轨制）
    maxResultSizeChars?: number;       // 结果字符上限，超出的触发大体积工具压缩
    searchHint?: string;              // 搜索提示（未充分使用）
    shouldDefer?: boolean;            // 推迟到下一轮批量执行
    alwaysLoad?: boolean;             // 始终加载（不受工具过滤影响）
    strict?: boolean;                 // DeepSeek strict function calling 模式

    description(): MaybePromise<string>;   // 系统提示词中的工具描述
    prompt(): MaybePromise<string>;        // 系统提示词中的使用指南

    isEnabled?(): MaybePromise<boolean>;   // 动态启用/禁用
    userFacingName?(): string;             // 用户界面展示名
    isConcurrencySafe?(): boolean;         // 同轮是否可多次调用

    formatResult?(options: { output: TOutput }): string;
    // 将 Tool 的内部输出格式化为发给模型的字符串。
    // 工具可保留富结构用于 UI/状态，同时只给模型发送简洁结果。

    call(
        input: TInput,
        context: ToolUseContext,
        runtime: Runtime,
        state: State,
    ): MaybePromise<TOutput>;
}
```

### 3.3 执行管道（executor.ts）

所有工具共享同一执行管道，入口函数 `executeToolCall`：

```
tool_calls 解析
    → findTool() 查找工具
        → 未找到 → renderUnavailableToolMessage（列出 agent 可用工具）
    → parseToolArguments() 解析 JSON 参数
    → validateToolInput() Zod schema 校验
        → 校验失败 → 返回错误消息
    → applyToolPermission() canUseTool 回调
        → 拒绝 → "Permission denied..."
    → tool.call() 执行工具逻辑
    → formatToolResult() 格式化输出
        → 有 formatResult() → 用工具自定义格式化
        → 无 → JSON.stringify
    → createToolResultMessage() 封装为 DeepSeekMessage(tool)
```

异常捕获：工具执行抛出任何异常 → `stringifyError()` → 作为工具错误结果返回（不中断主循环）。

### 3.4 14 工具总览

| #  | 工具                  | strict | 并发安全 | 结果上限 | 特殊标志                |
| -- | --------------------- | ------ | -------- | -------- | ----------------------- |
| 1  | **Read**        | ✅     | ✅       | -        | alwaysLoad              |
| 2  | **Write**       | ✅     | ❌       | 100K     | -                       |
| 3  | **Edit**        | ✅     | ❌       | 100K     | -                       |
| 4  | **Bash**        | ✅     | ❌       | 100K     | -                       |
| 5  | **Agent**       | ✅     | ❌       | 20K      | alwaysLoad              |
| 6  | **MemorySave**  | ✅     | ❌       | 20K      | alwaysLoad              |
| 7  | **ReadSkill**   | ✅     | ✅       | 80K      | alwaysLoad              |
| 8  | **SendMessage** | ✅     | ❌       | 4K       | alwaysLoad              |
| 9  | **Grep**        | ❌     | ✅       | 20K      | -                       |
| 10 | **Glob**        | ❌     | ✅       | 100K     | -                       |
| 11 | **WebSearch**   | ❌     | ✅       | 100K     | alwaysLoad              |
| 12 | **WebFetch**    | ❌     | ✅       | -        | shouldDefer, alwaysLoad |
| 13 | **TodoWrite**   | ❌     | ✅       | 50K      | alwaysLoad              |
| 14 | **Plan**        | ❌     | ✅       | -        | alwaysLoad              |

---

### 3.5 各工具详解

#### 3.5.1 Read — 文件读取

| 属性 | 值                                                                               |
| ---- | -------------------------------------------------------------------------------- |
| 输入 | `file_path`（绝对路径）、`offset`（起始行号）、`limit`（行数）             |
| 输出 | `{ filePath, content, numLines, startLine, totalLines }` 或 `file_unchanged` |
| 安全 | 拒绝二进制文件；文件大于 256KB 报错                                              |

**读缓存机制**：同一文件、相同 offset/limit、mtime 未变 → 返回 `file_unchanged` 标志，调用方跳过输出。缓存使用 LRU（`FileStateCache`），最大 100 条目 / 25MB。

**多格式支持**：

- 图片（PNG/JPG 等）：以多模态方式展示给模型
- PDF：最多 20 页，通过 `pages` 参数指定范围
- Jupyter Notebook（.ipynb）：渲染所有 cell（代码 + 输出 + 文本）

**副作用**：读取成功后调用 `discoverSkillsForReadPath()`，沿目录链扫描 `.claude/skills/` 目录。

**限制**：每次最多返回 2000 行。超过此限制需要使用 offset 分批读取。文件 > 256KB 直接拒绝。

#### 3.5.2 Write — 文件写入

| 属性 | 值                                                                  |
| ---- | ------------------------------------------------------------------- |
| 输入 | `file_path`（必须绝对路径）、`content`                          |
| 输出 | `{ type: 'create'\|'update', filePath, content, structuredPatch }` |

**read-before-write 机制**：

```
1. 检查 readFileState 中是否有该文件的记录
2. 无记录 → 拒绝："File has not been read yet. Read it first before writing."
3. 记录存在但 isPartialView → 拒绝（模型只看到了部分内容）
4. 检查 mtime：如果文件被外部修改（mtime > read 时间戳）→ 拒绝
5. 全部通过 → 允许写入
```

**原子写入**：自动创建父目录（`mkdir recursive`）。

**规则约束**：prompt 明确禁止未经用户要求就创建 `.md` 文档，禁止自行添加 emoji。

#### 3.5.3 Edit — 搜索替换编辑

| 属性 | 值                                                                         |
| ---- | -------------------------------------------------------------------------- |
| 输入 | `file_path`、`old_string`、`new_string`（必须不同）、`replace_all` |
| 输出 | `{ filePath, oldString, newString, structuredPatch, replaceAll }`        |

**prepareEdit 校验链**（6 步）：

```
1. old_string === new_string → 拒绝
2. 文件不存在
   → old_string === '' → 允许（创建新文件）
   → old_string !== '' → 拒绝
3. old_string === '' 但文件已有内容 → 拒绝（防止清空已有文件）
4. read-before-edit：检查 readFileState（同 Write）
5. mtime 检查（同 Write）
6. 唯一性检查：old_string 匹配次数 > 1 且未设 replace_all → 拒绝
```

**CRLF/LF 自动纠正**（`findActualString`）：

```
1. 先尝试精确匹配 old_string
2. 失败 → 尝试将所有 \n 替换为 \r\n 后匹配（模型给 LF，文件是 CRLF）
3. 失败 → 尝试将所有 \r\n 替换为 \n 后匹配（模型给 CRLF，文件是 LF）
4. 全部失败 → 返回 null
```

**结果覆盖**：写入成功后更新 `readFileState` 缓存。

#### 3.5.4 Grep — 正则搜索

| 属性 | 值                                                                                   |
| ---- | ------------------------------------------------------------------------------------ |
| 输入 | `pattern`（正则）、`path`、`glob`、`output_mode`、`head_limit`（默认 250） |
| 输出 | 依 output_mode 不同                                                                  |

**三种输出模式**：

- `content`：带行号的匹配行（支持 `-A`/`-B`/`-C` 上下文行）
- `files_with_matches`：匹配的文件路径，按修改时间排序
- `count`：每个文件的匹配数

**底层**：ripgrep，参数 `--hidden --max-columns 500`。排除 VCS 目录（`.git`/`.svn`/`.hg`）。

**多行搜索**：`multiline: true` 启用 `-U --multiline-dotall`，`.` 匹配换行。

#### 3.5.5 Glob — 文件模式匹配

| 属性 | 值                                                 |
| ---- | -------------------------------------------------- |
| 输入 | `pattern`（glob 表达式）、`path`（搜索目录）   |
| 输出 | `{ filenames, numFiles, durationMs, truncated }` |

**底层**：ripgrep `--files --glob`，按修改时间排序。

**特性**：包含隐藏文件（`--hidden`），忽略 `.gitignore`（`--no-ignore`）。结果上限 100 个文件。

#### 3.5.6 Bash — Shell 执行

| 属性 | 值                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------ |
| 输入 | `command`、`timeout`（默认 120s，最大 600s）、`description`、`dangerouslyDisableSandbox` |
| 输出 | `{ stdout, stderr, interrupted, returnCodeInterpretation }`                                    |

**安全校验层**（`getBlockedCommandReason`）：

1. 空命令 → 拒绝
2. 超长命令（>10K 字符）→ 拒绝
3. 超时 > 600s → 拒绝
4. `dangerouslyDisableSandbox` → 拒绝（暂不支持）
5. 后台执行（`&`） → 拒绝
6. 交互式命令（vim、nano、ssh、python REPL 等）→ 拒绝
7. 命令替换（反引号、`$()`）→ 拒绝
8. Heredoc → 拒绝
9. Shell 重定向（`>`、`>>`、`<`）→ 拒绝
10. 长管道（>3 个 `|`）→ 拒绝
11. 危险命令匹配（rm、git push --force、curl/wget、npm install 等）→ 拒绝

**缓冲上限**：stdout/stderr 各 100K 字符，超出截断并标注。

**formatResult**：按优先级输出 `returnCodeInterpretation → interrupted → stdout → stderr → persistedOutputPath`。

#### 3.5.7 Agent — 子智能体

| 属性 | 值                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------- |
| 输入 | `prompt`、`description`、`subagent_type`、`execution_mode`（sync/async/fork）、`isolation`（none/worktree） |
| 输出 | sync → 完整结果 + changedFiles；async → agentId + outputFile                                                        |

**三种执行模式**：

- **sync**：等待子 agent 完成，返回完整结果。结果上限 20K 字符，超出截断。
- **async**：后台启动，返回 agentId + 输出文件路径。后续用 `SendMessage` 通信。
- **fork**：继承完整父上下文（消息历史），子 agent 的工具输出不污染父对话。只能从 main agent 发起，不能用 subagent_type。

**worktree 隔离**：在 `git worktree` 中运行子 agent。有修改 → 保留 worktree 路径；无修改 → 自动清理。

**工具权限**（`tool-policy.ts`）：

- `Agent` 工具所有子 agent 默认禁止（防止无限递归）
- 只读 agent（explore/plan）默认只能访问 `Read/Glob/Grep/WebSearch/WebFetch/ReadSkill`
- verify agent 额外可访问 `Bash`
- MCP 工具默认允许

#### 3.5.8 MemorySave — 文件长期记忆

| 属性 | 值                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 输入 | `memory`（一条记忆文本）、`reason`（可选保存原因）、`memoryType`（user/feedback/project/reference） |
| 输出 | `{ event: "CREATED" \| "EXISTS", file: { path, slug, hash } }`                                           |

**行为**：调用 `saveFileMemory()`，将记忆写入 `~/.opencat/memory/projects/<project-key>/` 下的 Markdown 文件。流程：

1. 计算记忆正文的 SHA256 hash，扫描已有文件检查重复（`findMemoryByHash()`）
2. 生成 slug（正文前 80 字符规范化）、文件名 `${slug}-${hash前8位}.md`
3. 写入带 YAML frontmatter 的 Markdown 文件（`name`, `description`, `type`, `hash`, `reason`）
4. 更新 `MEMORY.md` 索引文件，追加条目 `- [标题](文件.md) - 一行描述`
5. 内存中同步更新选择器缓存（`lastSelectedFiles`、`loadedFileMemories`）

**去重**：如果内容 hash 已存在，返回 `event: "EXISTS"`，不创建新文件但确保索引中有链接。

**约束**：不支持更新或删除已有记忆（需手动编辑 MEMORY.md 或通过 Dream 合并）。prompt 要求不保存敏感信息。

**涉及文件**：`src/Tools/MemorySave/MemorySave.ts`（工具入口）→ `src/Memory/file-memory.ts`（核心读写）。

#### 3.5.9 ReadSkill — 读取项目技能

| 属性 | 值                                                                   |
| ---- | -------------------------------------------------------------------- |
| 输入 | `name` 或 `path`（二选一）                                       |
| 输出 | `{ name, description, skillDir?, skillPath?, content, truncated }` |

**沙箱**：只能读取 `skillRuntime.dynamicSkills` 中已发现的技能，不能读任意文件。这是一个安全机制——防止模型通过 ReadSkill 绕过文件访问控制。

**内容上限**：64K 字符。超出截断并标注 `[ReadSkill content truncated]`，`truncated: true`。

**变量替换**：`${OPENCAT_SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` 替换为实际技能目录路径。

**副作用**：`recordInvokedSkill()` → 存入 `state.invokedSkills`，供 auto-compress 后的恢复逻辑使用。

#### 3.5.10 WebSearch — 网页搜索

| 属性 | 值                                                                                      |
| ---- | --------------------------------------------------------------------------------------- |
| 输入 | `query`（2-1000 字符）、`allowed_domains`/`blocked_domains`（各最多 20 个，互斥） |
| 输出 | `{ results: [{ title, url }], summary }`                                              |

**实现**：通过 DeepSeek API 的服务端搜索能力，而非自行 HTTP 请求。domain 过滤只接受 hostname，不支持通配符。

**安全**：prompt 明确警告搜索结果不可信，不能作为系统指令执行。

#### 3.5.11 WebFetch — 网页抓取

| 属性 | 值                                                             |
| ---- | -------------------------------------------------------------- |
| 输入 | `url`（HTTP/HTTPS）、`prompt`（1-4000 字符，提取目标描述） |
| 输出 | `{ url, code, contentType, text, truncated, redirected }`    |

**shouldDefer: true**：推迟到下一轮批量执行（避免并发 HTTP 请求带来的问题和资源竞争）。

**HTML 提取流程**：去 script/style 标签 → 去注释 → 换行规范化 → 实体解码。

**重定向策略**：同源最多 5 次；跨域不自动跟随，返回目标 URL 让模型决定。

**上限**：响应体 2MB，提取文本 100K 字符。

#### 3.5.12 SendMessage — 子 agent 通信

| 属性 | 值                                                      |
| ---- | ------------------------------------------------------- |
| 输入 | `to`（agentId）、`message`、`summary`（可选预览） |
| 输出 | `{ success, queued, pendingMessageCount }`            |

**功能**：向正在运行的子 agent 发送消息。消息入队 `task.pendingMessages[]`，子 agent 在下一轮读取并处理。

**约束**：

- 只支持直接 agentId（不支持广播、跨会话、或 resume）
- 目标 agent 必须 running 状态
- 消息上限 4K 字符

#### 3.5.13 TodoWrite — 任务列表

| 属性 | 值                                                                    |
| ---- | --------------------------------------------------------------------- |
| 输入 | `todos`（任务数组，每项含 `content`、`activeForm`、`status`） |
| 输出 | `{ oldTodos, newTodos }`                                            |

**功能**：创建和维护当前会话的结构化任务列表。主 agent 用它跟踪多步骤工作的进度，子 agent 也可用。

**行为**：按 `runtime.agentId` 隔离（不同 agent 各自维护独立列表）。每次调用全量替换任务列表，写入 `state.todos[agentId]` 后通过 `recordTranscriptStateSnapshot` 持久化到 transcript。`formatResult()` 渲染为编号列表（`[pending]`/`[in_progress]`/`[completed]`）。

**配置**：`alwaysLoad: true`，`strict: true`，结果上限 20K 字符。

#### 3.5.14 Plan — 计划模式

| 属性 | 值                                                                          |
| ---- | --------------------------------------------------------------------------- |
| 输入 | `action`（enter/request_approval/exit）、`plan`（请求审批时的计划文本） |
| 输出 | 取决于 action 类型                                                          |

**功能**：在计划模式和默认执行模式之间切换，控制写操作的允许/禁止。

**行为**：

- `enter`：进入 plan 模式，只允许只读操作
- `request_approval`：提交计划等待用户批准，批准后自动 exit plan 模式
- `exit`：仅在用户明确指示时退出 plan 模式

**配置**：`alwaysLoad: true`，`isConcurrencySafe: true`。

---

### 3.6 执行管道控制

**并发控制**：`isConcurrencySafe()` 决定工具在同一轮是否可被多次调用。不安全的工具（如 Edit、Write、Bash、Agent）同轮只调用一次。

**延迟执行**：`shouldDefer: true` 的工具（WebFetch）推迟到下一轮批量执行，让模型在同轮继续推理而不等待 HTTP 响应。

**strict 模式**：`strict: true` 的工具要求 DeepSeek 在调用时启用 strict function calling 模式，确保参数类型严格匹配。

**大体积结果压缩**：工具输出超过 `maxResultSizeChars` 时，触发 `persistToolResultForBudget` 逻辑——将大结果离线存储，替换为摘要传给模型。涉及文件 `src/tool-results/persistence.ts`。

**formatResult 双层设计**：工具内部保留富结构输出（`TOutput`），通过 `formatResult()` 只给模型发送简洁摘要。例如：

- Edit：输出包含完整 `structuredPatch`，但发给模型的只有 "has been updated successfully"
- Bash：输出包含 `stdout`/`stderr`/`returnCodeInterpretation`，发给模型的按优先级排列

---

---

← [返回 ARCHITECTURE.md 目录](../ARCHITECTURE.md)
