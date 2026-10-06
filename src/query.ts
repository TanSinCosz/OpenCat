/**
 * 一次用户查询的主循环。这里只编排阶段，具体策略在 query/ 下按职责组织。
 * 阅读路线：准备上下文 → 模型响应 → 工具结果 → 回合摘要 → 查询收尾。
 */
import { withAppConfig } from "./config/load-config.js";
import type { Runtime } from "./types/runtime.js";
import type { State } from "./types/state.js";
import { emitRunEvent } from "./telemetry/observer.js";
import type { QueryEvent, QueryOptions } from "./query/types.js";
import { prepareMessagesForTurn } from "./query/turn-context.js";
import { sampleAssistantTurn } from "./query/assistant-turn.js";
import { executeToolCallsForTurn } from "./query/tool-execution.js";
import { clearTemporaryCommandAllowRules } from "./query/tool-permissions.js";
import { updateSessionMemoryAtSafeBoundary } from "./query/session-memory-update.js";
import { finalizeQuery, recordQueryFailure, type QueryBoundary } from "./query/lifecycle.js";

export type {
  MessagesForQuery,
  QueryEvent,
  QueryOptions,
} from "./query/types.js";
export { buildMessagesForQuery } from "./query/messages.js";
export { createStreamRequest } from "./query/request.js";
export { applyAutoCompression } from "./auto-compress/index.js";
export {
  appendRuntimeContextMessages,
  clearRuntimeContextAfterModelRequest,
  createRuntimeContextMessage,
  loadRuntimeContextForQuery,
} from "./query/runtime-context.js";

export async function* query(
  runtime: Runtime,
  state: State,
  options: QueryOptions = {},
): AsyncGenerator<QueryEvent, void, void> {
  // async generator 会在每次 next() 时恢复执行，因此每一步和 return() 都需进入所属配置作用域。
  const iterator = runQueryLoop(runtime, state, options);
  try {
    while (true) {
      const result = await withAppConfig(runtime.appConfig, () => iterator.next());
      if (result.done === true) return;
      yield result.value;
    }
  } finally {
    await withAppConfig(runtime.appConfig, () => iterator.return());
  }
}

/** 内部编排入口；正常调用方使用 query()，以获得逐步恢复的配置作用域。 */
async function* runQueryLoop(
  runtime: Runtime,
  state: State,
  options: QueryOptions = {},
): AsyncGenerator<QueryEvent, void, void> {
  clearTemporaryCommandAllowRules(runtime);
  const maxTurns = options.maxTurns ?? 100;
  // 这个边界属于整次用户查询，而不是某一轮模型请求；记忆提取据此选择增量消息。
  const boundary: QueryBoundary = {
    startMessageId: state.Messages.at(-1)?.id,
    startedAt: Date.now(),
  };
  await emitRunEvent(runtime, {
    type: "query_started",
    maxTurns,
    stateMessageCount: state.Messages.length,
  });

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      runtime.toolUseContext.abortController.signal.throwIfAborted();

      const context = await prepareMessagesForTurn(runtime, state, options, turn);
      yield {
        type: "context_ready",
        systemPrompt: context.systemPrompt,
        messages: context.messages,
        stats: context.stats,
      };

      const assistant = yield* sampleAssistantTurn(runtime, state, context, turn);
      const toolCalls = assistant.message.tool_calls ?? [];
      const hasToolUse = toolCalls.length > 0;
      const toolResults = yield* executeToolCallsForTurn(
        runtime, state, options, turn, toolCalls,
      );
      await emitRunEvent(runtime, { type: "turn_finished", turn, hasToolUse });
      yield { type: "turn_end", turn, hasToolUse };

      // 只在整组工具结果写入后更新摘要，避免摘要包含未配对的工具调用。
      await updateSessionMemoryAtSafeBoundary(runtime, state, [
        ...context.forkContextMessages,
        assistant.persistedMessage,
        ...toolResults,
      ]);

      if (!hasToolUse) {
        yield await finalizeQuery(runtime, state, boundary, "completed");
        return;
      }
    }

    yield await finalizeQuery(runtime, state, boundary, "max_turns");
  } catch (error) {
    await recordQueryFailure(runtime, boundary, error);
    throw error;
  } finally {
    // 正常结束、异常和调用方提前关闭迭代器，都不能把本次命令授权带到下一次查询。
    clearTemporaryCommandAllowRules(runtime);
  }
}
