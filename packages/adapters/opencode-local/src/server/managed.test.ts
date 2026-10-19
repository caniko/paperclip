import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runAdapterExecutionTargetProcess: vi.fn(),
}));

import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { execute } from "./execute.js";
import { reconcileExecution } from "./managed.js";

const control = vi.mocked(runAdapterExecutionTargetProcess);
const directories: string[] = [];
afterEach(async () => {
  control.mockReset();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-opencode-"));
  directories.push(cwd);
  const signal = new AbortController();
  const operations: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  let checkpoint: Record<string, unknown> = {};
  let generation = "generation-1";
  let statuses = 0;
  const stopped = vi.fn(async () => {});
  const ctx: AdapterExecutionContext = {
    runId: "managed-run",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "OpenCode",
      adapterType: "opencode_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      managedService: true,
      dangerouslySkipPermissions: false,
      cwd,
      model: "openai/gpt-6.1-sol",
      timeoutSec: 30,
    },
    context: { paperclipTaskMarkdown: "Owned task" },
    authToken: "paperclip-token",
    signal: signal.signal,
    onLog: vi.fn(async () => {}),
    onProviderStopped: stopped,
    onExecutionCheckpoint: async (value) => {
      operations.push("checkpoint");
      checkpoint = value;
    },
    onCancellationReady: async () => {
      operations.push("cancellation-ready");
    },
    onExecutionProgress: vi.fn(async () => {}),
  };
  const receipt = (operation: string, request: Record<string, unknown>) => {
    const body = JSON.parse(String(request.body));
    return {
      version: 1,
      key: request.key,
      bodySha256: createHash("sha256").update(String(request.body)).digest("hex"),
      backendID: "backend-1",
      backendGeneration: generation,
      sessionID: body.sessionID,
      inputID: body.inputID,
      admitted: operation !== "stop",
      stopRequested: operation === "stop",
      settled: operation === "stop" || (operation === "status" && statuses > 1),
      lineage: [
        {
          sessionID: body.sessionID,
          active: false,
          pending: 0,
          suspended: false,
          outcome: operation === "stop" ? "interrupted" : "succeeded",
        },
      ],
      result: {
        summary: "Finished owned task",
        costUsd: 0.25,
        tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
      },
    };
  };
  control.mockImplementation(async (_run, _target, _command, args, options) => {
    const operation = args.at(-1)!;
    operations.push(operation);
    expect(args.slice(0, 2)).toEqual(["session", "external"]);
    expect(options.env).toEqual({});
    const request = options.stdin ? JSON.parse(options.stdin) : {};
    requests.push(request);
    if (operation === "status") {
      statuses++;
      if (statuses === 1) generation = "generation-2";
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      pid: null,
      startedAt: new Date().toISOString(),
      stderr: "",
      stdout: JSON.stringify(
        operation === "info"
          ? { version: 1, backendID: "backend-1", backendGeneration: generation }
          : receipt(operation, request),
      ),
    };
  });
  return { ctx, signal, operations, requests, stopped, checkpoint: () => checkpoint, receipt };
}

it("checkpoints exact admission before dispatch and uses the managed backend without a CLI model process", async () => {
  const f = await fixture();
  const result = await execute(f.ctx);
  expect(result.exitCode).toBe(0);
  expect(result.summary).toBe("Finished owned task");
  expect(f.operations.slice(0, 4)).toEqual(["info", "checkpoint", "cancellation-ready", "admit"]);
  expect(f.operations.filter((value) => value === "admit")).toHaveLength(1);
  expect(f.requests.filter((value) => value.backendGeneration).map((value) => value.backendGeneration)).toEqual([
    "generation-1",
    "generation-2",
  ]);
  const checkpoint = f.checkpoint();
  expect(checkpoint).toMatchObject({ version: 1, kind: "opencode_managed", backendID: "backend-1" });
  expect(checkpoint.bodySha256).toBe(createHash("sha256").update(String(checkpoint.body)).digest("hex"));
  const body = JSON.parse(String(checkpoint.body));
  expect(body.environment.PAPERCLIP_API_KEY).toBe("paperclip-token");
  expect(body.prompt.text).toContain("Owned task");
  expect(body.environment).not.toHaveProperty("HOME");
  expect(body.environment).not.toHaveProperty("XDG_CONFIG_HOME");
  expect(f.requests.filter((value) => value.body).every((value) => value.body === checkpoint.body)).toBe(true);
  expect(f.stopped).toHaveBeenCalledOnce();
});

it("sends Stop-before-admit on cancellation with the checkpoint's original key and bytes", async () => {
  const f = await fixture();
  f.ctx.onCancellationReady = async () => {
    f.signal.abort();
  };
  const result = await execute(f.ctx);
  expect(result.signal).toBe("SIGTERM");
  expect(f.operations).not.toContain("admit");
  expect(f.operations).toContain("stop");
  expect(f.requests.at(-1)).toMatchObject({ key: f.checkpoint().key, body: f.checkpoint().body });
  expect(f.stopped).toHaveBeenCalledOnce();
});

it("reconciles controller recovery from the immutable checkpoint and refuses changed bytes", async () => {
  const f = await fixture();
  await execute(f.ctx);
  expect(await reconcileExecution(f.checkpoint())).toBe("settled");
  expect(f.requests.at(-1)).toMatchObject({ key: f.checkpoint().key, body: f.checkpoint().body });
  const before = control.mock.calls.length;
  expect(await reconcileExecution({ ...f.checkpoint(), body: `${f.checkpoint().body} ` })).toBe("pending");
  expect(control.mock.calls).toHaveLength(before);
});

it("keeps an uncertain Stop pending and rejects another backend's settlement", async () => {
  const f = await fixture();
  await execute(f.ctx);
  control.mockResolvedValueOnce({
    exitCode: 255,
    signal: null,
    timedOut: false,
    pid: null,
    startedAt: new Date().toISOString(),
    stderr: "",
    stdout: "",
  });
  expect(await reconcileExecution(f.checkpoint())).toBe("pending");
  control.mockImplementationOnce(async (_run, _target, _command, _args, options) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    pid: null,
    startedAt: new Date().toISOString(),
    stderr: "",
    stdout: JSON.stringify({ ...f.receipt("stop", JSON.parse(options.stdin!)), backendID: "other-backend" }),
  }));
  expect(await reconcileExecution(f.checkpoint())).toBe("pending");
});

it("retains ownership when Stop cannot prove settlement after a live cancellation", async () => {
  const f = await fixture();
  f.ctx.onExecutionProgress = async () => {
    f.signal.abort();
  };
  const implementation = control.getMockImplementation()!;
  control.mockImplementation(async (...args) => {
    const result = await implementation(...args);
    return args[3].at(-1) === "stop"
      ? { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), settled: false }) }
      : result;
  });
  await expect(execute(f.ctx)).rejects.toMatchObject({ code: "opencode_managed_stop_pending" });
  expect(f.operations.filter((value) => value === "admit")).toHaveLength(1);
  expect(f.operations.at(-1)).toBe("stop");
  expect(f.stopped).not.toHaveBeenCalled();
});

it("requires durable lifecycle hooks and preserves personal permission configuration", async () => {
  const f = await fixture();
  await expect(execute({ ...f.ctx, onExecutionCheckpoint: undefined })).rejects.toThrow(/checkpoint/i);
  await expect(execute({ ...f.ctx, config: { ...f.ctx.config, dangerouslySkipPermissions: true } })).rejects.toThrow(
    /permission/i,
  );
  expect(control).not.toHaveBeenCalled();
});
