import type { z } from "zod";

import type { Runtime } from "../../types/runtime.js";
import type { State } from "../../types/state.js";
import type { Tool, ToolUseContext } from "../types.js";
import {
  DESCRIPTION,
  renderWebFetchPrompt,
  WEB_FETCH_TOOL_NAME,
} from "./prompt.js";
import { inputSchema, outputSchema } from "./type.js";

type WebFetchInput = z.infer<ReturnType<typeof inputSchema>>;
type WebFetchOutput = z.infer<ReturnType<typeof outputSchema>>;

type WebFetchOptions = {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
};

type FetchedBody = {
  text: string;
  bytes: number;
  truncated: boolean;
};

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_TEXT_CHARS = 100_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_SAME_HOST_REDIRECTS = 5;

export class WebFetch
  implements Tool<
    WebFetchInput,
    WebFetchOutput,
    typeof inputSchema,
    typeof outputSchema
  > {
  name = WEB_FETCH_TOOL_NAME;
  inputSchema = inputSchema;
  outputSchema = outputSchema;
  maxResultSizeChars = 100_000;
  searchHint = "fetch and extract content from a URL";
  shouldDefer = true;
  alwaysLoad = true;

  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;

  constructor(options: WebFetchOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  description(): string {
    return DESCRIPTION;
  }

  prompt(): string {
    return renderWebFetchPrompt();
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  formatResult({ output }: { output: WebFetchOutput }): string {
    return [
      `URL: ${output.url}`,
      ...(output.finalUrl !== output.url ? [`Final URL: ${output.finalUrl}`] : []),
      `Status: ${output.code} ${output.codeText}`,
      `Content-Type: ${output.contentType || "(unknown)"}`,
      `Bytes read: ${output.bytes}${output.truncated ? " (truncated)" : ""}`,
      ...(output.note ? [`Note: ${output.note}`] : []),
      "",
      output.text,
    ].join("\n");
  }

  async call(
    input: WebFetchInput,
    context: ToolUseContext,
    _runtime: Runtime,
    _state: State,
  ): Promise<WebFetchOutput> {
    const startedAt = performance.now();
    const startUrl = parseHttpUrl(input.url);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("WebFetch request timed out.")),
      REQUEST_TIMEOUT_MS,
    );
    const abortFromContext = () =>
      controller.abort(context.abortController.signal.reason);
    context.abortController.signal.addEventListener(
      "abort",
      abortFromContext,
      { once: true },
    );

    try {
      const response = await fetchWithSameHostRedirects(
        this.fetchImpl,
        startUrl,
        controller.signal,
      );
      const durationMs = performance.now() - startedAt;

      if (response.type === "cross_host_redirect") {
        const statusText = response.statusText || getRedirectStatusText(
          response.status,
        );
        const text = [
          "REDIRECT DETECTED: The URL redirects to a different host.",
          "",
          `Original URL: ${input.url}`,
          `Redirect URL: ${response.redirectUrl}`,
          `Status: ${response.status} ${statusText}`,
          "",
          "To continue, call WebFetch again with the redirected URL if that destination is appropriate.",
        ].join("\n");

        return {
          url: input.url,
          finalUrl: response.redirectUrl,
          code: response.status,
          codeText: statusText,
          contentType: "",
          bytes: Buffer.byteLength(text, "utf8"),
          text,
          durationMs,
          redirected: true,
          truncated: false,
          note: "Cross-host redirect was not followed automatically.",
        };
      }

      const contentType = response.response.headers.get("content-type") ?? "";
      const code = response.response.status;
      const codeText = response.response.statusText;

      if (!isReadableContentType(contentType)) {
        const text = `Unsupported content-type for WebFetch initial implementation: ${contentType || "(unknown)"}.`;
        return {
          url: input.url,
          finalUrl: response.finalUrl,
          code,
          codeText,
          contentType,
          bytes: 0,
          text,
          durationMs,
          redirected: response.finalUrl !== input.url,
          truncated: false,
          note: "Binary and non-text content persistence will be added later.",
        };
      }

      const body = await readResponseBody(response.response, this.maxBytes);
      const extracted = extractReadableText(body.text, contentType);
      const limited = limitResultText(extracted);

      return {
        url: input.url,
        finalUrl: response.finalUrl,
        code,
        codeText,
        contentType,
        bytes: body.bytes,
        text: limited.text,
        durationMs,
        redirected: response.finalUrl !== input.url,
        truncated: body.truncated || limited.truncated,
        note: "Initial WebFetch version extracted readable text only; the prompt was not applied by a model.",
      };
    } finally {
      clearTimeout(timeout);
      context.abortController.signal.removeEventListener(
        "abort",
        abortFromContext,
      );
    }
  }
}

type FetchRedirectResult =
  | {
    type: "response";
    response: Response;
    finalUrl: string;
  }
  | {
    type: "cross_host_redirect";
    status: number;
    statusText: string;
    redirectUrl: string;
  };

async function fetchWithSameHostRedirects(
  fetchImpl: typeof fetch,
  startUrl: URL,
  signal: AbortSignal,
): Promise<FetchRedirectResult> {
  let current = startUrl;

  for (let redirectCount = 0; redirectCount <= MAX_SAME_HOST_REDIRECTS; redirectCount++) {
    const response = await fetchImpl(current, {
      redirect: "manual",
      signal,
      headers: {
        "Accept": "text/html, text/markdown, text/plain, application/json, application/xml, text/xml;q=0.9, */*;q=0.1",
        "User-Agent": "OpenCat-WebFetch/0.1",
      },
    });

    if (!isRedirectStatus(response.status)) {
      return {
        type: "response",
        response,
        finalUrl: current.toString(),
      };
    }

    const location = response.headers.get("location");
    if (!location) {
      return {
        type: "response",
        response,
        finalUrl: current.toString(),
      };
    }

    const next = new URL(location, current);
    if (next.hostname !== current.hostname) {
      return {
        type: "cross_host_redirect",
        status: response.status,
        statusText: response.statusText,
        redirectUrl: next.toString(),
      };
    }

    current = next;
  }

  throw new Error(`WebFetch exceeded ${MAX_SAME_HOST_REDIRECTS} same-host redirects.`);
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<FetchedBody> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return decodeBody(buffer, maxBytes, buffer.length > maxBytes);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = value ?? new Uint8Array();
    bytes += chunk.byteLength;

    if (bytes > maxBytes) {
      const remaining = Math.max(0, maxBytes - (bytes - chunk.byteLength));
      if (remaining > 0) {
        chunks.push(chunk.slice(0, remaining));
      }
      truncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(chunk);
  }

  return decodeBody(Buffer.concat(chunks), maxBytes, truncated, bytes);
}

function decodeBody(
  buffer: Buffer,
  maxBytes: number,
  truncated: boolean,
  originalBytes = buffer.length,
): FetchedBody {
  const clipped = buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer;

  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(clipped),
    bytes: originalBytes,
    truncated: truncated || buffer.byteLength > maxBytes,
  };
}

function parseHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`WebFetch only supports http and https URLs: ${value}`);
  }

  return url;
}

function isReadableContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("html") ||
    normalized.includes("markdown");
}

function extractReadableText(text: string, contentType: string): string {
  if (!contentType.toLowerCase().includes("html")) {
    return normalizeWhitespace(text);
  }

  return htmlToText(text);
}

function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|main|header|footer|li|ul|ol|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return normalizeWhitespace(decodeHtmlEntities(withoutNoise));
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code))
    );
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function limitResultText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_RESULT_TEXT_CHARS) {
    return { text: value, truncated: false };
  }

  return {
    text: `${value.slice(0, MAX_RESULT_TEXT_CHARS)}\n[... WebFetch content truncated ...]`,
    truncated: true,
  };
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function getRedirectStatusText(status: number): string {
  switch (status) {
    case 301:
      return "Moved Permanently";
    case 302:
      return "Found";
    case 303:
      return "See Other";
    case 307:
      return "Temporary Redirect";
    case 308:
      return "Permanent Redirect";
    default:
      return "Redirect";
  }
}

export default WebFetch;
