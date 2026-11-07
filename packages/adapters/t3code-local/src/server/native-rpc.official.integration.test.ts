import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { stopNativeThread } from "./native-rpc.js";

// Opt-in proof against a real, official T3 Code CLI. Set PAPERCLIP_T3_OFFICIAL_CLI
// to the `t3` binary; the test skips entirely otherwise. The advertised build is
// fixed here so a different binary cannot silently satisfy the proof.
const OFFICIAL_CLI = process.env.PAPERCLIP_T3_OFFICIAL_CLI?.trim() ?? "";
const OFFICIAL_VERSION = "0.1.8-nightly.20261107.4327";
// The caller may point this at a private scratch parent. The test creates one
// fresh child directory there and keeps all runtime state inside that child.
const PROOF_PARENT = process.env.PAPERCLIP_T3_PROOF_ROOT?.trim() || os.tmpdir();
const PROTOCOL_VERSION = "2";
const READ_SCOPE = "orchestration:read";
const OPERATE_SCOPE = "orchestration:operate";

type RpcFrame = Record<string, unknown>;

interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface RuntimeState {
  pid: number;
  port: number;
  origin: string;
  serverVersion?: string;
}

interface IssuedSession {
  sessionId: string;
  token: string;
}

const runOfficial = OFFICIAL_CLI.length > 0 ? describe : describe.skip;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): RpcFrame | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RpcFrame)
    : null;
}

function parseJsonOutput(text: string, label: string): unknown {
  const start = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const from = start === -1 ? arrayStart : arrayStart === -1 ? start : Math.min(start, arrayStart);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (from === -1 || end <= from) throw new Error(`${label} returned no JSON.`);
  try {
    return JSON.parse(text.slice(from, end + 1));
  } catch {
    throw new Error(`${label} returned no JSON.`);
  }
}

function cliStatus(result: CliResult): string {
  return result.code !== null ? `exit ${result.code}` : `signal ${result.signal ?? "unknown"}`;
}

// Never echo issuance output: native output can contain a bearer token.
function authIssueFailure(result: CliResult): Error {
  return new Error(`T3 Code auth session issue failed (${cliStatus(result)}).`);
}

function parseIssuedSessionOutput(text: string): IssuedSession {
  const issued = asRecord(parseJsonOutput(text, "T3 Code auth session issue"));
  if (!issued || typeof issued.sessionId !== "string" || typeof issued.token !== "string") {
    throw new Error("T3 Code auth session issue returned unexpected JSON.");
  }
  return { sessionId: issued.sessionId, token: issued.token };
}

runOfficial("official T3 Code native RPC integration", () => {
  let root = "";
  let cli = OFFICIAL_CLI;
  let baseDir = "";
  let workspace = "";
  let home = "";
  let env: Record<string, string> = {};
  let child: ChildProcess | null = null;
  let pid: number | null = null;
  let origin = "";
  let projectId = "";
  let threadId = "";
  let versionOutput = "";
  let cliLauncherSha256 = "";
  let serverRuntime: RuntimeState | null = null;
  let setupComplete = false;
  const observed: RpcFrame[] = [];

  const ownedRoot = (): boolean =>
    Boolean(root) && path.dirname(path.resolve(root)) === path.resolve(PROOF_PARENT);

  const ownedPath = (candidate: string): boolean => {
    if (!root) return false;
    const base = path.resolve(root);
    const resolved = path.resolve(candidate);
    return resolved !== base && resolved.startsWith(`${base}${path.sep}`);
  };

  const runCli = (args: string[], timeoutMs = 30_000): Promise<CliResult> =>
    new Promise((resolve, reject) => {
      const proc = spawn(cli, args, {
        cwd: workspace,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`${cli} ${args.join(" ")} did not finish within ${timeoutMs}ms`));
      }, timeoutMs);
      proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.once("error", (error) => { clearTimeout(timer); reject(error); });
      proc.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    });

  const issueSession = async (scopes: string[]): Promise<IssuedSession> => {
    const result = await runCli([
      "auth", "session", "issue",
      ...scopes.flatMap((scope) => ["--scope", scope]),
      "--ttl", "5m",
      "--label", "paperclip official proof",
      "--base-dir", baseDir,
      "--json",
    ]);
    if (result.code !== 0) throw authIssueFailure(result);
    return parseIssuedSessionOutput(result.stdout);
  };

  const revokeSession = async (sessionId: string): Promise<void> => {
    const result = await runCli(["auth", "session", "revoke", sessionId, "--base-dir", baseDir]);
    if (result.code !== 0 || !result.stdout.includes(`Revoked session ${sessionId}`)) {
      throw new Error(`T3 Code auth session revoke failed (${cliStatus(result)}).`);
    }
  };

  const listSessionIds = async (): Promise<string[]> => {
    const result = await runCli(["auth", "session", "list", "--base-dir", baseDir, "--json"]);
    if (result.code !== 0) {
      throw new Error(`T3 Code auth session list failed (${cliStatus(result)}).`);
    }
    const sessions = parseJsonOutput(result.stdout, "T3 Code auth session list");
    if (!Array.isArray(sessions)) {
      throw new Error("T3 Code auth session list returned unexpected JSON.");
    }
    return sessions.flatMap((session: unknown) => {
      const record = asRecord(session);
      return typeof record?.sessionId === "string" ? [record.sessionId] : [];
    });
  };

  const rpc = (
    token: string,
    tag: string,
    payload: unknown,
    timeoutMs = 10_000,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const url = new URL("/ws", origin);
      url.searchParams.set("orchestrationProtocol", PROTOCOL_VERSION);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const requestId = randomUUID();
      const ws = new WebSocket(url, {
        headers: { authorization: `Bearer ${token}` },
        handshakeTimeout: timeoutMs,
      });
      let settled = false;
      const finish = (error: Error | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          ws.once("error", () => {});
          ws.terminate();
          reject(error);
        } else {
          ws.close();
          resolve(value);
        }
      };
      const timer = setTimeout(() => finish(new Error(`RPC ${tag} timed out`)), timeoutMs);
      ws.once("unexpected-response", (_request, response) => {
        response.resume();
        finish(new Error(`RPC upgrade rejected (${response.statusCode ?? "unknown"})`));
      });
      ws.once("error", (error) => finish(new Error(`RPC connection failed: ${error.message}`)));
      ws.once("open", () => {
        ws.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
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
          if (!record) continue;
          if (record._tag === "ClientProtocolError" || record._tag === "Defect") {
            finish(new Error(`T3 Code rejected ${tag}: ${JSON.stringify(record).slice(0, 1000)}`));
            return;
          }
          if (record._tag !== "Exit" || String(record.requestId) !== requestId) continue;
          const exit = asRecord(record.exit);
          if (exit?._tag === "Success") {
            finish(null, exit.value);
          } else {
            finish(new Error(`T3 Code failed ${tag}: ${JSON.stringify(exit).slice(0, 1000)}`));
          }
          return;
        }
      });
    });

  const waitForRuntimeState = async (): Promise<RuntimeState> => {
    const statePath = path.join(baseDir, "userdata", "server-runtime.json");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child && child.exitCode !== null) {
        throw new Error(`t3 serve exited with ${child.exitCode} before writing runtime state:\n${await logTail()}`);
      }
      try {
        const state = asRecord(JSON.parse(await fs.readFile(statePath, "utf8")));
        if (
          state
          && typeof state.pid === "number"
          && typeof state.origin === "string"
          && typeof state.port === "number"
        ) {
          return state as unknown as RuntimeState;
        }
      } catch {
        // Not written yet.
      }
      await delay(100);
    }
    throw new Error(`t3 serve did not write ${statePath}:\n${await logTail()}`);
  };

  const logTail = async (): Promise<string> => {
    if (!root) return "";
    const read = async (name: string) =>
      (await fs.readFile(path.join(root, name), "utf8").catch(() => "")).slice(-4000);
    return `--- stdout ---\n${await read("serve.stdout.log")}\n--- stderr ---\n${await read("serve.stderr.log")}`;
  };

  const writeReceipt = async (setupDone: boolean): Promise<void> => {
    if (!root) return;
    await fs.writeFile(path.join(root, "receipt.json"), `${JSON.stringify({
      setupComplete: setupDone,
      cli,
      versionOutput,
      cliLauncherSha256,
      expectedVersion: OFFICIAL_VERSION,
      serverPid: pid,
      serverRuntime,
      origin,
      baseDir,
      workspace,
      home,
      projectId,
      threadId,
      observed,
    }, null, 2)}\n`);
  };

  beforeAll(async () => {
    const resolvedParent = path.resolve(PROOF_PARENT);
    const parentStat = await fs.stat(resolvedParent).catch(() => null);
    if (!parentStat?.isDirectory()) {
      throw new Error(`PAPERCLIP_T3_PROOF_ROOT must name an existing directory: ${resolvedParent}`);
    }
    root = await fs.mkdtemp(path.join(resolvedParent, "t3-native-proof-"));
    if (!ownedRoot()) {
      throw new Error(`Proof directory ${root} is not a fresh child of ${resolvedParent}.`);
    }
    baseDir = path.join(root, "base");
    workspace = path.join(root, "workspace");
    home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    await Promise.all([
      fs.mkdir(baseDir, { recursive: true }),
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(home, { recursive: true }),
      fs.mkdir(tmp, { recursive: true }),
    ]);

    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string"
          && !entry[0].startsWith("T3CODE_")
          && !entry[0].startsWith("XDG_")
          && entry[0] !== "HOME"
          && entry[0] !== "TMPDIR"
          && entry[0] !== "VITE_DEV_SERVER_URL",
      ),
    );
    env = {
      ...inherited,
      HOME: home,
      T3CODE_HOME: baseDir,
      T3CODE_TELEMETRY_ENABLED: "false",
      DO_NOT_TRACK: "1",
      TMPDIR: tmp,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      CI: "1",
    };

    const version = await runCli(["--version"]);
    expect(version.code).toBe(0);
    versionOutput = version.stdout.trim();
    expect(versionOutput).toContain(OFFICIAL_VERSION);
    // Hash the provided launcher file as-is. A Nix `bin/t3` wrapper may exec an
    // unwrapped payload, so this is not asserted to be the final executable.
    cliLauncherSha256 = createHash("sha256").update(await fs.readFile(cli)).digest("hex");

    const childEnv = env;
    child = spawn(cli, [
      "serve",
      "--base-dir", baseDir,
      "--host", "127.0.0.1",
      "--no-browser",
      workspace,
    ], {
      cwd: workspace,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    pid = child.pid ?? null;
    expect(pid).not.toBeNull();
    const stdoutLog = createWriteStream(path.join(root, "serve.stdout.log"));
    const stderrLog = createWriteStream(path.join(root, "serve.stderr.log"));
    child.stdout?.pipe(stdoutLog);
    child.stderr?.pipe(stderrLog);

    serverRuntime = await waitForRuntimeState();
    expect(serverRuntime.pid).toBe(pid);
    expect(serverRuntime.serverVersion ?? "").toContain(OFFICIAL_VERSION);
    const parsedOrigin = new URL(serverRuntime.origin);
    expect(["127.0.0.1", "localhost", "[::1]"].includes(parsedOrigin.hostname)).toBe(true);
    origin = serverRuntime.origin;

    const added = await runCli([
      "project", "add", workspace,
      "--title", "Paperclip native proof",
      "--base-dir", baseDir,
    ]);
    if (added.code !== 0) {
      throw new Error(`project add failed: ${(added.stderr || added.stdout).slice(0, 1000)}`);
    }
    const match = /Added project ([0-9a-f-]{36})/.exec(added.stdout);
    expect(match, added.stdout).not.toBeNull();
    projectId = match![1]!;

    threadId = randomUUID();
    const setupSession = await issueSession([READ_SCOPE, OPERATE_SCOPE]);
    try {
      await rpc(setupSession.token, "orchestration.dispatchCommand", {
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: randomUUID(),
        threadId,
        projectId,
        title: "Paperclip native proof (no provider turn)",
        // A nonexistent provider instance keeps any accidental launch from
        // reaching a real provider; thread.create never resolves it.
        modelSelection: { instanceId: "paperclip-proof-no-provider", model: "paperclip-proof-no-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      observed.push({ step: "thread.create", threadId, projectId });
    } finally {
      await revokeSession(setupSession.sessionId);
    }
    setupComplete = true;
    await writeReceipt(false);
  }, 120_000);

  afterAll(async () => {
    if (root && !ownedRoot()) {
      throw new Error(`Refusing cleanup outside the owned proof directory: ${root}`);
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, delay(10_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exited, delay(5_000)]);
      }
    }
    await writeReceipt(setupComplete);
  }, 30_000);

  it("runs the official 4327 CLI and serves a loopback-only instance from fresh scratch state", async () => {
    expect(versionOutput).toContain(`t3 v${OFFICIAL_VERSION}`);
    expect(cliLauncherSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(serverRuntime?.port).toBeGreaterThan(0);
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(ownedRoot()).toBe(true);
    for (const directory of [baseDir, workspace, home]) {
      expect(ownedPath(directory)).toBe(true);
    }
    observed.push({ step: "serve", pid, origin, serverVersion: serverRuntime?.serverVersion });
  });

  it("authenticates real projection reads and refuses a revoked bearer session", async () => {
    const session = await issueSession([READ_SCOPE, OPERATE_SCOPE]);
    const projection = asRecord(await rpc(session.token, "orchestration.getThreadProjection", { threadId }));
    expect(projection).not.toBeNull();
    expect(projection!.runs).toEqual([]);
    expect(projection!.providerTurns).toEqual([]);
    expect(projection!.subagents).toEqual([]);
    expect(asRecord(projection!.thread)).toMatchObject({ id: threadId, projectId });

    await revokeSession(session.sessionId);
    await expect(rpc(session.token, "orchestration.getThreadProjection", { threadId })).rejects.toThrow();
    observed.push({
      step: "projection+revoke",
      sessionId: session.sessionId,
      projectionKeys: Object.keys(projection!),
    });
  });

  it("rejects a read-only session on the operate method while keeping reads available", async () => {
    const readOnly = await issueSession([READ_SCOPE]);
    try {
      await expect(rpc(readOnly.token, "orchestration.getThreadProjection", { threadId })).resolves.toBeTruthy();
      let failure = "";
      try {
        await rpc(readOnly.token, "orchestration.dispatchCommand", {
          type: "thread.stop",
          commandId: randomUUID(),
          threadId,
          reason: "scope proof",
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toMatch(/orchestration:operate|scope|authoriz|permission/i);
      observed.push({ step: "read-only scope", failure });
    } finally {
      await revokeSession(readOnly.sessionId);
    }
  });

  it("confirms a stop on an idle native thread through the adapter API and revokes its session", async () => {
    const before = await listSessionIds();
    const error = await stopNativeThread({
      runId: "official-proof-idle",
      command: cli,
      cwd: workspace,
      env,
      threadId,
      deadline: Date.now() + 10_000,
      pollMs: 100,
    });
    const after = await listSessionIds();
    expect(error).toBeNull();
    expect(after.filter((id) => !before.includes(id))).toEqual([]);
    observed.push({
      step: "idle stop confirmed",
      threadId,
      sessionsBefore: before.length,
      sessionsAfter: after.length,
    });

    const verify = await issueSession([READ_SCOPE]);
    try {
      const projection = asRecord(await rpc(verify.token, "orchestration.getThreadProjection", { threadId }));
      expect(projection).not.toBeNull();
    } finally {
      await revokeSession(verify.sessionId);
    }
  }, 30_000);

  it("returns a real projection error for a missing thread instead of an idle projection", async () => {
    const session = await issueSession([READ_SCOPE]);
    try {
      let failure = "";
      try {
        await rpc(session.token, "orchestration.getThreadProjection", { threadId: randomUUID() });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toMatch(/ProjectionStoreThreadNotFound|No orchestration projection exists/);
      observed.push({ step: "missing projection fails closed", failure });
    } finally {
      await revokeSession(session.sessionId);
    }
  }, 30_000);

  it("fails closed on a missing thread without leaving a session behind", async () => {
    const missingThreadId = randomUUID();
    const before = await listSessionIds();
    const startedAt = Date.now();
    const error = await stopNativeThread({
      runId: "official-proof-missing",
      command: cli,
      cwd: workspace,
      env,
      threadId: missingThreadId,
      deadline: Date.now() + 5_000,
      pollMs: 100,
    });
    const elapsedMs = Date.now() - startedAt;
    const after = await listSessionIds();
    expect(error).not.toBeNull();
    expect(error).toContain(missingThreadId);
    expect(after.filter((id) => !before.includes(id))).toEqual([]);
    observed.push({
      step: "missing thread unverified",
      error,
      elapsedMs,
      sessionsBefore: before.length,
      sessionsAfter: after.length,
    });
  }, 30_000);
});

describe("T3 auth issue diagnostics", () => {
  const bearer = "bearer-token-that-must-not-leak";

  it("does not echo issuance output or tokens when issue fails or JSON is unusable", () => {
    const failed = authIssueFailure({
      code: 17,
      signal: null,
      stdout: `{"token":"${bearer}"}`,
      stderr: `token ${bearer}`,
    });
    expect(failed.message).toBe("T3 Code auth session issue failed (exit 17).");
    expect(failed.message).not.toContain(bearer);

    let malformedError: unknown;
    try {
      parseIssuedSessionOutput(`not json ${bearer}`);
    } catch (error) {
      malformedError = error;
    }
    expect(String(malformedError)).toContain("returned no JSON");
    expect(String(malformedError)).not.toContain(bearer);

    let shapeError: unknown;
    try {
      parseIssuedSessionOutput(JSON.stringify({ sessionId: "session-1", echoed: bearer }));
    } catch (error) {
      shapeError = error;
    }
    expect(String(shapeError)).toContain("unexpected JSON");
    expect(String(shapeError)).not.toContain(bearer);
  });
});
