export const AGENT_TOOL_NAME = 'Agent'
export const DESCRIPTION =
  "Launch a specialized subagent for complex, multi-step work.";

export function renderAgentPrompt(agentLines: readonly string[]): string {
  const availableAgents = agentLines.length
    ? agentLines.join("\n")
    : "- general-purpose: General-purpose agent for research and multi-step tasks.";

  return `Launch a new agent to handle complex, multi-step tasks autonomously.

Available agent types:
${availableAgents}

Usage notes:
- Use Agent when a task benefits from separate context, independent research, planning, or verification.
- Always include a short description summarizing what the agent will do.
- Use subagent_type to select a specialized agent. If omitted, general-purpose is used.
- execution_mode controls how the agent runs:
  - sync: run the agent now and wait for its result.
  - async: launch the agent in the background and return an agentId plus output file path.
  - fork: inherit the parent conversation context and run the directive in that context.
- run_in_background is supported as an alias for execution_mode: async.
- For async agents, use SendMessage with the returned agentId when you need to queue follow-up instructions while the agent is still running.
- Fork mode should be used when the child needs the parent's context but its detailed tool output should stay out of the parent conversation.
- Set isolation: "worktree" when an agent may edit files independently. This runs it in a temporary git worktree. If it makes changes, the worktree path is returned; if it makes no changes, the worktree is cleaned up.`;
}
// 启动全新智能代理，自主处理多步骤复杂任务。
// 可用代理类型：
// ${availableAgents}
// 使用说明：
// 若任务需要独立上下文、单独调研、方案规划或结果核验，应选用智能代理。
// 必须附带简短描述，概括该代理的执行内容。
// 通过 subagent_type 指定专用代理类型；若省略该参数，则默认使用通用型代理。
// execution_mode 用于控制代理运行模式：
// 同步模式：立即运行代理并等待返回结果。
// 异步模式：后台启动代理，返回代理编号与输出文件路径。
// 分支模式：继承父会话上下文，并在该上下文内执行指令。
// run_in_background 为 execution_mode 异步模式的等效别名。
// 异步代理运行期间，若需追加后续指令，可使用返回的代理编号调用消息发送接口。
// 当子代理需要沿用父会话上下文，但详细工具输出无需展示在父会话中时，应选用分支模式。
// 若代理存在独立编辑文件的需求，需将隔离模式设置为 "worktree"。该模式会在临时 Git 工作区中运行代理；若代理产生文件修改，将返回该工作区路径；若无任何修改，则自动清理临时工作区。
