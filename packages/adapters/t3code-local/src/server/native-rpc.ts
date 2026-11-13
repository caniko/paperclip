import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { WebSocket } from "ws";

const HELPER_TIMEOUT_SEC = 30;
const STOP_POLL_MS = 1000;
const RPC_OPEN_TIMEOUT_MS = 5000;
// orchestrationProtocol from packages/contracts/src/environment.ts in T3 Code.
const NATIVE_RPC_PROTOCOL_VERSION = "2";
// ServerWsRpcGroup tags from packages/contracts/src/orchestrationV2.ts
// (ORCHESTRATION_V2_WS_METHODS) in T3 Code.
const DISPATCH_COMMAND = "orchestration.dispatchCommand";
const GET_THREAD_PROJECTION = "orchestration.getThreadProjection";

// Inactive statuses from OrchestrationV2RunStatus, OrchestrationV2ProviderTurn,
// and OrchestrationV2Subagent in packages/contracts/src/orchestrationV2.ts.
// Anything outside these sets is unconfirmed, including future status strings.
const INACTIVE_RUN_STATUSES = new Set([
  "queued",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const INACTIVE_PROVIDER_TURN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);
const INACTIVE_SUBAGENT_STATUSES = new Set([
  "idle",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
// Live states from OrchestrationV2ProviderThread.status and OrchestrationV2TurnItemStatus
// in packages/contracts/src/orchestrationV2.ts. A terminal run or turn can still own work
// in these, because thread.stop queues the interruption instead of completing it inline.
const LIVE_PROVIDER_THREAD_STATUSES = new Set(["active"]);
const ACTIVE_COMMAND_STATUSES = new Set(["pending", "running", "waiting"]);

type JsonRecord = Record<string, unknown>;

interface IssuedSession {
  token: string;
  sessionId: string;
}

interface NativeRpcConnection {
  request(tag: string, payload: unknown, timeoutMs: number): Promise<unknown>;
  close(): void;
}

export interface NativeSessionContext {
  runId: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function expandHomePath(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(home, input.slice(2));
  return input;
}

async function readNativeServerOrigin(env: Record<string, string>, cwd: string): Promise<string | null> {
  // Match the t3 CLI's base-dir and state-dir rules so the issued session and
  // the origin belong to the same server. A configured key overrides the
  // inherited process value even when its value is empty.
  const envValue = (key: string) => (env[key] !== undefined ? env[key]! : (process.env[key] ?? "")).trim();
  const homeDirectory = envValue("HOME") || os.homedir();
  const configuredHome = envValue("T3CODE_HOME") || null;
  const devUrl = envValue("VITE_DEV_SERVER_URL") || null;
  const baseDir = configuredHome
    ? path.resolve(cwd, expandHomePath(configuredHome, homeDirectory))
    : path.join(homeDirectory, ".t3");
  const profile = configuredHome === null && devUrl ? "dev" : "userdata";
  try {
    const state = asRecord(JSON.parse(await fs.readFile(path.join(baseDir, profile, "server-runtime.json"), "utf8")));
    if (!state || typeof state.origin !== "string") return null;
    if (typeof state.pid === "number" && !processIsAlive(state.pid)) return null;
    return state.origin;
  } catch {
    return null;
  }
}

function parseIssuedSession(stdout: string): IssuedSession | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = asRecord(JSON.parse(stdout.slice(start, end + 1)));
    return parsed && typeof parsed.token === "string" && typeof parsed.sessionId === "string"
      ? { token: parsed.token, sessionId: parsed.sessionId }
      : null;
  } catch {
    return null;
  }
}

async function issueNativeSession(
  ctx: NativeSessionContext,
  timeoutSec = HELPER_TIMEOUT_SEC,
): Promise<IssuedSession> {
  const proc = await runChildProcess(`${ctx.runId}:native-auth-issue`, ctx.command, [
    "auth", "session", "issue",
    // RPC_REQUIRED_SCOPES in apps/server/src/auth/RpcAuthorization.ts: dispatchCommand
    // needs orchestration:operate and getThreadProjection needs orchestration:read.
    "--scope", "orchestration:read",
    "--scope", "orchestration:operate",
    "--ttl", "5m",
    "--label", "paperclip t3 adapter",
    "--json",
  ], {
    cwd: ctx.cwd,
    env: ctx.env,
    timeoutSec,
    graceSec: 1,
    onLog: async () => {},
  });
  const issued = proc.exitCode === 0 && !proc.timedOut ? parseIssuedSession(proc.stdout) : null;
  if (!issued) {
    throw new Error("Could not issue a T3 Code auth session for the native stop.");
  }
  return issued;
}

async function revokeNativeSession(ctx: NativeSessionContext, sessionId: string): Promise<void> {
  await runChildProcess(`${ctx.runId}:native-auth-revoke`, ctx.command, [
    "auth", "session", "revoke", sessionId,
  ], {
    cwd: ctx.cwd,
    env: ctx.env,
    timeoutSec: 5,
    graceSec: 1,
    onLog: async () => {},
  }).catch(() => undefined);
}

function nativeSocketUrl(origin: string): string {
  const url = new URL("/ws", origin);
  url.searchParams.set("orchestrationProtocol", NATIVE_RPC_PROTOCOL_VERSION);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function openNativeRpc(
  origin: string,
  token: string,
  timeoutMs: number,
): Promise<NativeRpcConnection> {
  const ws = new WebSocket(nativeSocketUrl(origin), {
    headers: { authorization: `Bearer ${token}` },
    handshakeTimeout: timeoutMs,
    maxPayload: 25 * 1024 * 1024,
  });
  const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  const failPending = (error: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const settle = (frame: JsonRecord) => {
    if (frame._tag === "ClientProtocolError" || frame._tag === "Defect") {
      failPending(new Error("The T3 Code server rejected the native RPC request."));
      return;
    }
    if (frame._tag !== "Exit" || (typeof frame.requestId !== "string" && typeof frame.requestId !== "number")) {
      return;
    }
    const entry = pending.get(String(frame.requestId));
    if (!entry) return;
    pending.delete(String(frame.requestId));
    clearTimeout(entry.timer);
    const exit = asRecord(frame.exit);
    if (exit?._tag === "Success") {
      entry.resolve(exit.value);
      return;
    }
    const causes = Array.isArray(exit?.cause) ? exit.cause : [];
    const failure = causes.map(asRecord).find((cause) => cause?._tag === "Fail");
    const detail = failure?.error === undefined ? null : JSON.stringify(failure.error);
    entry.reject(new Error(detail && detail !== "{}" ? detail : "The T3 Code server failed the native RPC request."));
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
      ws.off("unexpected-response", onUnexpected);
      if (error) {
        ws.once("error", () => {});
        ws.terminate();
        reject(error);
      } else {
        resolve();
      }
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error("Could not open an authenticated T3 Code RPC connection."));
    const onClose = () => finish(new Error("The T3 Code RPC connection closed before it opened."));
    const onUnexpected = (_request: unknown, response: { statusCode?: number; resume(): void }) => {
      response.resume();
      finish(new Error(`The T3 Code server rejected the RPC upgrade${response.statusCode === undefined ? "" : ` (${response.statusCode})`}.`));
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
    ws.once("unexpected-response", onUnexpected);
  });

  ws.on("message", (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    for (const frame of Array.isArray(parsed) ? parsed : [parsed]) {
      const record = asRecord(frame);
      if (record) settle(record);
    }
  });
  ws.on("close", () => failPending(new Error("The T3 Code RPC connection closed.")));
  ws.on("error", () => failPending(new Error("The T3 Code RPC connection failed.")));

  return {
    request(tag, payload, timeoutMs) {
      if (ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("The T3 Code RPC connection is not open."));
      }
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`The T3 Code server did not answer ${tag} in time.`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      });
    },
    close() {
      failPending(new Error("The T3 Code RPC connection closed."));
      ws.close(1000, "paperclip-complete");
    },
  };
}

function itemsAreIdle(projection: JsonRecord, key: string, inactiveStatuses: Set<string>): boolean {
  const items = projection[key];
  if (!Array.isArray(items)) return false;
  return items.every((item) => {
    const record = asRecord(item);
    return typeof record?.status === "string" && inactiveStatuses.has(record.status);
  });
}

function hasPendingBackgroundTasks(record: JsonRecord): boolean {
  return Array.isArray(record.pendingBackgroundTasks) && record.pendingBackgroundTasks.length > 0;
}

function backgroundWorkIsDrained(projection: JsonRecord): boolean {
  const thread = asRecord(projection.thread);
  if (thread && hasPendingBackgroundTasks(thread)) return false;
  const providerThreads = projection.providerThreads;
  if (Array.isArray(providerThreads)) {
    for (const entry of providerThreads) {
      const providerThread = asRecord(entry);
      if (!providerThread) continue;
      if (hasPendingBackgroundTasks(providerThread)) return false;
      if (typeof providerThread.status === "string" && LIVE_PROVIDER_THREAD_STATUSES.has(providerThread.status)) {
        return false;
      }
    }
  }
  const items = projection.turnItems;
  if (!Array.isArray(items)) return true;
  return items.every((item) => {
    const record = asRecord(item);
    return record?.type !== "command_execution"
      || typeof record.status !== "string"
      || !ACTIVE_COMMAND_STATUSES.has(record.status);
  });
}

export function isNativeThreadStopped(projection: unknown): boolean {
  const record = asRecord(projection);
  if (!record) return false;
  return itemsAreIdle(record, "runs", INACTIVE_RUN_STATUSES)
    && itemsAreIdle(record, "providerTurns", INACTIVE_PROVIDER_TURN_STATUSES)
    && itemsAreIdle(record, "subagents", INACTIVE_SUBAGENT_STATUSES)
    && backgroundWorkIsDrained(record);
}

function remainingTimeoutMs(deadline: number): number {
  return Math.max(1, Math.min(10_000, deadline - Date.now()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactToken(text: string, token: string | null): string {
  return token ? text.split(token).join("[redacted]") : text;
}

export interface NativeStopInput extends NativeSessionContext {
  threadId: string;
  deadline: number;
  budgetSec?: number;
  pollMs?: number;
}

/**
 * Stops a thread through the server's own RPC command and waits until its
 * projection shows no active run, provider turn, subagent, or background work
 * (pending background tasks and active command items). Returns an error string
 * instead of claiming a stop the server did not confirm.
 */
export async function stopNativeThread(input: NativeStopInput): Promise<string | null> {
  const pollMs = input.pollMs ?? STOP_POLL_MS;
  const budgetSec = input.budgetSec ?? Math.max(1, Math.ceil((input.deadline - Date.now()) / 1000));
  const notConfirmed = () =>
    `T3 Code did not confirm within ${budgetSec}s that thread ${input.threadId} stopped.`;
  if (Date.now() >= input.deadline) return notConfirmed();
  const origin = await readNativeServerOrigin(input.env, input.cwd);
  if (!origin) {
    return "Could not find the running T3 Code server for this user; the run may still be active in T3 Code.";
  }

  let issued: IssuedSession | null = null;
  let rpc: NativeRpcConnection | null = null;
  try {
    // The helper's whole-second timeout and kill grace can outlast the deadline.
    // Stop waiting at the deadline and revoke a session that is issued later.
    const issuing = issueNativeSession(
      input,
      Math.min(HELPER_TIMEOUT_SEC, Math.max(1, Math.ceil((input.deadline - Date.now()) / 1000))),
    );
    const onTime = await Promise.race([issuing, sleep(Math.max(0, input.deadline - Date.now())).then(() => null)]);
    if (!onTime) {
      issuing.then((late) => revokeNativeSession(input, late.sessionId), () => undefined);
      return notConfirmed();
    }
    issued = onTime;
    rpc = await openNativeRpc(origin, issued.token, Math.min(RPC_OPEN_TIMEOUT_MS, Math.max(1, input.deadline - Date.now())));
    try {
      await rpc.request(DISPATCH_COMMAND, {
        type: "thread.stop",
        commandId: randomUUID(),
        threadId: input.threadId,
        reason: "Paperclip stopped this run.",
      }, remainingTimeoutMs(input.deadline));
    } catch (err) {
      const reason = redactToken(err instanceof Error ? err.message : String(err), issued.token);
      return `Could not stop T3 Code thread ${input.threadId}: ${reason}`;
    }
    for (;;) {
      if (Date.now() >= input.deadline) return notConfirmed();
      try {
        const projection = await rpc.request(
          GET_THREAD_PROJECTION,
          { threadId: input.threadId },
          remainingTimeoutMs(input.deadline),
        );
        if (isNativeThreadStopped(projection)) return null;
      } catch (err) {
        const reason = redactToken(err instanceof Error ? err.message : String(err), issued?.token ?? null);
        if (Date.now() >= input.deadline) {
          return `${notConfirmed()} ${reason}`.trim();
        }
      }
      if (Date.now() + pollMs >= input.deadline) {
        await sleep(Math.max(0, input.deadline - Date.now()));
      } else {
        await sleep(pollMs);
      }
    }
  } catch (err) {
    const reason = redactToken(err instanceof Error ? err.message : String(err), issued?.token ?? null);
    return `Could not confirm that T3 Code thread ${input.threadId} stopped: ${reason}`;
  } finally {
    rpc?.close();
    // Revocation must not stretch the stop window. It keeps running after the
    // deadline, and the session's 5-minute TTL bounds a revocation that fails.
    if (issued) {
      await Promise.race([
        revokeNativeSession(input, issued.sessionId),
        sleep(Math.max(0, input.deadline - Date.now())),
      ]);
    }
  }
}
