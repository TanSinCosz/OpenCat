/** 查询收尾：长期记忆提取、工作区补丁存档、完成或失败事件与最终使用量。 */
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import type { MessageId } from "../types/messages.js";
import { emitRunEvent, stringifyTelemetryError } from "../telemetry/observer.js";
import {
  saveWorkspacePatchSnapshot,
  type WorkspacePatchSnapshotReason,
} from "../workspace/patch-snapshot.js";
import {
  extractLongTermMemoryForCompletedQuery,
  type LongTermMemoryExtractionResult,
} from "./long-term-memory.js";
import { snapshotRuntimeUsage } from "./usage.js";
import type { QueryEvent } from "./types.js";

export interface QueryBoundary {
  startMessageId?: MessageId;
  startedAt: number;
}

/** 正常结束后统一收尾；达到轮次上限时不触发完整任务的长期记忆提取。 */
export async function finalizeQuery(
  runtime: Runtime,
  state: State,
  boundary: QueryBoundary,
  reason: "completed" | "max_turns",
): Promise<Extract<QueryEvent, { type: "done" }>> {
  if (reason === "completed") {
    const extraction = await extractLongTermMemoryForCompletedQuery(runtime, state, {
      turnStartMessageId: boundary.startMessageId,
      turnStartedAt: boundary.startedAt,
    });
    await emitLongTermMemoryExtractionEvent(runtime, extraction);
  }
  await recordWorkspacePatchSnapshot(runtime, reason);
  await emitRunEvent(runtime, {
    type: "query_finished",
    reason,
    durationMs: Date.now() - boundary.startedAt,
  });
  return { type: "done", reason, sessionUsage: snapshotRuntimeUsage(runtime) };
}

/** 保存失败时的工作区与遥测；异常由主循环原样抛回调用方。 */
export async function recordQueryFailure(
  runtime: Runtime,
  boundary: QueryBoundary,
  error: unknown,
): Promise<void> {
  await recordWorkspacePatchSnapshot(runtime, "failed");
  await emitRunEvent(runtime, {
    type: "query_failed",
    durationMs: Date.now() - boundary.startedAt,
    error: stringifyTelemetryError(error),
  });
}

async function recordWorkspacePatchSnapshot(
  runtime: Runtime,
  reason: WorkspacePatchSnapshotReason,
): Promise<void> {
  if (runtime.agentRole === "session" || runtime.agentType === "session_memory") {
    return;
  }

  const result = await saveWorkspacePatchSnapshot(runtime, reason);
  if (result.status === "failed") {
    await emitRunEvent(runtime, {
      type: "workspace_patch_snapshot_failed",
      reason,
      error: result.error,
    });
    return;
  }

  if (result.status === "saved") {
    await emitRunEvent(runtime, {
      type: "workspace_patch_snapshot_saved",
      reason,
      patchPath: result.patchPath,
      latestPath: result.latestPath,
      bytes: result.bytes,
      sequence: result.sequence,
    });
  }
}

async function emitLongTermMemoryExtractionEvent(
  runtime: Runtime,
  result: LongTermMemoryExtractionResult,
): Promise<void> {
  await emitRunEvent(runtime, {
    type: "long_term_memory_extracted",
    status: result.status,
    count: result.status === "extracted" ? result.count : undefined,
    source: result.status === "extracted" ? result.source : undefined,
    reason: result.status === "skipped" || result.status === "failed"
      ? result.reason
      : undefined,
  });
}
