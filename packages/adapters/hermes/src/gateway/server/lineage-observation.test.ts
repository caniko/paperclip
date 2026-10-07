import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AdapterExecutionContext, AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import { expect, it, vi } from "vitest";
import { execute } from "./execute.js";
import { reconcileExecution } from "./recovery.js";

function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const frame = (sequence: number, event: string, fields = {}) =>
  `id: ${sequence}\nevent: ${event}\ndata: ${JSON.stringify({ sequence, event, ...fields })}\n\n`;

async function fixture(route: (path: string, res: ServerResponse) => void,
  callbacks: Partial<AdapterExecutionContext> = {}) {
  const cancel = new AbortController();
  const events: AdapterRuntimeEvent[] = [];
  const progress: Record<string, unknown>[] = [];
  const stopped = vi.fn(async () => {});
  const leaf = barrier();
  let checkpoint: Record<string, unknown> = {};
  let returned = false;
  let allowStop = false;
  let stopReceipt: Record<string, unknown> | undefined;
  const stops: Record<string, unknown>[] = [];
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const validStop = () => ({ run_id: "parent", status: "superseded", stop_requested: true,
    lineage_settled: true, lineage: [{ run_id: "parent", status: "superseded" }, { run_id: "leaf", status: "cancelled" }],
    admission: { version: 1, root_run_id: "parent", key_sha256: sha256("fixture-admission"), body_sha256: sha256(String(checkpoint.body)) } });
  const server = createServer(async (req, res) => {
    const path = req.url!;
    if (path === "/v1/capabilities") {
      res.end(JSON.stringify({ features: { runs_recovery: { version: 1,
        durable_lineage_stop: true, ordinary_stop_admission: true, admission_binding: 1 } } }));
    } else if (path === "/v1/runs") {
      for await (const _chunk of req) { /* Consume the exact admission body. */ }
      res.end(JSON.stringify({ run_id: "parent", status: "running" }));
    } else if (path === "/v1/runs/parent/stop" || path === "/v1/runs/stop") {
      const receipt = allowStop ? validStop() : stopReceipt ?? { status: "stopping" };
      stops.push(receipt);
      res.end(JSON.stringify(receipt));
    } else {
      if (path.endsWith("/events")) {
        res.setHeader("Content-Type", "text/event-stream");
        res.flushHeaders();
      }
      route(path, res);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const execution = execute({
    runId: "fixture-admission", signal: cancel.signal,
    agent: { id: "agent", companyId: "company", name: "Worker", adapterType: "hermes_gateway", adapterConfig: {} },
    config: { apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      apiKey: "fixture", pollIntervalMs: 250, eventReconnectMs: 250, timeoutSec: 0 },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, context: {},
    onLog: async () => {}, onEvent: async event => { events.push(event); },
    onExecutionCheckpoint: async value => { checkpoint = value; },
    onExecutionProgress: async value => {
      progress.push(value);
      if (value.runId === "leaf") leaf.resolve();
    }, onProviderStopped: stopped, ...callbacks,
  }).then(result => { returned = true; return result; });
  return { execution, leaf: leaf.promise, events, progress, stopped, stops, cancel,
    pending: () => { expect(returned).toBe(false); expect(stopped).not.toHaveBeenCalled(); },
    setStop: (value: Record<string, unknown>) => { stopReceipt = value; },
    checkpoint: () => checkpoint, validStop,
    async close() {
      allowStop = true;
      cancel.abort();
      server.closeAllConnections();
      await execution;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}

it("binds a delayed ID-less parent poll to its original HTTP endpoint", async () => {
  const poll = barrier<ServerResponse>();
  const stream = barrier<ServerResponse>();
  let leafPolls = 0;
  const test = await fixture((path, res) => {
    if (path === "/v1/runs/parent") poll.resolve(res);
    else if (path === "/v1/runs/parent/events") stream.resolve(res);
    else if (path === "/v1/runs/leaf") { leafPolls++; res.end('{"status":"running"}'); }
  });
  try {
    const parentPoll = await poll.promise;
    (await stream.promise).end(frame(1, "run.superseded", { successor_run_id: "leaf" }));
    await test.leaf;
    parentPoll.end('{"status":"completed"}');
    await vi.waitFor(() => expect(leafPolls).toBeGreaterThan(0), { timeout: 3000 });
    test.pending();
    expect(test.progress.at(-1)?.runId).toBe("leaf");
  } finally { await test.close(); }
}, 15_000);

it.each(["chunk", "eof"])("rejects a delayed parent SSE %s after a polled successor", async mode => {
  const stream = barrier<ServerResponse>();
  const closed = barrier();
  let leafPolls = 0;
  const test = await fixture((path, res) => {
    if (path === "/v1/runs/parent/events") {
      res.once("close", () => closed.resolve());
      if (mode === "eof") res.write(frame(1, "run.completed").trimEnd());
      stream.resolve(res);
    } else if (path === "/v1/runs/parent") void stream.promise.then(() => res.end('{"status":"superseded","successor_run_id":"leaf"}'));
    else if (path === "/v1/runs/leaf") { leafPolls++; res.end('{"status":"running"}'); }
  });
  try {
    const parent = await stream.promise;
    await test.leaf;
    parent.end(mode === "chunk" ? frame(1, "message.delta", { delta: "stale" }) + frame(2, "run.completed") : "");
    await closed.promise;
    await vi.waitFor(() => expect(leafPolls).toBeGreaterThan(0), { timeout: 3000 });
    test.pending();
    expect(test.events).toEqual([]);
    expect(test.progress.at(-1)).toMatchObject({ runId: "leaf", cursors: {} });
  } finally { await test.close(); }
}, 15_000);

it("retains parent event identity across a blocked durable event callback", async () => {
  const entered = barrier();
  const release = barrier();
  let leafPolls = 0;
  const observed: AdapterRuntimeEvent[] = [];
  const test = await fixture((path, res) => {
    if (path === "/v1/runs/parent/events") res.end(frame(1, "run.completed"));
    else if (path === "/v1/runs/parent") void entered.promise.then(() => res.end('{"status":"superseded","successor_run_id":"leaf"}'));
    else if (path === "/v1/runs/leaf") { leafPolls++; res.end('{"status":"running"}'); }
  }, { onEvent: async event => { observed.push(event); entered.resolve(); await release.promise; } });
  try {
    await entered.promise;
    await test.leaf;
    release.resolve();
    await vi.waitFor(() => expect(leafPolls).toBeGreaterThan(0), { timeout: 3000 });
    test.pending();
    expect(observed[0].providerSource?.runId).toBe("parent");
    expect(test.progress.at(-1)).toMatchObject({ runId: "leaf", cursors: {} });
  } finally { release.resolve(); await test.close(); }
}, 15_000);

const invalidLineages = [
  { name: "unrelated", members: [{ run_id: "other", status: "completed" }] },
  { name: "root omitted", members: [{ run_id: "leaf", status: "cancelled" }] },
  { name: "leaf omitted", members: [{ run_id: "parent", status: "completed" }] },
  { name: "empty id", members: [{ run_id: "parent", status: "completed" }, { run_id: "", status: "cancelled" }] },
  { name: "whitespace id", members: [{ run_id: "parent", status: "completed" }, { run_id: " ", status: "cancelled" }] },
  { name: "duplicate equal", members: [{ run_id: "parent", status: "completed" }, { run_id: "leaf", status: "cancelled" }, { run_id: "leaf", status: "cancelled" }] },
  { name: "duplicate conflicting", members: [{ run_id: "parent", status: "completed" }, { run_id: "leaf", status: "cancelled" }, { run_id: "leaf", status: "completed" }] },
  { name: "nonterminal", members: [{ run_id: "parent", status: "completed" }, { run_id: "leaf", status: "running" }] },
];

it.each(invalidLineages)("holds live and recovery ownership for $name lineage receipts", async ({ members }) => {
  const test = await fixture((path, res) => {
    if (path === "/v1/runs/parent/events") res.end(frame(1, "run.superseded", { successor_run_id: "leaf" }));
    else if (!path.endsWith("/events")) res.end('{"status":"running"}');
  });
  try {
    await test.leaf;
    const bad = { ...test.validStop(), status: "completed", lineage: members };
    test.setStop(bad);
    test.cancel.abort();
    await vi.waitFor(() => expect(test.stops.length).toBeGreaterThan(1), { timeout: 3000 });
    test.pending();
    expect(await reconcileExecution(test.checkpoint(), test.progress.at(-1))).toBe("pending");
  } finally { await test.close(); }
}, 15_000);

it.each(["false flag", "missing flag", "wrong root", "wrong body", "wrong key"])("rejects %s in admission settlement", async kind => {
  const test = await fixture((path, res) => {
    if (path === "/v1/runs/parent/events") res.end(frame(1, "run.superseded", { successor_run_id: "leaf" }));
    else if (!path.endsWith("/events")) res.end('{"status":"running"}');
  });
  try {
    await test.leaf;
    const bad: Record<string, unknown> = test.validStop();
    if (kind === "false flag") bad.lineage_settled = false;
    if (kind === "missing flag") delete bad.stop_requested;
    if (kind === "wrong root") bad.run_id = "other";
    if (kind === "wrong body") (bad.admission as Record<string, unknown>).body_sha256 = "0".repeat(64);
    if (kind === "wrong key") (bad.admission as Record<string, unknown>).key_sha256 = "0".repeat(64);
    test.setStop(bad);
    expect(await reconcileExecution(test.checkpoint())).toBe("pending");
    if (!kind.startsWith("wrong b") && kind !== "wrong key") {
      test.cancel.abort();
      await vi.waitFor(() => expect(test.stops.length).toBeGreaterThan(2), { timeout: 3000 });
      test.pending();
    }
  } finally { await test.close(); }
}, 15_000);

it.each(["changed replay", "past truncation", "sequence mismatch", "host conflict", "initial gap", "later gap"])("stops and settles before returning a %s protocol failure", async kind => {
  const prefix = kind === "past truncation" ? "x".repeat(600) : "";
  const test = await fixture((path, res) => {
    if (path === "/v1/runs/parent/events") {
      const first = frame(1, "message.delta", { delta: `${prefix}first` });
      if (kind === "initial gap" || kind === "later gap") {
        res.end((kind === "later gap" ? first : "") + frame(3, "message.delta", { delta: "skipped-event" }));
        return;
      }
      res.end(first + first + (kind === "sequence mismatch"
        ? 'id: 2\nevent: run.completed\ndata: {"sequence":3,"status":"completed"}\n\n'
        : frame(1, "message.delta", { delta: `${prefix}changed` })));
    } else if (!path.endsWith("/events")) res.end('{"status":"running"}');
  }, kind === "host conflict" ? { onEvent: async () => { throw new Error("native_event_replay_conflict"); } } : {});
  try {
    await vi.waitFor(() => expect(test.stops.length).toBeGreaterThan(1), { timeout: 3000 });
    test.pending();
    if (kind !== "host conflict") {
      expect(test.events).toHaveLength(kind === "initial gap" ? 0 : 1);
      expect(JSON.stringify(test.events)).not.toContain("skipped-event");
      if (test.events.length) expect(JSON.stringify(test.events[0].providerSource?.canonicalPayload)).not.toContain("first");
      if (kind.endsWith("gap")) expect(test.progress.at(-1)?.cursors).toEqual(kind === "initial gap" ? {} : { parent: 1 });
    }
    test.setStop({ run_id: "parent", status: "cancelled", stop_requested: true, lineage_settled: true,
      lineage: [{ run_id: "parent", status: "cancelled" }] });
    expect(await test.execution).toMatchObject({ exitCode: 1, errorCode: "hermes_gateway_protocol_error" });
    expect(test.stopped).toHaveBeenCalledOnce();
  } finally { await test.close(); }
}, 15_000);
