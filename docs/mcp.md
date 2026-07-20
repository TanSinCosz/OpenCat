# MCP 协议支持

## 四、==MCP== 协议支持（Model Context Protocol）

==MCP== 允许 OpenCat 连接外部工具服务器，将外部工具动态注入到智能体的工具列表中。涉及文件：

| 文件                        | 职责                                                       |
| --------------------------- | ---------------------------------------------------------- |
| `src/mcp/types.ts`        | JSON-RPC 2.0 类型定义、服务器配置、工具定义                |
| `src/mcp/config.ts`       | 配置加载（`.opencat/mcp.json`）、连接创建、工具合并      |
| `src/mcp/stdio-client.ts` | Stdio 传输：子进程 + 行分隔 JSON-RPC                       |
| `src/mcp/http-client.ts`  | HTTP 传输：fetch + 会话管理 + SSE                          |
| `src/mcp/tool-adapter.ts` | `McpToolAdapter`：将 ==MCP== 工具伪装成 OpenCat Tool |
| `src/mcp/index.ts`        | 统一导出                                                   |

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

| 维度     | Stdio                | HTTP                        |
| -------- | -------------------- | --------------------------- |
| 连接方式 | `spawn()` 子进程   | HTTP POST (`fetch`)       |
| 请求匹配 | pending Map + ID     | await fetch（天然同步）     |
| 超时     | setTimeout 30s       | fetch 自带                  |
| 会话     | 无状态（进程即会话） | `mcp-session-id` header   |
| 认证     | 无（OS 信任边界）    | Bearer token                |
| 流式响应 | 不支持               | SSE (`text/event-stream`) |
| 连接模式 | 长连接（一个进程）   | 每次请求独立                |

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

### 4.5 ==MCP== 工具适配器（==Mcp==ToolAdapter）

将 ==MCP== 工具伪装成 OpenCat 的 `Tool` 接口，与内置工具完全平等：

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

- **模型侧**：使用 ==MCP== 服务器提供的原始 JSON Schema（`inputJsonSchema`），原封不动传给 DeepSeek 的 function calling
- **验证侧**：使用宽松的 `z.record(z.string(), z.unknown())`，因为 ==MCP== 服务器的 schema 格式可能不完全兼容 Zod，实际验证交还给服务器

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

`createToolsWithConfiguredMcp()` 将 ==MCP== 工具与内置工具合并：

```
内置工具 (14 个) + MCP 工具 (动态数量) → 统一 tools 数组
```

### 4.7 当前未实现的部分

| 待实现                               | 说明                                                                                                                                                           | 影响                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `notifications/tools/list_changed` | ==MCP== 协议允许服务端通知客户端工具列表变更，但 Stdio 客户端的`handleLine` 只处理带 `id` 的响应（通知无 `id`，被丢弃），HTTP 客户端无长连接接收推送 | 工具列表只在连接时获取一次，运行时不变 |
| `.opencat/mcp.json` 热加载         | 配置文件只在启动时读取一次                                                                                                                                     | 运行时修改配置不生效                   |
| 子进程崩溃自动重连                   | `process.once("exit")` 后将 `this.process` 设为 `undefined`，但不自动重新 spawn                                                                          | 崩溃后下次请求直接报错                 |
| 服务端能力检查                       | `initialize` 返回值中的 `capabilities` 被丢弃                                                                                                              | 当前无影响（只用 tools），未来需补     |
| HTTP SSE 实时流式消费                | 当前使用`response.text()` 一次性读完再解析                                                                                                                   | 无法实时展示长时间工具调用的中间进度   |
| Stdio stderr 处理                    | 子进程 stderr 被静默忽略                                                                                                                                       | 调试困难                               |

---

---

← [返回 ARCHITECTURE.md 目录](../ARCHITECTURE.md)
