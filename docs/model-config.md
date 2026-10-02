# 模型配置

模型设置属于统一 YAML 配置的一部分，入口与路径规则见 [统一配置](configuration.md)。

## 单模型

```yaml
model:
  provider: deepseek
  apiKey: ""
  baseUrl: https://api.deepseek.com
  model: deepseek-v4-pro
  maxTokens: 32768
  reasoningEffort: max
```

将真实 API key 写入私有的 `.opencat/config.yaml` 或 `~/.opencat/config.yaml`。
模型参数与密钥都来自 YAML；环境变量和 `apiKeyEnv` 不再生效。

## 命名 profile

```yaml
activeProfile: deepseek

profiles:
  deepseek:
    provider: deepseek
    apiKey: ""
    baseUrl: https://api.deepseek.com
    model: deepseek-v4-pro
    maxTokens: 32768
    reasoningEffort: max
    userId: cache-worker-1
  ark-coding:
    provider: volcengine
    apiKey: ""
    baseUrl: https://ark.cn-beijing.volces.com/api/coding/v3
    model: deepseek-v4-pro
    maxTokens: 32768
    reasoningEffort: high
  custom:
    provider: openai-compatible
    apiKey: ""
    baseUrl: https://gateway.example/v1
    model: custom-model
```

`model` 和 `profiles` 二选一。多个 profile 必须填写 `activeProfile`；
只有一个 profile 时自动选中。单次启动可以指定：

```bash
npm run web -- --config .opencat/config.yaml --profile ark-coding
```

这里的 profile 名称只是本地标签，`provider` 决定请求兼容行为。

| provider | 用途 |
| --- | --- |
| `deepseek` | DeepSeek，支持其 user_id、thinking 和 reasoning 扩展 |
| `volcengine`（别名 `ark`） | 火山引擎 Ark / Coding Plan |
| `openai-compatible` | 其他兼容 Chat Completions 的接口 |

省略 provider 时仍可从 baseUrl 推断。主模型使用 Chat Completions；
Claude 等模型需要兼容该协议的网关，原生 Anthropic Messages 接口不能直接作为主模型接口。

## 字段

| 字段 | 含义 |
| --- | --- |
| `apiKey` | YAML 中的 API key，必需用于实际模型调用 |
| `baseUrl` | API 基地址 |
| `model` | 模型名或 endpoint ID |
| `maxTokens` | 正整数输出 token 预算，默认 32768 |
| `reasoningEffort` | low / medium / high / xhigh / max；DeepSeek 默认 max |
| `userId` | 请求用户标识，DeepSeek 可用于 KV-cache 隔离 |
| `headers` | 静态请求 headers，字符串字典 |

WebSearch 的独立接口配置在 `tools.webSearch`。
旧向量记忆的独立 LLM/embedding 配置在 `memory.llm` 和 `memory.embedding`。
文件记忆的 selector 和自动提取继续使用 Runtime 的主模型客户端。

## Cache usage normalization

DeepSeek 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 与
兼容服务的 `prompt_tokens_details.cached_tokens` 都会归一化后用于遥测和 transcript。
