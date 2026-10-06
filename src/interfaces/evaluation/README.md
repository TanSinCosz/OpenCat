# SWE 评测看板界面

启动入口为 `../../eval-dashboard.ts`，只负责初始化配置、确定项目根目录和启动看板。看板业务服务在 `../../evaluation/`。

| 文件 | 职责 |
| --- | --- |
| `options.ts` | 解析本次看板的根目录、端口和 Web Chat URL |
| `server.ts` | 组装服务与路由，监听端口，处理端口被占用时的回退 |
| `routes.ts` | HTTP 路由、输入提取、调用评测服务、输出响应 |
| `http.ts` | JSON 请求体与 HTML / JSON / 文本响应 |
| `page.ts` | HTML 骨架，组装样式和浏览器脚本 |
| `page-styles.ts` | 看板 CSS |
| `client-script.ts` | 浏览器事件、运行选择、指标与会话展示、仓库准备交互 |

## 配置和依赖方向

`options.ts` 接收项目根目录和 AppConfig。YAML 的 `evaluation.directory` 优先于 `--dataset`；没有显式选择时，保留 Verified、Lite 和 Lite Baseline 三个默认根目录。项目根目录以启动入口的位置推导，避免拆分后错误地从 `interfaces/evaluation/` 定位数据。

`server.ts` → `routes.ts` → `evaluation/service.ts`。路由只处理协议，不直接操作文件、Git 或 Python。导入模块本身不会启动服务。

默认端口被占用时，保留原有向后尝试最多 20 个端口的行为。页面资源仍内联输出并随 TypeScript 构建，无需单独复制静态文件。脚本保存在模板字符串中，修改反斜杠或插值后需要检查实际生成的 JavaScript。

先读 `routes.ts` 了解 API；修改指标逻辑读 [评测服务导航](../../evaluation/README.md)；修改展示读页面文件。回归入口为 `tests/evaluation-dashboard.test.ts`，运行 `npm run test:dashboard`。
