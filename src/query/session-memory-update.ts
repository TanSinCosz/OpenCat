/** 回合结束后的会话摘要更新；同一个 State 的更新排队执行，避免重叠请求竞争摘要游标。 */
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import type { Message } from "../types/messages.js";
import {
  shouldUpdateSessionMemory,
  updateSessionMemoryForAutoCompress,
  type SessionMemoryUpdateResult,
} from "../session-memory/index.js";
import { emitRunEvent } from "../telemetry/observer.js";

const sessionMemoryUpdateQueues = new WeakMap<State, Promise<void>>();

export async function updateSessionMemoryAtSafeBoundary(
  runtime: Runtime,
  state: State,
  forkContextMessages: readonly Message[],
): Promise<SessionMemoryUpdateResult> {
  if (!canRuntimeUpdateSessionMemory(runtime)) {
    return { status: "skipped", reason: "unsupported_runtime" };
  }

  // 同一 State 的更新先排队；前一次完成后再检查阈值，使用已经推进的摘要游标。
  const previous = sessionMemoryUpdateQueues.get(state) ?? Promise.resolve();
  const update = previous.then(() =>
    performSessionMemoryUpdateAtSafeBoundary(
      runtime,
      state,
      forkContextMessages,
    )
  );
  const queueTail = update.then(
    () => undefined,
    () => undefined,
  );
  sessionMemoryUpdateQueues.set(state, queueTail);
  void queueTail.then(() => {
    if (sessionMemoryUpdateQueues.get(state) === queueTail) {
      sessionMemoryUpdateQueues.delete(state);
    }
  });

  return update;
}

async function performSessionMemoryUpdateAtSafeBoundary(
  runtime: Runtime,
  state: State,
  forkContextMessages: readonly Message[],
): Promise<SessionMemoryUpdateResult> {
  const decision = shouldUpdateSessionMemory(state);
  if (decision.update === false) {
    await emitRunEvent(runtime, {
      type: "session_memory_update_finished",
      status: "skipped",
      reason: decision.reason,
      messageCount: state.Messages.length,
    });
    return { status: "skipped", reason: decision.reason };
  }

  await emitRunEvent(runtime, {
    type: "session_memory_update_started",
    messageCount: state.Messages.length,
  });
  const result = await updateSessionMemoryForAutoCompress(runtime, state, {
    forkContextMessages,
  });

  await emitRunEvent(runtime, {
    type: "session_memory_update_finished",
    status: result.status,
    reason: result.status === "skipped" ? result.reason : undefined,
    messageCount: state.Messages.length,
    contentChars: result.status === "updated" ? result.content.length : undefined,
    lastSummarizedMessageId: state.sessionMemory.lastSummarizedMessageId,
  });

  if (result.status === "skipped" && result.reason === "model_request_failed") {
    await emitRunEvent(runtime, {
      type: "session_memory_update_failed",
      error: state.sessionMemory.lastFailureReason ?? result.reason,
    });
  }

  return result;
}

function canRuntimeUpdateSessionMemory(runtime: Runtime): boolean {
  return runtime.agentRole === "main" && runtime.agentType !== "session_memory";
}
