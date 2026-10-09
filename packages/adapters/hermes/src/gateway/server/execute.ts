import { createHash } from "node:crypto";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  selectPaperclipPromptSections,
  isPaperclipRecoveryWakePayload,
  stringifyPaperclipWakePayload,
  paperclipWakeCommentsArePromptOwned,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ADAPTER_TYPE,
  DEFAULT_EVENT_RECONNECT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_SEC,
  STOP_GRACE_MS,
} from "../shared/constants.js";
import {
  allowsInsecureRemoteHttp,
  isLoopbackHostname,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";
import { bindSessionKey, requireWorkspaceCapability, resolveWorkspaceBinding, type WorkspaceBinding } from "./execution-context.js";
import { admitOwnedRun, waitForOwnedRun } from "./run-lifetime.js";
import { executionCheckpoint, lineageStopSettled, settleOwnedAdmission } from "./recovery.js";
import { requireManagedMcpCapability, resolveManagedMcp, type ManagedMcpManifest } from "./managed-mcp.js";
import { selectExecutor } from "./executor-selection.js";
import { buildHeaders, normalizeBaseUrl, parseHeaders } from "./http-config.js";
export { buildHeaders, normalizeBaseUrl, parseHeaders } from "./http-config.js";

type SessionKeyStrategy = "issue" | "agent" | "run" | "none";

type SseFrame = {
  event: string | null;
  data: string;
  id?: string;
};

type HermesHttpError = Error & {
  status?: number;
  code?: string;
  retryNotBefore?: string | null;
  body?: unknown;
  transportCause?: unknown;
};

type TerminalState = {
  runId: string;
  status: string;
  eventName?: string | null;
  payload?: Record<string, unknown> | null;
  output?: string | null;
};

type ExecutionState = {
  runId: string;
  rootRunId: string;
  lineage: Set<string>;
  cursors: Map<string, number>;
  eventDigests: Map<string, Map<number, string>>;
  protocolError: Error | null;
  stopping: boolean;
  activeEvents: number;
  outputChunks: string[];
  lastEventName: string | null;
  terminal: TerminalState | null;
  resolveTerminal: (state: TerminalState) => void;
  terminalPromise: Promise<TerminalState>;
};

type TextRedactor = (value: string) => string;

const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(auth|authorization|token|secret|password|api[_-]?key|private[_-]?key)([_-]|$)/i;
const BEARER_TOKEN_PATTERN = /Bearer\s+\S+/gi;
const HERMES_SESSION_KEY_HEADER_PATTERN = /(X-Hermes-Session-Key\s*[:=]\s*)([^\s,;]+)/gi;
const PAPERCLIP_SESSION_KEY_PATTERN =
  /\bpaperclip:(?:company:[A-Za-z0-9-]+:agent:[A-Za-z0-9-]+(?::(?:issue|run):[A-Za-z0-9-]+)?|run:[A-Za-z0-9-]+)\b/gi;

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "stopped",
  "interrupted",
]);

const FAILURE_STATUSES = new Set(["failed", "error"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "stopped", "interrupted"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeSessionKeyStrategy(value: unknown): SessionKeyStrategy {
  const raw = asString(value, "issue").trim().toLowerCase();
  if (raw === "agent" || raw === "run" || raw === "none") return raw;
  return "issue";
}

function apiUrl(baseUrl: URL, path: string): string {
  const base = baseUrl.toString().replace(/\/+$/, "");
  return `${base}${path}`;
}

function issueIdFromContext(ctx: AdapterExecutionContext): string | null {
  return nonEmpty(ctx.context.taskId) ?? nonEmpty(ctx.context.issueId);
}

export function resolveSessionKey(input: {
  strategy: SessionKeyStrategy;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
}): string | null {
  if (input.strategy === "none") return null;
  if (input.strategy === "agent") {
    return `paperclip:company:${input.companyId}:agent:${input.agentId}`;
  }
  if (input.strategy === "run") {
    return `paperclip:run:${input.runId}`;
  }
  const issuePart = input.issueId ? `issue:${input.issueId}` : `run:${input.runId}`;
  return `paperclip:company:${input.companyId}:agent:${input.agentId}:${issuePart}`;
}

function stringifyForLog(value: unknown, maxChars = 4_000): string {
  const text = JSON.stringify(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function sanitizeSensitiveText(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(HERMES_SESSION_KEY_HEADER_PATTERN, "$1[redacted]")
    .replace(PAPERCLIP_SESSION_KEY_PATTERN, "[redacted-session-key]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createTextRedactor(secrets: Array<string | null | undefined>): TextRedactor {
  const exactSecrets = [...new Set(secrets.filter((secret): secret is string => typeof secret === "string" && secret.length >= 4))]
    .sort((a, b) => b.length - a.length)
    .map((secret) => ({
      secret,
      regex: new RegExp(escapeRegExp(secret), "g"),
    }));

  return (value: string) => {
    let result = sanitizeSensitiveText(value);
    for (const entry of exactSecrets) {
      result = result.replace(entry.regex, `[redacted len=${entry.secret.length}]`);
    }
    return result;
  };
}

function redactForLog(value: unknown, keyPath: string[] = [], depth = 0, redactText: TextRedactor = sanitizeSensitiveText): unknown {
  const key = keyPath[keyPath.length - 1] ?? "";
  if (typeof value === "string") {
    if (SENSITIVE_KEY_PATTERN.test(key)) return `[redacted len=${value.length}]`;
    const sanitized = redactText(value);
    return sanitized.length > 500
      ? `${sanitized.slice(0, 500)}... [truncated ${sanitized.length - 500} chars]`
      : sanitized;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth > 5) return "[array-truncated]";
    return value.slice(0, 40).map((entry, index) => redactForLog(entry, [...keyPath, String(index)], depth + 1, redactText));
  }
  if (typeof value === "object") {
    if (depth > 5) return "[object-truncated]";
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      out[entryKey] = redactForLog(entryValue, [...keyPath, entryKey], depth + 1, redactText);
    }
    return out;
  }
  return redactText(String(value));
}

function buildInput(ctx: AdapterExecutionContext, paperclipApiUrl: string | null): string {
  // Stable session keys (issue/agent strategy) resume the same remote Hermes
  // conversation across runs; a stored session id from a prior run means that
  // conversation already received the task brief, so pick the compact
  // task-context variant under the shared resume rules.
  const sessionKeyStrategy = normalizeSessionKeyStrategy(ctx.config.sessionKeyStrategy);
  const resumedSession =
    (sessionKeyStrategy === "issue" || sessionKeyStrategy === "agent") &&
    Boolean(nonEmpty(ctx.runtime?.sessionId));
  const { taskContextNote: taskMarkdown, wakePrompt } = selectPaperclipPromptSections(ctx.context, {
    resumedSession,
    // Hermes gateway owns the execution contract below; retain the old
    // gateway prompt shape and avoid adding a second contract on resume.
    includeExecutionContract: false,
  });
  const wakePayloadJson = paperclipWakeCommentsArePromptOwned(ctx.context)
    ? null
    : stringifyPaperclipWakePayload(ctx.context.paperclipWake, {
        omitIssueDescription: Boolean(taskMarkdown),
      });
  const sessionHandoff = nonEmpty(ctx.context.paperclipSessionHandoffMarkdown);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(ctx.context);
  const lines = [
    `You are ${ctx.agent.name}, an AI agent employee in a Paperclip-managed company.`,
    "",
    "Paperclip runtime identity:",
    `- Agent ID: ${ctx.agent.id}`,
    `- Company ID: ${ctx.agent.companyId}`,
    `- Run ID: ${ctx.runId}`,
    ...(paperclipApiUrl ? [`- Paperclip API URL: ${paperclipApiUrl}`] : []),
    ...(issueWorkMode ? [`- Issue work mode: ${issueWorkMode}`] : []),
    "",
    ...(ctx.context.conversationMode === true || isPaperclipRecoveryWakePayload(ctx.context.paperclipWake)
      ? []
      : [
          "Execution contract:",
          "- Take concrete action in this run when the task is actionable.",
          "- Do not stop at a plan unless the issue asks for planning only.",
          "- Leave durable progress and update the issue to a clear final disposition.",
          "- Use X-Paperclip-Run-Id on mutating Paperclip API requests when a Paperclip API key is available.",
          "",
        ]),
    wakePrompt,
    ...(sessionHandoff ? ["", sessionHandoff] : []),
    ...(taskMarkdown ? ["", taskMarkdown] : []),
    ...(wakePayloadJson
      ? [
          "",
          "Structured wake payload JSON:",
          "```json",
          wakePayloadJson,
          "```",
        ]
      : []),
  ];
  return lines.filter((line) => line !== null && line !== undefined).join("\n").trim();
}

function buildRunBody(ctx: AdapterExecutionContext, sessionKey: string | null): Record<string, unknown> {
  const paperclipApiUrl = nonEmpty(ctx.config.paperclipApiUrl);
  const payloadTemplate = parseObject(ctx.config.payloadTemplate);
  const configuredInput = nonEmpty(payloadTemplate.input);
  const input = configuredInput && ctx.context.conversationMode === true
    ? `${configuredInput}\n\n${buildInput(ctx, paperclipApiUrl)}`
    : configuredInput ?? buildInput(ctx, paperclipApiUrl);
  const instructions =
    nonEmpty(ctx.config.instructions) ??
    nonEmpty(payloadTemplate.instructions) ??
    "Follow the Paperclip wake instructions exactly. Do not expose secrets in logs, comments, or final output.";
  return {
    ...payloadTemplate,
    input,
    instructions,
    ...(sessionKey ? { session_id: sessionKey } : {}),
  };
}

async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function classifyHttpError(status: number): { code: string; family: AdapterExecutionResult["errorFamily"] | null } {
  if (status === 401 || status === 403) return { code: "hermes_gateway_auth_failed", family: null };
  if (status === 404) return { code: "hermes_gateway_runs_unsupported", family: null };
  if (status === 429) return { code: "hermes_gateway_rate_limited", family: "transient_upstream" };
  if (status >= 500) return { code: "hermes_gateway_upstream_error", family: "transient_upstream" };
  return { code: "hermes_gateway_protocol_error", family: null };
}

function fetchFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
  if (!cause || typeof cause !== "object") return message;

  const causeRecord = cause as { code?: unknown; message?: unknown };
  const causeMessage = typeof causeRecord.message === "string" ? causeRecord.message : "";
  const causeCode = typeof causeRecord.code === "string" ? causeRecord.code : "";
  if (!causeMessage || causeMessage === message) return causeCode ? `${message} (${causeCode})` : message;
  return causeCode ? `${message} (${causeCode}: ${causeMessage})` : `${message} (${causeMessage})`;
}

async function fetchJson(input: RequestInfo | URL, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (err) {
    const fetchErr = new Error(`Hermes gateway request failed: ${fetchFailureMessage(err)}`) as HermesHttpError;
    fetchErr.code = "hermes_gateway_connect_failed";
    fetchErr.transportCause = err instanceof Error ? err.cause : undefined;
    throw fetchErr;
  }
  const body = await readResponseJson(response);
  if (!response.ok) {
    const classified = classifyHttpError(response.status);
    const err = new Error(`Hermes gateway HTTP ${response.status}`) as HermesHttpError;
    err.status = response.status;
    err.code = classified.code;
    err.retryNotBefore = response.headers.get("retry-after");
    err.body = body;
    throw err;
  }
  return body;
}

function extractRunId(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.run_id) ?? nonEmpty(record?.runId) ?? nonEmpty(record?.id);
}

function eventNameFromData(data: unknown, fallback: string | null): string | null {
  const record = asRecord(data);
  return nonEmpty(record?.event) ?? nonEmpty(record?.type) ?? fallback;
}

function parseJsonData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return { text: data };
  }
}

export function parseSseFramesForTest(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames: SseFrame[] = [];
  let offset = 0;
  while (true) {
    const idx = normalized.indexOf("\n\n", offset);
    if (idx < 0) break;
    const rawFrame = normalized.slice(offset, idx);
    offset = idx + 2;
    let event: string | null = null;
    let id: string | undefined;
    const dataLines: string[] = [];
    for (const line of rawFrame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      } else if (line.startsWith("id:")) {
        id = line.slice("id:".length).trim();
      }
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n"), ...(id === undefined ? {} : { id }) });
  }
  return { frames, rest: normalized.slice(offset) };
}

function createExecutionState(runId: string): ExecutionState {
  let resolveTerminal!: (state: TerminalState) => void;
  const terminalPromise = new Promise<TerminalState>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    runId,
    rootRunId: runId,
    lineage: new Set([runId]),
    cursors: new Map(),
    eventDigests: new Map(),
    protocolError: null,
    stopping: false,
    activeEvents: 0,
    outputChunks: [],
    lastEventName: null,
    terminal: null,
    resolveTerminal,
    terminalPromise,
  };
}

function markTerminal(state: ExecutionState, terminal: TerminalState): void {
  if (state.terminal) return;
  state.terminal = terminal;
  state.resolveTerminal(terminal);
}

function extractStatus(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.status)?.toLowerCase() ?? null;
}

function extractOutput(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const direct =
    nonEmpty(record.output) ??
    nonEmpty(record.result) ??
    nonEmpty(record.text) ??
    nonEmpty(record.summary) ??
    nonEmpty(record.message);
  if (direct) return direct;
  const nested = asRecord(record.data) ?? asRecord(record.payload);
  return nested ? extractOutput(nested) : null;
}

function terminalReceiptForRun(runId: string, value: unknown, fallbackEventName: string | null = null): TerminalState | null {
  const record = asRecord(value);
  if (!record) return null;
  const receiptRunId = extractRunId(record);
  if (receiptRunId && receiptRunId !== runId) return null;
  const eventName = eventNameFromData(record, fallbackEventName);
  // A child or tool's terminal status does not settle the parent run. Receipts
  // without an explicit identity are scoped by the parent HTTP/SSE endpoint.
  if (eventName && !eventName.startsWith("run.")) return null;
  const status = extractStatus(record) ?? (eventName?.startsWith("run.") ? eventName.slice(4) : null);
  if (!status || (!TERMINAL_STATUSES.has(status) && status !== "unrecoverable")) return null;
  if (record.lineage_settled === false) return null;
  return { runId, status, eventName, payload: record, output: extractOutput(record) };
}

async function observeRun(ctx: AdapterExecutionContext, state: ExecutionState, runId: string, value: unknown, fallback: string | null = null): Promise<void> {
  const record = asRecord(value);
  if (state.runId !== runId || state.protocolError || !record || (extractRunId(record) && extractRunId(record) !== runId)) return;
  const eventName = eventNameFromData(record, fallback);
  if (eventName && !eventName.startsWith("run.")) return;
  const status = extractStatus(record) ?? eventName?.replace(/^run\./, "");
  if (status === "superseded") {
    const successor = nonEmpty(record.successor_run_id);
    if (!successor) return; // Poll the parent until its durable reservation is visible.
    if (state.lineage.has(successor)) throw protocolError("Hermes recovery lineage contains a cycle");
    state.runId = successor;
    state.lineage.add(successor);
    await persistProgress(ctx, state);
    return;
  }
  if (state.stopping || (fallback === null && state.activeEvents > 0)) return;
  const terminal = terminalReceiptForRun(runId, value, fallback);
  if (terminal) markTerminal(state, terminal);
}

async function persistProgress(ctx: AdapterExecutionContext, state: ExecutionState): Promise<void> {
  try {
    await ctx.onExecutionProgress?.({ version: 1, rootRunId: state.rootRunId, runId: state.runId,
      lineage: [...state.lineage], cursors: Object.fromEntries(state.cursors) });
  } catch {
    throw protocolError("Host refused the Hermes execution progress receipt");
  }
}

function protocolError(message: string): Error {
  return Object.assign(new Error(message), { code: "hermes_gateway_protocol_error" });
}

// Persist only a digest of the complete wire payload. Display redaction is lossy
// and cannot distinguish conflicting replays beyond its truncation boundary.
function eventDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    const record = asRecord(item);
    return record ? Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])])) : item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

async function handleEvent(
  ctx: AdapterExecutionContext,
  state: ExecutionState,
  runId: string,
  frame: SseFrame,
  redactText: TextRedactor = sanitizeSensitiveText,
): Promise<void> {
  const parsed = parseJsonData(frame.data);
  const record = asRecord(parsed);
  const eventName = eventNameFromData(parsed, frame.event);
  if (state.runId !== runId || state.protocolError || (extractRunId(record) && extractRunId(record) !== runId)) return;
  const sequence = Number(frame.id ?? record?.sequence);
  const sequenced = Number.isSafeInteger(sequence) && sequence > 0;
  if ((frame.id !== undefined || record?.sequence !== undefined) && !sequenced) throw protocolError("Invalid Hermes event sequence");
  if (frame.id !== undefined && record?.sequence !== undefined && Number(frame.id) !== Number(record.sequence)) {
    throw protocolError("Hermes SSE id and payload sequence disagree");
  }
  const digest = eventDigest({ event: eventName, payload: parsed });
  const seen = state.eventDigests.get(runId) ?? new Map<number, string>();
  if (sequenced && seen.has(sequence)) {
    if (seen.get(sequence) !== digest) throw protocolError("Conflicting Hermes event replay");
    return;
  }
  if (sequenced && sequence !== (state.cursors.get(runId) ?? 0) + 1) {
    throw protocolError("Noncontiguous Hermes event sequence");
  }
  state.lastEventName = eventName;
  const sanitized = asRecord(redactForLog(parsed, [], 0, redactText)) ?? {};
  if (sequenced && ctx.onEvent) {
    try {
      await ctx.onEvent({ eventType: `hermes.${eventName ?? "message"}`, stream: "stdout", payload: sanitized,
        message: eventName === "message.delta" ? redactText(nonEmpty(record?.delta) ?? nonEmpty(record?.text_delta) ?? "") : undefined,
        providerSource: { runId, sequence, canonicalPayload: { version: 1, sha256: digest } } });
    } catch {
      throw protocolError("Host refused the Hermes event receipt");
    }
  } else {
    await ctx.onLog("stdout", `[hermes-gateway:event] run=${runId} event=${eventName ?? "message"} data=${stringifyForLog(sanitized, 8_000)}\n`);
  }

  if (state.runId !== runId || state.protocolError) return;

  const delta = nonEmpty(record?.delta) ?? nonEmpty(record?.text_delta);
  if (eventName === "message.delta" && delta) {
    const sanitizedDelta = redactText(delta);
    state.outputChunks.push(sanitizedDelta);
    if (!sequenced || !ctx.onEvent) await ctx.onLog("stdout", sanitizedDelta);
  }

  if (state.runId !== runId || state.protocolError) return;
  if (sequenced) {
    seen.set(sequence, digest);
    state.eventDigests.set(runId, seen);
    state.cursors.set(runId, sequence);
  }
  await persistProgress(ctx, state);
  await observeRun(ctx, state, runId, parsed, eventName);
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function pollStatus(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  state: ExecutionState;
  signal: AbortSignal;
  intervalMs: number;
  supervised?: boolean;
  redactText?: TextRedactor;
  onProtocolError: (error: Error) => void;
}): Promise<void> {
  while (!input.signal.aborted && !input.state.terminal) {
    await delay(input.intervalMs, input.signal);
    if (input.signal.aborted || input.state.terminal) break;
    const runId = input.state.runId;
    try {
      const status = await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(runId)}`), {
        method: "GET",
        headers: input.headers,
        signal: input.supervised ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]) : input.signal,
      });
      await observeRun(input.ctx, input.state, runId, status);
    } catch (err) {
      if ((err as HermesHttpError).code === "hermes_gateway_protocol_error") input.onProtocolError(err as Error);
      if (input.signal.aborted) return;
      await input.ctx.onLog("stderr", `[hermes-gateway] status poll failed: ${redactErrorMessage(err, input.redactText)}\n`);
    }
  }
}

async function consumeEvents(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  state: ExecutionState;
  signal: AbortSignal;
  reconnectMs: number;
  redactText?: TextRedactor;
  onProtocolError: (error: Error) => void;
}): Promise<void> {
  const handle = async (runId: string, frame: SseFrame) => {
    input.state.activeEvents++;
    try {
      await handleEvent(input.ctx, input.state, runId, frame, input.redactText);
    } finally {
      input.state.activeEvents--;
    }
  };
  while (!input.signal.aborted && !input.state.terminal) {
    const runId = input.state.runId;
    try {
      const response = await fetch(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(runId)}/events`), {
        method: "GET",
        headers: { ...input.headers, ...(input.state.cursors.has(runId)
          ? { "Last-Event-ID": String(input.state.cursors.get(runId)) } : {}) },
        signal: input.signal,
      });
      if (!response.ok) {
        await input.ctx.onLog("stderr", `[hermes-gateway] event stream HTTP ${response.status}; falling back to polling\n`);
        await delay(input.reconnectMs, input.signal);
        continue;
      }
      if (!response.body) {
        await input.ctx.onLog("stderr", "[hermes-gateway] event stream response had no body; falling back to polling\n");
        await delay(input.reconnectMs, input.signal);
        continue;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
      while (!input.signal.aborted && !input.state.terminal && input.state.runId === runId) {
        const { value, done } = await reader.read();
        if (input.signal.aborted || input.state.terminal || input.state.runId !== runId) break;
        if (done) {
          if (buffer.trim().length > 0) {
            const parsed = parseSseFramesForTest(`${buffer}\n\n`);
            buffer = parsed.rest;
            for (const frame of parsed.frames) {
              await handle(runId, frame);
              if (input.state.terminal || input.state.runId !== runId) break;
            }
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFramesForTest(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          await handle(runId, frame);
          if (input.state.terminal || input.state.runId !== runId) break;
        }
      }
      } finally {
        await reader.cancel();
      }
    } catch (err) {
      if ((err as HermesHttpError).code === "hermes_gateway_protocol_error") {
        input.onProtocolError(err as Error);
        return;
      }
      if (input.signal.aborted || input.state.terminal) return;
      await input.ctx.onLog("stderr", `[hermes-gateway] event stream disconnected: ${redactErrorMessage(err, input.redactText)}\n`);
    }
    if (!input.state.terminal) await delay(input.reconnectMs, input.signal);
  }
}

function parseUsage(value: unknown): UsageSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const source = asRecord(record.usage) ?? record;
  const inputTokens = asNumber(source.input_tokens ?? source.inputTokens ?? source.input, 0);
  const outputTokens = asNumber(source.output_tokens ?? source.outputTokens ?? source.output, 0);
  const cachedInputTokens = asNumber(source.cached_input_tokens ?? source.cachedInputTokens, 0);
  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

function parseCostUsd(value: unknown): number | null {
  const record = asRecord(value);
  const raw = record?.cost_usd ?? record?.costUsd ?? asRecord(record?.usage)?.cost_usd ?? asRecord(record?.usage)?.costUsd;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function extractSessionId(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.session_id) ?? nonEmpty(record?.sessionId) ?? nonEmpty(asRecord(record?.data)?.session_id);
}

function extractModel(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.model) ?? nonEmpty(asRecord(record?.usage)?.model);
}

function extractErrorMessage(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.error) ?? nonEmpty(record?.message) ?? nonEmpty(record?.detail) ?? extractOutput(value);
}

function terminalResultCode(status: string): { exitCode: number; signal: string | null; errorCode: string | null } {
  if (status === "completed") return { exitCode: 0, signal: null, errorCode: null };
  if (FAILURE_STATUSES.has(status)) return { exitCode: 1, signal: null, errorCode: "hermes_gateway_run_failed" };
  if (CANCELLED_STATUSES.has(status)) return { exitCode: 1, signal: "SIGTERM", errorCode: "hermes_gateway_cancelled" };
  return { exitCode: 1, signal: null, errorCode: "hermes_gateway_protocol_error" };
}

export function mapFinalResultForTest(input: {
  terminal: TerminalState;
  outputChunks: string[];
  sessionKey: string | null;
  strategy: SessionKeyStrategy;
  redactText?: TextRedactor;
}): AdapterExecutionResult {
  const redactText = input.redactText ?? sanitizeSensitiveText;
  const payload = input.terminal.payload ?? {};
  const output = redactText(
    input.terminal.output ?? extractOutput(payload) ?? input.outputChunks.join("").trim(),
  );
  const sessionId = extractSessionId(payload) ?? input.sessionKey;
  const sessionDisplayId = sessionId ? redactText(sessionId) : null;
  const mapped = terminalResultCode(input.terminal.status);
  if (input.terminal.status === "unrecoverable") {
    mapped.errorCode = payload.intervention_reason === "tool_effect_uncertain"
      ? "hermes_gateway_tool_effect_uncertain" : "hermes_gateway_unrecoverable";
  }
  const usage = parseUsage(payload);
  const costUsd = parseCostUsd(payload);
  const errorMessage = mapped.errorCode
    ? redactText(extractErrorMessage(payload) ?? `Hermes run ${input.terminal.status}`)
    : null;
  return {
    exitCode: mapped.exitCode,
    signal: mapped.signal,
    timedOut: false,
    provider: "hermes_gateway",
    model: extractModel(payload),
    ...(mapped.errorCode ? { errorCode: mapped.errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(usage ? { usage } : {}),
    ...(costUsd !== null ? { costUsd } : {}),
    ...(output ? { summary: output.slice(0, 2_000) } : {}),
    sessionId: sessionDisplayId,
    sessionParams: {
      hermesRunId: input.terminal.runId,
      ...(sessionId && sessionDisplayId === sessionId ? { hermesSessionId: sessionId } : {}),
      strategy: input.strategy,
    },
    sessionDisplayId,
    resultJson: {
      run_id: input.terminal.runId,
      status: input.terminal.status,
      session_id: sessionDisplayId,
      last_event: input.terminal.eventName ?? null,
      output: output ?? "",
      usage: usage ?? null,
      cost_usd: costUsd,
      ...(payload.intervention_reason ? { intervention_reason: payload.intervention_reason } : {}),
    },
  };
}

async function stopRun(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  runId: string;
  redactText?: TextRedactor;
}): Promise<Record<string, unknown> | null> {
  try {
    const stopped = await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.runId)}/stop`), {
      method: "POST",
      headers: input.headers,
      signal: AbortSignal.timeout(30_000),
    });
    await input.ctx.onLog("stdout", `[hermes-gateway] stop requested for run ${input.runId}\n`);
    return asRecord(stopped);
  } catch (err) {
    await input.ctx.onLog("stderr", `[hermes-gateway] stop request failed: ${redactErrorMessage(err, input.redactText)}\n`);
    return null;
  }
}

async function fetchFinalStatus(input: {
  baseUrl: URL;
  headers: Record<string, string>;
  runId: string;
  deadlineMs: number;
}): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + input.deadlineMs;
  while (Date.now() < deadline) {
    try {
      const status = await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.runId)}`), {
        method: "GET",
        headers: input.headers,
      });
      const record = asRecord(status);
      const normalized = extractStatus(status);
      if (normalized && TERMINAL_STATUSES.has(normalized)) return record;
    } catch {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

function redactErrorMessage(err: unknown, redactText: TextRedactor = sanitizeSensitiveText): string {
  if (err instanceof Error) return redactText(err.message);
  return redactText(String(err));
}

function isConfiguredLoopbackRefusal(error: HermesHttpError, baseUrl: URL): boolean {
  if (error.code !== "hermes_gateway_connect_failed" || !isLoopbackHostname(baseUrl.hostname)) return false;
  const cause = asRecord(error.transportCause);
  if (cause?.code !== "ECONNREFUSED") return false;
  const port = Number(baseUrl.port || (baseUrl.protocol === "https:" ? 443 : 80));
  const hostname = baseUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const refusals = Array.isArray(cause.errors) ? cause.errors : [cause];
  if (refusals.length === 0 || refusals.length > 8) return false;
  return refusals.every((value) => {
    const refusal = asRecord(value);
    return refusal?.code === "ECONNREFUSED" && refusal.syscall === "connect" &&
      refusal.port === port && typeof refusal.address === "string" &&
      isLoopbackHostname(refusal.address) &&
      (hostname === "localhost" || refusal.address.toLowerCase() === hostname);
  });
}

function errorResult(err: unknown, baseUrl: URL, redactText: TextRedactor = sanitizeSensitiveText): AdapterExecutionResult {
  const hermesError = err as HermesHttpError;
  const code = hermesError.code ?? "hermes_gateway_protocol_error";
  const classified = hermesError.status ? classifyHttpError(hermesError.status) : null;
  const loopbackRefused = isConfiguredLoopbackRefusal(hermesError, baseUrl);
  const errorMessage = code === "hermes_gateway_auth_failed"
    ? `${redactErrorMessage(err, redactText)}. Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY for the running gateway.`
    : loopbackRefused
      ? `${redactErrorMessage(err, redactText)}. The configured loopback gateway refers to the Paperclip server, not an agent sandbox or your browser's machine. Check that the Hermes API server is running there, or set adapterConfig.apiBaseUrl to its address reachable from the Paperclip server. Hermes Gateway connects to an already-running gateway; use hermes_local if Paperclip should launch the local Hermes CLI.`
      : redactErrorMessage(err, redactText);
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: code,
    errorFamily: classified?.family ?? (code === "hermes_gateway_connect_failed" ? "transient_upstream" : null),
    retryNotBefore: hermesError.retryNotBefore ?? null,
    errorMessage,
    errorMeta: {
      // Diagnosis only: a redirected request may have received a response
      // before refusing a later connection. This never proves non-dispatch.
      ...(loopbackRefused ? { category: "gateway_loopback_connection_refused", phase: "create_run" } : {}),
      ...(hermesError.status ? { status: hermesError.status } : {}),
      ...(hermesError.body ? { body: redactForLog(hermesError.body, [], 0, redactText) as Record<string, unknown> } : {}),
    },
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  let selectedExecutor: string | null;
  try {
    selectedExecutor = await selectExecutor(ctx);
  } catch (error) {
    return { exitCode: 1, signal: null, timedOut: false,
      errorCode: asString(parseObject(error).code, "hermes_gateway_executor_unavailable"),
      errorMessage: error instanceof Error ? error.message : "Executor selection failed." };
  }
  if (selectedExecutor) ctx = { ...ctx, config: { ...ctx.config, apiBaseUrl: selectedExecutor } };
  const apiBaseUrlValue = asString(ctx.config.apiBaseUrl ?? ctx.config.url, "").trim();
  if (!apiBaseUrlValue) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_base_url_missing",
      errorMessage: "Hermes gateway adapter requires apiBaseUrl.",
    };
  }

  const baseUrl = normalizeBaseUrl(apiBaseUrlValue);
  if (!baseUrl) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_base_url_invalid",
      errorMessage: `Invalid Hermes gateway apiBaseUrl: ${apiBaseUrlValue}`,
    };
  }
  if (isRemotePlainHttp(baseUrl) && !allowsInsecureRemoteHttp(ctx.config)) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_plain_http_remote_denied",
      errorMessage: remotePlainHttpDeniedMessage(baseUrl.hostname),
    };
  }

  const apiKey = nonEmpty(ctx.config.apiKey) ?? nonEmpty(ctx.config.token);
  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_key_missing",
      errorMessage: "Hermes gateway adapter requires apiKey.",
    };
  }

  const timeoutSec = parseNonNegativeNumber(ctx.config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  let binding: WorkspaceBinding | null;
  let managedMcp: ManagedMcpManifest | null;
  try {
    managedMcp = resolveManagedMcp(ctx, baseUrl.toString());
    binding = resolveWorkspaceBinding(ctx, baseUrl.toString());
    if (managedMcp && (binding?.context.lifetime !== "wait_for_jobs" || !ctx.onExecutionCheckpoint)) {
      throw Object.assign(new Error("Managed MCP requires a supervised workspace and host-owned durable execution checkpoints."), {
        code: "hermes_gateway_managed_mcp_blocked",
      });
    }
  } catch (err) {
    return errorResult(err, baseUrl);
  }
  // A stored session from another target must receive the full brief.
  if (managedMcp || (binding && ctx.runtime.sessionParams?.executionContextFingerprint !== binding.fingerprint)) {
    ctx = { ...ctx, runtime: { ...ctx.runtime, sessionId: null, sessionParams: null, sessionDisplayId: null } };
  }
  const timeoutMs = timeoutSec > 0 ? Math.ceil(timeoutSec * 1000) : 0;
  const reconnectMs = Math.floor(clamp(parseNonNegativeNumber(ctx.config.eventReconnectMs, DEFAULT_EVENT_RECONNECT_MS), 250, 30_000));
  const pollIntervalMs = Math.floor(clamp(parseNonNegativeNumber(ctx.config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS), 250, 10_000));
  const strategy = normalizeSessionKeyStrategy(ctx.config.sessionKeyStrategy);
  const sessionKey = managedMcp ? null : bindSessionKey(resolveSessionKey({
    strategy,
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    runId: ctx.runId,
    issueId: issueIdFromContext(ctx),
  }), binding);
  const extraHeaders = parseHeaders(ctx.config.headers);
  const runHeaders = buildHeaders({
    apiKey,
    sessionKey,
    runId: ctx.runId,
    extraHeaders,
    accept: "application/json",
    contentType: "application/json",
  });
  const eventHeaders = buildHeaders({
    apiKey,
    sessionKey,
    runId: ctx.runId,
    extraHeaders,
    accept: "text/event-stream",
  });
  const redactText = createTextRedactor([
    apiKey,
    sessionKey,
    runHeaders.Authorization,
    runHeaders["X-Hermes-Session-Key"],
    ...(managedMcp?.servers.map((server) => server.token) ?? []),
  ]);
  const body = buildRunBody(ctx, sessionKey);
  if (binding) body.execution_context = binding.context;
  if (managedMcp) body.runtime_mcp = managedMcp;
  const requestBody = JSON.stringify(body);
  const createRunUrl = apiUrl(baseUrl, "/v1/runs");

  await ctx.onMeta?.({
    adapterType: ADAPTER_TYPE,
    command: "POST /v1/runs",
    commandArgs: [createRunUrl],
    context: {
      runId: ctx.runId,
      timeoutSec,
      eventReconnectMs: reconnectMs,
      sessionKeyStrategy: strategy,
      hasSessionKey: Boolean(sessionKey),
    },
  });
  await ctx.onLog("stdout", `[hermes-gateway] creating run at ${createRunUrl} (timeout=${timeoutSec}s, session=${strategy})\n`);
  await ctx.onLog("stdout", `[hermes-gateway] request headers (redacted): ${stringifyForLog(redactForLog(runHeaders, [], 0, redactText), 3_000)}\n`);

  let runId: string | null = null;
  const supervised = binding?.context.lifetime === "wait_for_jobs";
  const ownedAdmission = supervised || Boolean(ctx.onExecutionCheckpoint) || Boolean(selectedExecutor);
  const cancellable = ownedAdmission || Boolean(ctx.signal);
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  const deadlineExpired = () => deadline !== null && Date.now() >= deadline;
  const checkpoint = executionCheckpoint(baseUrl, runHeaders, requestBody);
  let checkpointPrepared = false;
  try {
    if (cancellable && !ctx.onExecutionCheckpoint) {
      throw Object.assign(new Error("Cancellable Hermes admission requires host-owned durable execution checkpoints"), {
        code: "hermes_gateway_checkpoint_required",
      });
    }
    if (cancellable) await ctx.onCancellationReady?.();
    if (binding || managedMcp || ownedAdmission) {
      const capabilities = await fetchJson(apiUrl(baseUrl, "/v1/capabilities"), {
        method: "GET", headers: runHeaders,
        signal: AbortSignal.timeout(30_000),
      });
      if (binding) requireWorkspaceCapability(capabilities, binding);
      if (managedMcp) requireManagedMcpCapability(capabilities, managedMcp);
      if (ownedAdmission) {
        const recovery = parseObject(parseObject(asRecord(capabilities)?.features).runs_recovery);
        if (recovery.version !== 1 || recovery.durable_lineage_stop !== true || recovery.admission_binding !== 1 || (!supervised && recovery.ordinary_stop_admission !== true)) {
          throw Object.assign(new Error("Hermes worker lacks durable lineage stop for owned admissions"), { code: "hermes_gateway_recovery_unsupported" });
        }
      }
    }
    if (cancellable && ctx.signal?.aborted) {
      return { exitCode: 1, signal: "SIGTERM", timedOut: false, errorCode: "hermes_gateway_cancelled",
        resultJson: { executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } } };
    }
    if (ownedAdmission) {
      if (!ctx.onExecutionCheckpoint) throw new Error("wait_for_jobs requires host-owned durable execution checkpoints");
      await ctx.onExecutionCheckpoint(checkpoint,
        (strategy === "agent" || (strategy === "issue" && issueIdFromContext(ctx))) && !managedMcp
          ? baseUrl.toString().replace(/\/+$/, "") : undefined);
      checkpointPrepared = true;
    }
    // This adapter has no local child process, so crossing into the first
    // remote create request is its dispatch boundary. Report it before the
    // request can block so continuation gates may release their issue lock.
    ctx.onDispatch?.();
    const create = async (url = createRunUrl) => {
      // Abort the uncertain admission, never the separate request that fences it.
      const timeout = AbortSignal.timeout(30_000);
      const receipt = await fetchJson(url, {
        method: "POST", headers: runHeaders, body: requestBody,
        ...(ownedAdmission || managedMcp ? {
          signal: url === createRunUrl && ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
          redirect: "error",
        } : {}),
      });
      if (ownedAdmission && !extractRunId(receipt)) throw new Error("Hermes admission acknowledgement has no run_id; retaining ownership.");
      return receipt;
    };
    const created = ownedAdmission ? await admitOwnedRun({
      create, retryMs: reconnectMs,
      stopAdmission: () => create(apiUrl(baseUrl, "/v1/runs/stop")),
      shouldStop: () => Boolean(ctx.signal?.aborted) || deadlineExpired(),
      onUncertain: (err) => ctx.onLog("stderr", `[hermes-gateway] admission uncertain; replaying original idempotency key: ${redactErrorMessage(err, redactText)}\n`),
    }) : await create();
    runId = extractRunId(created);
    if (!runId) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "hermes_gateway_protocol_error",
        errorMessage: "Hermes /v1/runs response did not include run_id.",
        errorMeta: { response: redactForLog(created, [], 0, redactText) as Record<string, unknown> },
      };
    }
  } catch (err) {
    // Recovery may already be using the persisted checkpoint. Even a definitive
    // rejection here needs a provider-side fence before ownership is released.
    if (checkpointPrepared) {
      await settleOwnedAdmission(checkpoint, reconnectMs);
      await ctx.onProviderStopped?.();
    }
    return errorResult(err, baseUrl, redactText);
  }

  // After admission, a broken log sink must not stop lifecycle observation.
  // Both synchronous throws and rejected log writes leave ownership intact.
  const observer = cancellable ? {
    ...ctx,
    onLog: async (...args: Parameters<AdapterExecutionContext["onLog"]>) => {
      try { await ctx.onLog(...args); } catch { /* keep observing the owned run */ }
    },
  } : ctx;
  await observer.onLog("stdout", `[hermes-gateway] run created: ${runId}\n`);

  const state = createExecutionState(runId);
  state.stopping = ctx.signal?.aborted ?? false;
  const requestedStop = () => { state.stopping = true; };
  ctx.signal?.addEventListener("abort", requestedStop, { once: true });
  const controller = new AbortController();
  const protocolStop = new AbortController();
  const onProtocolError = (error: Error) => {
    state.protocolError ??= error;
    state.stopping = true;
    protocolStop.abort();
  };
  // Persist the admitted root even when the first frame is rejected. Recovery
  // must retain its empty cursor rather than depend on a later valid event.
  try { await persistProgress(observer, state); }
  catch (err) { onProtocolError(err instanceof Error ? err : new Error(String(err))); }
  const events = consumeEvents({
    ctx: observer,
    baseUrl,
    headers: eventHeaders,
    state,
    signal: controller.signal,
    reconnectMs,
    redactText,
    onProtocolError,
  }).catch(() => undefined);
  const polling = pollStatus({
    ctx: observer,
    baseUrl,
    headers: eventHeaders,
    state,
    signal: controller.signal,
    intervalMs: pollIntervalMs,
    supervised: cancellable,
    redactText,
    onProtocolError,
  }).catch(() => undefined);

  const onStopReceipt = (receipt: unknown) => {
    const record = asRecord(receipt);
    // A malformed lineage receipt cannot fall through to single-run parsing.
    if (record && ("lineage" in record || "lineage_settled" in record)) {
      if (!lineageStopSettled(record, state.rootRunId, state.lineage)) return;
      const current = (record.lineage as Record<string, unknown>[]).find(member => member.run_id === state.runId)!;
      const status = current.status === "superseded" ? "cancelled" : String(current.status);
      markTerminal(state, { runId: state.runId, status, payload: { ...record, ...current, status } });
      return;
    }
    // Owned recovery workers must prove the whole lineage, even for a root-only
    // admission. Legacy, unowned workers retain their single-run Stop contract.
    if (ownedAdmission) return;
    const terminal = terminalReceiptForRun(state.runId, receipt);
    if (terminal) markTerminal(state, terminal);
  };

  if (cancellable) {
    const timedOutBeforeObservation = deadlineExpired();
    const owned = await waitForOwnedRun({
      terminal: state.terminalPromise.then(terminal => { controller.abort(); return terminal; }),
      signal: ctx.signal ? AbortSignal.any([ctx.signal, protocolStop.signal]) : protocolStop.signal,
      timeoutMs: deadline === null ? 0 : Math.max(1, deadline - Date.now()), retryMs: reconnectMs,
      stop: () => { state.stopping = true; return stopRun({ ctx: observer, baseUrl, headers: eventHeaders, runId, redactText }); },
      onStopReceipt,
    });
    controller.abort();
    ctx.signal?.removeEventListener("abort", requestedStop);
    await Promise.all([events, polling]);
    await ctx.onProviderStopped?.();
    if (state.protocolError) {
      const result = errorResult(state.protocolError, baseUrl, redactText);
      if (selectedExecutor) result.sessionParams = { hermesRunId: runId, strategy, executorBaseUrl: selectedExecutor };
      return result;
    }
    const result = mapFinalResultForTest({ terminal: owned.terminal, outputChunks: state.outputChunks,
      sessionKey, strategy, redactText });
    if (binding) result.sessionParams = { ...result.sessionParams, executionContextFingerprint: binding.fingerprint };
    if (selectedExecutor) result.sessionParams = { ...result.sessionParams, executorBaseUrl: selectedExecutor };
    if (ctx.signal?.aborted) {
      result.resultJson = { ...result.resultJson,
        executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } };
    }
    if (owned.timedOut || timedOutBeforeObservation) {
      result.timedOut = true;
      result.errorCode = "hermes_gateway_timeout";
      result.errorMessage = `Hermes gateway run timed out after ${timeoutSec}s; owned jobs have settled.`;
    }
    return result;
  }

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    if (timeoutMs <= 0) return;
    timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const protocolFailure = new Promise<"protocol">((resolve) => {
    if (protocolStop.signal.aborted) resolve("protocol");
    else protocolStop.signal.addEventListener("abort", () => resolve("protocol"), { once: true });
  });
  const outcome = await Promise.race([state.terminalPromise, timeoutPromise, protocolFailure]);
  ctx.signal?.removeEventListener("abort", requestedStop);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (outcome === "protocol") {
    await waitForOwnedRun({ terminal: state.terminalPromise, signal: protocolStop.signal, timeoutMs: 0,
      retryMs: reconnectMs, stop: () => stopRun({ ctx: observer, baseUrl, headers: eventHeaders, runId, redactText }), onStopReceipt });
    controller.abort();
    await Promise.all([events, polling]);
    return errorResult(state.protocolError!, baseUrl, redactText);
  }
  controller.abort();

  if (outcome === "timeout") {
    await stopRun({ ctx, baseUrl, headers: eventHeaders, runId, redactText });
    const finalStatus = await fetchFinalStatus({ baseUrl, headers: eventHeaders, runId, deadlineMs: STOP_GRACE_MS });
    return {
      exitCode: 1,
      signal: null,
      timedOut: true,
      errorCode: "hermes_gateway_timeout",
      errorMessage: `Hermes gateway run timed out after ${timeoutSec}s.`,
      provider: "hermes_gateway",
      resultJson: {
        run_id: runId,
        status: extractStatus(finalStatus) ?? "timeout",
        last_event: state.lastEventName,
        final_status: redactForLog(finalStatus, [], 0, redactText),
      },
      sessionParams: {
        hermesRunId: runId,
        strategy,
        ...(binding ? { executionContextFingerprint: binding.fingerprint } : {}),
        ...(selectedExecutor ? { executorBaseUrl: selectedExecutor } : {}),
      },
      sessionDisplayId: sessionKey ? redactText(sessionKey) : null,
    };
  }

  const result = mapFinalResultForTest({
    terminal: outcome,
    outputChunks: state.outputChunks,
    sessionKey,
    strategy,
    redactText,
  });
  if (binding) result.sessionParams = { ...result.sessionParams, executionContextFingerprint: binding.fingerprint };
  if (selectedExecutor) result.sessionParams = { ...result.sessionParams, executorBaseUrl: selectedExecutor };
  return result;
}
