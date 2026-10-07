import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, environmentLeases, heartbeatRuns, issues, secretAccessEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recordAdapterExecutionProgress, settleAdapterExecution } from "../services/adapter-execution-ownership.js";
import { legacyControllerBootId } from "../services/legacy-controller-lease.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";

describe("legacy settlement PostgreSQL locking", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let writer: ReturnType<typeof createDb>;
  let completionWriter: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-settlement-lock-");
    db = createDb(database.connectionString);
    writer = createDb(database.connectionString, { maxConnections: 1 });
    completionWriter = createDb(database.connectionString, { maxConnections: 1 });
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Settlement locks", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor", role: "engineer", adapterType: "process" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Stop running work", status: "in_progress" });
    const [run] = await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running", runtimeMode: "legacy", contextSnapshot: { issueId },
    }).returning();
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId,
      executionAgentNameKey: "executor", executionLockedAt: new Date() }).where(eq(issues.id, issueId));
    return { run, issueId };
  }

  const cancel = (run: typeof heartbeatRuns.$inferSelect) => terminalizeLegacyExecution({
    db: writer, run, status: "cancelled", patch: { errorCode: "cancelled", finishedAt: new Date() },
  });

  async function expectReleased(issueId: string) {
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task).toMatchObject({ executionRunId: null, checkoutRunId: null,
      executionAgentNameKey: null, executionLockedAt: null });
  }

  it.each(["run", "task-and-run"] as const)("settles Stop while an audit insert holds %s foreign-key locks", async (kind) => {
    const { run, issueId } = await seed();
    await db.transaction(async tx => {
      if (kind === "run") {
        await tx.insert(activityLog).values({ companyId: run.companyId, actorId: "operator",
          action: "stop.requested", entityType: "heartbeat_run", entityId: run.id, runId: run.id });
      } else {
        await tx.insert(secretAccessEvents).values({ companyId: run.companyId, issueId,
          heartbeatRunId: run.id, provider: "test", actorType: "system", consumerType: "run",
          consumerId: run.id, outcome: "success" });
      }
      // The insert remains uncommitted: PostgreSQL retains KEY SHARE until
      // this callback returns. Stop must settle without waiting for audit.
      expect(await cancel(run)).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
      await expectReleased(issueId);
    });
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(persisted.status).toBe("cancelled");
  });

  it("waits for admission and observes the checkpoint committed while waiting", async () => {
    const { run, issueId } = await seed();
    const leaseId = randomUUID();
    const [connection] = await writer.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    let pending: ReturnType<typeof cancel> | undefined;
    try {
      await db.transaction(async tx => {
        await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("no key update");
        await tx.insert(environmentLeases).values({ id: leaseId, companyId: run.companyId,
          issueId, heartbeatRunId: run.id, metadata: { adapterExecution: { state: "pending", version: 1 } } });
        pending = cancel(run);
        void pending.catch(() => {});
        // Observe the actual wait, then commit admission. A statement snapshot
        // taken before acquiring the lock would miss the newly committed lease.
        await expect.poll(async () => {
          const [row] = await db.execute<{ blocked: boolean }>(sql`select cardinality(pg_blocking_pids(${connection.pid})) > 0 as blocked`);
          return row.blocked;
        }, { interval: 10, timeout: 800 }).toBe(true);
      });
    } finally {
      // Always drain the writer after releasing the holder, including failures.
      await pending?.catch(() => {});
    }
    expect(await pending!).toBeNull();
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task.executionRunId).toBe(run.id);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("running");
    await settleAdapterExecution(db, { companyId: run.companyId, runId: run.id, leaseId });
    expect(await cancel(run)).toMatchObject({ status: "cancelled" });
    await expectReleased(issueId);
  });

  it("serializes Stop with executor completion and preserves the winning terminal receipt", async () => {
    const { run, issueId } = await seed();
    const [stopConnection] = await writer.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    const [completionConnection] = await completionWriter.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    const pending: ReturnType<typeof cancel>[] = [];
    try {
      await db.transaction(async tx => {
        await tx.select().from(issues).where(eq(issues.id, issueId)).for("no key update");
        pending.push(cancel(run), terminalizeLegacyExecution({ db: completionWriter, run, status: "succeeded" }));
        for (const write of pending) void write.catch(() => {});
        await expect.poll(async () => {
          const [row] = await db.execute<{ blocked: boolean }>(sql`select
            cardinality(pg_blocking_pids(${stopConnection.pid})) > 0 and
            cardinality(pg_blocking_pids(${completionConnection.pid})) > 0 as blocked`);
          return row.blocked;
        }, { interval: 10, timeout: 800 }).toBe(true);
      });
    } finally { await Promise.allSettled(pending); }
    const winners = (await Promise.all(pending)).filter(result => result !== null);
    expect(winners).toHaveLength(1);
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(persisted.status).toBe(winners[0]!.status);
    expect(persisted.executionStatusDeliveryId).toBe(winners[0]!.executionStatusDeliveryId);
    expect(persisted.executionStatusDeliveryId).toBeTruthy();
    await expectReleased(issueId);
  });

  it("persists successor observations without changing admission material and rejects foreign ownership", async () => {
    const { run, issueId } = await seed();
    await db.update(heartbeatRuns).set({ controllerBootId: legacyControllerBootId,
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, run.id));
    const leaseId = randomUUID();
    const material = { provider: "local_encrypted", externalRef: "immutable-admission-material" };
    await db.insert(environmentLeases).values({ id: leaseId, companyId: run.companyId, issueId,
      heartbeatRunId: run.id, status: "active", metadata: { unrelated: "retained",
        adapterExecution: { state: "pending", version: 1, material } } });
    const progress = { version: 1, rootRunId: "hermes-parent", runId: "hermes-leaf",
      lineage: ["hermes-parent", "hermes-leaf"], cursors: { "hermes-leaf": 4 } };
    await recordAdapterExecutionProgress(db, { companyId: run.companyId, runId: run.id, leaseId, progress });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    expect(lease.metadata).toEqual({ unrelated: "retained", adapterExecution: { state: "pending", version: 1, material, progress } });
    await expect(recordAdapterExecutionProgress(writer, { companyId: randomUUID(), runId: run.id, leaseId, progress }))
      .rejects.toThrow("controller lease");
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, run.id));
    await expect(recordAdapterExecutionProgress(db, { companyId: run.companyId, runId: run.id, leaseId, progress }))
      .rejects.toThrow("controller lease");
    await db.update(heartbeatRuns).set({ controllerBootId: legacyControllerBootId,
      controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, run.id));
    await expect(recordAdapterExecutionProgress(db, { companyId: run.companyId, runId: run.id, leaseId, progress }))
      .rejects.toThrow("controller lease");
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, run.id));
    await settleAdapterExecution(db, { companyId: run.companyId, runId: run.id, leaseId });
    await expect(recordAdapterExecutionProgress(db, { companyId: run.companyId, runId: run.id, leaseId, progress }))
      .rejects.toThrow("pending admission");
  });

  it("deduplicates durable Hermes receipts across writers and rejects changed replay payloads", async () => {
    const { run } = await seed();
    const input = { companyId: run.companyId, runId: run.id, agentId: run.agentId,
      eventType: "hermes.message.delta", message: "once", nativeSource: {
        sourceInstanceId: "hermes_gateway:leaf", sourceEventId: "hermes_gateway:leaf:1",
        sourceSeq: 1, protocolSchemaVersion: 1, canonicalPayload: { run_id: "leaf", delta: "once" },
      } };
    const first = await appendHeartbeatRunEvent(db, input);
    const replay = await appendHeartbeatRunEvent(writer, input);
    expect(first.disposition).toBe("committed");
    expect(replay.disposition).toBe("duplicate");
    expect(replay.row.id).toBe(first.row.id);
    await expect(appendHeartbeatRunEvent(writer, { ...input,
      nativeSource: { ...input.nativeSource, canonicalPayload: { run_id: "leaf", delta: "changed" } } }))
      .rejects.toThrow("native_event_replay_conflict");
  });
});
