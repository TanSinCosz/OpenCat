import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSessionMemoryState,
  type SessionMemoryState,
} from "../types/session-memory.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";

const SESSION_MEMORY_STORE_VERSION = 1;
const SESSION_MEMORY_DIR = ".opencat/session-memory";

type PersistedSessionMemory = {
  version: typeof SESSION_MEMORY_STORE_VERSION;
  sessionId: string;
  savedAt: number;
  state: SessionMemoryState;
};

export async function loadPersistedSessionMemory(
  runtime: Runtime,
  state: State,
): Promise<{ loaded: true } | { loaded: false; reason: string }> {
  const current = ensurePersistableSessionMemoryState(state);
  if (current.status === "ready" && current.content.trim() !== "") {
    return { loaded: false, reason: "session_memory_already_loaded" };
  }

  let raw: string;
  try {
    raw = await readFile(getSessionMemoryStatePath(runtime), "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return { loaded: false, reason: "session_memory_file_missing" };
    }

    return { loaded: false, reason: "session_memory_file_read_failed" };
  }

  const persisted = parsePersistedSessionMemory(raw);
  if (!persisted || persisted.sessionId !== runtime.sessionId) {
    return { loaded: false, reason: "session_memory_file_invalid" };
  }

  state.sessionMemory = {
    ...createSessionMemoryState(current.config),
    ...persisted.state,
    config: {
      ...persisted.state.config,
      ...current.config,
    },
  };
  return { loaded: true };
}

export async function savePersistedSessionMemory(
  runtime: Runtime,
  state: State,
): Promise<void> {
  const sessionMemory = ensurePersistableSessionMemoryState(state);
  await mkdir(getSessionMemoryStateDir(runtime), { recursive: true });

  const persisted: PersistedSessionMemory = {
    version: SESSION_MEMORY_STORE_VERSION,
    sessionId: runtime.sessionId,
    savedAt: Date.now(),
    state: sessionMemory,
  };

  await writeFile(
    getSessionMemoryStatePath(runtime),
    `${JSON.stringify(persisted, null, 2)}\n`,
    "utf8",
  );
}

export function getSessionMemoryStatePath(runtime: Runtime): string {
  return join(
    getSessionMemoryStateDir(runtime),
    `${sanitizeSessionId(runtime.sessionId)}.json`,
  );
}

function getSessionMemoryStateDir(runtime: Runtime): string {
  return join(runtime.cwd, SESSION_MEMORY_DIR);
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function ensurePersistableSessionMemoryState(state: State): SessionMemoryState {
  state.sessionMemory ??= createSessionMemoryState();
  state.sessionMemory.status ??= "idle";
  state.sessionMemory.tokensAtLastUpdateAttempt ??= 0;
  state.sessionMemory.tokensAtLastExtraction ??= 0;
  state.sessionMemory.config ??= createSessionMemoryState().config;
  return state.sessionMemory;
}

function parsePersistedSessionMemory(
  raw: string,
): PersistedSessionMemory | null {
  try {
    const value = JSON.parse(raw) as Partial<PersistedSessionMemory>;
    if (
      value.version !== SESSION_MEMORY_STORE_VERSION ||
      typeof value.sessionId !== "string" ||
      typeof value.savedAt !== "number" ||
      !value.state ||
      typeof value.state !== "object"
    ) {
      return null;
    }

    return value as PersistedSessionMemory;
  } catch {
    return null;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === code;
}
