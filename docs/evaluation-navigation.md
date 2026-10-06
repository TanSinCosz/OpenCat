# 评测导航

| 要做什么 | 入口 |
| --- | --- |
| 准备 SWE 数据集 | `scripts/prepare-swe-dataset.ts`，`npm run eval:swe:prepare` |
| 串行运行 SWE 评测 | `scripts/eval-swe-serial.ts`，`npm run eval:swe-serial` |
| 启动评测看板、修改页面或 API | `src/eval-dashboard.ts`，`npm run swe`；[看板导航](../src/interfaces/evaluation/README.md) |
| 读取运行记录、计算指标、合并历史结果 | [评测服务导航](../src/evaluation/README.md) |
| 管理缓存仓库和工作区 | `src/swe/workspace.ts` |
| 导出评测表格 | `scripts/export-swe-eval-xlsx.ts`，`npm run eval:swe:export` |
| 在 Web 中手动调查 SWE 实例 | `src/interfaces/web/swe-dataset.ts`、`swe-prompts.ts`、`swe-patch.ts` |
| 验证真实模型缓存或压缩 | `scripts/smoke-*-real.ts`，属于需要外部模型的实验 |

配置从统一 YAML 的 `evaluation` 部分读取。完整数据流和产物说明见 [评测文档](eval.md)。看板入口只组装应用：HTTP 与页面在 `src/interfaces/evaluation/`，数据读取、指标与工作区服务在 `src/evaluation/`。

本地验证运行 `npm run check`、`npm run test:dashboard` 和 `npm run build`。回归测试使用临时产物与本地服务替身，覆盖历史指标回退、数据集展示、会话 / 事件回顾、路由和端口回退。
