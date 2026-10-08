import { parseObject } from "@paperclipai/adapter-utils/server-utils";

const CRITICAL_HEADERS = new Set(["authorization", "content-type", "accept", "idempotency-key", "x-hermes-session-key"]);
const HERMES_DASHBOARD_API_PATHS = new Set(["", "/", "/chat"]);

export function normalizeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    url.pathname = url.port === "9119" && HERMES_DASHBOARD_API_PATHS.has(normalizedPath)
      ? "/api" : url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export function parseHeaders(value: unknown): Record<string, string> {
  const source = typeof value === "string" && value.trim().length > 0
    ? (() => { try { return JSON.parse(value); } catch { return {}; } })() : value;
  const parsed = parseObject(source);
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    const normalized = key.trim();
    if (!normalized || CRITICAL_HEADERS.has(normalized.toLowerCase())) continue;
    if (typeof entry === "string") headers[normalized] = entry;
  }
  return headers;
}

export function buildHeaders(input: {
  apiKey: string;
  sessionKey: string | null;
  runId: string;
  extraHeaders: Record<string, string>;
  accept: string;
  contentType?: string;
}): Record<string, string> {
  return {
    ...input.extraHeaders,
    Authorization: `Bearer ${input.apiKey}`,
    Accept: input.accept,
    ...(input.contentType ? { "Content-Type": input.contentType } : {}),
    "Idempotency-Key": input.runId,
    ...(input.sessionKey ? { "X-Hermes-Session-Key": input.sessionKey } : {}),
  };
}
