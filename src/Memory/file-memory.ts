import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { Runtime } from "../types/runtime.js";

export const FILE_MEMORY_BASE_DIR = ".opencat/memory";
export const FILE_MEMORY_ENTRYPOINT = "MEMORY.md";
export const FILE_MEMORY_LOGS_DIR = "logs";

export type FileMemoryType = "user" | "feedback" | "project" | "reference";

export type SaveFileMemoryInput = {
  memory: string;
  reason?: string;
  type?: FileMemoryType;
};

export type SaveFileMemoryResult = {
  id: string;
  memory: string;
  metadata: {
    event: "ADD" | "EXISTS";
    path: string;
    entrypointPath: string;
    type: FileMemoryType;
    hash: string;
    reason?: string;
  };
};

export type LoadedFileMemoryEntrypoint = {
  path: string;
  content: string;
};

export type FileMemoryHeader = {
  filename: string;
  path: string;
  name?: string;
  description?: string;
  type?: FileMemoryType;
};

export type LoadedFileMemory = FileMemoryHeader & {
  content: string;
};

const DEFAULT_MEMORY_TYPE: FileMemoryType = "user";
const MAX_SCANNED_MEMORY_FILES = 200;
const ENTRYPOINT_HEADER = [
  "# Long-term memory",
  "",
  "This file is an index. Keep each entry short and put memory details in topic files.",
  "",
].join("\n");

export async function saveFileMemory(
  runtime: Runtime,
  input: SaveFileMemoryInput,
): Promise<{ results: SaveFileMemoryResult[] }> {
  if (!runtime.longTermMemoryConfig.enabled) {
    return { results: [] };
  }

  const memory = input.memory.trim();
  if (!memory) {
    return { results: [] };
  }

  const memoryDir = getFileMemoryDir(runtime);
  await mkdir(memoryDir, { recursive: true });

  const hash = hashMemory(memory);
  const existing = await findMemoryByHash(memoryDir, hash);
  const type = input.type ?? DEFAULT_MEMORY_TYPE;
  const entrypointPath = getFileMemoryEntrypointPath(runtime);

  if (existing) {
    await ensureEntrypointHasLink(entrypointPath, existing, memory);
    return {
      results: [{
        id: basename(existing, ".md"),
        memory,
        metadata: {
          event: "EXISTS",
          path: existing,
          entrypointPath,
          type,
          hash,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      }],
    };
  }

  const filename = `${slugify(memory)}-${hash.slice(0, 8)}.md`;
  const path = join(memoryDir, filename);
  await writeFile(
    path,
    renderMemoryFile({
      name: titleFromMemory(memory),
      description: descriptionFromMemory(memory),
      type,
      memory,
      hash,
      reason: input.reason,
    }),
    "utf8",
  );
  await ensureEntrypointHasLink(entrypointPath, path, memory);

  return {
    results: [{
      id: basename(path, ".md"),
      memory,
      metadata: {
        event: "ADD",
        path,
        entrypointPath,
        type,
        hash,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    }],
  };
}

export async function loadFileMemoryEntrypoint(
  runtime: Runtime,
): Promise<LoadedFileMemoryEntrypoint | null> {
  if (!runtime.longTermMemoryConfig.enabled) {
    return null;
  }

  const path = getFileMemoryEntrypointPath(runtime);
  try {
    const content = (await readFile(path, "utf8")).trim();
    return content ? { path, content } : null;
  } catch {
    return null;
  }
}

export async function scanFileMemoryHeaders(
  runtime: Runtime,
): Promise<FileMemoryHeader[]> {
  if (!runtime.longTermMemoryConfig.enabled) {
    return [];
  }

  const memoryDir = getFileMemoryDir(runtime);
  const files = await listMarkdownMemoryFiles(memoryDir);
  const headers: FileMemoryHeader[] = [];

  for (const path of files.slice(0, MAX_SCANNED_MEMORY_FILES)) {
    try {
      const content = await readFile(path, "utf8");
      const frontmatter = parseFrontmatter(content);
      headers.push({
        filename: relative(memoryDir, path).replace(/\\/g, "/"),
        path,
        name: frontmatter.name,
        description: frontmatter.description,
        type: parseFileMemoryType(frontmatter.type),
      });
    } catch {
      // Ignore unreadable memory files. Memory recall should never block the
      // main request because one old note is malformed.
    }
  }

  return headers;
}

export async function loadFileMemories(
  runtime: Runtime,
  filenames: readonly string[],
): Promise<LoadedFileMemory[]> {
  const memoryDir = getFileMemoryDir(runtime);
  const allowed = new Map(
    (await scanFileMemoryHeaders(runtime)).map((header) => [
      header.filename,
      header,
    ]),
  );
  const loaded: LoadedFileMemory[] = [];

  for (const filename of filenames) {
    const header = allowed.get(filename);
    if (!header) {
      continue;
    }

    try {
      loaded.push({
        ...header,
        content: stripFrontmatter(await readFile(header.path, "utf8")).trim(),
      });
    } catch {
      // Stale index entries and concurrently edited files are harmless.
    }
  }

  void memoryDir;
  return loaded;
}

export function formatFileMemoryManifest(
  headers: readonly FileMemoryHeader[],
): string {
  return headers.map((header) => {
    const type = header.type ? `[${header.type}] ` : "";
    const name = header.name ? `${header.name} - ` : "";
    const description = header.description ?? "";
    return `- ${type}${header.filename}: ${name}${description}`.trimEnd();
  }).join("\n");
}

export function getFileMemoryDir(runtime: Runtime): string {
  const configured = runtime.longTermMemoryConfig.fileMemoryDirectory;
  if (configured) {
    return resolveMemoryDirectory(configured, runtime.cwd);
  }

  return join(
    homedir(),
    FILE_MEMORY_BASE_DIR,
    "projects",
    createProjectMemoryKey(runtime.cwd),
  );
}

export function getFileMemoryEntrypointPath(runtime: Runtime): string {
  return join(getFileMemoryDir(runtime), FILE_MEMORY_ENTRYPOINT);
}

export function getFileMemoryLogsDir(runtime: Runtime): string {
  return join(getFileMemoryDir(runtime), FILE_MEMORY_LOGS_DIR);
}

async function ensureEntrypointHasLink(
  entrypointPath: string,
  memoryPath: string,
  memory: string,
): Promise<void> {
  const entrypointDir = dirname(entrypointPath);
  await mkdir(entrypointDir, { recursive: true });

  let content = "";
  try {
    content = await readFile(entrypointPath, "utf8");
  } catch {
    content = ENTRYPOINT_HEADER;
  }

  if (!content.trim()) {
    content = ENTRYPOINT_HEADER;
  }

  const link = relative(entrypointDir, memoryPath).replace(/\\/g, "/");
  if (content.includes(`](${link})`)) {
    return;
  }

  const line = `- [${titleFromMemory(memory)}](${link}) - ${
    descriptionFromMemory(memory)
  }`;
  const next = `${content.trimEnd()}\n${line}\n`;
  await writeFile(entrypointPath, next, "utf8");
}

async function findMemoryByHash(
  memoryDir: string,
  hash: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(memoryDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry === FILE_MEMORY_ENTRYPOINT || !entry.endsWith(".md")) {
      continue;
    }

    const path = join(memoryDir, entry);
    try {
      const content = await readFile(path, "utf8");
      if (content.includes(`hash: ${hash}`)) {
        return path;
      }
    } catch {
      // Ignore unreadable memory files; the next save will still succeed.
    }
  }

  return null;
}

async function listMarkdownMemoryFiles(memoryDir: string): Promise<string[]> {
  const result: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === FILE_MEMORY_LOGS_DIR) {
          continue;
        }
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== FILE_MEMORY_ENTRYPOINT) {
        result.push(path);
      }
    }
  }

  await visit(memoryDir);
  return result.sort();
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    result[key] = parseYamlScalar(rawValue);
  }

  return result;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function parseYamlScalar(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }

  return value;
}

function parseFileMemoryType(value: string | undefined): FileMemoryType | undefined {
  return value === "user" ||
      value === "feedback" ||
      value === "project" ||
      value === "reference"
    ? value
    : undefined;
}

function renderMemoryFile(input: {
  name: string;
  description: string;
  type: FileMemoryType;
  memory: string;
  hash: string;
  reason?: string;
}): string {
  return [
    "---",
    `name: ${yamlScalar(input.name)}`,
    `description: ${yamlScalar(input.description)}`,
    `type: ${input.type}`,
    `hash: ${input.hash}`,
    input.reason ? `reason: ${yamlScalar(input.reason)}` : undefined,
    "---",
    "",
    input.memory,
    "",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function hashMemory(memory: string): string {
  return createHash("sha256").update(memory).digest("hex");
}

function resolveMemoryDirectory(path: string, cwd: string): string {
  const expanded = path === "~" || path.startsWith("~/") || path.startsWith("~\\")
    ? join(homedir(), path.slice(2))
    : path;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function createProjectMemoryKey(cwd: string): string {
  const absolute = resolve(cwd);
  const slug = absolute
    .replace(/^[A-Za-z]:/, (drive) => drive.slice(0, 1))
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project";
  return `${slug}-${hashMemory(absolute).slice(0, 8)}`;
}

function slugify(value: string): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return ascii || "memory";
}

function titleFromMemory(memory: string): string {
  return truncateOneLine(memory, 64);
}

function descriptionFromMemory(memory: string): string {
  return truncateOneLine(memory, 150);
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, " "));
}
