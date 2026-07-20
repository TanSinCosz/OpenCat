# MCP 协议详解

## 一、MCP 是什么

**MCP（Model Context Protocol）** 是 Anthropic 于 2024 年底发布的一个开放协议，解决了一个核心问题：**LLM 如何安全、标准化地调用外部工具和数据源？**

### 1.1 为什么需要 MCP

在 MCP 出现之前，每个 AI 应用都要自己写工具集成代码——OpenCat 的 Read/Write/Edit/Bash 都是手写的。如果想让 AI 调用 GitHub API、查询数据库、操作文件系统，你需要为每个服务单独实现适配层。

MCP 做的事就是**标准化这个适配层**：定义一套 JSON-RPC 2.0 消息格式，让工具提供方（MCP Server）和工具消费方（AI 应用，MCP Client）用同一种语言对话。

```
传统方式：                       MCP 方式：
                     
AI 应用                           AI 应用
  ├─ Read (手写)                    └─ MCP Client (通用)
  ├─ Write (手写)                       │
  ├─ Bash (手写)                   ┌────┴────┐
  ├─ GitHub API (手写适配)         ▼         ▼
  └─ Database (手写适配)      MCP Server A  MCP Server B
                               (codegraph)   (GitHub)
```

### 1.2 MCP 的核心概念

| 概念                   | 说明                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP Server**   | 工具提供方。它可以是一个子进程（stdio）或 HTTP 服务。暴露`tools`、`resources`、`prompts` 等能力。                                       |
| **MCP Client**   | 工具消费方。连接到一个或多个 Server，获取工具列表，调用工具。                                                                                 |
| **Transport**    | 传输层。MCP 支持两种：**stdio**（子进程 stdin/stdout）和 **Streamable HTTP**（2025-03-26 引入，替代了旧的 HTTP+SSE 双端点模式）。 |
| **JSON-RPC 2.0** | MCP 的消息编码协议。所有请求、响应、通知都遵循此格式。                                                                                        |
| **Tool**         | MCP Server 暴露的函数。有`name`、`description`、`inputSchema`（JSON Schema）。                                                          |
| **Capability**   | 能力声明。Server 在握手时告知 Client："我支持 tools、resources、prompts 等"。                                                                 |

MCP 还定义了 `resources`（只读数据源，如文件内容、数据库查询）和 `prompts`（预置提示词模板），但目前 OpenCat 只用了 `tools`。

---

## 二、JSON-RPC 2.0 — MCP 的消息基石

MCP 的所有通信都以 **JSON-RPC 2.0** 格式编码。理解 MCP，必须先从 JSON-RPC 2.0 入手。

### 2.1 JSON-RPC 2.0 是什么

> JSON-RPC 2.0 是一个轻量级的远程过程调用（RPC）协议，用 JSON 作为数据格式。它**不依赖传输层**——可以跑在 HTTP、WebSocket、stdlib pipe 或任何能传字符串的通道上。

它只定义了 4 种消息类型：

### 2.2 四种消息类型

#### （1）Request（请求）— 带 id，期望回复

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

| 字段        | 必填 | 说明                                           |
| ----------- | ---- | ---------------------------------------------- |
| `jsonrpc` | ✅   | 固定为`"2.0"`                                |
| `id`      | ✅   | 请求 ID（数字或字符串），用于匹配响应          |
| `method`  | ✅   | 要调用的方法名，点号分隔（如`"tools/call"`） |
| `params`  | ❌   | 方法参数，可以是数组或对象                     |

#### （2）Response（成功响应）— 带 id，含 result

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      { "name": "codegraph_explore", "description": "..." }
    ]
  }
}
```

| 字段       | 说明                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| `result` | 方法的返回值。**result 和 error 互斥**——成功响应只有 result，错误响应只有 error。 |

#### （3）Error Response（错误响应）— 带 id，含 error

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": {
    "code": -32601,
    "message": "Method not found",
    "data": "The method 'tools/delete' does not exist"
  }
}
```

| 字段              | 说明                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `error.code`    | 整数错误码（标准码：-32700 解析错误、-32601 方法不存在、-32602 参数无效、-32603 内部错误） |
| `error.message` | 简短错误描述                                                                               |
| `error.data`    | （可选）附加信息，可以是任意类型                                                           |

#### （4）Notification（通知）— **无 id**，不期望回复

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

关键区别：**没有 `id` 字段**。服务端收到通知后不回复——它是单向的。

### 2.3 核心规则

| 规则                           | 说明                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| **id 匹配**              | 响应的`id` 必须等于请求的 `id`。Client 用 `id` 来把响应对应到发出请求的 Promise。 |
| **无 id = 通知**         | 没有`id` 字段的消息就是通知，服务端不回复。                                           |
| **result 与 error 互斥** | 有效响应必须包含`result`（成功）或 `error`（失败），不能同时存在，也不能都不存在。  |
| **传输无关**             | JSON-RPC 2.0 不关心底层传输——可以走 HTTP POST、WebSocket、stdio pipe 或消息队列。     |

### 2.4 为什么 MCP 选择 JSON-RPC 2.0

1. **极简** — 四种消息类型，规格只有一页纸。比 gRPC/OpenAPI 简单一个数量级。
2. **传输无关** — 同样一套消息格式，可以在 HTTP 和 stdio 之间无缝切换。
3. **双向** — 在 stdio 这种双向通道上，Client 和 Server 可以随时互发 request/notification。
4. **有状态** — 带 `id` 的 Request-Response 天然支持异步匹配，适合并发场景。

### 2.5 重要：JSON-RPC 2.0 和 MCP 的关系

**JSON-RPC 2.0 只定义消息格式，MCP 定义应用层语义。** 这是一个关键区分——两者不是同一个东西：

| 层                     | 谁定义的      | 管什么                                                                                                                                | 不管什么                                          |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **JSON-RPC 2.0** | JSON-RPC 规范 | 消息必须带`jsonrpc:"2.0"`、`id` 用来匹配请求和响应、`result` 和 `error` 互斥                                                  | 有什么 method、按什么顺序调、有没有初始化步骤     |
| **MCP**          | MCP 规范      | 定义`initialize`/`tools/list`/`tools/call` 等具体方法、`initialize`→`initialized` 的调用顺序、`protocolVersion` 协商格式 | 消息用什么格式编码（这件事完全交给 JSON-RPC 2.0） |

**类比**：JSON-RPC 2.0 相当于 HTTP（只管请求-响应的传输格式），MCP 相当于 REST API（在 HTTP 之上定义了 `/users`、`/orders` 等具体端点和业务规则）。JSON-RPC 2.0 甚至不知道 "初始化" 这个概念的存在——`initialize` → `notifications/initialized` 的状态栅栏完全是 MCP 协议自己的设计。

---

## 三、MCP 连接生命周期（完整五步）

MCP 的连接生命周期是**严格顺序的**——每步必须完成才能进入下一步。以下是两个传输层共用的流程。

### 步骤 1：建立传输通道

| 传输            | 建立方式                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------- |
| **stdio** | `spawn("node", ["server.js"])` — 创建子进程，获得 `child.stdin` 和 `child.stdout` |
| **HTTP**  | 无持久连接。每个请求都是独立的`POST`，通过 `mcp-session-id` header 维持会话          |

```
Client                                    Server
  │                                          │
  ├── spawn("server") ──────────────────────▶│  进程启动
  │                                          │
  │  stdin / stdout pipe 已建立              │  传输通道就绪
```

### 步骤 2：Client 发送 `initialize` 请求

这是**强制性的第一步 JSON-RPC** 交互：

```json
// Client → Server
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": {
      "name": "opencat-typescript",
      "version": "0.1.0"
    }
  }
}
```

| 参数                | 说明                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `protocolVersion` | Client 支持的 MCP 协议版本。Server 若不兼容应拒绝连接。                                                             |
| `capabilities`    | **Client 的能力声明**。告诉 Server "我能理解哪些概念"。OpenCat 当前传空 `{}`，表示只使用最基础的 MCP 功能。 |
| `clientInfo`      | 客户端标识信息，用于日志和调试。                                                                                    |

Server 返回：

```json
// Server → Client
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "tools": { "listChanged": true }
    },
    "serverInfo": {
      "name": "codegraph",
      "version": "1.0.0"
    }
  }
}
```

| 返回字段            | 说明                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `protocolVersion` | Server 确认使用的版本。双方协商一致后才能继续。                                                                                  |
| `capabilities`    | **Server 的能力声明**。`"tools": {}` 表示支持工具调用，`"tools": {"listChanged": true}` 表示工具列表变化时会主动通知。 |
| `serverInfo`      | 服务端标识信息。                                                                                                                 |

### 步骤 3：Client 发送 `notifications/initialized` 通知

```json
// Client → Server
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

这是一个**通知**（无 `id`），意思是"我准备好了，可以开始正常通信了"。

> **为什么需要这一步？** 在 `initialize` 完成之后、`initialized` 通知之前，Server 处于"半初始化"状态——不应该处理任何非初始化请求。这是协议层面的状态栅栏。

### 步骤 4：Client 调用 `tools/list` 获取工具列表

```json
// Client → Server
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}
```

Server 返回：

```json
// Server → Client
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "codegraph_explore",
        "description": "Explore code structure...",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": { "type": "string", "description": "..." },
            "maxFiles": { "type": "number" }
          },
          "required": ["query"]
        }
      }
    ]
  }
}
```

Client 拿到 `inputSchema` 后，将每个 MCP 工具转换为自己的 Tool 接口，注入到工具列表中和内置工具平级。

### 步骤 5：正常运行时

连接就绪后，Client 可以自由调用 `tools/call`：

```json
// Client → Server
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "codegraph_explore",
    "arguments": { "query": "AuthService login" }
  }
}
```

Server 返回：

```json
// Server → Client
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      { "type": "text", "text": "Found AuthService in src/auth/service.ts..." }
    ]
  }
}
```

### 完整时序图

```
Client                                          Server
  │                                                │
  │─────── initialize ────────────────────────────▶│  步骤 1-2: 握手
  │◀────── { capabilities, serverInfo } ──────────│
  │                                                │
  │─────── notifications/initialized ─────────────▶│  步骤 3: 就绪通知
  │                                                │
  │─────── tools/list ────────────────────────────▶│  步骤 4: 获取工具
  │◀────── { tools: [...] } ──────────────────────│
  │                                                │
  │─────── tools/call ────────────────────────────▶│  步骤 5: 运行时调用
  │◀────── { content: [...] } ────────────────────│
  │                                                │
  │─────── tools/call ────────────────────────────▶│
  │◀────── { content: [...] } ────────────────────│
  │                                                │
  │  ... 更多 tools/call ...                       │
  │                                                │
  │─────── 进程退出 / HTTP 不再请求 ──────────────▶│  关闭
```

---

## 四、两种传输方式深度对比

### 4.0 背景：HTTP+SSE 的废弃与 Streamable HTTP 的诞生

**你可能听说过 MCP 有两种 HTTP 传输方式：旧的 "HTTP+SSE" 和新的 "Streamable HTTP"。前者已在 2025-06-18 被官方废弃。** 理解这两者的区别对于理解 MCP 的 HTTP 传输非常重要。

#### 旧方式：HTTP+SSE（已废弃，2024-11-05 ~ 2025-06-18）

在 MCP 协议的早期版本中，HTTP 传输采用的是 **HTTP + SSE** 模式。这个名称容易让人误解——它的"SSE"不是指"用 SSE 做流式传输"，而是指一种**需要两个端点的架构**：

```
Client                                        Server
  │                                              │
  │────── GET /sse ─────────────────────────────▶│ ← ① 打开一个持久 SSE 连接
  │◀═════════ event-stream (长连接，不关闭) ═════│    客户端在此坐等服务端推送
  │                                              │
  │────── POST /messages?sessionId=xxx ─────────▶│ ← ② 通过另一个端点发请求
  │◀────── 202 Accepted ────────────────────────│    (不能直接在 SSE 连接上发)
  │                                              │
  │◀═════ SSE event: {"jsonrpc":"2.0","id":1...} │ ← ③ 响应从 SSE 通道推送回来
```

**两个端点**：

- `GET /sse` — 建立持久 SSE 连接，用于**接收**服务端推送的响应
- `POST /messages` — 发送 JSON-RPC 请求和通知

**请求的生命周期是这个样子**：客户端 POST 一个请求到 `/messages` 端点，服务端返回 `202 Accepted` 表示"收到了"，然后通过之前建立的 SSE 连接把 JSON-RPC 响应**推送**给客户端。响应不走 HTTP 返回体，走的是旁路 SSE 通道。

#### 为什么被废弃（五大硬伤）

| 问题                                | 具体表现                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **双端点架构复杂**            | 客户端必须同时维护两个连接，状态管理复杂。Server 也要实现两套路由。                                                                 |
| **持久连接不兼容 Serverless** | SSE 要求一个长时间存活的 TCP 连接，AWS Lambda / Cloudflare Workers 等无服务器平台天然无法支持。                                     |
| **认证形同虚设**              | SSE 连接建立时只能认证一次，之后就一直敞着。Token 往往被迫放在 URL Query String（`?token=xyz`）中，暴露在日志和浏览器历史里。     |
| **负载均衡噩梦**              | 持久连接需要"粘性会话"（sticky session）——负载均衡器必须把同一个客户端的所有请求路由到同一台服务器，因为 SSE 连接只在一台机器上。 |
| **不支持二进制**              | SSE 只能传文本，无法传输图片、音频等二进制内容（虽然 MCP 目前不常用，但协议层面限制了扩展性）。                                     |

#### 根因：浏览器的 `EventSource` API 限制

很多人在看旧方案时会问："为什么不能 POST 过去直接返回结果？非得再单独建一个 GET SSE 连接？" 答案不在 MCP 的设计上，而在**浏览器的 API 限制**上。

SSE 在浏览器里只有一个入口：`EventSource`——浏览器内置的 JS API，专门接收 SSE 流：

```javascript
// 你只能这么用：
const es = new EventSource("/sse");
//                  ↑ 固定用法，没有第二个参数让你设 method、headers、body

es.onmessage = (event) => {
  console.log(event.data);
};
```

`EventSource` 的限制是旧 MCP 架构的根因：

| 限制                        | 后果                                           |
| --------------------------- | ---------------------------------------------- |
| **只能用 GET**        | 不能 POST，请求体带不了 JSON-RPC 消息          |
| **不能自定义 header** | `Authorization`、`mcp-session-id` 全传不了 |
| **不能设请求体**      | JSON-RPC 请求消息没地方放                      |

而 2024 年底 MCP 设计者脑子里最典型的客户端是 Claude Desktop（一个浏览器壳应用）。在浏览器里，想发 JSON-RPC 请求**且**能接收服务端推送，只能拆成两条路：

```
路线 A：EventSource GET /sse          ← 专门"听"（因为 EventSource 只能干这个）
路线 B：fetch POST /messages          ← 专门"发"（因为 EventSource 发不了）
```

同样的功能在 Node.js 里：

```javascript
// Node.js 没有 EventSource 限制，一个 POST 全搞定：
const res = await fetch("https://mcp.example.com/mcp", {
  method: "POST",
  headers: { "Authorization": "Bearer xxx", "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", ... })
});
const result = await res.json();
```

这就是为什么 Streamable HTTP 对 Node.js 客户端来说是自然的一步到位——你从来不需要绕 `EventSource` 的弯。旧方案不是技术上做不到单 POST，而是被浏览器 API 逼成了两端点。后来发现 1) 浏览器不是唯一客户端，2) 服务端主动推送几乎没人用——两个假设都错了，Streamable HTTP 把它们纠正了回来。

#### 新方式：Streamable HTTP（2025-03-26 引入，当前推荐）

Streamable HTTP 用一个**统一的端点**替代了旧的两端点架构：

```
Client                                        Server
  │                                              │
  │── POST /mcp ────────────────────────────────▶│ ← 唯一端点，每次请求独立 HTTP POST
  │   Header: Accept: application/json,           │
  │           text/event-stream                   │
  │   Header: Mcp-Session-Id: abc123              │   (可选，首次 initialize 后获得)
  │   Body: {"jsonrpc":"2.0","id":1,...}         │
  │                                              │
  │◀── 响应体（JSON 或 SSE stream）─────────────│ ← 响应在同一 HTTP 返回体中
  │   Content-Type: application/json              │   短结果 → 直接 JSON
  │   或 text/event-stream                       │   长结果 → 可选 SSE 流式返回
```

**核心变化**：

|            | HTTP+SSE（旧，已废弃）                      | Streamable HTTP（新）                                            |
| ---------- | ------------------------------------------- | ---------------------------------------------------------------- |
| 端点数量   | **2 个**（GET /sse + POST /messages） | **1 个**（POST /mcp）                                      |
| 响应通道   | 旁路 SSE 推送                               | 同一 HTTP 返回体                                                 |
| 连接模式   | 持久长连接                                  | 每次请求独立                                                     |
| 认证方式   | 只能握手时认证一次，常被迫走 Query String   | 每次请求带`Authorization` header                               |
| Serverless | ❌ 不兼容                                   | ✅ 天然兼容                                                      |
| 负载均衡   | 需要粘性会话                                | 标准 HTTP 负载均衡                                               |
| 流式响应   | 不支持（SSE 被长连接占用）                  | 可选：`content-type: text/event-stream` 用于单次请求的流式返回 |

#### 本质理解：Streamable HTTP 的 "Streamable" 是什么意思

这里的 **"Streamable"** 不是说 MCP 变成流式协议了，而是说**单次 POST 请求的响应体可以是流式的**：

```
Client POST → Server 开始处理 → Server 先返回中间状态 → 继续处理 → 返回最终结果
             ┌──────────────────── HTTP 返回体（SSE stream）────────────────────┐
             │ data: {"jsonrpc":"2.0","id":1,"result":{"progress":0.3}}         │
             │ data: {"jsonrpc":"2.0","id":1,"result":{"progress":0.7}}         │
             │ data: {"jsonrpc":"2.0","id":1,"result":{"content":[...]}}        │
             └──────────────────────────────────────────────────────────────────┘
```

这和旧的 HTTP+SSE 完全不同：

- 旧的 SSE：一个"永远开着"的推送通道，响应从另一边绕回来
- 新的 Streamable：同一个 HTTP 请求-响应周期内，响应体用了 SSE 格式来流式发送（可选）

如果你不想要流式——直接返回 `application/json` 就完了。Streamable HTTP 本质就是**标准 REST**，只是多了一个"响应体可以是 SSE stream"的选择。

### 4.1 Stdio 传输

**原理**：MCP Server 作为一个**长期运行的子进程**，通过 stdin/stdout 以行分隔 JSON 通信。

```
┌──────────┐          stdin           ┌──────────┐
│  Client  │ ──── JSON-RPC \n ───────▶│  Server  │
│  (父进程) │                           │  (子进程)  │
│          │ ◀─── JSON-RPC \n ────────│          │
└──────────┘          stdout          └──────────┘
```

**每条消息占一行**：`{"jsonrpc":"2.0","id":1,...}\n`。Client 通过 `readline` 逐行解析。

**底层原理：操作系统管道（Pipe）**

Stdio 传输不经过网络协议栈。它是操作系统在两个进程之间创建的一对**内核缓冲区**（pipe）：

```
进程 A（OpenCat）         内核空间         进程 B（MCP Server）
    │                                                  │
    ├─ write("...\n") ──▶ [stdin pipe 缓冲区] ──▶ process.stdin 可读
    │                                                  │
    │               [stdout pipe 缓冲区] ◀── process.stdout.write("...\n")
    │                                                  │
    └─ readline 读到 ◀──  [stdout pipe 缓冲区] ───┘
```

关键特征：

| 特征                 | 说明                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| **传输介质**   | 操作系统内核管理的内存缓冲区，不是网络 Socket                                |
| **延迟**       | 微秒级（纯内存拷贝，不经过网卡、TCP 协议栈）                                 |
| **安全性**     | 操作系统保证——只有当前进程及其直接子进程能访问这根管子，无中间人，无多租户 |
| **不需要认证** | 进程边界就是信任边界                                                         |
| **不需要端口** | pipe 由操作系统文件描述符管理，没有 IP 地址、没有端口号                      |

MCP Server 甚至不需要是一个网络服务——它就是一个普通的命令行程序，从 `stdin` 读 JSON-RPC 请求，往 `stdout` 写 JSON-RPC 响应。这也是为什么 stdio 传输从头到尾没有改动——它的简单性和安全性已经足够好。需要改进的只有 HTTP 传输（从旧 HTTP+SSE 到 Streamable HTTP）。

**请求-响应匹配（Pending Map 模式）**：

这是 stdio 传输最精妙的部分。因为 stdin/stdout 是**全双工异步通道**——Client 可以在收到前一个响应之前就发出下一个请求——所以需要一个机制来把返回的 JSON 和发出的 Promise 匹配起来。

```typescript
// 核心数据结构
private pending = new Map<id, { resolve, reject, timer }>();

// 发送请求时：
request(method, params) {
  const id = this.nextRequestId++;           // 分配唯一 id
  const message = { jsonrpc: "2.0", id, method, params };
  
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {         // 30 秒超时兜底
      this.pending.delete(id);
      reject(new Error("timeout"));
    }, 30_000);
    this.pending.set(id, { resolve, reject, timer });
  });
  
  child.stdin.write(JSON.stringify(message) + "\n");
  return promise;                            // 返回 Promise，异步等待响应
}

// 收到响应时：
handleLine(line) {
  const response = JSON.parse(line);         // 解析一行 JSON
  const pending = this.pending.get(response.id);  // 按 id 查找对应的 Promise
  if (!pending) return;
  
  clearTimeout(pending.timer);
  this.pending.delete(response.id);
  
  if (response.error) {
    pending.reject(new Error(response.error.message));
  } else {
    pending.resolve(response.result);        // resolve → 上游 await 拿到结果
  }
}
```

这个模式的关键优势：

- **支持请求并发**：可以一口气发 5 个请求，响应顺序不影响匹配
- **自动清理**：超时或进程退出时 `rejectAllPending()` 统一清理，不留泄漏
- **单连接复用**：一个子进程处理所有请求，不需要每次新建

### 4.2 Streamable HTTP 传输

**原理**：每个 JSON-RPC 消息是一个独立的 HTTP POST 请求，走同一个端点（`/mcp`）。这是 MCP 当前推荐的 HTTP 传输方式（旧 HTTP+SSE 已于 2025-06-18 废弃，详见 4.0 节）。

**会话管理**：首次 `initialize` 响应返回 `mcp-session-id` header，Client 保存后后续请求全部携带：

```
Client → POST (无 session header) → Server
Client ← Response (Header: mcp-session-id: abc123) ← Server
Client → POST (Header: Mcp-Session-Id: abc123) →  Server  ← 有状态
```

**流式响应（可选）**：当工具调用耗时较长时，Server 可以选择将响应体设为 `text/event-stream`（SSE 格式）来流式返回中间进度。注意这和旧的 HTTP+SSE 完全不同——这里的 SSE 只存在于**单次 HTTP 请求的返回体中**，请求结束即关闭：

```
POST /mcp → Server 处理中
  ← Content-Type: text/event-stream
  ← data: {"jsonrpc":"2.0","id":1,"result":{"progress":0.3}}
  ← data: {"jsonrpc":"2.0","id":1,"result":{"progress":0.7}}
  ← data: {"jsonrpc":"2.0","id":1,"result":{"content":[...]}}
  ← 连接关闭
```

Client 端解析时扫描所有 `data:` 行，找到匹配 `id` 的最终 JSON-RPC 响应。如果不需要流式，Server 直接返回 `application/json` 即可。

### 4.3 全面对比

| 维度                   | Stdio                           | Streamable HTTP                                        |
| ---------------------- | ------------------------------- | ------------------------------------------------------ |
| **协议版本**     | 一直存在，未变                  | 2025-03-26 引入，替代旧 HTTP+SSE                       |
| **连接方式**     | `spawn()` 子进程，长连接      | 每次`fetch()`，短连接                                |
| **请求匹配**     | Pending Map + id 匹配           | `await fetch()` — 请求-响应天然同步                 |
| **并发支持**     | ✅ 可同时发多个请求             | ❌ 每个请求等待上一个完成（HTTP/1.1）                  |
| **超时机制**     | 自建`setTimeout` 30s          | 浏览器/fetch 原生超时                                  |
| **会话**         | 进程即会话（进程存活=会话有效） | `Mcp-Session-Id` header 跨请求                       |
| **认证**         | 无（OS 进程边界=信任边界）      | `Authorization: Bearer` header（每次请求可重新认证） |
| **流式响应**     | ❌ 不支持（JSON 按行发送）      | ✅ 可选 SSE（存在于单次请求返回体中，请求结束即关闭）  |
| **启动成本**     | 高（每次 spawn 新进程）         | 低（HTTP 请求）                                        |
| **生命周期管理** | Client 负责`kill()` 子进程    | 无状态，无需管理                                       |
| **Serverless**   | ❌ 不兼容                       | ✅ 天然兼容                                            |
| **适用场景**     | 本地工具、CLI 工具、单机部署    | 远程服务、微服务、多租户、云部署                       |

### 4.4 如何选择

| 场景                                                    | 推荐                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 本地 CLI 工具、代码分析、文件操作                       | **Stdio** — 零网络开销，OS 进程隔离天然安全                                                                  |
| 远程服务、多用户共享、需要认证、部署在 Serverless / K8s | **Streamable HTTP** — 标准 REST，兼容云原生基础设施                                                          |
| 工具调用耗时较长                                        | **Streamable HTTP + SSE 响应体** — 流式返回中间状态（注意：这是单次请求内的 SSE stream，不是旧的两端点 SSE） |

---

## 五、Tool 的生命周期：从定义到调用

这一节以 OpenCat 的 `McpToolAdapter` 为实例说明 MCP Tool 如何融入 AI 应用。

### 5.1 Step 1：Server 定义 Tool

MCP Server 在代码中定义自己的工具。每个工具包含：

```json
{
  "name": "codegraph_explore",
  "description": "Explore code structure using natural language queries",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "What to explore" },
      "maxFiles": { "type": "number", "default": 12 }
    },
    "required": ["query"]
  }
}
```

### 5.2 Step 2：Client 获取并适配

Client 通过 `tools/list` 拿到工具列表后，需要将其适配为自己的工具接口。OpenCat 用 `McpToolAdapter` 做这个适配：

```typescript
class McpToolAdapter implements Tool {
  name = `${serverName}__${toolName}`;          // 双下划线连接，如 "codegraph__codegraph_explore"
  description = `[MCP:${serverName}] ${originalDescription}`;  // 前缀标记来源
  
  // 用宽松的 Zod schema 来校验（不依赖 MCP Server 的 JSON Schema 格式）
  inputSchema = z.record(z.string(), z.unknown());
  
  // 但给模型看的是 Server 提供的精确 JSON Schema
  inputJsonSchema = originalJsonSchema;
  
  async call(input) {
    return await mcpClient.callTool(originalName, input);
    //    ↑ 最终走到 tools/call JSON-RPC
  }
}
```

**Schema 双轨制**：这是 OpenCat 的一个设计细节——给模型看的是 MCP Server 提供的精确 JSON Schema（用于 function calling 参数生成），但验证用的是宽松的 `z.record(z.string(), z.unknown())`——因为不同 MCP Server 的 JSON Schema 格式可能有差异，严格用 Zod 校验反而容易误杀。真正的参数校验交还给 MCP Server 自己处理。

### 5.3 Step 3：工具合并

MCP 工具和内置工具放在同一个数组里，对 query 循环来说完全平等：

```
内置工具 (14 个) + MCP 工具 (N 个) → 统一 tools[]
                                    → DeepSeek function calling 参数
                                    → 模型选择调用哪个
```

### 5.4 Step 4：调用 → tools/call

当模型选择调用 MCP 工具时，流程和内置工具一模一样：

```
模型输出: { name: "codegraph__codegraph_explore", arguments: { query: "AuthService" } }
         │
         ▼
executor.ts 找到对应 Tool (McpToolAdapter)
         │
         ▼
tool.call({ query: "AuthService" })
         │
         ▼
mcpClient.callTool("codegraph_explore", { query: "AuthService" })
         │
         ▼
发送 JSON-RPC: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "codegraph_explore", arguments: { query: "AuthService" } } }
         │
         ▼
收到响应: { jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "..." }] } }
         │
         ▼
formatResult → 返回给模型
```

### 5.5 关键设计点总结

| 设计                   | 说明                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| **命名空间隔离** | `{serverName}__{toolName}` 格式，避免不同 MCP Server 的工具重名冲突                                      |
| **前缀标识**     | `[MCP:serverName]` 前缀让模型知道这个工具来自外部服务                                                    |
| **Schema 双轨**  | 模型看精确 JSON Schema，校验用宽松 Zod，把精确验证交给 Server                                              |
| **统一执行**     | MCP 工具和内置工具走同一个`executor.ts` 执行管道，享有一致的权限控制、错误处理、formatResult、落盘持久化 |

---

## 六、MCP 协议的优势和局限

### 优势

| 优势                   | 说明                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------- |
| **开放标准**     | 不绑定任何特定 LLM 平台。任何实现了 MCP 的 AI 应用可以连接任何 MCP Server。             |
| **传输灵活性**   | stdio 适用于本地工具，HTTP 适用于远程服务，同一套协议无缝切换。                         |
| **渐进增强**     | 可以先只实现`tools`，后续再添加 `resources`、`prompts`、`sampling` 等高级功能。 |
| **安全边界清晰** | stdio 模式下，进程边界就是信任边界——Server 的权限受限于启动它的用户的权限。           |
| **工具热插拔**   | 理论上 Server 可以运行时通知 Client`tools/list_changed`，Client 动态更新工具列表。    |

### 当前局限（截至 2025 年）

| 局限                               | 说明                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| **Server 实现不多**          | MCP 发布不到一年，可用 Server 数量有限。大多还是 AI 工具开发者自己在写。          |
| **资源/Prompt 功能鲜有人用** | 当前的 MCP 社区几乎只关注`tools`，`resources` 和 `prompts` 的生态还很薄弱。 |
| **Streaming 支持不完善**     | 工具调用的流式输出（渐进式返回结果）尚未标准化，各实现自行处理。                  |
| **无发现机制**               | 没有一个中心化的 MCP Server 注册表，需要手动配置 Server 地址。                    |
| **版本协商简单**             | `initialize` 中的协议版本协商目前只是个字符串比对，不处理向后兼容的复杂逻辑。   |

---

## 七、OpenCat 中的 MCP 实现

### 7.1 文件结构

| 文件                        | 职责                                                                           |
| --------------------------- | ------------------------------------------------------------------------------ |
| `src/mcp/types.ts`        | JSON-RPC 2.0 类型定义（Request/Response/Notification）、Server 配置、Tool 定义 |
| `src/mcp/config.ts`       | 加载`.opencat/mcp.json` 配置、创建连接、工具合并                             |
| `src/mcp/stdio-client.ts` | Stdio 传输：子进程 spawn + Pending Map 请求匹配 + 行分隔 JSON-RPC              |
| `src/mcp/http-client.ts`  | Streamable HTTP 传输：fetch + Session ID + 可选 SSE 响应体解析 + Bearer 认证   |
| `src/mcp/tool-adapter.ts` | `McpToolAdapter`：将 MCP Tool 适配为 OpenCat Tool 接口                       |
| `src/mcp/index.ts`        | 统一导出                                                                       |

### 7.2 配置示例

```jsonc
// .opencat/mcp.json
{
  "mcpServers": {
    // Stdio 本地工具
    "codegraph": {
      "command": "node",
      "args": ["vendor/codegraph/dist/bin/codegraph.js", "serve", "--mcp"],
      "env": { "CODEGRAPH_MCP_TOOLS": "explore,status,files" }
    },
    // HTTP 远程工具
    "remote-service": {
      "url": "https://api.example.com/mcp",
      "auth": { "type": "bearer", "token": "sk-xxx" }
    }
  }
}
```

### 7.3 当前未实现的 MCP 功能

| 功能                                 | 状态 | 说明                                                                                                                          |
| ------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| `notifications/tools/list_changed` | ❌   | MCP 允许 Server 通知 Client 工具变更。Stdio 的`handleLine` 只处理带 `id` 的响应（通知无 `id`），HTTP 无长连接接收推送。 |
| 配置文件热加载                       | ❌   | `.opencat/mcp.json` 只在启动时读取一次。                                                                                    |
| 子进程崩溃重连                       | ❌   | `process.once("exit")` 后 `this.process` 置空，但不自动重新 spawn。                                                       |
| `resources` / `prompts`          | ❌   | OpenCat 当前只消费`tools`。                                                                                                 |
| Streamable HTTP 响应体流式消费       | ❌   | 当前用`response.text()` 一次性读完再解析 SSE 响应体，无法实时展示中间进度。                                                 |

---

← [返回 ARCHITECTURE.md 目录](../ARCHITECTURE.md)
