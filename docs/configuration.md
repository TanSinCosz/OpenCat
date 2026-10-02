# 统一 YAML 配置

应用配置的唯一加载入口是 `src/config/load-config.ts` 的 `loadAppConfig()`；
字段、类型校验和通用默认值在 `src/config/schema.ts` 中定义。
CLI、Web、SWE 评测和 smoke 脚本均使用这一入口，不再读取应用环境变量或独立的配置 JSON。

## 开始使用

```bash
mkdir -p .opencat
cp config/example.yaml .opencat/config.yaml
# 编辑 .opencat/config.yaml，填写 model.apiKey
npm run build
npm start
npm run web
```

`.opencat/` 已被 Git 忽略。带真实密钥的 YAML 放在此目录或用户配置目录，
不要填写到受版本控制的示例文件中。

每次启动只选择一个文件，查找顺序为：

1. `--config <path>` 或 `--config=<path>` 指定的 YAML。
2. 启动目录中的 `.opencat/config.yaml`。
3. 用户目录中的 `~/.opencat/config.yaml`。
4. 没有文件时使用内置默认值；调用模型前仍必须提供 API key。

这些文件不会叠加合并。显式指定的文件不存在、YAML 格式错误、字段拼写错误、
数值范围或类型错误都会报错。程序不会自动读取 `.env`。

```bash
npm start -- --config .opencat/config.yaml "解释这个项目"
npm run web -- --config .opencat/config.yaml
npm run eval:swe-serial -- --config .opencat/config.yaml
npm run eval:swe:prepare -- --config .opencat/config.yaml
```

配置在启动时解析为快照；修改 YAML 后重启程序。Web 切换会话和子 Agent 切换到
任务 worktree 时沿用同一快照，不会从 worktree 再加载另一份配置。

## 分组与职责

| 分组 | 控制的内容 |
| --- | --- |
| `model` 或 `profiles` + `activeProfile` | 主模型的 provider、API key、baseUrl、输出预算和请求 headers |
| `memory` | 文件记忆开关、自动注入/提取、目录、用户标识和 Dream；embedding/llm/vectorStore 用于旧向量记忆接口 |
| `compression` | AutoCompress、History Snip、工具结果压缩和 recent-tail 阈值 |
| `reasoning` | 输出截断后的续写次数和输出预算 |
| `session` | Web 默认会话、是否恢复、transcript 恢复模式 |
| `web` | Web 端口和评测页面使用的聊天地址 |
| `tools` | ripgrep 路径和 WebSearch 独立模型/凭据/URL |
| `workspace` | patch 存储目录、SWE worktree 与 repo cache 根目录 |
| `mcp` | stdio/http 服务器、认证、headers 及子进程 env |
| `evaluation` | 页面端口、数据目录、serial/verified 评测参数 |
| `experiments` | 真实 API smoke 脚本的预算、间隔、运行标识 |

完整可编辑示例见 [config/example.yaml](../config/example.yaml)。布尔值必须写成
`true` / `false`，数值必须写成 YAML 数字；字符串形式的 `"false"` 或 `"180000"` 会报错。

模型支持命名 profile，使用 `activeProfile` 或 `--profile <name>` 选择；
`model` 与 `profiles` 不能同时出现。详见 [模型配置](model-config.md)。

## 路径规则

`--config` 的相对路径以启动目录为基准。YAML 中的资源路径保留各模块的工作目录语义：
记忆目录、向量数据库、MCP server.cwd、patchSnapshotDir 相对于运行时 cwd；
Web/Eval 的数据目录、SWE 工作区与 repo cache 路径相对于宿主工作目录。
跨 worktree 共用的资源建议使用绝对路径。未指定文件记忆目录时，仍使用用户级、按项目隔离的默认目录。

## 迁移旧设置

| 旧设置 | 新 YAML 字段 |
| --- | --- |
| `DEEPSEEK_API_KEY` / `ARK_API_KEY` / `OPENAI_API_KEY` | 选中的 `model.apiKey` / `profiles.<name>.apiKey` |
| `OPENCAT_MODEL` 等模型覆盖 | `model.model` / `profiles.<name>.model` |
| `OPENCAT_CONFIG_PATH` | 启动参数 `--config` |
| `OPENCAT_MODEL_PROFILE` | `activeProfile` 或 `--profile` |
| `OPENCAT_AUTO_COMPRESS_TRIGGER_TOKENS` | `compression.autoCompressTriggerTokens` |
| `OPENCAT_FILE_MEMORY_DIR` | `memory.directory` |
| `OPENCAT_WEB_PORT` | `web.port` |
| `.opencat/mcp.json` | `mcp.stdio` / `mcp.http` |
| SWE 的 `config.json` 与 `SWE_SERIAL_*` / `SWE_VERIFIED_*` | `evaluation.serial` / `evaluation.verified` |

旧环境变量不再覆盖 YAML，旧 `apiKeyEnv` / `apiKeyEnvVar` 字段也不再支持。
MCP 原来的 `mcpServers` 字典改成 `stdio` 列表，每项加上 `name`。
评测脚本的 `--config` 现在指定整份应用 YAML，而不是评测专用 JSON。
仪表盘和 Web SWE 会话使用 `evaluation.active` 选择 serial 或 verified 参数。
数据集、transcript、summary 和遥测仍是 JSON/JSONL 数据文件，它们不是应用配置。
Python 数据导出辅助程序由评测入口从 YAML 读取设置后通过参数调用，不再读取 `SWE_VERIFIED_*` 环境变量。
数据集准备命令（包括保留的 lite/baseline 命令别名）使用 `evaluation.active` 选中的参数，
Python 路径由该分组的 `python` 指定；不再写死 Windows 路径。
XLSX 的配置页显示当前选中的 YAML 参数，并标明它不是历史 run 的配置快照，且不导出密钥。

操作系统提供的 Shell、PATH、Windows 安装目录，以及子进程环境继承仍保留。
MCP 服务器需要的特定变量可以在 YAML 的 `mcp.stdio[].env` 中明确设置。

## 在代码中接入

```ts
const config = loadAppConfig({ configPath: "local.yaml" });
const runtime = createRuntime({
  appConfig: config,
  modelRuntimeConfig: config.model,
  MemoryConfig: createMemoryConfig({ config }),
});
```

`getAppConfig()` 返回当前应用/运行作用域的配置；`loadConfig()` 暂时作为只返回模型配置的兼容接口保留。
新字段先加入 schema，再从对应分组读取。`getConfigValue("compression.historySnipTargetTokens")`
是已有压缩和脚本逻辑的标量适配器，字段名是 YAML 路径。
显式运行配置通过 `Runtime.appConfig` 传递；query 和消息投影在该配置作用域中运行，
并行会话与子 Agent 不会互相覆盖设置。程序化 Runtime 仍允许显式传入依赖和测试覆盖项。
