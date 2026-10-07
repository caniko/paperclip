import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, environmentLeases, heartbeatRuns, issues, mcpPreparedLaunches, projects } from "@paperclipai/db";
import type { McpPreparedLaunchSnapshot } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { mcpPreparedLaunchService } from "../services/mcp-prepared-launch.js";
import { mcpLaunchProofBytes } from "../services/mcp-prepared-launch-contract.js";
import { prepareAdapterExecution, readPendingAdapterExecutionCheckpoint } from "../services/adapter-execution-ownership.js";
import { legacyControllerBootId } from "../services/legacy-controller-lease.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { reconcileExecution, validateManagedMcpExecutionCheckpoint } from "../../../packages/adapters/hermes/src/gateway/server/recovery.js";

describe("prepared MCP launch PostgreSQL admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "42".repeat(32));
    database = await startEmbeddedPostgresTestDatabase("paperclip-mcp-launch-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { try { await database?.cleanup(); } finally { vi.unstubAllEnvs(); } }, 60_000);

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID(), projectId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "MCP admission", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", adapterType: "hermes_gateway" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Pinned evidence" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Read scoped evidence", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "legacy",
      contextSnapshot: { issueId }, controllerBootId: legacyControllerBootId, controllerLeaseExpiresAt: new Date(Date.now() + 120_000) });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const snapshot: McpPreparedLaunchSnapshot = { version: 1, companyId, agentId, issueId, projectId, runId,
      controllerBootId: legacyControllerBootId, controllerInstanceId: "fixture", generation: 1,
      assignmentDigest: "a".repeat(64), policyDigest: "b".repeat(64), worker: { id: "worker", keyId: "key-1", publicKey,
        executionHostId: "host-a", gatewayUrl: "https://worker.example" },
      servers: [{ connectionId: "reader", url: "https://reader.example/mcp", serverHostId: "host-b", authorizedCrossHost: true, credentialRef: "ref:reader" }],
      assignmentRevision: "assignment-rev-1", policyRevision: "policy-rev-1",
      launchJson: JSON.stringify({ prompt: "private-prompt", runtime_mcp: { version: 1, run_id: runId, token: "private-reader-token" },
        execution_context: { version: 1, lifetime: "wait_for_jobs" } }),
      launchHeaders: { Authorization: "Bearer private-worker-token", "Idempotency-Key": runId }, expiresAt: Date.now() + 90_000 };
    let current: unknown = structuredClone(snapshot);
    // Models a trusted controller grant/worker resolver. The public request
    // never supplies this value, and every operation resolves it anew in its tx.
    const resolve = async () => current;
    const service = () => mcpPreparedLaunchService(db, { resolveCurrent: resolve });
    return { snapshot, service, setCurrent(value: unknown) { current = value; } };
  }

  it("persists one immutable preparation, one authorization and one dispatch claim across service reconstruction and concurrent retries", async () => {
    const f = await fixture();
    const prepared = await Promise.all([f.service().prepare(f.snapshot), f.service().prepare(f.snapshot)]);
    expect(prepared[0]).toEqual(prepared[1]);
    const { launchId, launchDigest } = prepared[0];
    const subject = { companyId: f.snapshot.companyId, runId: f.snapshot.runId, launchId, launchDigest };
    const challenges = await Promise.all([f.service().challenge(subject), f.service().challenge(subject)]);
    expect(challenges[0]).toEqual(challenges[1]);
    const signature = sign(null, mcpLaunchProofBytes(challenges[0]), keys.privateKey).toString("base64url");
    const receipts = await Promise.all([f.service().authorize({ ...subject, signature }), f.service().authorize({ ...subject, signature })]);
    expect(receipts[0]).toEqual(receipts[1]);
    await expect(f.service().claimDispatch(subject)).rejects.toThrow("Managed MCP launch authorization is blocked");
    const [lease] = await db.insert(environmentLeases).values({ companyId: subject.companyId, heartbeatRunId: subject.runId }).returning();
    expect(validateManagedMcpExecutionCheckpoint(recoveryCheckpoint(f.snapshot, prepared[0]), {
      runId: subject.runId, gatewayUrl: f.snapshot.worker.gatewayUrl, headers: f.snapshot.launchHeaders,
      body: f.snapshot.launchJson, launchId, launchDigest,
    })).toBe(true);
    await prepareAdapterExecution(db, { companyId: subject.companyId, runId: subject.runId, leaseId: lease.id,
      adapterType: "hermes_gateway", checkpoint: recoveryCheckpoint(f.snapshot, prepared[0]) });
    const claims = await Promise.all([f.service().claimDispatch(subject), f.service().claimDispatch(subject)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await f.service().claimDispatch(subject)).toBe(false);
    const [stored] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, launchId));
    expect(stored.state).toBe("dispatching");
    expect(JSON.stringify(stored)).not.toContain("private-reader-token");
    expect(JSON.stringify(stored)).not.toContain("private-prompt");
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, launchId)).orderBy(activityLog.createdAt);
    expect(events.map(e => e.action)).toEqual(["mcp_launch.prepared", "mcp_launch.challenge_issued", "mcp_launch.authorized", "mcp_launch.dispatch_claimed"]);
    expect(JSON.stringify(events)).not.toContain("private-reader-token");
    const fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).endsWith("/v1/capabilities")) return Response.json({ features: { runs_execution_context: { version: 1, stop_admission: true } } });
      expect(String(url)).toBe(`${f.snapshot.worker.gatewayUrl}/v1/runs/stop`);
      expect(options?.body).toBe(f.snapshot.launchJson);
      expect(options?.headers).toEqual(f.snapshot.launchHeaders);
      return Response.json({ run_id: subject.runId, status: "cancelled" });
    });
    vi.stubGlobal("fetch", fetch);
    try { expect(await reconcileExecution(recoveryCheckpoint(f.snapshot, prepared[0]))).toBe("settled"); }
    finally { vi.unstubAllGlobals(); }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  function recoveryCheckpoint(s: McpPreparedLaunchSnapshot, prepared: { launchId: string; launchDigest: string }) {
    return { version: 1, baseUrl: s.worker.gatewayUrl, headers: s.launchHeaders, body: s.launchJson,
      managedMcpLaunchId: prepared.launchId, managedMcpLaunchDigest: prepared.launchDigest };
  }

  it.each(["companyId", "agentId", "issueId", "projectId", "runId", "controllerBootId", "assignmentDigest", "assignmentRevision", "policyDigest", "policyRevision", "launchJson", "launchHeaders", "worker", "servers"] as const)(
    "permanently invalidates changed %s authority without consuming the challenge", async field => {
      const f = await fixture();
      const prepared = await f.service().prepare(f.snapshot);
      const subject = { companyId: f.snapshot.companyId, runId: f.snapshot.runId, ...prepared };
      const challenge = await f.service().challenge(subject);
      const signature = sign(null, mcpLaunchProofBytes(challenge), keys.privateKey).toString("base64url");
      const changed = structuredClone(f.snapshot);
      if (field === "worker") changed.worker.gatewayUrl = "https://replacement.example";
      else if (field === "servers") changed.servers[0].authorizedCrossHost = false;
      else if (field === "launchJson") changed.launchJson = '{"token":"changed"}';
      else if (field === "launchHeaders") changed.launchHeaders.Authorization = "Bearer changed";
      else changed[field] = randomUUID();
      f.setCurrent(changed);
      await expect(f.service().authorize({ ...subject, signature })).rejects.toThrow("Managed MCP launch authorization is blocked");
      await expect(f.service().prepare(changed)).rejects.toThrow("Managed MCP launch authorization is blocked");
      f.setCurrent(f.snapshot);
      await expect(f.service().authorize({ ...subject, signature })).rejects.toThrow();
      await expect(f.service().prepare(f.snapshot)).rejects.toThrow();
      const [row] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, prepared.launchId));
      expect(row.state).toBe("revoked");
      expect(row.authorizedAt).toBeNull();
    });

  it("rejects copied ciphertext, foreign requests, revoked worker keys and unowned runs", async () => {
    const f = await fixture(), other = await fixture();
    const prepared = await f.service().prepare(f.snapshot), otherPrepared = await other.service().prepare(other.snapshot);
    const subject = { companyId: f.snapshot.companyId, runId: f.snapshot.runId, ...prepared };
    await expect(f.service().challenge({ ...subject, companyId: other.snapshot.companyId })).rejects.toThrow();
    await expect(f.service().challenge({ ...subject, runId: other.snapshot.runId })).rejects.toThrow();
    const challenge = await f.service().challenge(subject);
    const signature = sign(null, mcpLaunchProofBytes(challenge), keys.privateKey).toString("base64url");
    await expect(f.service().authorize({ ...subject, signature: sign(null, mcpLaunchProofBytes(challenge), generateKeyPairSync("ed25519").privateKey).toString("base64url") })).rejects.toThrow();
    const [original] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, prepared.launchId));
    const [foreign] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, otherPrepared.launchId));
    await db.update(mcpPreparedLaunches).set({ material: foreign.material }).where(eq(mcpPreparedLaunches.id, original.id));
    await expect(f.service().authorize({ ...subject, signature })).rejects.toThrow();
    await db.update(mcpPreparedLaunches).set({ material: original.material }).where(eq(mcpPreparedLaunches.id, original.id));
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, subject.runId));
    await expect(f.service().authorize({ ...subject, signature })).rejects.toThrow();
  });

  it("commits permanent revocation after actual task-row changes even if the original task is restored", async () => {
    const f = await fixture();
    const prepared = await f.service().prepare(f.snapshot);
    const subject = { companyId: f.snapshot.companyId, runId: f.snapshot.runId, ...prepared };
    const challenge = await f.service().challenge(subject);
    const signature = sign(null, mcpLaunchProofBytes(challenge), keys.privateKey).toString("base64url");
    const replacement = randomUUID();
    await db.insert(projects).values({ id: replacement, companyId: subject.companyId, name: "Changed scope" });
    await db.update(issues).set({ projectId: replacement }).where(eq(issues.id, f.snapshot.issueId!));
    await expect(f.service().authorize({ ...subject, signature })).rejects.toThrow();
    await db.update(issues).set({ projectId: f.snapshot.projectId }).where(eq(issues.id, f.snapshot.issueId!));
    await expect(f.service().authorize({ ...subject, signature })).rejects.toThrow();
    const [row] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, prepared.launchId));
    expect(row.state).toBe("revoked");
    const audits = await db.select().from(activityLog).where(eq(activityLog.entityId, prepared.launchId));
    expect(audits.filter(e => e.action === "mcp_launch.revoked")).toHaveLength(1);
  });

  it("renews an expired unconsumed challenge under the row lock and rejects its earlier proof", async () => {
    const f = await fixture();
    const prepared = await f.service().prepare(f.snapshot);
    const subject = { companyId: f.snapshot.companyId, runId: f.snapshot.runId, ...prepared };
    const original = await f.service().challenge(subject);
    const oldSignature = sign(null, mcpLaunchProofBytes(original), keys.privateKey).toString("base64url");
    await db.update(mcpPreparedLaunches).set({ challengeExpiresAt: new Date(Date.now() - 1000) }).where(eq(mcpPreparedLaunches.id, prepared.launchId));
    const renewed = await Promise.all([f.service().challenge(subject), f.service().challenge(subject)]);
    expect(renewed[0]).toEqual(renewed[1]);
    expect(renewed[0].nonce).not.toBe(original.nonce);
    await expect(f.service().authorize({ ...subject, signature: oldSignature })).rejects.toThrow();
    const signature = sign(null, mcpLaunchProofBytes(renewed[0]), keys.privateKey).toString("base64url");
    expect((await f.service().authorize({ ...subject, signature })).launchId).toBe(subject.launchId);
    const audits = await db.select().from(activityLog).where(eq(activityLog.entityId, prepared.launchId));
    expect(audits.filter(e => e.action === "mcp_launch.challenge_renewed")).toHaveLength(1);
  });

  it.each(["references_only", "recipient", "body", "credentials", "admission_key"])("rejects an unrecoverable %s checkpoint before claiming dispatch", async change => {
    const f = await fixture();
    const prepared = await f.service().prepare(f.snapshot);
    const subject = { companyId: f.snapshot.companyId, runId: f.snapshot.runId, ...prepared };
    const challenge = await f.service().challenge(subject);
    await f.service().authorize({ ...subject, signature: sign(null, mcpLaunchProofBytes(challenge), keys.privateKey).toString("base64url") });
    const checkpoint = structuredClone(recoveryCheckpoint(f.snapshot, prepared));
    if (change === "recipient") checkpoint.baseUrl = "https://replacement.example";
    if (change === "body") checkpoint.body = "{}";
    if (change === "credentials") checkpoint.headers.Authorization = "Bearer replacement";
    if (change === "admission_key") checkpoint.headers["Idempotency-Key"] = randomUUID();
    const [lease] = await db.insert(environmentLeases).values({ companyId: subject.companyId, heartbeatRunId: subject.runId }).returning();
    await prepareAdapterExecution(db, { companyId: subject.companyId, runId: subject.runId, leaseId: lease.id, adapterType: "hermes_gateway",
      checkpoint: change === "references_only" ? { managedMcpLaunchId: prepared.launchId, managedMcpLaunchDigest: prepared.launchDigest } : checkpoint });
    await expect(f.service().claimDispatch(subject)).rejects.toThrow();
    const [row] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, prepared.launchId));
    expect(row.state).toBe("authorized");
    expect(row.dispatchClaimedAt).toBeNull();
  });

  it("distinguishes unavailable resolution from authoritative revocation and never resurrects a revoked worker", async () => {
    const f = await fixture();
    const prepared = await f.service().prepare(f.snapshot);
    const subject = { companyId: f.snapshot.companyId, runId: f.snapshot.runId, ...prepared };
    const challenge = await f.service().challenge(subject);
    const signature = sign(null, mcpLaunchProofBytes(challenge), keys.privateKey).toString("base64url");
    const unavailable = mcpPreparedLaunchService(db, { resolveCurrent: async () => { throw new Error("fixture-private-provider-error"); } });
    await expect(unavailable.authorize({ ...subject, signature })).rejects.toThrow("Managed MCP launch authorization is blocked");
    const [pending] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, prepared.launchId));
    expect(pending.state).toBe("prepared");
    expect((await f.service().authorize({ ...subject, signature })).launchId).toBe(prepared.launchId);
    f.setCurrent(null);
    await expect(f.service().authorize({ ...subject, signature })).rejects.toThrow();
    f.setCurrent(f.snapshot);
    await expect(f.service().authorize({ ...subject, signature })).rejects.toThrow();
    const [revoked] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, prepared.launchId));
    expect(revoked.state).toBe("revoked");
  });

  it("does not authorize after the controller lease expires during resolution", async () => {
    const f = await fixture();
    const prepared = await f.service().prepare(f.snapshot);
    const subject = { companyId: f.snapshot.companyId, runId: f.snapshot.runId, ...prepared };
    const challenge = await f.service().challenge(subject);
    const signature = sign(null, mcpLaunchProofBytes(challenge), keys.privateKey).toString("base64url");
    const expired = mcpPreparedLaunchService(db, { resolveCurrent: async tx => {
      await tx.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(heartbeatRuns.id, subject.runId));
      return structuredClone(f.snapshot);
    } });
    await expect(expired.authorize({ ...subject, signature })).rejects.toThrow();
    const [row] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, prepared.launchId));
    expect(row.state).toBe("prepared");
    expect(row.authorizedAt).toBeNull();
  });

  it("checks real elapsed launch expiry after asynchronous resolution", async () => {
    const f = await fixture();
    f.snapshot.expiresAt = Date.now() + 2000;
    f.setCurrent(f.snapshot);
    const prepared = await f.service().prepare(f.snapshot);
    const subject = { companyId: f.snapshot.companyId, runId: f.snapshot.runId, ...prepared };
    const challenge = await f.service().challenge(subject);
    let resolved = false;
    const slow = mcpPreparedLaunchService(db, { resolveCurrent: async tx => {
      await tx.execute(sql`select pg_sleep(2.1)`);
      resolved = true;
      return structuredClone(f.snapshot);
    } });
    const signature = sign(null, mcpLaunchProofBytes(challenge), keys.privateKey).toString("base64url");
    await expect(slow.authorize({ ...subject, signature })).rejects.toThrow();
    expect(resolved).toBe(true);
    const [row] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, prepared.launchId));
    expect(row.authorizedAt).toBeNull();
  });

  it("rolls a dispatch claim back if its launch expires during checkpoint decryption", async () => {
    const f = await fixture();
    f.snapshot.expiresAt = Date.now() + 2000;
    f.setCurrent(f.snapshot);
    const prepared = await f.service().prepare(f.snapshot);
    const subject = { companyId: f.snapshot.companyId, runId: f.snapshot.runId, ...prepared };
    const challenge = await f.service().challenge(subject);
    await f.service().authorize({ ...subject, signature: sign(null, mcpLaunchProofBytes(challenge), keys.privateKey).toString("base64url") });
    const [lease] = await db.insert(environmentLeases).values({ companyId: subject.companyId, heartbeatRunId: subject.runId }).returning();
    await prepareAdapterExecution(db, { companyId: subject.companyId, runId: subject.runId, leaseId: lease.id,
      adapterType: "hermes_gateway", checkpoint: recoveryCheckpoint(f.snapshot, prepared) });
    const provider = getSecretProvider("local_encrypted");
    const resolve = provider.resolveVersion.bind(provider);
    let decrypted = false;
    const spy = vi.spyOn(provider, "resolveVersion").mockImplementation(async input => {
      const plain = await resolve(input);
      if (plain.includes("paperclip.adapter-execution.v1")) {
        decrypted = true;
        await new Promise(resolve => setTimeout(resolve, 2100));
      }
      return plain;
    });
    try { await expect(f.service().claimDispatch(subject)).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect(decrypted).toBe(true);
    const [row] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, prepared.launchId));
    expect(row.state).toBe("authorized");
    expect(row.dispatchClaimedAt).toBeNull();
  });

  it("waits for a real task lock, then observes a competing controller change and revokes the launch", async () => {
    const f = await fixture();
    const prepared = await f.service().prepare(f.snapshot);
    const subject = { companyId: f.snapshot.companyId, runId: f.snapshot.runId, ...prepared };
    const challenge = await f.service().challenge(subject);
    const signature = sign(null, mcpLaunchProofBytes(challenge), keys.privateKey).toString("base64url");
    let held!: () => void, release!: () => void, writerPid = 0;
    const locked = new Promise<void>(resolve => { held = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writer = db.transaction(async tx => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      writerPid = backend.pid;
      await tx.select().from(issues).where(eq(issues.id, f.snapshot.issueId!)).for("no key update");
      held();
      await gate;
      await tx.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, subject.runId));
    });
    await locked;
    const authorization = f.service().authorize({ ...subject, signature });
    const rejection = expect(authorization).rejects.toThrow();
    // Query the lock manager rather than rely on scheduler timing. It is bounded
    // and establishes that the admission actually waited on the task lock.
    try {
      for (let attempts = 0; ; attempts++) {
        const [waiting] = await db.execute<{ count: string }>(sql`select count(*)::text as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and ${writerPid} = any(pg_blocking_pids(pid))`);
        if (Number(waiting.count) > 0) break;
        if (attempts >= 50) throw new Error("Admission never reached the held task lock");
        await db.execute(sql`select pg_sleep(0.02)`);
      }
    } finally { release(); await writer; }
    await rejection;
    const [row] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, subject.launchId));
    expect(row.state).toBe("revoked");
  });

  it.each(["succeeded", "interrupted", "failed", "cancelled", "timed_out"])("retains deletion references until %s run and ownership settlement, then explicitly retires the private ledger", async status => {
    const f = await fixture();
    const prepared = await f.service().prepare(f.snapshot);
    const subject = { companyId: f.snapshot.companyId, runId: f.snapshot.runId, ...prepared };
    await expect(f.service().retireForDeletion(subject)).rejects.toThrow();
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, subject.runId));
    const [lease] = await db.insert(environmentLeases).values({ companyId: subject.companyId, heartbeatRunId: subject.runId,
      metadata: { workspaceOwnership: { version: 1, state: "pending", adapterType: "hermes_gateway" } } }).returning();
    await expect(f.service().retireForDeletion(subject)).rejects.toThrow();
    await db.update(environmentLeases).set({ releasedAt: new Date(), status: "released" }).where(eq(environmentLeases.id, lease.id));
    await expect(f.service().retireForDeletion(subject)).rejects.toThrow();
    await db.update(environmentLeases).set({ metadata: { workspaceOwnership: { version: 1, state: "settled", adapterType: "hermes_gateway" } } }).where(eq(environmentLeases.id, lease.id));
    expect(await f.service().retireForDeletion(subject)).toBe(true);
    expect(await f.service().retireForDeletion(subject)).toBe(false);
    expect(await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, subject.launchId))).toEqual([]);
    const [audit] = await db.select().from(activityLog).where(eq(activityLog.entityId, subject.launchId));
    const audits = await db.select().from(activityLog).where(eq(activityLog.entityId, subject.launchId));
    expect(audits.filter(e => e.action === "mcp_launch.retired")).toHaveLength(1);
    expect(audit.entityId).toBe(subject.launchId);
    expect(JSON.stringify(audit)).not.toContain("private-worker-token");
  });

  it("preserves an oversized legacy checkpoint through the shared reader and original producer recovery", async () => {
    const f = await fixture();
    const { companyId, runId } = f.snapshot;
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId }).returning();
    const checkpoint = { version: 1, baseUrl: f.snapshot.worker.gatewayUrl, headers: f.snapshot.launchHeaders,
      body: JSON.stringify({ input: "a".repeat(4_194_304), execution_context: { version: 1, lifetime: "wait_for_jobs" } }) };
    await prepareAdapterExecution(db, { companyId, runId, leaseId: lease.id, adapterType: "hermes_gateway", checkpoint });
    const [stored] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    const recovered = await readPendingAdapterExecutionCheckpoint(stored);
    expect(recovered?.checkpoint).toEqual(checkpoint);
    const fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).endsWith("/v1/capabilities")) return Response.json({ features: { runs_execution_context: { version: 1, stop_admission: true } } });
      expect(String(url)).toBe(`${checkpoint.baseUrl}/v1/runs/stop`);
      expect(options?.body).toBe(checkpoint.body);
      expect(options?.headers).toEqual(checkpoint.headers);
      return Response.json({ run_id: runId, status: "cancelled" });
    });
    vi.stubGlobal("fetch", fetch);
    try { expect(await reconcileExecution(recovered!.checkpoint)).toBe("settled"); }
    finally { vi.unstubAllGlobals(); }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rechecks the database clock after a slow resolver and never consumes expired authority", async () => {
    const f = await fixture();
    const prepared = await f.service().prepare(f.snapshot);
    const subject = { companyId: f.snapshot.companyId, runId: f.snapshot.runId, ...prepared };
    const challenge = await f.service().challenge(subject);
    const signature = sign(null, mcpLaunchProofBytes(challenge), keys.privateKey).toString("base64url");
    const slow = mcpPreparedLaunchService(db, { resolveCurrent: async (tx) => {
      await tx.update(mcpPreparedLaunches).set({ challengeExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(mcpPreparedLaunches.id, prepared.launchId));
      return structuredClone(f.snapshot);
    } });
    await expect(slow.authorize({ ...subject, signature })).rejects.toThrow();
    const [row] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, prepared.launchId));
    expect(row.state).toBe("prepared");
    expect(row.authorizedAt).toBeNull();
  });

  it("rolls preparation back when its required audit cannot commit", async () => {
    const f = await fixture();
    await db.execute(sql`create function reject_mcp_launch_audit() returns trigger language plpgsql as $$ begin
      if new.action = 'mcp_launch.prepared' then raise exception 'fixture audit failure'; end if; return new; end $$`);
    await db.execute(sql`create trigger reject_mcp_launch_audit before insert on activity_log for each row execute function reject_mcp_launch_audit()`);
    try {
      await expect(f.service().prepare(f.snapshot)).rejects.toThrow();
      expect(await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.runId, f.snapshot.runId))).toEqual([]);
    } finally {
      await db.execute(sql`drop trigger reject_mcp_launch_audit on activity_log`);
      await db.execute(sql`drop function reject_mcp_launch_audit()`);
    }
  });

  it.each(["challenge", "authorize", "dispatch", "revoke", "retire"] as const)("rolls %s back atomically when its required audit fails", async operation => {
    const f = await fixture();
    const prepared = await f.service().prepare(f.snapshot);
    const subject = { companyId: f.snapshot.companyId, runId: f.snapshot.runId, ...prepared };
    let signature = "";
    if (operation === "authorize" || operation === "dispatch") {
      const challenge = await f.service().challenge(subject);
      signature = sign(null, mcpLaunchProofBytes(challenge), keys.privateKey).toString("base64url");
    }
    if (operation === "dispatch") {
      await f.service().authorize({ ...subject, signature });
      const [lease] = await db.insert(environmentLeases).values({ companyId: subject.companyId, heartbeatRunId: subject.runId }).returning();
      await prepareAdapterExecution(db, { companyId: subject.companyId, runId: subject.runId, leaseId: lease.id,
        adapterType: "hermes_gateway", checkpoint: recoveryCheckpoint(f.snapshot, prepared) });
    }
    if (operation === "revoke") f.setCurrent({ ...f.snapshot, policyDigest: "c".repeat(64) });
    if (operation === "retire") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, subject.runId));
    const action = { challenge: "challenge_issued", authorize: "authorized", dispatch: "dispatch_claimed", revoke: "revoked", retire: "retired" }[operation];
    const [before] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, subject.launchId));
    await db.execute(sql.raw(`create function reject_mcp_launch_audit() returns trigger language plpgsql as $$ begin
      if new.action = 'mcp_launch.${action}' then raise exception 'fixture audit failure'; end if; return new; end $$`));
    await db.execute(sql`create trigger reject_mcp_launch_audit before insert on activity_log for each row execute function reject_mcp_launch_audit()`);
    try {
      const attempt = operation === "challenge" || operation === "revoke" ? f.service().challenge(subject) :
        operation === "authorize" ? f.service().authorize({ ...subject, signature }) :
        operation === "dispatch" ? f.service().claimDispatch(subject) : f.service().retireForDeletion(subject);
      await expect(attempt).rejects.toThrow("Managed MCP launch authorization is blocked");
      const [after] = await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, subject.launchId));
      expect(after).toEqual(before);
    } finally {
      await db.execute(sql`drop trigger reject_mcp_launch_audit on activity_log`);
      await db.execute(sql`drop function reject_mcp_launch_audit()`);
    }
  });
});
