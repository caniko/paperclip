import { afterEach, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

function context(runId = "run-a"): AdapterExecutionContext {
  return {
    runId,
    agent: { id: "agent", companyId: "company", name: "Worker", adapterType: "hermes_gateway", adapterConfig: {} },
    config: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "gateway-secret", sessionKeyStrategy: "agent", bindWorkspace: true, waitForJobs: true },
    runtime: { sessionId: "previous-session", sessionParams: {}, sessionDisplayId: null, taskKey: null },
    context: { issueId: "task", paperclipWorkspace: { cwd: "/workspace" } },
    executionTarget: { kind: "local", environmentId: "worker-host" },
    runtimeMcp: { getServers: () => [{ name: "Chaosbox", url: "http://127.0.0.1:9000/mcp", token: "reader-secret", connectionId: "chaosbox",
      runBinding: { runId, executionHostId: "worker-host", serverHostId: "worker-host", gatewayUrl: "http://127.0.0.1:8642/" } }] },
    onLog: vi.fn(async () => {}), onDispatch: vi.fn(), onExecutionCheckpoint: vi.fn(async () => {}), onProviderStopped: vi.fn(async () => {}),
  };
}

function gateway(capability: unknown = { version: 1, enabled: true, mode: "run_isolated", host_id: "worker-host" }) {
  const bodies: Record<string, unknown>[] = [];
  const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/v1/capabilities")) return Response.json({ features: { runs_managed_mcp: capability,
      runs_execution_context: { version: 1, mode: "precondition", backends: ["local"], lifetimes: ["wait_for_jobs"], stop_admission: true },
    } });
    if (String(url).endsWith("/v1/runs")) {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ run_id: `hermes-${bodies.length}`, status: "started" }, { status: 202 });
    }
    return Response.json({ status: "completed", output: "done", session_id: `fresh-${bodies.length}` });
  });
  vi.stubGlobal("fetch", mock);
  return { bodies, mock };
}

afterEach(() => { vi.unstubAllGlobals(); });

it("rejects a replacement gateway even when it reports the approved host label", async () => {
  const { bodies, mock } = gateway();
  const ctx = context();
  ctx.config.apiBaseUrl = "https://replacement.example";
  ctx.runtimeMcp = { getServers: () => [{ name: "Chaosbox", url: "http://127.0.0.1:9000/mcp", token: "reader-secret", connectionId: "chaosbox",
    runBinding: { runId: ctx.runId, executionHostId: "worker-host", serverHostId: "worker-host", gatewayUrl: "http://127.0.0.1:8642/" } }] };
  expect((await execute(ctx)).errorCode).toBe("hermes_gateway_managed_mcp_blocked");
  expect(bodies).toEqual([]);
  expect(mock).not.toHaveBeenCalled();
});

it("rejects managed credentials without the durable owned-run lifecycle", async () => {
  const { bodies, mock } = gateway();
  const ctx = context();
  delete ctx.onExecutionCheckpoint;
  expect((await execute(ctx)).errorCode).toBe("hermes_gateway_managed_mcp_blocked");
  expect(bodies).toEqual([]);
  expect(mock).not.toHaveBeenCalled();
});

it("blocks unqualified host delivery and configuration bypass before dispatch", async () => {
  for (const capability of [null, { version: 1, enabled: false }, { version: 1, enabled: true, mode: "run_isolated", host_id: "other-host" }]) {
    const { bodies } = gateway(capability);
    const ctx = context();
    expect((await execute(ctx)).errorCode).toBe("hermes_gateway_managed_mcp_blocked");
    expect(bodies).toEqual([]);
    expect(ctx.onDispatch).not.toHaveBeenCalled();
  }
  for (const key of ["runtime_mcp", "session_id", "previous_response_id", "conversation_history", "hosted_room_dispatch"]) {
    const { bodies } = gateway();
    const ctx = context();
    ctx.config.payloadTemplate = { [key]: "untrusted" };
    expect((await execute(ctx)).errorCode).toBe("hermes_gateway_managed_mcp_blocked");
    expect(bodies).toEqual([]);
  }
  const { bodies } = gateway();
  const ctx = context();
  ctx.runtimeMcp = { getServers: () => [{ name: "operator", url: "http://127.0.0.1:9000/mcp", token: "operator-secret", connectionId: "operator" }] };
  expect((await execute(ctx)).errorCode).toBe("hermes_gateway_managed_mcp_blocked");
  expect(bodies).toEqual([]);
});

it("delivers run-bound credentials only into fresh A/B/A conversations and redacts logs", async () => {
  const { bodies } = gateway();
  const sessions: unknown[] = [];
  for (const run of ["run-a", "run-b", "run-a-again"]) {
    const ctx = context(run);
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(ctx.onExecutionCheckpoint).toHaveBeenCalledOnce();
    expect(ctx.onProviderStopped).toHaveBeenCalledOnce();
    const body = bodies.at(-1)!;
    sessions.push(result.sessionId);
    expect(body.runtime_mcp).toMatchObject({ version: 1, run_id: run, execution_host_id: "worker-host", servers: [{ connection_id: "chaosbox", token: "reader-secret" }] });
    expect(body.session_id).toBeUndefined();
    expect(JSON.stringify(vi.mocked(ctx.onLog).mock.calls)).not.toContain("reader-secret");
  }
  expect(new Set(sessions).size).toBe(3);
});
