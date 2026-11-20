import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runAdapterExecutionTargetProcess: vi.fn(),
}));

import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { executeManaged, reconcileExecution, validateManagedConfig } from "./managed.js";

const run = vi.mocked(runAdapterExecutionTargetProcess);
afterEach(() => {
  run.mockReset();
  vi.unstubAllGlobals();
});

function fixture(target: AdapterExecutionTarget | null = null, files = ["/workspace/a b.txt"]) {
  const operations: string[] = [];
  const stopped = vi.fn();
  const signal = new AbortController();
  let checkpoint: Record<string, unknown> = {};
  let root: Record<string, unknown> | undefined;
  let prompt: Record<string, unknown> | undefined;
  let pid = 42;
  let discoveredPID = pid;
  let inbox: Array<Record<string, unknown>> = [];
  let active = false;
  let busyChild = false;
  let jobs = false;
  let backendID = "upstream:db";
  let admissionLost = 0;
  let restartOnLoss = false;
  const ctx = {
    runId: "run",
    agent: { companyId: "company", id: "agent" },
    config: { model: "openai/gpt-6.1-sol", timeoutSec: 5 },
    signal: signal.signal,
    onExecutionCheckpoint: async (value: Record<string, unknown>) => {
      operations.push("checkpoint");
      checkpoint = value;
    },
    onCancellationReady: async () => { operations.push("ready"); },
    onExecutionProgress: vi.fn(async () => {}),
  } as unknown as AdapterExecutionContext;
  run.mockImplementation(async (_run, site, command, args, options) => {
    const request = JSON.parse(options.stdin!);
    expect(site).toEqual(target ?? { kind: "local" });
    expect(command).toBe("node");
    expect(args[0]).toBe("-e");
    operations.push(request.operation);
    if (request.operation === "discover") discoveredPID = pid;
    if (request.operation === "environment") {
      expect(request.pid).toBe(pid);
      expect(request.variables).toEqual({ PAPERCLIP_API_KEY: "run-token" });
    }
    let stdout = "";
    if (request.operation === "discover")
      stdout = JSON.stringify({ url: "http://127.0.0.1:4096", password: "private", pid, backendID, generation: `pid-${pid}` });
    if (request.operation === "request") {
      const response = await http(new URL(request.route, request.url), {
        method: request.method,
        redirect: "error",
        headers: { authorization: `Basic ${Buffer.from(`opencode:${request.password}`).toString("base64")}` },
        body: request.payload === undefined ? undefined : JSON.stringify(request.payload),
      });
      stdout = JSON.stringify({ status: response.status, body: response.status !== 204 ? await response.json() : null });
    }
    return {
      exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: "", stderr: "",
      stdout,
    };
  });
  const http = vi.fn(async (url: URL, init: RequestInit) => {
    expect(new Headers(init.headers).get("authorization")).toBe("Basic " + Buffer.from("opencode:private").toString("base64"));
    expect(init.redirect).toBe("error");
    const method = init.method ?? "GET";
    const route = url.pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    operations.push(`${method} ${route}`);
    const json = (data: unknown) => Response.json({ data });
    const empty = () => new Response(null, { status: 204 });
    if (route === "/api/info") return Response.json({ version: "2.3.2", pid });
    if (route === "/api/session/active") return json(active ? { [String(root?.id)]: { type: "running" } } : {});
    if (route === "/api/session" && method === "POST") {
      root ??= { ...body, time: {}, tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }, cost: 0 };
      return json(root);
    }
    if (route === "/api/session") {
      const child = { id: "ses_child", parentID: root?.id, time: { busy: 1 }, ...(busyChild ? {} : { outcome: "succeeded", time: { idle: 2 } }) };
      return Response.json({
        data: busyChild && url.searchParams.get("parentID") === root?.id ? [child] : [],
        cursor: { next: null, previous: null },
      });
    }
    if (route === "/api/experimental/job") return json(jobs ? [{ id: "job" }] : []);
    if (route.startsWith("/api/experimental/session/") && route.endsWith("/wait")) return empty();
    if (root && route === `/api/session/${root.id}` && method === "DELETE") {
      root = undefined;
      inbox = [];
      return empty();
    }
    if (route === `/api/session/${root?.id}` && method === "PATCH") {
      root = { ...root!, ...body };
      return empty();
    }
    if (route === `/api/session/${root?.id}`) return json(root);
    if (route.endsWith("/prompt")) {
      expect(body.resume).toBe(false);
      expect(body.delivery).toBe("queue");
      if (admissionLost > 0) {
        admissionLost--;
        if (restartOnLoss) { pid++; active = false; }
        throw new Error("Lost admission acknowledgement");
      }
      prompt = { id: body.id, sessionID: root?.id, type: "user", delivery: "queue" };
      inbox = [prompt];
      return json(prompt);
    }
    if (route.endsWith("/inbox")) return json(route.includes("/ses_child/") ? [] : inbox);
    if (route.includes("/inbox/") && method === "PATCH") {
      expect(discoveredPID).toBe(pid);
      if (body.delivery === "steer" && !active) {
        inbox = [];
        root = { ...root, time: { busy: 1, idle: 2 }, outcome: "succeeded" };
      }
      return empty();
    }
    if (route.includes("/inbox/") && method === "DELETE") {
      inbox = inbox.filter((entry) => !route.endsWith(`/${entry.id}`));
      return empty();
    }
    if (route.endsWith("/interrupt")) {
      active = false;
      return Response.json({ interrupted: true });
    }
    if (route.endsWith("/message")) {
      return Response.json({
        data: [{ type: "assistant", time: { completed: 2 }, content: [{ type: "text", text: "Finished" }] }],
        cursor: {},
      });
    }
    if (route.endsWith(`/message/${prompt?.id}`) && root?.outcome) return json({ id: prompt?.id, type: "user" });
    return Response.json({ _tag: "SessionNotFoundError" }, { status: 404 });
  });
  const controllerFetch = target ? vi.fn(() => { throw new Error("SSH traffic escaped the execution target"); }) : http;
  vi.stubGlobal("fetch", controllerFetch);
  const execute = () => executeManaged(ctx, {
    command: "opencode", cwd: "/workspace", target, prompt: "Do the task", files,
    environment: { PAPERCLIP_API_KEY: "run-token" }, onSettled: stopped,
  });
  return {
    ctx, execute, http, controllerFetch, operations, signal, stopped, checkpoint: () => checkpoint,
    setActive: () => { active = true; },
    setBusyChild: (value: boolean) => { busyChild = value; },
    setJobs: (value: boolean) => { jobs = value; },
    restart: () => { pid++; active = false; },
    setBackendID: (value: string) => { backendID = value; },
    loseAdmission: (times = Infinity, restart = false) => { admissionLost = times; restartOnLoss = restart; },
  };
}

it("checks in before admission, uses durable upstream IDs and returns per-run accounting", async () => {
  const f = fixture();
  const result = await f.execute();
  expect(result).toMatchObject({
    exitCode: 0, summary: "Finished", costUsd: 0, costStatus: "estimated",
    usage: { inputTokens: 8, outputTokens: 7, cachedInputTokens: 5, cacheWriteTokens: 6 },
  });
  const checkpoint = f.checkpoint();
  expect(checkpoint).toMatchObject({ version: 1, kind: "opencode_managed", backendID: "upstream:db" });
  expect(checkpoint.bodySha256).toBe(createHash("sha256").update(String(checkpoint.body)).digest("hex"));
  expect(JSON.parse(String(checkpoint.body)).environment).toEqual({ PAPERCLIP_API_KEY: "run-token" });
  expect(JSON.stringify(checkpoint)).not.toContain("private");
  const id = String(checkpoint.sessionID);
  expect(id).toMatch(/^ses_external_[a-f0-9]{64}$/);
  expect(f.operations.indexOf("ready")).toBeLessThan(f.operations.indexOf("POST /api/session"));
  expect(f.operations.indexOf("environment")).toBeLessThan(f.operations.indexOf(`POST /api/session/${id}/prompt`));
  const requests = f.http.mock.calls.filter(([url, init]) => url.pathname.endsWith("/prompt") && init.method === "POST");
  expect(requests).toHaveLength(1);
  expect(JSON.parse(String(requests[0]?.[1].body))).toMatchObject({
    id: checkpoint.inputID, text: "Do the task", files: [{ uri: "file:///workspace/a%20b.txt" }],
  });
  expect(f.stopped).toHaveBeenCalledOnce();
});

it("waits for descendants and background jobs before accepting an idle root", async () => {
  const f = fixture();
  f.setBusyChild(true);
  f.setJobs(true);
  f.ctx.onExecutionProgress = vi.fn(async () => {
    expect(f.stopped).not.toHaveBeenCalled();
    if (vi.mocked(f.ctx.onExecutionProgress!).mock.calls.length === 1) f.setBusyChild(false);
    else f.setJobs(false);
  });
  expect(await f.execute()).toMatchObject({ exitCode: 0 });
  expect(f.ctx.onExecutionProgress).toHaveBeenCalledTimes(3);
});

it("uses target-side loopback and embeds controller-side attachments for native SSH", async () => {
  const target = {
    kind: "remote",
    transport: "ssh",
    remoteCwd: "/target/workspace",
    spec: {
      host: "remote", port: 22, username: "fixture", remoteCwd: "/target/workspace",
      remoteWorkspacePath: "/target/workspace", privateKey: null, knownHosts: null, strictHostKeyChecking: true,
    },
  } as const;
  const fixtureFile = new URL("../../package.json", import.meta.url).pathname;
  const f = fixture(target, [fixtureFile]);
  expect(await f.execute()).toMatchObject({ exitCode: 0 });
  expect(f.controllerFetch).not.toHaveBeenCalled();
  const body = JSON.parse(String(f.checkpoint().body));
  expect(body.location.directory).toBe(target.remoteCwd);
  expect(body.prompt.files[0]).toMatchObject({ name: "package.json", uri: expect.stringMatching(/^data:text\/plain;base64,/) });
});

it("reapplies the environment after a backend restart without admitting a second prompt", async () => {
  const f = fixture();
  f.setActive();
  f.ctx.onExecutionProgress = vi.fn(async () => {
    if (vi.mocked(f.ctx.onExecutionProgress!).mock.calls.length === 1) f.restart();
  });
  expect(await f.execute()).toMatchObject({ exitCode: 0 });
  expect(f.operations.filter((item) => item === "environment")).toHaveLength(2);
  expect(f.operations.filter((item) => item.endsWith("/prompt"))).toHaveLength(1);
});

it("keeps ownership on cancellation while a job remains, and retries Stop on the same backend", async () => {
  const f = fixture();
  f.setActive();
  f.setJobs(true);
  f.ctx.onExecutionProgress = async () => { f.signal.abort(); };
  await expect(f.execute()).rejects.toMatchObject({ code: "opencode_managed_stop_pending" });
  expect(f.operations.some((item) => item.startsWith("DELETE ") && item.includes("/inbox/"))).toBe(true);
  expect(f.stopped).not.toHaveBeenCalled();
  f.setJobs(false);
  const receipt = f.checkpoint();
  expect(await reconcileExecution({ ...receipt, body: `${receipt.body} ` })).toBe("pending");
  f.setBackendID("upstream:replacement");
  expect(await reconcileExecution(receipt)).toBe("pending");
  f.setBackendID("upstream:db");
  expect(await reconcileExecution(receipt)).toBe("settled");
});

it("does not arm work after cancellation before admission", async () => {
  const f = fixture();
  f.ctx.onCancellationReady = async () => { f.signal.abort(); };
  expect(await f.execute()).toMatchObject({ exitCode: 1, signal: "SIGTERM" });
  expect(f.operations).not.toContain("POST /api/session");
  expect(f.stopped).toHaveBeenCalledOnce();
});

it("replays an unanswered dispatch with the same message id", async () => {
  const f = fixture();
  f.loseAdmission(1, true);
  expect(await f.execute()).toMatchObject({ exitCode: 0, summary: "Finished" });
  const prompts = f.http.mock.calls.filter(([url]) => String(url).endsWith("/prompt"));
  expect(prompts).toHaveLength(2);
  expect(new Set(prompts.map(([, init]) => JSON.parse(String(init.body)).id)).size).toBe(1);
});

it("releases an unanswered dispatch on Stop by deleting the run's own session", async () => {
  const f = fixture();
  f.loseAdmission();
  expect(await f.execute()).toMatchObject({ exitCode: 1, signal: "SIGTERM" });
  expect(f.operations.some((item) => /^DELETE \/api\/session\/[^/]+$/.test(item))).toBe(true);
  expect(await reconcileExecution(f.checkpoint())).toBe("settled");
  expect(f.stopped).toHaveBeenCalledOnce();
});

it("keeps a verified settlement if the final progress write fails", async () => {
  const f = fixture();
  f.ctx.onExecutionProgress = async () => { throw new Error("Controller lease write failed"); };
  expect(await f.execute()).toMatchObject({ exitCode: 0, timedOut: false });
  expect(f.stopped).toHaveBeenCalledOnce();
});

it("rejects variants before admission and keeps legacy checkpoints fenced", async () => {
  const f = fixture();
  f.ctx.config.model += "#high";
  await expect(f.execute()).rejects.toThrow("without a variant");
  expect(run).not.toHaveBeenCalled();
  f.ctx.config.model = "openai/gpt-6.1-sol";
  await f.execute();
  const checkpoint = f.checkpoint();
  const previous = JSON.parse(String(checkpoint.body));
  const legacy = (model: object) => {
    const body = JSON.stringify({ ...previous, model, backendID: "fork:db" });
    return { ...checkpoint, body, backendID: "fork:db", bodySha256: createHash("sha256").update(body).digest("hex") };
  };
  expect(await reconcileExecution(legacy({ providerID: "openai", id: "model" }))).toBe("pending");
  expect(await reconcileExecution(legacy({ provider: "openai", model: "model" }))).toBe("settled");
});

it("requires lifecycle hooks and allows only Paperclip and server-owned scratch overrides", () => {
  const f = fixture();
  const dir = "/scratch/run";
  const validate = (env: Record<string, string>) => validateManagedConfig({
    ...f.ctx,
    config: { dangerouslySkipPermissions: false, env },
    context: { paperclipScratch: { type: "heartbeat_run", dir, tempKeysApplied: ["TMPDIR"] } },
  });
  expect(() => validate({ TMPDIR: dir, PAPERCLIP_RUN_SCRATCH_DIR: dir })).not.toThrow();
  expect(() => validate({ TMPDIR: "/other" })).toThrow(/Paperclip-scoped/);
  expect(() => validate({ HOME: "/other" })).toThrow(/Paperclip-scoped/);
  expect(() => validateManagedConfig({ ...f.ctx, onExecutionCheckpoint: undefined })).toThrow(/checkpoint/i);
  expect(() => validateManagedConfig({ ...f.ctx, config: { dangerouslySkipPermissions: true } })).toThrow(/permissions/i);
});
