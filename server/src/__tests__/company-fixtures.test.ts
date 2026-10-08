import { generateKeyPairSync, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, mcpWorkerEnrollments } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resetCompanyFixtures } from "./helpers/company-fixtures.js";
import { mcpWorkerEnrollmentService } from "../services/mcp-worker-enrollment.js";

describe("disposable company fixture reset", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-company-fixture-reset-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function seed(companyId = randomUUID()) {
    const agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Disposable fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture agent" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Fixture task", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, runId };
  }

  it("removes the selected company graph and permits identical paired-attempt IDs", async () => {
    const first = await seed();
    const foreign = await seed();
    await resetCompanyFixtures(db, [first.companyId]);
    expect(await db.select().from(companies).where(eq(companies.id, first.companyId))).toEqual([]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.runId))).toEqual([]);
    expect(await db.select().from(issues).where(eq(issues.id, first.issueId))).toEqual([]);
    expect(await db.select().from(agents).where(eq(agents.id, first.agentId))).toEqual([]);
    expect(await db.select().from(companies).where(eq(companies.id, foreign.companyId))).toHaveLength(1);
    expect((await seed(first.companyId)).companyId).toBe(first.companyId);
  });

  it("retains enrollment tombstones and the entire selected graph when protected state exists", async () => {
    const fixture = await seed();
    const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const prepared = await mcpWorkerEnrollmentService(db, { controllerInstanceId: "fixture-controller" }).prepare(
      fixture.companyId,
      { workerId: "fixture-worker", keyId: "fixture-key", publicKey, gatewayUrl: "https://worker.example/api",
        executionHostId: "fixture-host", expiresAt: Date.now() + 60_000 },
      { actorType: "user", actorId: "fixture-operator" },
    );
    await expect(resetCompanyFixtures(db, [fixture.companyId])).rejects.toThrow("Protected MCP fixtures require a fresh disposable database");
    expect(await db.select().from(companies).where(eq(companies.id, fixture.companyId))).toHaveLength(1);
    expect(await db.select().from(agents).where(eq(agents.id, fixture.agentId))).toHaveLength(1);
    expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, prepared.enrollment.id))).toHaveLength(1);
  });
});
