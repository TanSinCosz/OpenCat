import type { Runtime } from "../types/runtime.js";
import type { EvaluationEvent, TelemetryAgentFields } from "./events.js";

export type EvaluationEventInput = EvaluationEvent extends infer Event
  ? Event extends EvaluationEvent
    ? Omit<Event, keyof TelemetryAgentFields>
    : never
  : never;

type RuntimeEventFields = {
  timestamp: number;
  sessionId: string;
  agentId: string;
  agentRole: Runtime["agentRole"];
  parentAgentId?: Runtime["parentAgentId"];
  agentType?: Runtime["agentType"];
};

export interface RunObserver {
  emit(event: EvaluationEvent): void | Promise<void>;
}

export async function emitRunEvent(
  runtime: Runtime,
  event: EvaluationEventInput,
): Promise<void> {
  if (!runtime.observer) {
    return;
  }

  await runtime.observer.emit({
    ...event,
    timestamp: Date.now(),
    sessionId: runtime.sessionId,
    agentId: runtime.agentId,
    agentRole: runtime.agentRole,
    parentAgentId: runtime.parentAgentId,
    agentType: runtime.agentType,
  } as EvaluationEvent);
}

export function stringifyTelemetryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
