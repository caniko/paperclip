import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { reconcileExecution } from "./recovery.js";

it.each(["normal", "lost-admission", "managed-mcp-lost-admission", "failed-logging", "child-completion", "pre-admission-cancel", "rejected-admission"])("retains cancellation ownership through %s and unknown stop status", async (failure) => {
  const managed = failure === "managed-mcp-lost-admission";
  const loseAdmission = failure === "lost-admission" || managed;
  const cancel = new AbortController();
  let admitted = 0;
  let stops = 0;
  let polls = 0;
  let allowSettlement = false;
  const requests: { key: string | undefined; body: string }[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/capabilities") {
      res.end(JSON.stringify({ features: { runs_execution_context: {
        version: 1, mode: "precondition", backends: ["local"], lifetimes: ["wait_for_jobs"], stop_admission: true,
      }, runs_managed_mcp: { version: 1, enabled: true, mode: "run_isolated", host_id: "worker" },
        runs_recovery: { version: 1, durable_lineage_stop: true, ordinary_stop_admission: true, admission_binding: 1 } } }));
    } else if (req.url === "/v1/runs" || req.url === "/v1/runs/stop") {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ key: req.headers["idempotency-key"] as string, body });
      if (managed) expect(JSON.parse(body)).toMatchObject({ runtime_mcp: { run_id: "paperclip-owned", servers: [{ token: "run-reader-secret" }] } });
      if (req.url === "/v1/runs/stop") {
        stops++;
        res.end(JSON.stringify({ run_id: "owned", status: allowSettlement ? "cancelled" : "stopping",
          admission: { version: 1, root_run_id: "owned",
            key_sha256: createHash("sha256").update(String(req.headers["idempotency-key"])).digest("hex"),
            body_sha256: createHash("sha256").update(body).digest("hex") },
          stop_requested: true, lineage_settled: allowSettlement,
          lineage: [{ run_id: "owned", status: allowSettlement ? "cancelled" : "stopping" }] }));
        return;
      }
      admitted++;
      cancel.abort();
      if (failure === "rejected-admission") { res.writeHead(409).end(); return; }
      if (loseAdmission && admitted === 1) { res.destroy(); return; }
      res.writeHead(202).end(JSON.stringify({ run_id: "owned", status: "started" }));
    } else if (req.url === "/v1/runs/owned/stop") {
      stops++;
      // Acknowledging the stop request is not evidence of target settlement.
      res.end(JSON.stringify({ run_id: "owned", status: allowSettlement ? "cancelled" : "stopping",
        stop_requested: true, lineage_settled: allowSettlement,
        lineage: [{ run_id: "owned", status: allowSettlement ? "cancelled" : "stopping" }] }));
    } else if (req.url === "/v1/runs/owned/events") {
      if (allowSettlement) {
        res.setHeader("Content-Type", "text/event-stream");
        res.end('event: run.cancelled\ndata: {"status":"cancelled"}\n\n');
        return;
      }
      if (failure === "child-completion") {
        res.setHeader("Content-Type", "text/event-stream");
        res.end('event: subagent.complete\ndata: {"run_id":"owned","status":"completed"}\n\n');
        return;
      }
      res.writeHead(503).end();
    } else {
      polls++;
      if (failure === "failed-logging" && polls === 1) { res.writeHead(503).end(); return; }
      res.end(JSON.stringify({ status: allowSettlement ? "cancelled" : "stopping" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const collected = vi.fn(async () => {});
  const ready = vi.fn(async () => {});
  let checkpoint: Record<string, unknown> | undefined;
  const ctx: AdapterExecutionContext = {
    runId: "paperclip-owned", signal: cancel.signal, onCancellationReady: ready, onProviderStopped: collected,
    onExecutionCheckpoint: async (value) => {
      checkpoint = value;
      if (failure === "pre-admission-cancel") cancel.abort();
    },
    agent: { id: "agent", companyId: "company", name: "Worker", adapterType: "hermes_gateway", adapterConfig: {} },
    config: { apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "fixture",
      pollIntervalMs: 250, eventReconnectMs: 250 },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    context: { paperclipWorkspace: { cwd: "/srv/data" } },
    executionTarget: { kind: "local", environmentId: "worker", workspaceRealization: {
      mode: "in_place" as const, authoritativeRoot: "/srv/data", pathAliases: [], outboundRestorePaths: [],
    } },
    ...(managed ? { runtimeMcp: { getServers: () => [{ name: "reader", connectionId: "reader", token: "run-reader-secret",
      url: "http://127.0.0.1:9000/mcp", runBinding: { runId: "paperclip-owned", executionHostId: "worker", serverHostId: "worker",
        gatewayUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` } }] } } : {}),
    onLog: vi.fn(async (_stream, message) => {
      if (failure === "failed-logging" && message.includes("status poll failed")) throw new Error("log sink unavailable");
    }),
  };
  let returned = false;
  const execution = execute(ctx).then((result) => { returned = true; return result; });
  try {
    await vi.waitFor(() => expect(stops).toBeGreaterThan(0), { timeout: 5000 });
    expect(ready).toHaveBeenCalledOnce();
    expect(checkpoint).toBeDefined();
    expect(returned).toBe(false);
    expect(collected).not.toHaveBeenCalled();
    expect(JSON.parse(requests[0].body).execution_context.lifetime).toBe("wait_for_jobs");
    // A fresh controller only has the durable checkpoint. Its stop response is
    // still not permission to release while the target remains nonterminal.
    expect(await reconcileExecution(checkpoint!)).toBe("pending");
    expect(requests.at(-1)).toEqual(requests[0]);
    if (loseAdmission) expect(requests[1]).toEqual(requests[0]);
    if (failure === "failed-logging") await vi.waitFor(() => expect(polls).toBeGreaterThan(1), { timeout: 3000 });
    if (failure === "child-completion") {
      await vi.waitFor(() => expect(polls).toBeGreaterThan(0), { timeout: 3000 });
      expect(returned).toBe(false);
    }
    allowSettlement = true;
    const result = await execution;
    if (failure === "rejected-admission") expect(result.exitCode).toBe(1);
    else expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(collected).toHaveBeenCalledOnce();
    if (managed) expect(JSON.stringify(vi.mocked(ctx.onLog).mock.calls)).not.toContain("run-reader-secret");
    expect(await reconcileExecution(checkpoint!)).toBe("settled");
    expect(admitted).toBe(failure === "pre-admission-cancel" ? 0 : 1);
  } finally {
    allowSettlement = true;
    await execution;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);

it.each([
  { name: "terminal", receipt: { run_id: "owned", status: "cancelled" }, terminal: true, blockedObservers: false },
  { name: "child", receipt: { run_id: "owned", status: "completed", type: "subagent.complete" }, terminal: false, blockedObservers: false },
  { name: "mismatched", receipt: { run_id: "other", status: "cancelled" }, terminal: false, blockedObservers: false },
  { name: "nonterminal", receipt: { run_id: "owned", status: "stopping" }, terminal: false, blockedObservers: false },
  { name: "terminal with blocked observers", receipt: { run_id: "owned", status: "cancelled" }, terminal: true, blockedObservers: true },
].flatMap(test => ["gateway", "in_place"].map(mode => ({ ...test, mode }))))("settles cancellation only from a parent terminal stop receipt: $name / $mode", async ({ receipt, terminal, blockedObservers, mode }) => {
  const cancel = new AbortController();
  const collected = vi.fn(async () => {});
  const ready = vi.fn(async () => {});
  let stops = 0;
  let polls = 0;
  let streams = 0;
  let closedObservers = 0;
  let allowSettlement = terminal;
  let cleanup = false;
  const finalReceipt = { run_id: "owned", status: "cancelled", output: "Owned jobs stopped", usage: { input_tokens: 3, output_tokens: 2 },
    stop_requested: true, lineage_settled: true, lineage: [{ run_id: "owned", status: "cancelled" }] };
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/capabilities") {
      res.end(JSON.stringify({ features: { runs_execution_context: {
        version: 1, mode: "precondition", backends: ["local"], lifetimes: ["wait_for_jobs"], stop_admission: true,
      }, runs_recovery: { version: 1, durable_lineage_stop: true, ordinary_stop_admission: true, admission_binding: 1 } } }));
    } else if (req.url === "/v1/runs") {
      for await (const _chunk of req) { /* consume the admission body */ }
      res.writeHead(202).end(JSON.stringify({ run_id: "owned", status: "started" }));
    } else if (req.url === "/v1/runs/owned/stop") {
      stops++;
      res.end(JSON.stringify(allowSettlement ? finalReceipt : receipt));
    } else if (req.url === "/v1/runs/owned/events" || req.url === "/v1/runs/owned") {
      if (req.url.endsWith("/events")) streams++;
      else polls++;
      if (cleanup) {
        // Bound a failed regression's cleanup without granting stop-only success.
        res.end(JSON.stringify(finalReceipt));
      } else if (blockedObservers) {
        res.once("close", () => { closedObservers++; });
        // Neither observer answers; terminal stop evidence must abort both requests.
      } else {
        res.writeHead(503).end();
      }
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let returned = false;
  const execution = execute({
    runId: "paperclip-stop-receipt", signal: cancel.signal, onProviderStopped: collected, onCancellationReady: ready,
    onExecutionCheckpoint: async () => {},
    agent: { id: "agent", companyId: "company", name: "Worker", adapterType: "hermes_gateway", adapterConfig: {} },
    config: { apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "fixture",
      pollIntervalMs: 250, eventReconnectMs: 250 },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, context: {},
    ...(mode === "in_place" ? { executionTarget: { kind: "local" as const, workspaceRealization: {
      mode: "in_place", authoritativeRoot: "/srv/data", pathAliases: [], outboundRestorePaths: [],
    } } } : {}), onLog: async () => {},
  }).then(result => { returned = true; return result; });
  try {
    await vi.waitFor(() => {
      expect(polls).toBeGreaterThan(0);
      expect(streams).toBeGreaterThan(0);
    }, { timeout: 3000 });
    cancel.abort();
    if (!terminal) {
      await vi.waitFor(() => expect(stops).toBeGreaterThan(1), { timeout: 3000 });
      expect(returned).toBe(false);
      expect(collected).not.toHaveBeenCalled();
      allowSettlement = true;
    }
    await vi.waitFor(() => expect(returned).toBe(true), { timeout: 3000 });
    const result = await execution;
    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(result.resultJson).toMatchObject({ run_id: "owned", status: "cancelled" });
    expect(result.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged" });
    expect(result.summary).toBe("Owned jobs stopped");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(collected).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledOnce();
    if (blockedObservers) await vi.waitFor(() => expect(closedObservers).toBe(2), { timeout: 3000 });
    const counts = { stops, polls, streams };
    await new Promise(resolve => setTimeout(resolve, 350));
    expect({ stops, polls, streams }).toEqual(counts);
    expect(collected).toHaveBeenCalledOnce();
  } finally {
    cleanup = true;
    allowSettlement = true;
    cancel.abort();
    // Also unstick observers in the broken implementation when stop evidence is ignored.
    server.closeAllConnections();
    await execution;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 15_000);
