# 模型适配

把 OpenCat 的模型请求转换成兼容 OpenAI 的 API 调用。主循环只依赖本模块的客户端契约，不应直接处理供应商的 HTTP 和 SSE 细节。

| 文件 | 职责 |
| --- | --- |
| `model-client.ts` | 创建客户端、模型调用接口 |
| `transport.ts` | HTTP 请求与流式传输 |
| `provider.ts` | 供应商判断、基础 URL 等差异 |
| `types.ts` | 请求、消息、流式事件的契约 |
| `content.ts` | 文本与多模态消息内容处理 |
| `errors.ts` | 错误识别、面向用户的错误说明 |

调用方为 `query/request.ts` 与相关流式收集模块。模型选项由 `config/` 与 `types/config.ts` 解析。测试入口为 `tests/openai-compatible-provider.test.ts`、`tests/openai-compatible-errors.test.ts` 和 `tests/reasoning-content.test.ts`；配置见 [模型配置](../../docs/model-config.md)。
