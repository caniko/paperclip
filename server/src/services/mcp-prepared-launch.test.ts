import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  mcpLaunchProofBytes, prepareMcpLaunchEnvelope, readMcpLaunchEnvelope, verifyMcpLaunchProof,
} from "./mcp-prepared-launch-contract.js";

const keys = generateKeyPairSync("ed25519");
function snapshot() {
  return {
    version: 1 as const, companyId: randomUUID(), agentId: randomUUID(), issueId: randomUUID(),
    projectId: randomUUID(), runId: randomUUID(), controllerBootId: randomUUID(), generation: 1,
    controllerInstanceId: "fixture", assignmentDigest: "a".repeat(64), policyDigest: "b".repeat(64),
    assignmentRevision: "assignment-rev-1", policyRevision: "policy-rev-1",
    worker: { id: "worker-a", keyId: "key-1", publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      gatewayUrl: "https://worker.example/api", executionHostId: "host-a" },
    servers: [{ connectionId: "reader", url: "https://reader.example/mcp", serverHostId: "host-b", authorizedCrossHost: true,
      credentialRef: "gateway-token:fixture" }],
    launchJson: '{"model":"fixture","runtime_mcp":{"token":"private-token"}}', expiresAt: Date.now() + 60_000,
    launchHeaders: { Authorization: "Bearer private-worker-token" },
  };
}

describe("controller-owned prepared MCP launch contract", () => {
  it("binds every effective launch byte while keeping the digest salted and secrets private", () => {
    const source = snapshot();
    const first = prepareMcpLaunchEnvelope(source);
    const second = prepareMcpLaunchEnvelope(source);
    expect(first.digest).not.toBe(second.digest);
    const readback = readMcpLaunchEnvelope(first.envelope, first.id, first.digest);
    expect(readback.snapshot).toEqual(source);
    source.worker.gatewayUrl = "https://replacement.example";
    expect(readback.snapshot.worker.gatewayUrl).toBe("https://worker.example/api");
    expect(() => readMcpLaunchEnvelope({ ...first.envelope, snapshot: source }, first.id, first.digest)).toThrow("Managed MCP launch authorization is blocked");
    expect(() => readMcpLaunchEnvelope(first.envelope, randomUUID(), first.digest)).toThrow();
    expect(JSON.stringify({ id: first.id, digest: first.digest })).not.toContain("private-token");
  });

  it("rejects JSON escape expansion above the readable envelope limit before preparation", () => {
    const source = snapshot();
    source.launchJson = "{" + "\t".repeat(1_048_574) + "}";
    expect(Buffer.byteLength(source.launchJson, "utf8")).toBe(1_048_576);
    expect(() => prepareMcpLaunchEnvelope(source)).toThrow("Managed MCP launch authorization is blocked");
    source.launchJson = '{"prompt":"\ud800"}';
    expect(() => prepareMcpLaunchEnvelope(source)).toThrow();
    source.launchJson = "{}";
    source.launchHeaders.Authorization = "Bearer private\r\nInjected: true";
    expect(() => prepareMcpLaunchEnvelope(source)).toThrow();
  });

  it.each([
    (s: ReturnType<typeof snapshot>) => { s.servers[0].authorizedCrossHost = false; },
    (s: ReturnType<typeof snapshot>) => { s.worker.gatewayUrl = "https://user:secret@worker.example"; },
    (s: ReturnType<typeof snapshot>) => { s.servers.push({ ...s.servers[0] }); },
    (s: ReturnType<typeof snapshot>) => { s.launchJson = "null"; },
    (s: ReturnType<typeof snapshot>) => { s.launchJson = "[1]"; },
    (s: ReturnType<typeof snapshot>) => { s.generation = 0; },
  ])("rejects malformed or widened preparation with a content-free error", mutate => {
    const source = snapshot(); mutate(source);
    expect(() => prepareMcpLaunchEnvelope(source)).toThrow("Managed MCP launch authorization is blocked");
  });

  it("verifies the enrolled Ed25519 key against the whole challenge, not a host label", () => {
    const challenge = { version: 1 as const, launchId: randomUUID(), launchDigest: "c".repeat(64),
      companyId: randomUUID(), runId: randomUUID(), controllerInstanceId: "fixture", controllerBootId: randomUUID(), generation: 1,
      workerId: "worker-a", keyId: "key-1", gatewayUrl: "https://worker.example/api", executionHostId: "host-a",
      nonce: "d".repeat(64), expiresAt: Date.now() + 60_000 };
    const signature = sign(null, mcpLaunchProofBytes(challenge), keys.privateKey).toString("base64url");
    expect(verifyMcpLaunchProof(challenge, signature, snapshot().worker.publicKey)).toBe(true);
    for (const field of ["launchId", "companyId", "runId", "controllerBootId", "workerId", "keyId", "gatewayUrl", "executionHostId", "launchDigest", "nonce"]) {
      expect(verifyMcpLaunchProof({ ...challenge, [field]: "changed" }, signature, snapshot().worker.publicKey)).toBe(false);
    }
    expect(verifyMcpLaunchProof(challenge, signature, generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64"))).toBe(false);
    expect(verifyMcpLaunchProof(challenge, `${signature}=`, snapshot().worker.publicKey)).toBe(false);
    expect(verifyMcpLaunchProof(challenge, signature, "private-enrollment-key")).toBe(false);
  });
});
