import type { AdapterExecutionContext, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { execute } from "@paperclipai/hermes-paperclip-adapter/gateway/server";
import { afterEach, expect, it, vi } from "vitest";
import { bindRuntimeMcpServersToRun } from "../services/runtime-mcp-admission.js";

const server: AdapterRuntimeMcpServer = {
  name: "Paperclip assigned tools", connectionId: "assignment:fixture", url: "https://controller.example/mcp/gateways/fixture", token: "run-secret",
};
const policy = JSON.stringify({ version: 1, servers: { [server.connectionId]: {
  url: server.url, gatewayUrl: "http://127.0.0.1:8642", serverHostId: "controller-host", executionHostIds: ["worker-host", "controller-host"],
} } });

afterEach(() => vi.unstubAllGlobals());

it("admits only exact operator-owned endpoints and selected execution hosts", () => {
  const input = { servers: [server], runId: "run-a", executionTarget: { kind: "local" as const, environmentId: "worker-host" }, policy };
  expect(bindRuntimeMcpServersToRun(input)).toEqual([{ ...server, name: server.connectionId,
    runBinding: { runId: "run-a", executionHostId: "worker-host", serverHostId: "controller-host", gatewayUrl: "http://127.0.0.1:8642/", authorizedCrossHost: true } }]);
  expect(server).not.toHaveProperty("runBinding");
  for (const override of [
    { policy: undefined }, { policy: "{}" }, { policy: "not-json" },
    { executionTarget: { kind: "local" as const, environmentId: "unapproved-host" } },
    { executionTarget: { kind: "local" as const } }, { servers: [{ ...server, url: "https://other.example/mcp" }] },
    { servers: [{ ...server, connectionId: "unapproved-connection" }] },
  ]) expect(() => bindRuntimeMcpServersToRun({ ...input, ...override })).toThrow(/MCP admission/);
  expect(bindRuntimeMcpServersToRun({ ...input, executionTarget: { kind: "local", environmentId: "controller-host" } })[0].runBinding?.authorizedCrossHost).toBe(false);
});

it("requires no admission policy when no server credentials are delivered", () => {
  expect(bindRuntimeMcpServersToRun({ servers: [], runId: "empty", policy: "invalid" })).toEqual([]);
});

it.each(["http://127.0.0.1:9119", "http://127.0.0.1:9119/", "http://127.0.0.1:9119/chat", "http://127.0.0.1:9119/api"])(
  "uses the dispatch canonicalizer for the approved dashboard alias %s", (gatewayUrl) => {
    const admitted = bindRuntimeMcpServersToRun({ servers: [server], runId: "dashboard-run",
      executionTarget: { kind: "local", environmentId: "worker-host" },
      policy: JSON.stringify({ version: 1, servers: { [server.connectionId]: {
        url: server.url, gatewayUrl, serverHostId: "controller-host", executionHostIds: ["worker-host"],
      } } }),
    });
    expect(admitted[0].runBinding?.gatewayUrl).toBe("http://127.0.0.1:9119/api");
  },
);

it("delivers a controller-produced run binding through the real Hermes adapter without conversation reuse", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/v1/capabilities")) return Response.json({ features: { runs_managed_mcp: {
      version: 1, enabled: true, mode: "run_isolated", host_id: "controller-host",
    }, runs_execution_context: { version: 1, mode: "precondition", backends: ["local"], lifetimes: ["wait_for_jobs"], stop_admission: true },
    runs_recovery: { version: 1, durable_lineage_stop: true, ordinary_stop_admission: true, admission_binding: 1 } } });
    if (String(url).endsWith("/v1/runs")) {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ run_id: `provider-${bodies.length}`, status: "started" }, { status: 202 });
    }
    return Response.json({ status: "completed", output: "done" });
  }));
  for (const runId of ["run-a", "run-b", "run-a-next"]) {
    const executionTarget = { kind: "local" as const, environmentId: "worker-host" };
    const admitted = bindRuntimeMcpServersToRun({ servers: [{ ...server, token: `credential-${runId}` }], runId, executionTarget, policy });
    const ctx: AdapterExecutionContext = {
      runId, agent: { id: "agent", companyId: "company", name: "Worker", adapterType: "hermes_gateway", adapterConfig: {} },
      config: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "gateway-secret", bindWorkspace: true, waitForJobs: true }, executionTarget,
      runtime: { sessionId: "old-session", sessionParams: {}, sessionDisplayId: null, taskKey: null }, context: { paperclipWorkspace: { cwd: "/workspace" } },
      runtimeMcp: { getServers: () => admitted }, onLog: vi.fn(async () => {}),
      onExecutionCheckpoint: vi.fn(async () => {}), onProviderStopped: vi.fn(async () => {}),
    };
    expect((await execute(ctx)).exitCode).toBe(0);
    expect(ctx.onExecutionCheckpoint).toHaveBeenCalledOnce();
    expect(ctx.onProviderStopped).toHaveBeenCalledOnce();
    expect(bodies.at(-1)).toMatchObject({ runtime_mcp: { run_id: runId, execution_host_id: "worker-host",
      servers: [{ name: server.connectionId, connection_id: server.connectionId, token: `credential-${runId}`,
        server_host_id: "controller-host", authorized_cross_host: true }] } });
    expect(bodies.at(-1)?.session_id).toBeUndefined();
    expect(JSON.stringify(vi.mocked(ctx.onLog).mock.calls)).not.toContain(`credential-${runId}`);
  }
});
