import { createMessage, type Message, type MessageSource } from "../types/messages.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import { recordTranscriptStateSnapshot } from "../transcript/persistence.js";

type RuntimeContextMessageOptions = {
  source: Extract<
    MessageSource,
    | "runtime"
    | "agent_notification"
    | "agent_message"
    | "auto_compress"
    | "file_restore"
    | "long_term_memory"
    | "dynamic_skill"
  >;
  content: string;
};

export function createRuntimeContextMessage(
  options: RuntimeContextMessageOptions,
): Message {
  return createMessage({
    role: "user",
    name: "opencat_runtime",
    content: wrapRuntimeContextContent(options.source, options.content),
  }, { source: options.source });
}

export function appendRuntimeContextMessages(
  state: State,
  messages: readonly Message[],
): number {
  if (messages.length === 0) {
    return 0;
  }

  state.runtimeContextMessages.push(...messages);
  return messages.length;
}

/**
 * Loads one-shot runtime events into the request context in one place.
 *
 * Durable conversation messages stay in `state.Messages`; runtime context
 * messages are projected separately so they can be ordered after compression
 * without pretending to be direct user turns.
 */
export async function loadRuntimeContextForQuery(
  runtime: Runtime,
  state: State,
): Promise<number> {
  let loaded = 0;

  if (runtime.agentRole === "main") {
    loaded += appendRuntimeContextMessages(
      state,
      drainAgentNotifications(state),
    );
  }

  if (loaded > 0) {
    await recordTranscriptStateSnapshot(runtime, state, "runtime_context");
  }

  return loaded;
}

export async function clearRuntimeContextAfterModelRequest(
  runtime: Runtime,
  state: State,
): Promise<number> {
  const cleared = state.runtimeContextMessages.length;
  if (cleared === 0) {
    return 0;
  }

  state.runtimeContextMessages = [];
  await recordTranscriptStateSnapshot(runtime, state, "runtime_context");
  return cleared;
}

function drainAgentNotifications(state: State): Message[] {
  const notifications = state.agentNotifications.splice(0);

  return notifications.map((notification) =>
    createRuntimeContextMessage({
      source: "agent_notification",
      content: notification.message,
    })
  );
}

function wrapRuntimeContextContent(
  source: RuntimeContextMessageOptions["source"],
  content: string,
): string {
  const tagName = source.replaceAll("_", "-");

  return [
    `<runtime-context source="${source}">`,
    `<${tagName}>`,
    content,
    `</${tagName}>`,
    `</runtime-context>`,
  ].join("\n");
}
