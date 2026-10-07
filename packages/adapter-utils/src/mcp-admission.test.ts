import { describe, expect, it } from "vitest";
import conformance from "harbor-llm/contracts/mcp-admission-conformance.v1.json" with { type: "json" };
import * as upstream from "harbor-llm/mcp-admission";
import {
  bindMcpServersToRun,
  McpAdmissionError,
  requireMcpRunBinding,
} from "./mcp-admission.js";

const server = {
  connectionId: "fixture-reader", name: "Fixture reader display name",
  url: "https://tools.example/mcp", token: "reader-secret", custom: "retained",
};
const policy = { version: 1, servers: { [server.connectionId]: {
  url: server.url, gatewayUrl: "https://worker.example/profile/main/",
  serverHostId: "worker", executionHostIds: ["worker", "remote"],
} } };
const input = { servers: [server], runId: "run-a", executionHostId: "worker", policy };

describe("provider-neutral MCP run admission", () => {
  it("uses Harbor's implementation and error identity through the compatibility entrypoint", () => {
    expect(bindMcpServersToRun).toBe(upstream.bindMcpServersToRun);
    expect(requireMcpRunBinding).toBe(upstream.requireMcpRunBinding);
    expect(McpAdmissionError).toBe(upstream.McpAdmissionError);
    const [bound] = bindMcpServersToRun(input);
    expect(upstream.requireMcpRunBinding(bound.runBinding, bound.runBinding)).toBe(bound.runBinding);
  });
  it.each(conformance.cases)("conforms: $name", (vector) => {
    const fixtureServer = { ...conformance.server,
      ...("connectionId" in vector ? { connectionId: vector.connectionId } : {}),
      ...("url" in vector ? { url: vector.url } : {}),
    };
    const fixturePolicy = { ...conformance.policy, servers: { fixture: {
      ...conformance.policy.servers.fixture,
      ...("gatewayUrl" in vector ? { gatewayUrl: vector.gatewayUrl } : {}),
    } } };
    const invoke = () => bindMcpServersToRun({ servers: [fixtureServer], runId: vector.runId,
      executionHostId: vector.executionHostId, policy: fixturePolicy });
    if ("expectedReason" in vector) expect(invoke).toThrow(expect.objectContaining({ reason: vector.expectedReason }));
    else expect(invoke()[0].runBinding.authorizedCrossHost).toBe(vector.expectedCrossHost);
  });

  it("preserves display names, extensions and the exact approved recipient without provider aliases", () => {
    const bound = bindMcpServersToRun(input);
    expect(bound).toEqual([{ ...server, runBinding: {
      runId: "run-a", executionHostId: "worker", serverHostId: "worker",
      gatewayUrl: policy.servers[server.connectionId].gatewayUrl, authorizedCrossHost: false,
    } }]);
    expect(server).not.toHaveProperty("runBinding");
    expect(Object.isFrozen(bound[0].runBinding)).toBe(true);
    const alias = "http://127.0.0.1:9119/chat";
    expect(bindMcpServersToRun({ ...input, policy: { ...policy, servers: {
      [server.connectionId]: { ...policy.servers[server.connectionId], gatewayUrl: alias },
    } } })[0].runBinding.gatewayUrl).toBe(alias);
  });

  it("permits cross-host delivery only when the exact execution identity is in operator policy", () => {
    expect(bindMcpServersToRun({ ...input, executionHostId: "remote" })[0].runBinding.authorizedCrossHost).toBe(true);
    expect(() => bindMcpServersToRun({ ...input, executionHostId: "other" })).toThrow(McpAdmissionError);
  });

  it.each([
    { policy: null }, { policy: {} }, { runId: "bad run" }, { executionHostId: undefined },
    { servers: [{ ...server, url: `${server.url}/` }] },
    { servers: [{ ...server, connectionId: "other" }] },
    { servers: [{ ...server, connectionId: "constructor" }] },
    { servers: [server, server] }, { servers: Array(9).fill(server) },
  ])("fails closed for invalid or mismatched admission %j", (override) => {
    expect(() => bindMcpServersToRun({ ...input, ...override })).toThrow(McpAdmissionError);
  });

  it.each([
    "http://worker.example", "https://user:secret@worker.example", "https://worker.example?token=x",
    "https://worker.example#fragment", "file:///worker", " https://worker.example", "https://worker.example/\n",
  ])("rejects an unsafe credential recipient %s", (gatewayUrl) => {
    expect(() => bindMcpServersToRun({ ...input, policy: { ...policy, servers: {
      [server.connectionId]: { ...policy.servers[server.connectionId], gatewayUrl },
    } } })).toThrow(McpAdmissionError);
  });

  it("rejects unknown policy fields and prototype-chain decisions", () => {
    for (const invalid of [
      { ...policy, wildcard: true },
      { ...policy, version: true },
      { ...policy, servers: { [server.connectionId]: { ...policy.servers[server.connectionId], allowAll: true } } },
      { ...policy, servers: Object.create(policy.servers) },
    ]) expect(() => bindMcpServersToRun({ ...input, policy: invalid })).toThrow(McpAdmissionError);
  });

  it("rejects inherited execution-host array entries", () => {
    const executionHostIds = new Array<string>(1);
    Object.setPrototypeOf(executionHostIds, Object.assign(Object.create(Array.prototype), { 0: "worker" }));
    expect(() => bindMcpServersToRun({ ...input, policy: { ...policy, servers: {
      [server.connectionId]: { ...policy.servers[server.connectionId], executionHostIds },
    } } })).toThrow(expect.objectContaining({ code: "runtime_mcp_admission_blocked", reason: "invalid_policy" }));
  });

  it("needs no policy when no credentials are being delivered", () => {
    expect(bindMcpServersToRun({ servers: [], runId: "", policy: null })).toEqual([]);
  });

  it("replaces stale delivery metadata instead of retaining its run identity", () => {
    const stale = { ...server, runBinding: { runId: "old-run" as const } };
    const [bound] = bindMcpServersToRun({ ...input, servers: [stale], runId: "new-run" });
    // The output type must replace a caller's old binding, including narrow
    // literal types, rather than intersecting them with the fresh binding.
    const freshRun: string = "new-run";
    const typedBinding: typeof bound.runBinding = { ...bound.runBinding, runId: freshRun };
    expect(typedBinding.runId).toBe("new-run");
    expect(stale.runBinding.runId).toBe("old-run");
  });

  it("rechecks run, execution identity and recipient at the consumer boundary", () => {
    const [bound] = bindMcpServersToRun(input);
    const expected = { runId: "run-a", executionHostId: "worker", gatewayUrl: bound.runBinding.gatewayUrl };
    expect(requireMcpRunBinding(bound.runBinding, expected)).toBe(bound.runBinding);
    for (const override of [
      { runId: "run-b" }, { executionHostId: "remote" }, { gatewayUrl: "https://replacement.example/" },
    ]) expect(() => requireMcpRunBinding(bound.runBinding, { ...expected, ...override })).toThrow(McpAdmissionError);
    expect(() => requireMcpRunBinding(undefined, expected)).toThrow(McpAdmissionError);
    expect(() => requireMcpRunBinding({ ...bound.runBinding, serverHostId: "remote", authorizedCrossHost: false }, expected)).toThrow(McpAdmissionError);
  });

  it("requires an own cross-host approval even when Object.prototype is polluted", () => {
    const [bound] = bindMcpServersToRun(input);
    const binding = { runId: "run-a", executionHostId: "worker", serverHostId: "remote", gatewayUrl: bound.runBinding.gatewayUrl };
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "authorizedCrossHost");
    try {
      Object.defineProperty(Object.prototype, "authorizedCrossHost", { value: true, configurable: true });
      expect(() => requireMcpRunBinding(binding, binding)).toThrow(expect.objectContaining({
        code: "runtime_mcp_admission_blocked", reason: "binding_mismatch",
      }));
      expect(requireMcpRunBinding({ ...binding, authorizedCrossHost: true }, binding).authorizedCrossHost).toBe(true);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "authorizedCrossHost", previous);
      else Reflect.deleteProperty(Object.prototype, "authorizedCrossHost");
    }
  });

  it.each([1, 2])("redacts a provider normalizer exception on call %s", (throwOnCall) => {
    const [bound] = bindMcpServersToRun(input);
    let calls = 0;
    try {
      requireMcpRunBinding(bound.runBinding, { ...bound.runBinding, normalizeRecipient: (url) => {
        if (++calls === throwOnCall) throw new Error(`private recipient: ${url}`);
        return url;
      } });
      expect.fail("must block");
    } catch (error) {
      expect(error).toBeInstanceOf(McpAdmissionError);
      expect(error).toMatchObject({ code: "runtime_mcp_admission_blocked", reason: "binding_mismatch" });
      expect(String(error)).not.toContain(bound.runBinding.gatewayUrl);
      expect(String(error)).not.toContain("private recipient");
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("returns content-free provider-neutral errors", () => {
    try {
      bindMcpServersToRun({ ...input, servers: [{ ...server, url: "https://unapproved.example/secret" }] });
      expect.fail("must block");
    } catch (error) {
      expect(error).toMatchObject({ code: "runtime_mcp_admission_blocked", reason: "endpoint_mismatch" });
      expect(String(error)).not.toContain("reader-secret");
      expect(String(error)).not.toContain("unapproved.example");
    }
  });
});
