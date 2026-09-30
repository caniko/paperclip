import { afterEach, expect, it, vi } from "vitest";
import { prepareWorkspaceOwnership, reconcileWorkspaceOwnership } from "./ownership.js";

afterEach(() => vi.unstubAllGlobals());

it.each(["object", "json"])("preserves routing headers through acquisition and checkpoint recovery (%s)", async (format) => {
  const configuredHeaders = {
    "X-Worker-Route": "worker-a",
    " aUtHoRiZaTiOn ": "Bearer config-must-not-win",
    " idempotency-KEY ": "config-must-not-win",
    "content-TYPE": "text/plain",
    ACCEPT: "text/plain",
    "x-hermes-session-key": "config-must-not-win",
  };
  const requests: { operation: string; headers: Headers }[] = [];
  let checkpoint: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const operation = url.endsWith("/v1/capabilities") ? "capability" : JSON.parse(String(init?.body)).operation;
    requests.push({ operation, headers: new Headers(init?.headers) });
    if (operation === "capability") return Response.json({ features: { runs_execution_context: {
      version: 1, mode: "precondition", backends: ["local"], lifetimes: ["wait_for_jobs"], stop_admission: true,
      filesystem_ownership: { version: 1, early_intent: true, target_authority: true, controller_release: true },
    } } });
    return Response.json({ state: operation === "release" ? "settled" : "active", claim: "grant-1" });
  }));
  await prepareWorkspaceOwnership({
    runId: "routing-run", agent: { id: "agent", companyId: "company", name: "Worker", adapterType: "hermes_gateway", adapterConfig: {} },
    config: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "host-owned-key",
      headers: format === "json" ? JSON.stringify(configuredHeaders) : configuredHeaders }, context: {},
    executionTarget: { kind: "local", workspaceRealization: { mode: "in_place", authoritativeRoot: "/data", pathAliases: [], outboundRestorePaths: [] } },
    policy: { authority: "host", principal: "controller", roots: ["/data"] }, assertActive: async () => {},
    onCheckpoint: async value => { checkpoint = JSON.parse(JSON.stringify(value)); }, onGranted: async () => {},
  });
  expect(await reconcileWorkspaceOwnership(checkpoint)).toBe("settled");
  expect(requests.map(request => request.operation)).toEqual(["capability", "reserve", "stop", "release"]);
  for (const { headers } of requests) {
    expect(headers.get("X-Worker-Route")).toBe("worker-a");
    expect(headers.get("Authorization")).toBe("Bearer host-owned-key");
    expect(headers.get("Idempotency-Key")).toBe("routing-run");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.has("X-Hermes-Session-Key")).toBe(false);
  }
});

it("persists intent before acquisition, parks without model work, and fences a lost grant on cancellation", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  let checkpoint: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/capabilities")) return Response.json({ features: { runs_execution_context: {
      version: 1, mode: "precondition", backends: ["local"], lifetimes: ["wait_for_jobs"], stop_admission: true,
      filesystem_ownership: { version: 1, early_intent: true, target_authority: true, controller_release: true },
    } } });
    expect(url).toMatch(/\/v1\/filesystem-ownership$/);
    const body = JSON.parse(String(init?.body));
    events.push(body.operation);
    if (body.operation === "reserve") {
      expect(events[0]).toBe("checkpoint");
      controller.abort();
      throw new Error("grant reply was lost");
    }
    return Response.json({ state: "settled", claim: "original-grant" });
  }));
  await expect(prepareWorkspaceOwnership({
    runId: "run-1", agent: { id: "agent-1", companyId: "company-1", name: "Worker", adapterType: "hermes_gateway", adapterConfig: {} },
    config: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "private-fixture-key", pollIntervalMs: 1 },
    context: { paperclipWorkspace: { cwd: "/data/shared " } },
    executionTarget: { kind: "local", workspaceRealization: { mode: "in_place", authoritativeRoot: "/data/shared ", pathAliases: [], outboundRestorePaths: [] } },
    policy: { authority: "host-1", principal: "controller-1", roots: ["/data/shared "] },
    signal: controller.signal,
    onCheckpoint: async (value) => { checkpoint = value; events.push("checkpoint"); },
    onGranted: async () => { throw new Error("a lost grant must not permit preparation"); },
    assertActive: async () => {},
  })).rejects.toThrow(/cancelled/);
  expect(events).toEqual(["checkpoint", "reserve", "stop", "release"]);
  expect(await reconcileWorkspaceOwnership(checkpoint)).toBe("settled");
});

it("refuses acquisition when the durable intent cannot be committed", async () => {
  const fetchMock = vi.fn(async () => Response.json({ features: { runs_execution_context: {
    version: 1, mode: "precondition", backends: ["local"], lifetimes: ["wait_for_jobs"], stop_admission: true,
    filesystem_ownership: { version: 1, early_intent: true, target_authority: true, controller_release: true },
  } } }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(prepareWorkspaceOwnership({
    runId: "run-2", agent: { id: "agent", companyId: "company", name: "Worker", adapterType: "hermes_gateway", adapterConfig: {} },
    config: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "fixture" }, context: {},
    executionTarget: { kind: "local", workspaceRealization: { mode: "in_place", authoritativeRoot: "/data", pathAliases: [], outboundRestorePaths: [] } },
    policy: { authority: "host", principal: "controller", roots: ["/data"] },
    onCheckpoint: async () => { throw new Error("database unavailable"); }, onGranted: async () => {}, assertActive: async () => {},
  })).rejects.toThrow("database unavailable");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("reports an authoritative refusal and keeps its checkpoint until explicit settlement", async () => {
  const operations: string[] = [];
  let checkpoint: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/capabilities")) return Response.json({ features: { runs_execution_context: {
      version: 1, mode: "precondition", backends: ["local"], lifetimes: ["wait_for_jobs"], stop_admission: true,
      filesystem_ownership: { version: 1, early_intent: true, target_authority: true, controller_release: true },
    } } });
    operations.push(JSON.parse(String(init?.body)).operation);
    // A second acquisition would conceal the refusal; make that bug terminate
    // deterministically rather than leaving the failed test's retry loop alive.
    return operations.length === 1
      ? Response.json({ code: "rejected", error: "private enrollment details" }, { status: 409 })
      : Response.json({ state: "settled" });
  }));
  await expect(prepareWorkspaceOwnership({
    runId: "denied", agent: { id: "agent", companyId: "company", name: "Worker", adapterType: "hermes_gateway", adapterConfig: {} },
    config: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "fixture", pollIntervalMs: 1 }, context: {},
    executionTarget: { kind: "local", workspaceRealization: { mode: "in_place", authoritativeRoot: "/data", pathAliases: [], outboundRestorePaths: [] } },
    policy: { authority: "host", principal: "controller", roots: ["/data"] }, assertActive: async () => {},
    onCheckpoint: async value => { checkpoint = value; },
    onGranted: async () => { throw new Error("refused work cannot start"); },
  })).rejects.toThrow("Filesystem authority rejected the ownership request");
  expect(operations).toEqual(["reserve"]);
  expect(checkpoint).toHaveProperty("executionContext");
  expect(await reconcileWorkspaceOwnership(checkpoint)).toBe("settled");
  expect(operations).toEqual(["reserve", "stop", "release"]);
});
