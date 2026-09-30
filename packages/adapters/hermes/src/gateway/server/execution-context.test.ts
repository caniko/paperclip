import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { sessionCodec } from "./index.js";

function context(): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Worker", adapterType: "hermes_gateway", adapterConfig: {} },
    config: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "fixture-key", bindWorkspace: true },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    context: { issueId: "issue-1", paperclipWorkspace: { cwd: "/srv/data" } },
    executionTarget: { kind: "local", environmentId: "local-worker", workspaceRealization: {
      mode: "in_place", authoritativeRoot: "/srv/data", pathAliases: [], outboundRestorePaths: [],
    } },
    onLog: vi.fn(async () => {}), onDispatch: vi.fn(), onExecutionCheckpoint: vi.fn(async () => {}),
  };
}

function server(capability: unknown = { version: 1, mode: "precondition", backends: ["local", "ssh"], lifetimes: ["wait_for_jobs"], stop_admission: true }) {
  const bodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/v1/capabilities")) {
      return Response.json({ features: { runs_execution_context: capability } });
    }
    if (String(url).endsWith("/v1/runs")) {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ run_id: `hermes-${bodies.length}`, status: "started" }, { status: 202 });
    }
    return Response.json({ status: "completed", output: "done" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { bodies, fetchMock };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("configured-worker execution binding", () => {
  it.each([undefined, { version: 2 }, { version: 1, mode: "precondition", backends: ["ssh"] }])(
    "rejects unsupported capabilities before dispatch (%j)", async (capability) => {
      const { bodies } = server(capability ?? null);
      const ctx = context();
      const result = await execute(ctx);
      expect(result.errorCode).toBe("hermes_gateway_execution_context_unsupported");
      expect(bodies).toEqual([]);
      expect(ctx.onDispatch).not.toHaveBeenCalled();
    },
  );

  it("pins core targets, scopes sessions across A/B/A, and keeps credentials out of dispatch", async () => {
    const { bodies, fetchMock } = server();
    const ctx = context();
    ctx.config.cwd = "/ignored-config-cwd";
    const a = await execute(ctx);
    expect(a.exitCode).toBe(0);
    expect(bodies[0].execution_context).toEqual({ version: 1, backend: "local", cwd: "/srv/data", lifetime: "wait_for_jobs" });
    const original = ctx.executionTarget;
    ctx.executionTarget = {
      kind: "remote", transport: "ssh", environmentId: "ssh-worker", remoteCwd: "/home/alice/data",
      workspaceRealization: { mode: "in_place", authoritativeRoot: "/home/alice/data", pathAliases: [], outboundRestorePaths: [] },
      spec: { host: "workstation.example", port: 2222, username: "alice", remoteWorkspacePath: "/home/alice/data", remoteCwd: "/home/alice/data",
        privateKey: "PRIVATE-KEY-MUST-NOT-TRAVEL", knownHosts: "HOST-KEY-MUST-NOT-TRAVEL", strictHostKeyChecking: true },
    };
    ctx.runtime.sessionId = a.sessionId ?? null;
    ctx.runtime.sessionParams = sessionCodec.deserialize(sessionCodec.serialize(a.sessionParams ?? null));
    expect(ctx.runtime.sessionParams?.executionContextFingerprint).toBe(a.sessionParams?.executionContextFingerprint);
    expect((await execute(ctx)).exitCode).toBe(0);
    expect(bodies[1].execution_context).toEqual({ version: 1, backend: "ssh", cwd: "/home/alice/data", lifetime: "wait_for_jobs",
      ssh: { host: "workstation.example", port: 2222, user: "alice" } });
    expect(bodies[1].session_id).not.toBe(bodies[0].session_id);
    ctx.executionTarget = original;
    expect((await execute(ctx)).exitCode).toBe(0);
    expect(bodies[2].session_id).toBe(bodies[0].session_id);
    ctx.config.apiBaseUrl = "http://127.0.0.1:8643";
    expect((await execute(ctx)).exitCode).toBe(0);
    expect(bodies[3].session_id).not.toBe(bodies[0].session_id);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("MUST-NOT-TRAVEL");
    expect(a.sessionParams?.executionContextFingerprint).toBeTruthy();
  });

  it("rejects a payload template that overrides binding or conversation provenance", async () => {
    const { bodies } = server();
    for (const key of ["execution_context", "session_id", "previous_response_id", "conversation_history", "hosted_room_dispatch"]) {
      const ctx = context();
      ctx.config.payloadTemplate = { [key]: "override" };
      expect((await execute(ctx)).errorCode).toBe("hermes_gateway_execution_context_invalid");
    }
    expect(bodies).toEqual([]);
  });
});
