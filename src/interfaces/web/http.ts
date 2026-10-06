/** HTTP 编解码与 NDJSON 写入；不持有会话，也不调用智能体。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatOpenAICompatibleErrorForUser } from "../../openai-compatible/errors.js";
import { renderHtml } from "./page.js";

const MAX_BODY_BYTES = 256 * 1024;

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

export function writeEvent(response: ServerResponse, event: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }

  try {
    response.write(`${JSON.stringify(event)}\n`);
  } catch {
    // The browser may have navigated away. Keep the query running; the
    // transcript remains the source of truth when the session is reopened.
  }
}

export function sendHtml(response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(renderHtml());
}

export function sendJson(
  response: ServerResponse,
  value: unknown,
  statusCode = 200,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

export function sendText(
  response: ServerResponse,
  statusCode: number,
  text: string,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(text);
}

export function stringifyError(error: unknown): string {
  return formatOpenAICompatibleErrorForUser(error);
}
