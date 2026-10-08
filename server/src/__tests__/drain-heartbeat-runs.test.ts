import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { cancelFixtureHeartbeatRuns, drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.js";

describe("heartbeat fixture settlement", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-fixture-drain-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Drain fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued" });
    return runId;
  }

  it("fails explicitly when persisted work never reaches quiescence", async () => {
    const runId = await seed();
    try {
      await expect(drainHeartbeatRunsToQuiescence(db, { drainActiveRunExecutions: async () => {} }))
        .rejects.toThrow("Heartbeat fixture still has queued or running work");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).toHaveLength(1);
    } finally {
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId));
    }
  });

  it("awaits tracked execution settlement before inspecting terminal rows", async () => {
    const runId = await seed();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let settled = false;
    const drain = drainHeartbeatRunsToQuiescence(db, {
      drainActiveRunExecutions: async () => {
        entered();
        await gate;
        await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
      },
    }).then(() => { settled = true; });
    try {
      await started;
      expect(settled).toBe(false);
    } finally {
      release();
      await drain;
    }
    expect(settled).toBe(true);
  });

  it("uses owning cancellation only for declared fixture companies and leaves failures inspectable", async () => {
    const ownedId = await seed(), foreignId = await seed();
    const [owned] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ownedId));
    const [foreign] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, foreignId));
    const heartbeat = heartbeatService(db);
    await expect(cancelFixtureHeartbeatRuns(db, { ...heartbeat,
      cancelRun: async () => { throw new Error("Owning cancellation refused"); },
    }, [owned.companyId])).rejects.toThrow("Owning cancellation refused");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ownedId)))[0].status).toBe("queued");
    // The foreign pending row still forbids a claim of database-wide quiescence.
    await expect(cancelFixtureHeartbeatRuns(db, heartbeat, [owned.companyId]))
      .rejects.toThrow("Heartbeat fixture still has queued or running work");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ownedId)))[0].status).toBe("cancelled");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, foreignId)))[0].status).toBe("queued");
    await cancelFixtureHeartbeatRuns(db, heartbeat, [foreign.companyId]);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  });
});
