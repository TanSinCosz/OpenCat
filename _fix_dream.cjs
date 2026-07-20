const fs = require('fs');
const path = 'C:/Users/Administrator/Desktop/opencat-typescirpt/docs/long-term-memory.md';
let content = fs.readFileSync(path, 'utf8');

const startMarker = '### 8.6 Dream Prompts';
const endMarker = '#### 8.6.3 锁机制';

const start = content.indexOf(startMarker);
const end = content.indexOf(endMarker);

if (start >= 0 && end >= 0) {
  const replacement = `#### 8.6.2 Dream Prompt

\`buildMemoryDreamPrompt()\` 产出的 prompt（中文译版）：

> # Dream：记忆合并
>
> 你现在执行一次手动 dream：对 OpenCat 基于文件的长期记忆进行一次反思。将最近记录的
> 记忆信号合成为持久、组织良好的 topic 记忆，让后续会话能快速定位。
>
> 记忆目录：\`memoryDir\` / 日志目录：\`logsDir\` / transcript 目录：\`transcriptDir\`
> 索引文件：\`MEMORY.md\` / 当前日期：\`YYYY-MM-DD\`
>
> 可用 Read、Grep、Glob 查看记忆文件。只能对记忆目录内进行 Edit/Write。编辑前先读取已有文件。
>
> ## 已有记忆清单
> \`formatFileMemoryManifest 输出\` 或 \`"(未找到 topic 记忆文件。)"\`
>
> ## 最近会话 transcript
> \`formatMemoryDreamTranscriptManifest 输出\` 或 \`"(未找到近期的 transcript 文件。)"\`
>
> ## Phase 1 — 定位
> - 查看记忆目录，读取 MEMORY.md（如存在）
> - 浏览已有 topic 文件，确保更新而非创建近似重复
> - 如果 logs/ 存在，查看最近的日志条目（日志是原始信号，非正式记忆）
>
> ## Phase 2 — 收集近期信号
> 寻找值得持久化的新信息。来源优先级：
> 1. \`logs/YYYY/MM/YYYY-MM-DD.md\`（如存在）
> 2. 已有记忆是否偏离、与较新事实矛盾、或需要清理
> 3. 上述近期 transcript 文件（仅在日志和 topic 文件不足以提供上下文时）
>
> - 寻找后续对话中有参考价值的用户偏好、反馈、项目上下文、外部引用
> - 不要逐行通读 transcript JSONL 文件——用精确关键词搜索，只细读匹配区域
> - 不要从 transcript 中保留临时任务进度，除非揭示了持久偏好或项目规则
>
> ## Phase 3 — 合并
> - 在记忆目录顶层写入或更新 topic 记忆文件
> - frontmatter 格式：
>   \`\`\`
>   ---
>   name: {记忆名称}
>   description: {用于后续相关性判断的一行描述}
>   type: user | feedback | project | reference
>   ---
>   {记忆正文}
>   \`\`\`
> - 将新信号合并到已有 topic 文件，不创建近似重复
> - 尽可能将相对日期转为绝对日期
> - 如记忆过时、错误或已被替代，修正或移除
> - feedback/project 类记忆应可执行：来源提供了 Why/How 时一并记录
>
> ## 不应该保存的内容
> - 代码结构、文件路径、架构事实、项目约定
> - Git 历史、最近变更、当前任务进度和计划
> - Debug 方案（属于代码、测试或文档）
> - 项目文件中已有记录的内容（除非用户将其设为跨会话偏好）
>
> ## Phase 4 — 清理与索引
> - 仅更新 MEMORY.md 为简洁的索引
> - 每条索引一行：\`- [Title](file.md) — 一行摘要\`
> - 从不将完整记忆正文放入索引
> - 移除指向过时、错误、已删除或被替代记忆的指针
> - 保持索引简短、对相关性选择有价值
>
> 返回合并、更新、清理的简要概述，或说明为何没有变更。

`;

  content = content.slice(0, start) + replacement + content.slice(end);
  fs.writeFileSync(path, content);
  console.log('Done. New length:', content.length);
} else {
  console.log('Markers not found. start:', start, 'end:', end);
}
