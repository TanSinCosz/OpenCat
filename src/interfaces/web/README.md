# Web 模块

负责浏览器交互、HTTP API 和 Web 会话生命周期。启动入口为 `../../web-cli.ts`；导入本目录的模块不会自动监听端口或创建会话。

## 阅读顺序

`server.ts` 组装 `WebSessionManager` 与路由 → `routes.ts` 接收请求 → 各服务处理业务 → `http.ts` 输出响应。

| 文件 | 职责 |
| --- | --- |
| `server.ts` | 创建会话管理器、创建 HTTP 服务、监听配置中的端口 |
| `routes.ts` | 路由表、请求校验、调用服务；修改 API 从这里开始 |
| `session-manager.ts` | 创建 Runtime、恢复 State、重置或替换当前会话 |
| `transcript-index.ts` | 枚举 transcript、区分会话类别、选择启动恢复的会话 |
| `query-handler.ts` | 启动查询、传输 NDJSON 事件、取消与清理 |
| `tool-permissions.ts` | 等待用户审批、处理响应、超时和断连时结清审批 |
| `presentation.ts` | 历史消息和模型事件的展示格式、隐藏上下文、截断预览 |
| `swe-dataset.ts` | 数据集发现、SWE 实例查找、工作区查询 |
| `swe-prompts.ts` | 调查 / 修复 / 完整任务的提示词 |
| `swe-patch.ts` | 查询当前 SWE 工作区、导出并保存 Git 补丁 |
| `http.ts` | 请求体读取、HTML / JSON / 文本响应、事件流写入 |
| `page.ts` | 页面 HTML 骨架，组装内联样式和脚本 |
| `page-styles.ts` | 页面 CSS |
| `client-script.ts` | 浏览器事件、会话选择、消息与补丁渲染 |
| `types.ts` | Web 会话及 SWE 展示数据的共享契约 |

## 会话归属与清理

当前浏览器会话由 `WebSessionManager.current` 持有。每个查询开始时捕获它的会话引用；之后即使用户切换会话，原查询仍更新原 State 和 transcript。空闲会话在替换时关闭 MCP 连接，正在执行的旧会话在查询结束时关闭连接。

浏览器断开不会自动中止查询，但会拒绝该会话尚未回答的工具审批。主动停止查询通过 AbortController 传递给核心工具执行上下文。审批队列属于 Web 会话，不能放进全局队列或可序列化 State。

页面资源以 TypeScript 字符串保存，构建时随模块输出，无需额外复制静态文件。浏览器脚本中的反斜杠受模板字符串转义影响，修改后应验证实际输出的 JavaScript。

依赖核心 `query`、Runtime / State、MCP、transcript、SWE 工作区和补丁服务。回归入口为 `tests/web-cli.test.ts`；会话持久化另由 `tests/session-transcript.test.ts` 验证。
