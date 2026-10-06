/** 会话文件索引与启动恢复策略，不创建运行时，也不启动 HTTP 服务。 */
import { readdir, stat } from "node:fs/promises";
import { join, parse } from "node:path";
import { getConfigValue } from "../../config/load-config.js";
import { parseSweBenchSessionId } from "../../swe/workspace.js";
import type {
  TranscriptHydrationMode,
  WebCliTranscriptSummary,
  WebCliTranscriptCategory,
} from "./types.js";

export const TRANSCRIPT_DIR = ".opencat/transcripts";

export async function resolveInitialSessionId(cwd: string): Promise<string | undefined> {
  const configured = getConfigValue("session.id")?.trim();
  if (configured) {
    return configured;
  }

  if (getConfigValue("session.resume") === "0" ||
    getConfigValue("session.resume") === "false") {
    return undefined;
  }

  return findLatestMainTranscriptSessionId(cwd);
}

async function findLatestMainTranscriptSessionId(
  cwd: string,
): Promise<string | undefined> {
  return (await listMainTranscriptSessions(cwd))
    .find((item) => !parseSweBenchSessionId(item.sessionId))
    ?.sessionId;
}

export async function listMainTranscriptSessions(
  cwd: string,
): Promise<WebCliTranscriptSummary[]> {
  const directory = join(cwd, TRANSCRIPT_DIR);

  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const path = join(directory, entry.name);
          const fileStat = await stat(path);
          return {
            sessionId: parse(entry.name).name,
            modifiedAt: fileStat.mtimeMs,
            size: fileStat.size,
            category: categorizeTranscriptSessionId(parse(entry.name).name),
          };
        }),
    );

    return candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  } catch {
    return [];
  }
}

function categorizeTranscriptSessionId(sessionId: string): WebCliTranscriptCategory {
  if (sessionId.startsWith("session_swe_serial_")) {
    return "swe_serial";
  }

  if (sessionId.startsWith("session_swe_")) {
    return "swe";
  }

  return "general";
}

export async function hasMainTranscriptSession(
  cwd: string,
  sessionId: string,
): Promise<boolean> {
  return (await listMainTranscriptSessions(cwd))
    .some((item) => item.sessionId === sessionId);
}

export function getTranscriptHydrationMode(): TranscriptHydrationMode {
  return getConfigValue("session.transcriptHydrate") === "full" ? "full" : "auto";
}
