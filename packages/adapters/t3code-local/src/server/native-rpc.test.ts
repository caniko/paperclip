import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { isNativeThreadStopped, stopNativeThread } from "./native-rpc.js";

const FAKE_T3 = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = process.env.T3_FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "auth-calls.jsonl"), JSON.stringify({ args }) + "\\n");
if (args[0] === "auth" && args[1] === "session" && args[2] === "issue") {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ sessionId: "sess-1", token: "tok-secret" }, null, 2) + "\\n");
    process.exit(process.env.T3_FAKE_AUTH_EXIT ? Number(process.env.T3_FAKE_AUTH_EXIT) : 0);
  }, Number(process.env.T3_FAKE_ISSUE_DELAY_MS || 0));
  return;
}
const revokeDelay = args[2] === "revoke" ? Number(process.env.T3_FAKE_REVOKE_DELAY_MS || 0) : 0;
setTimeout(() => process.exit(process.env.T3_FAKE_AUTH_EXIT ? Number(process.env.T3_FAKE_AUTH_EXIT) : 0), revokeDelay);
`;

type StopFrame = { tag: string; payload: Record<string, unknown> };

const tempRoots: string[] = [];
const servers: WebSocketServer[] = [];

async function setup(options: {
  authExit?: number;
  runtime?: boolean;
  requireToken?: string;
  useT3Home?: boolean;
  homeOverride?: boolean;
  env?: Record<string, string>;
  stateFile?: (home: string) => string;
  dispatchError?: unknown;
  projectionError?: unknown;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-t3-native-rpc-"));
  tempRoots.push(root);
  const fakeDir = path.join(root, "fake");
  const home = path.join(root, "home");
  await fs.mkdir(fakeDir);
  await fs.mkdir(home, { recursive: true });
  const command = path.join(fakeDir, "t3");
  await fs.writeFile(command, FAKE_T3, { mode: 0o755 });
  const {
    T3CODE_HOME: _inheritedT3Home,
    VITE_DEV_SERVER_URL: _inheritedDevUrl,
    HOME: _inheritedHome,
    ...inheritedEnv
  } = process.env;

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  if (options.runtime !== false) {
    const statePath = options.stateFile?.(home) ?? path.join(home, "userdata", "server-runtime.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify({ version: 1, pid: process.pid, port, origin: `http://127.0.0.1:${port}` }),
    );
  }

  const frames: StopFrame[] = [];
  const authorizations: Array<string | undefined> = [];
  return {
    command,
    home,
    env: {
      ...inheritedEnv,
      ...(options.useT3Home === false ? {} : { T3CODE_HOME: home }),
      ...(options.homeOverride ? { HOME: home } : {}),
      T3_FAKE_DIR: fakeDir,
      ...(options.authExit ? { T3_FAKE_AUTH_EXIT: String(options.authExit) } : {}),
      ...options.env,
    } as Record<string, string>,
    frames,
    authorizations,
    authCalls: async () =>
      (await fs.readFile(path.join(fakeDir, "auth-calls.jsonl"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[] }),
    serve(projections: unknown[]) {
      server.on("connection", (socket, request) => {
        authorizations.push(request.headers.authorization);
        if (options.requireToken && request.headers.authorization !== `Bearer ${options.requireToken}`) {
          socket.close(1008);
          return;
        }
        socket.on("message", (data) => {
          const request = JSON.parse(data.toString()) as StopFrame & { _tag: string; id: string };
          frames.push({ tag: request.tag, payload: request.payload });
          const failure = request.tag === "orchestration.dispatchCommand"
            ? options.dispatchError
            : request.tag === "orchestration.getThreadProjection"
              ? options.projectionError
              : undefined;
          if (failure !== undefined) {
            socket.send(JSON.stringify({
              _tag: "Exit",
              requestId: request.id,
              exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: failure }] },
            }));
            return;
          }
          const value = request.tag === "orchestration.dispatchCommand"
            ? { sequence: 1 }
            : (projections.length > 1 ? projections.shift() : projections[0]) ?? { runs: [], providerTurns: [], subagents: [] };
          socket.send(JSON.stringify({
            _tag: "Exit",
            requestId: request.id,
            exit: { _tag: "Success", value },
          }));
        });
      });
    },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    for (const client of server.clients) client.terminate();
    server.close(() => resolve());
  })));
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const active = { runs: [{ status: "running" }], providerTurns: [{ status: "running" }], subagents: [] };
const stopped = {
  runs: [{ status: "interrupted" }],
  providerTurns: [{ status: "interrupted" }],
  subagents: [{ status: "cancelled" }],
};

describe("native T3 RPC stop", () => {
  it("dispatches thread.stop and polls the projection until it is idle", async () => {
    const env = await setup();
    env.serve([active, stopped]);
    const error = await stopNativeThread({
      runId: "run-1",
      command: env.command,
      cwd: os.tmpdir(),
      env: env.env,
      threadId: "thr-1",
      deadline: Date.now() + 3_000,
      pollMs: 10,
    });

    expect(error).toBeNull();
    expect(env.authorizations).toEqual(["Bearer tok-secret"]);
    expect(env.frames.map((frame) => frame.tag)).toEqual([
      "orchestration.dispatchCommand",
      "orchestration.getThreadProjection",
      "orchestration.getThreadProjection",
    ]);
    expect(env.frames[0]!.payload).toMatchObject({
      type: "thread.stop",
      threadId: "thr-1",
      reason: "Paperclip stopped this run.",
    });
    expect(env.frames[0]!.payload.commandId).toEqual(expect.any(String));
    expect(env.frames[1]!.payload).toEqual({ threadId: "thr-1" });

    const calls = await env.authCalls();
    expect(calls.map((call) => call.args.slice(0, 3))).toEqual([
      ["auth", "session", "issue"],
      ["auth", "session", "revoke"],
    ]);
    expect(calls[0]!.args).toEqual(expect.arrayContaining([
      "--scope", "orchestration:read", "--scope", "orchestration:operate", "--json",
    ]));
    expect(calls[1]!.args).toEqual(["auth", "session", "revoke", "sess-1"]);
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain("tok-secret");
    expect(JSON.stringify(env.frames)).not.toContain("tok-secret");
  });

  it("reads the default ~/.t3 state directory when HOME is inherited", async () => {
    const env = await setup({
      useT3Home: false,
      stateFile: (home) => path.join(home, ".t3", "userdata", "server-runtime.json"),
    });
    vi.stubEnv("HOME", env.home);
    vi.stubEnv("T3CODE_HOME", "");
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    env.serve([stopped]);

    const error = await stopNativeThread({
      runId: "run-1",
      command: env.command,
      cwd: os.tmpdir(),
      env: env.env,
      threadId: "thr-1",
      deadline: Date.now() + 2_000,
      pollMs: 10,
    });

    expect(error).toBeNull();
    expect(env.authorizations).toEqual(["Bearer tok-secret"]);
  });

  it("reads ~/.t3 under an adapter HOME override", async () => {
    const env = await setup({
      useT3Home: false,
      homeOverride: true,
      stateFile: (home) => path.join(home, ".t3", "userdata", "server-runtime.json"),
    });
    vi.stubEnv("T3CODE_HOME", "");
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    env.serve([stopped]);

    const error = await stopNativeThread({
      runId: "run-1",
      command: env.command,
      cwd: os.tmpdir(),
      env: env.env,
      threadId: "thr-1",
      deadline: Date.now() + 2_000,
      pollMs: 10,
    });

    expect(error).toBeNull();
    expect(env.authorizations).toEqual(["Bearer tok-secret"]);
  });

  it("expands a tilde T3CODE_HOME against the adapter HOME", async () => {
    const env = await setup({
      homeOverride: true,
      env: { T3CODE_HOME: "~/t3-base" },
      stateFile: (home) => path.join(home, "t3-base", "userdata", "server-runtime.json"),
    });
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    env.serve([stopped]);

    const error = await stopNativeThread({
      runId: "run-1",
      command: env.command,
      cwd: os.tmpdir(),
      env: env.env,
      threadId: "thr-1",
      deadline: Date.now() + 2_000,
      pollMs: 10,
    });

    expect(error).toBeNull();
    expect(env.authorizations).toEqual(["Bearer tok-secret"]);
  });

  it.each(["method not found", "resource not found", "Thread thr-1 was not found."])(
    "does not treat %s as a confirmed stop",
    async (message) => {
      const env = await setup({ dispatchError: { message } });
      env.serve([stopped]);

      const error = await stopNativeThread({
        runId: "run-1",
        command: env.command,
        cwd: os.tmpdir(),
        env: env.env,
        threadId: "thr-1",
        deadline: Date.now() + 2_000,
        pollMs: 10,
      });

      expect(error).not.toBeNull();
      expect(error).toContain(message);
      expect((await env.authCalls()).at(-1)!.args).toEqual(["auth", "session", "revoke", "sess-1"]);
    },
  );

  it("does not confirm a stop when the projection request fails", async () => {
    const env = await setup({ projectionError: { message: "resource not found" } });
    env.serve([stopped]);

    const error = await stopNativeThread({
      runId: "run-1",
      command: env.command,
      cwd: os.tmpdir(),
      env: env.env,
      threadId: "thr-1",
      deadline: Date.now() + 300,
      pollMs: 20,
    });

    expect(error).toContain("did not confirm within");
    expect(env.frames[0]!.tag).toBe("orchestration.dispatchCommand");
    expect(env.frames.some((frame) => frame.tag === "orchestration.getThreadProjection")).toBe(true);
    // Revocation continues after the stop window closes.
    await vi.waitFor(async () =>
      expect((await env.authCalls()).at(-1)!.args).toEqual(["auth", "session", "revoke", "sess-1"]));
  });

  it("keeps the stop unverified while the projection still has an active run", async () => {
    // A slow revocation must not hold the reported stop past its deadline.
    const env = await setup({ env: { T3_FAKE_REVOKE_DELAY_MS: "1500" } });
    env.serve([active]);
    const deadline = Date.now() + 300;
    const error = await stopNativeThread({
      runId: "run-1",
      command: env.command,
      cwd: os.tmpdir(),
      env: env.env,
      threadId: "thr-1",
      deadline,
      pollMs: 20,
    });

    expect(error).toContain("T3 Code did not confirm within 1s that thread thr-1 stopped.");
    // Session revocation must not extend the stop window it reports on.
    expect(Date.now() - deadline).toBeLessThan(250);
    expect(env.frames[0]!.tag).toBe("orchestration.dispatchCommand");
    await vi.waitFor(async () =>
      expect((await env.authCalls()).at(-1)!.args).toEqual(["auth", "session", "revoke", "sess-1"]));
  });

  it("waits for a delayed background interruption before confirming the stop", async () => {
    const env = await setup();
    const interruptedRunWithBackgroundWork = {
      runs: [{ status: "interrupted" }],
      providerTurns: [{ status: "interrupted" }],
      subagents: [],
      providerThreads: [{ status: "active", pendingBackgroundTasks: [{ taskId: "task-1", kind: "command" }] }],
      turnItems: [{ type: "command_execution", status: "running" }],
    };
    const drained = {
      runs: [{ status: "interrupted" }],
      providerTurns: [{ status: "interrupted" }],
      subagents: [],
      providerThreads: [{ status: "idle", pendingBackgroundTasks: [] }],
      turnItems: [{ type: "command_execution", status: "interrupted" }],
    };
    env.serve([interruptedRunWithBackgroundWork, interruptedRunWithBackgroundWork, drained]);

    const error = await stopNativeThread({
      runId: "run-1",
      command: env.command,
      cwd: os.tmpdir(),
      env: env.env,
      threadId: "thr-1",
      deadline: Date.now() + 2_000,
      pollMs: 20,
    });

    expect(error).toBeNull();
    // One projection showed the terminal run with live background work; the stop
    // is only confirmed after a later projection drains it.
    const reads = env.frames.filter((frame) => frame.tag === "orchestration.getThreadProjection");
    expect(reads.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the stop unverified when a background interruption fails", async () => {
    const env = await setup();
    env.serve([{
      runs: [{ status: "interrupted" }],
      providerTurns: [{ status: "interrupted" }],
      subagents: [],
      providerThreads: [{ status: "active", pendingBackgroundTasks: [{ taskId: "task-1", kind: "command" }] }],
      turnItems: [{ type: "command_execution", status: "running" }],
    }]);

    const error = await stopNativeThread({
      runId: "run-1",
      command: env.command,
      cwd: os.tmpdir(),
      env: env.env,
      threadId: "thr-1",
      deadline: Date.now() + 400,
      pollMs: 20,
    });

    expect(error).toContain("T3 Code did not confirm within 1s that thread thr-1 stopped.");
    expect(env.frames.some((frame) => frame.tag === "orchestration.getThreadProjection")).toBe(true);
  });

  it("stops waiting for a slow auth helper at the deadline and revokes the late session", async () => {
    const env = await setup({ env: { T3_FAKE_ISSUE_DELAY_MS: "700" } });
    env.serve([stopped]);
    const deadline = Date.now() + 300;
    const error = await stopNativeThread({
      runId: "run-1",
      command: env.command,
      cwd: os.tmpdir(),
      env: env.env,
      threadId: "thr-1",
      deadline,
      pollMs: 20,
    });

    expect(error).toContain("did not confirm within");
    expect(Date.now() - deadline).toBeLessThan(250);
    expect(env.frames).toEqual([]);
    await vi.waitFor(async () =>
      expect((await env.authCalls()).at(-1)!.args).toEqual(["auth", "session", "revoke", "sess-1"]), { timeout: 3000 });
  });

  it("does not connect when it cannot issue an auth session", async () => {
    const env = await setup({ authExit: 1 });
    env.serve([stopped]);
    const error = await stopNativeThread({
      runId: "run-1",
      command: env.command,
      cwd: os.tmpdir(),
      env: env.env,
      threadId: "thr-1",
      deadline: Date.now() + 2_000,
      pollMs: 10,
    });

    expect(error).toContain("Could not confirm that T3 Code thread thr-1 stopped");
    expect(env.authorizations).toEqual([]);
    expect(env.frames).toEqual([]);
  });

  it("reports an unverified stop when the server rejects the bearer session", async () => {
    const env = await setup({ requireToken: "a-different-token" });
    env.serve([stopped]);
    const error = await stopNativeThread({
      runId: "run-1",
      command: env.command,
      cwd: os.tmpdir(),
      env: env.env,
      threadId: "thr-1",
      deadline: Date.now() + 2_000,
      pollMs: 10,
    });

    expect(error).toMatch(/^Could not (stop|confirm) T3 Code thread thr-1/);
    expect(error).not.toContain("tok-secret");
    expect(env.authorizations).toEqual(["Bearer tok-secret"]);
    expect((await env.authCalls()).at(-1)!.args).toEqual(["auth", "session", "revoke", "sess-1"]);
  });

  it("does not connect without a running server runtime state", async () => {
    const env = await setup({ runtime: false });
    env.serve([stopped]);
    const error = await stopNativeThread({
      runId: "run-1",
      command: env.command,
      cwd: os.tmpdir(),
      env: env.env,
      threadId: "thr-1",
      deadline: Date.now() + 2_000,
      pollMs: 10,
    });

    expect(error).toContain("Could not find the running T3 Code server");
    expect(env.authorizations).toEqual([]);
    expect(await env.authCalls()).toEqual([]);
  });
});

describe("native thread projection state", () => {
  it("confirms only known inactive statuses and fails closed on unknown strings", () => {
    expect(isNativeThreadStopped(stopped)).toBe(true);
    for (const status of ["queued", "completed", "interrupted", "failed", "cancelled", "rolled_back"]) {
      expect(isNativeThreadStopped({ runs: [{ status }], providerTurns: [], subagents: [] })).toBe(true);
    }
    for (const status of ["completed", "interrupted", "failed", "cancelled"]) {
      expect(isNativeThreadStopped({ runs: [], providerTurns: [{ status }], subagents: [] })).toBe(true);
    }
    for (const status of ["idle", "completed", "failed", "cancelled", "interrupted"]) {
      expect(isNativeThreadStopped({ runs: [], providerTurns: [], subagents: [{ status }] })).toBe(true);
    }

    expect(isNativeThreadStopped({ runs: [{ status: "waiting" }], providerTurns: [], subagents: [] })).toBe(false);
    expect(isNativeThreadStopped(active)).toBe(false);
    expect(isNativeThreadStopped({ runs: [], providerTurns: [{ status: "running" }], subagents: [] })).toBe(false);
    expect(isNativeThreadStopped({ runs: [], providerTurns: [], subagents: [{ status: "waiting" }] })).toBe(false);

    expect(isNativeThreadStopped({ runs: [{ status: "new_unknown_state" }], providerTurns: [], subagents: [] })).toBe(false);
    expect(isNativeThreadStopped({ runs: [], providerTurns: [{ status: "new_unknown_state" }], subagents: [] })).toBe(false);
    expect(isNativeThreadStopped({ runs: [], providerTurns: [], subagents: [{ status: "new_unknown_state" }] })).toBe(false);
    expect(isNativeThreadStopped(null)).toBe(false);
    expect(isNativeThreadStopped({})).toBe(false);
    expect(isNativeThreadStopped({ runs: [{}], providerTurns: [], subagents: [] })).toBe(false);
  });

  it("holds the stop while background work drains and fails closed when it does not", () => {
    const settled = { runs: [{ status: "interrupted" }], providerTurns: [], subagents: [] };
    const pendingTask = { taskId: "task-1", kind: "command", description: "npm test" };

    // A terminal run can still own a pending background task on its provider thread.
    expect(isNativeThreadStopped({
      ...settled,
      providerThreads: [{ status: "active", pendingBackgroundTasks: [pendingTask] }],
    })).toBe(false);
    expect(isNativeThreadStopped({
      ...settled,
      providerThreads: [{ status: "active", pendingBackgroundTasks: [] }],
    })).toBe(false);
    expect(isNativeThreadStopped({
      ...settled,
      providerThreads: [{ status: "idle", pendingBackgroundTasks: [pendingTask] }],
    })).toBe(false);
    // The thread shell carries the same list when the server exposes it.
    expect(isNativeThreadStopped({ ...settled, thread: { pendingBackgroundTasks: [pendingTask] } })).toBe(false);
    // A command item stays active after its run reached a terminal state.
    for (const status of ["pending", "running", "waiting"]) {
      expect(isNativeThreadStopped({
        ...settled,
        turnItems: [{ type: "command_execution", status }],
      })).toBe(false);
    }

    expect(isNativeThreadStopped({
      ...settled,
      thread: { pendingBackgroundTasks: [] },
      providerThreads: [{ status: "idle", pendingBackgroundTasks: [] }],
      turnItems: [{ type: "command_execution", status: "completed" }, { type: "assistant_message" }],
    })).toBe(true);
  });

  it("treats a missing or unknown background status as still running", () => {
    const settled = { runs: [{ status: "interrupted" }], providerTurns: [], subagents: [] };

    // Command items: only known inactive statuses settle; missing and unknown fail closed.
    expect(isNativeThreadStopped({ ...settled, turnItems: [{ type: "command_execution" }] })).toBe(false);
    expect(isNativeThreadStopped({
      ...settled,
      turnItems: [{ type: "command_execution", status: "new_unknown_state" }],
    })).toBe(false);
    // Provider threads: same rule for the thread status.
    expect(isNativeThreadStopped({ ...settled, providerThreads: [{ pendingBackgroundTasks: [] }] })).toBe(false);
    expect(isNativeThreadStopped({
      ...settled,
      providerThreads: [{ status: "new_unknown_state", pendingBackgroundTasks: [] }],
    })).toBe(false);

    // Every known terminal status still confirms.
    for (const status of ["idle", "completed", "failed", "cancelled", "interrupted"]) {
      expect(isNativeThreadStopped({ ...settled, turnItems: [{ type: "command_execution", status }] })).toBe(true);
    }
    for (const status of ["not_loaded", "idle", "archived", "closed", "error"]) {
      expect(isNativeThreadStopped({
        ...settled,
        providerThreads: [{ status, pendingBackgroundTasks: [] }],
      })).toBe(true);
    }
  });
});
