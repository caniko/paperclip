import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, mcpWorkerEnrollments } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { mcpWorkerEnrollmentService, readEnrolledMcpWorker } from "../services/mcp-worker-enrollment.js";
import { mcpWorkerEnrollmentProofBytes } from "../services/mcp-worker-enrollment-contract.js";

describe("operator-pinned MCP worker enrollment", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const actor = { actorType: "user" as const, actorId: "fixture-operator" };
  const service = () => mcpWorkerEnrollmentService(db, { controllerInstanceId: "controller-a" });
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-mcp-enroll-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function fixture(lifetimeMs = 60_000) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Enrolled worker", issuePrefix: companyId.slice(0, 8) });
    const pins = { workerId: "worker-a", keyId: "key-a", gatewayUrl: "https://worker.example/api",
      executionHostId: "host-a", publicKey, expiresAt: Date.now() + lifetimeMs };
    const prepared = await service().prepare(companyId, pins, actor);
    const subject = { enrollmentId: prepared.challenge.enrollmentId, bearerToken: prepared.bearerToken,
      signature: sign(null, mcpWorkerEnrollmentProofBytes(prepared.challenge), keys.privateKey).toString("base64url") };
    return { companyId, pins, prepared, subject };
  }

  it("enrolls exactly the approved pins once across concurrent lost-ack retries and returns a locked consumer binding", async () => {
    const f = await fixture();
    const receipts = await Promise.all([service().prove(f.subject), service().prove(f.subject)]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(receipts[0].state).toBe("enrolled");
    expect(receipts[0].revision).not.toBe(f.prepared.enrollment.revision);
    expect(await service().inspect(f.companyId, f.subject.enrollmentId)).toEqual(receipts[0]);
    const binding = await db.transaction(tx => readEnrolledMcpWorker(tx, {
      companyId: f.companyId, enrollmentId: f.subject.enrollmentId, controllerInstanceId: "controller-a",
      launchExpiresAt: f.pins.expiresAt,
    }));
    expect(binding?.workerId).toBe(f.pins.workerId);
    expect(binding?.gatewayUrl).toBe(f.pins.gatewayUrl);
    expect(binding?.executionHostId).toBe(f.pins.executionHostId);
    expect(binding?.revision).toBe(receipts[0].revision);
    expect(binding?.expiresAt).toBe(f.pins.expiresAt);
    const [row] = await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.subject.enrollmentId));
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, row.id));
    expect(events.map(event => event.action)).toEqual(["mcp_worker.enrollment_prepared", "mcp_worker.enrolled"]);
    for (const bytes of [JSON.stringify(row), JSON.stringify(events), JSON.stringify(receipts)]) expect(bytes).not.toContain(f.prepared.bearerToken);
    expect(JSON.stringify(events)).not.toContain(f.pins.gatewayUrl);
    expect(JSON.stringify(receipts)).not.toContain(row.bootstrapTokenHash);
    expect(JSON.stringify(receipts)).not.toContain(row.nonce);
  });

  it("requires both bootstrap authentication and possession of the operator-pinned key", async () => {
    const f = await fixture(), other = await fixture();
    await expect(service().prove({ ...f.subject, bearerToken: other.prepared.bearerToken })).rejects.toMatchObject({ code: "runtime_mcp_admission_blocked" });
    await expect(service().prove({ ...f.subject, enrollmentId: other.subject.enrollmentId })).rejects.toThrow();
    const signature = sign(null, mcpWorkerEnrollmentProofBytes(f.prepared.challenge), generateKeyPairSync("ed25519").privateKey).toString("base64url");
    await expect(service().prove({ ...f.subject, signature })).rejects.toThrow();
    await expect(service().prove({ ...f.subject, signature: `${f.subject.signature}=` })).rejects.toThrow();
    const row = await service().inspect(f.companyId, f.subject.enrollmentId);
    expect(row?.state).toBe("pending");
    expect(row?.enrolledAt).toBeNull();
    expect(await service().inspect(other.companyId, f.subject.enrollmentId)).toBeNull();
  });

  it("rejects unsafe or self-asserted enrollment pins and retains the live worker slot until explicit revocation", async () => {
    const f = await fixture();
    for (const invalid of [
      { ...f.pins, gatewayUrl: "http://worker.example" },
      { ...f.pins, gatewayUrl: "https://operator:credential@worker.example" },
      { ...f.pins, publicKey: keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") },
      { ...f.pins, expiresAt: Date.now() - 1 },
      { ...f.pins, expiresAt: Date.now() + 31 * 24 * 60 * 60_000 },
      { ...f.pins, controllerInstanceId: "self-asserted-controller" },
      Object.create(f.pins),
    ]) await expect(service().prepare(f.companyId, invalid, actor)).rejects.toThrow();
    let accessed = false;
    const accessor = { ...f.pins };
    Object.defineProperty(accessor, "gatewayUrl", { enumerable: true, get() { accessed = true; return f.pins.gatewayUrl; } });
    await expect(service().prepare(f.companyId, accessor, actor)).rejects.toThrow();
    expect(accessed).toBe(false);
    await expect(service().prepare(f.companyId, { ...f.pins, keyId: "key-b" }, actor)).rejects.toThrow();
    await expect(service().prepare(f.companyId, f.pins, { actorType: "agent" as "user", actorId: "self-enrollment" })).rejects.toThrow();
    expect((await service().prove(f.subject)).state).toBe("enrolled");
  });

  it("binds every enrollment challenge field and domain so changed pins cannot be proved", async () => {
    const f = await fixture();
    for (const field of Object.keys(f.prepared.challenge)) {
      const changed = { ...f.prepared.challenge, [field]: "changed" };
      const signature = sign(null, mcpWorkerEnrollmentProofBytes(changed as typeof f.prepared.challenge), keys.privateKey).toString("base64url");
      await expect(service().prove({ ...f.subject, signature })).rejects.toThrow();
    }
    const signature = sign(null, Buffer.from("paperclip.mcp-launch-proof.v1"), keys.privateKey).toString("base64url");
    await expect(service().prove({ ...f.subject, signature })).rejects.toThrow();
    expect((await service().prove(f.subject)).state).toBe("enrolled");
  });

  it("rejects pending, expired, foreign-controller and overlong launch bindings", async () => {
    const f = await fixture();
    const input = { companyId: f.companyId, enrollmentId: f.subject.enrollmentId, controllerInstanceId: "controller-a", launchExpiresAt: f.pins.expiresAt };
    expect(await db.transaction(tx => readEnrolledMcpWorker(tx, input))).toBeNull();
    await service().prove(f.subject);
    expect(await db.transaction(tx => readEnrolledMcpWorker(tx, { ...input, controllerInstanceId: "controller-b" }))).toBeNull();
    expect(await db.transaction(tx => readEnrolledMcpWorker(tx, { ...input, companyId: randomUUID() }))).toBeNull();
    expect(await db.transaction(tx => readEnrolledMcpWorker(tx, { ...input, launchExpiresAt: f.pins.expiresAt + 1 }))).toBeNull();
    expect(await db.transaction(tx => readEnrolledMcpWorker(tx, { ...input, launchExpiresAt: Date.now() - 1 }))).toBeNull();
  });

  it("rejects actual elapsed enrollment expiry without consuming the pending bootstrap", async () => {
    const f = await fixture(1500);
    await db.execute(sql`select pg_sleep(1.6)`);
    await expect(service().prove(f.subject)).rejects.toThrow();
    expect((await service().inspect(f.companyId, f.subject.enrollmentId))?.state).toBe("pending");
    expect(await db.transaction(tx => readEnrolledMcpWorker(tx, { companyId: f.companyId,
      enrollmentId: f.subject.enrollmentId, controllerInstanceId: "controller-a", launchExpiresAt: f.pins.expiresAt }))).toBeNull();
  });

  it("rolls acceptance back when its audit crosses the immutable enrollment deadline", async () => {
    const f = await fixture(1500);
    await db.execute(sql`create function delay_mcp_worker_audit() returns trigger language plpgsql as $$ begin
      if new.action = 'mcp_worker.enrolled' then perform pg_sleep(1.6); end if; return new; end $$`);
    await db.execute(sql`create trigger delay_mcp_worker_audit before insert on activity_log for each row execute function delay_mcp_worker_audit()`);
    try {
      await expect(service().prove(f.subject)).rejects.toThrow();
      const row = await service().inspect(f.companyId, f.subject.enrollmentId);
      expect(row?.state).toBe("pending");
      expect(row?.revision).toBe(f.prepared.enrollment.revision);
    } finally {
      await db.execute(sql`drop trigger delay_mcp_worker_audit on activity_log`);
      await db.execute(sql`drop function delay_mcp_worker_audit()`);
    }
  });

  it("holds the enrolled key lock through consumer commit so a competing revocation cannot race authorization", async () => {
    const f = await fixture();
    await service().prove(f.subject);
    let held!: () => void, release!: () => void, readerPid = 0;
    const locked = new Promise<void>(resolve => { held = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reader = db.transaction(async tx => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      readerPid = backend.pid;
      const row = await readEnrolledMcpWorker(tx, { companyId: f.companyId, enrollmentId: f.subject.enrollmentId,
        controllerInstanceId: "controller-a", launchExpiresAt: f.pins.expiresAt });
      expect(row?.state).toBe("enrolled");
      held();
      await gate;
    });
    await locked;
    const revocation = service().revoke(f.companyId, f.subject.enrollmentId, actor);
    try {
      for (let attempts = 0; ; attempts++) {
        const [waiting] = await db.execute<{ count: string }>(sql`select count(*)::text as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and ${readerPid} = any(pg_blocking_pids(pid))`);
        if (Number(waiting.count) > 0) break;
        if (attempts >= 50) throw new Error("Revocation did not reach the held enrollment lock");
        await db.execute(sql`select pg_sleep(0.02)`);
      }
      expect((await service().inspect(f.companyId, f.subject.enrollmentId))?.state).toBe("enrolled");
    } finally { release(); await reader; await revocation; }
    expect((await service().inspect(f.companyId, f.subject.enrollmentId))?.state).toBe("revoked");
  });

  it("permanently revokes under the same row lock, preserves tombstones and permits only a new key label", async () => {
    const f = await fixture();
    await service().prove(f.subject);
    const revoked = await service().revoke(f.companyId, f.subject.enrollmentId, actor);
    expect(revoked.state).toBe("revoked");
    expect(await service().revoke(f.companyId, f.subject.enrollmentId, actor)).toEqual(revoked);
    await expect(service().prove(f.subject)).rejects.toThrow();
    await expect(service().prepare(f.companyId, f.pins, actor)).rejects.toThrow();
    await expect(db.delete(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.subject.enrollmentId))).rejects.toThrow();
    await expect(db.update(mcpWorkerEnrollments).set({ state: "enrolled", revokedAt: null, revision: randomUUID() }).where(eq(mcpWorkerEnrollments.id, f.subject.enrollmentId))).rejects.toThrow();
    expect((await service().prepare(f.companyId, { ...f.pins, keyId: "key-b" }, actor)).enrollment.state).toBe("pending");
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, f.subject.enrollmentId));
    expect(events.filter(event => event.action === "mcp_worker.revoked")).toHaveLength(1);
  });

  it.each(["gatewayUrl", "executionHostId", "publicKey", "keyId", "controllerInstanceId", "bootstrapTokenHash", "nonce", "expiresAt", "challengeExpiresAt"] as const)(
    "rejects SQL substitution of immutable %s authority", async field => {
      const f = await fixture();
      const value = field.endsWith("At") ? new Date(f.pins.expiresAt + 1000) : "changed";
      await expect(db.update(mcpWorkerEnrollments).set({ [field]: value }).where(eq(mcpWorkerEnrollments.id, f.subject.enrollmentId))).rejects.toThrow();
      expect((await service().prove(f.subject)).state).toBe("enrolled");
    });

  it("rolls enrollment and revocation back with their required activity audit", async () => {
    const f = await fixture();
    await db.execute(sql`create function reject_mcp_worker_audit() returns trigger language plpgsql as $$ begin
      if new.action in ('mcp_worker.enrolled', 'mcp_worker.revoked') then raise exception 'fixture private audit failure'; end if; return new; end $$`);
    await db.execute(sql`create trigger reject_mcp_worker_audit before insert on activity_log for each row execute function reject_mcp_worker_audit()`);
    try {
      await expect(service().prove(f.subject)).rejects.toThrow();
      await expect(service().revoke(f.companyId, f.subject.enrollmentId, actor)).rejects.toThrow();
      const row = await service().inspect(f.companyId, f.subject.enrollmentId);
      expect(row?.state).toBe("pending");
      expect(row?.revision).toBe(f.prepared.enrollment.revision);
    } finally {
      await db.execute(sql`drop trigger reject_mcp_worker_audit on activity_log`);
      await db.execute(sql`drop function reject_mcp_worker_audit()`);
    }
    expect((await service().prove(f.subject)).state).toBe("enrolled");
  });

  it("retains company ownership until an explicit company-retirement integration is qualified", async () => {
    const f = await fixture();
    await service().revoke(f.companyId, f.subject.enrollmentId, actor);
    await expect(db.transaction(async tx => {
      await tx.delete(activityLog).where(eq(activityLog.companyId, f.companyId));
      await tx.delete(companies).where(eq(companies.id, f.companyId));
    })).rejects.toThrow();
    expect(await service().inspect(f.companyId, f.subject.enrollmentId)).not.toBeNull();
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, f.subject.enrollmentId));
    expect(events.map(event => event.action)).toEqual(["mcp_worker.enrollment_prepared", "mcp_worker.revoked"]);
  });

  it.each(["2026-03-01T12:00:00Z", "2026-10-15T12:00:00Z"])(
    "enforces exactly 720 elapsed hours across a non-UTC DST boundary starting %s", async start => {
      const f = await fixture();
      const createdAt = new Date(start), deadline = createdAt.getTime() + 720 * 60 * 60_000;
      const insert = (expiresAt: number, workerId: string) => db.transaction(async tx => {
        await tx.execute(sql`set local time zone 'America/New_York'`);
        return tx.insert(mcpWorkerEnrollments).values({ companyId: f.companyId, controllerInstanceId: "controller-a",
          workerId, keyId: "dst-boundary", publicKey, gatewayUrl: f.pins.gatewayUrl, executionHostId: "host-a",
          createdAt, challengeExpiresAt: new Date(createdAt.getTime() + 60_000), expiresAt: new Date(expiresAt),
          bootstrapTokenHash: "a".repeat(64), nonce: "b".repeat(64) }).returning();
      });
      const [accepted] = await insert(deadline, "worker-dst-accepted");
      expect(accepted.expiresAt.getTime()).toBe(deadline);
      await expect(insert(deadline + 60_000, "worker-dst-rejected")).rejects.toThrow();
    });
});
