# 交互入口

这里只放协议适配和页面交互。应用入口初始化配置，界面模块组装依赖，核心服务负责业务规则。

| 界面 | 启动入口 | 阅读导航 | 核心依赖 |
| --- | --- | --- | --- |
| Web Chat | `../web-cli.ts` | [Web 导航](web/README.md) | Query、会话、工具、SWE 工作区 |
| SWE 评测看板 | `../eval-dashboard.ts` | [看板导航](evaluation/README.md) | [评测服务](../evaluation/README.md) |

界面依赖核心服务，核心服务不依赖界面。两个应用各自持有会话或服务实例，避免通过模块顶层变量共享应用状态。
