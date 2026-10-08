import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb, instanceSettings, instanceUserRoles } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertMcpOperatorInTx } from "../services/mcp-operator-authorization.js";

describe("current MCP operator authorization in PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-mcp-operator-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);
  afterEach(() => { vi.unstubAllEnvs(); });

  async function fixture(enabled: boolean, role: "owner" | "member" | "admin" | "support" = "owner", staleRole = false) {
    const companyId = randomUUID(), actorId = `operator-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Operator fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actorId, status: "active", membershipRole: "owner" });
    await db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableOwnerInstanceAdmin: enabled } })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableOwnerInstanceAdmin: enabled } } });
    if (staleRole) await db.insert(instanceUserRoles).values({ userId: actorId });
    return { companyId, actor: { actorType: "user", actorId, actorSource: "cloud_tenant", cloudStackRole: role } };
  }

  it("authorizes the authenticated Cloud stack owner with current elevation and no persisted instance role", async () => {
    const f = await fixture(true);
    await expect(db.transaction(tx => assertMcpOperatorInTx(tx, f.companyId, f.actor))).resolves.toBeUndefined();
  });

  it.each(["member", "admin", "support"] as const)("does not elevate Cloud %s using a stale persisted instance-admin row", async role => {
    const f = await fixture(true, role, true);
    await expect(db.transaction(tx => assertMcpOperatorInTx(tx, f.companyId, f.actor))).rejects.toThrow("MCP administration");
  });

  it("rejects a former elevated owner after current elevation is disabled despite a stale instance role", async () => {
    const f = await fixture(false, "owner", true);
    await expect(db.transaction(tx => assertMcpOperatorInTx(tx, f.companyId, f.actor))).rejects.toThrow("MCP administration");
  });

  it("requires authentication-owned Cloud owner provenance even when company ownership and a stale instance role exist", async () => {
    const f = await fixture(true, "owner", true);
    const { cloudStackRole: _role, ...actor } = f.actor;
    await expect(db.transaction(tx => assertMcpOperatorInTx(tx, f.companyId, actor))).rejects.toThrow("MCP administration");
  });

  it("rechecks suspended company membership for an otherwise elevated Cloud owner", async () => {
    const f = await fixture(true);
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, f.actor.actorId));
    await expect(db.transaction(tx => assertMcpOperatorInTx(tx, f.companyId, f.actor))).rejects.toThrow("MCP administration");
  });

  it.each([true, false])("uses current canonical managed owner elevation %s over the opposite stored value", async enabled => {
    const f = await fixture(!enabled);
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "fixture",
      features: { enableOwnerInstanceAdmin: enabled }, plugins: { autoInstall: [] } }));
    const operation = db.transaction(tx => assertMcpOperatorInTx(tx, f.companyId, f.actor));
    if (enabled) await expect(operation).resolves.toBeUndefined();
    else await expect(operation).rejects.toThrow("MCP administration");
  });

  it("retains current elevation's row lock until the privileged transaction settles", async () => {
    const f = await fixture(true);
    let report!: () => void, reject!: (error: unknown) => void, release!: () => void;
    const authorized = new Promise<void>((resolve, fail) => { report = resolve; reject = fail; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let pid = 0;
    const owner = db.transaction(async tx => {
      pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0].pid;
      await assertMcpOperatorInTx(tx, f.companyId, f.actor);
      report();
      await gate;
    });
    void owner.catch(reject);
    await authorized;
    const revoke = db.update(instanceSettings).set({ experimental: { enableOwnerInstanceAdmin: false } })
      .where(eq(instanceSettings.singletonKey, "default"));
    const outcome = revoke.then(() => null, error => error);
    try {
      let waited = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const [row] = await db.execute<{ present: boolean }>(sql`select exists (select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and ${pid} = any(pg_blocking_pids(pid))) as present`);
        if (row.present) { waited = true; break; }
        await db.execute(sql`select pg_sleep(0.02)`);
      }
      expect(waited).toBe(true);
    } finally { release(); await owner; }
    expect(await outcome).toBeNull();
    await expect(db.transaction(tx => assertMcpOperatorInTx(tx, f.companyId, f.actor))).rejects.toThrow("MCP administration");
  });
});
