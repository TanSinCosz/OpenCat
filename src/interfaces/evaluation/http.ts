/** 看板 HTTP 编解码；返回非对象请求体时沿用空对象语义。 */
import type * as http from "node:http";
import type { JsonRecord } from "../../evaluation/types.js";
import { isRecord } from "../../evaluation/records.js";

export function sendHtml(response: http.ServerResponse, html: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

export function sendJson(
  response: http.ServerResponse,
  value: unknown,
  statusCode = 200,
): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

export function sendText(
  response: http.ServerResponse,
  statusCode: number,
  text: string,
): void {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}

export async function readJsonBody(request: http.IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1024) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return isRecord(parsed) ? parsed : {};
}
