import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authAccounts, authSessions, authUsers, authVerifications, companies, companyMemberships, createDb,
  instanceSettings, instanceUserRoles, principalPermissionGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { claimBoardOwnership, initializeBoardClaimChallenge, getBoardClaimWarningUrl } from "../board-claim.js";
import { cloudActorHeaderSourceFromHeaders, resolveCloudTenantActor } from "../middleware/auth.js";
import { bootstrapOperator } from "../deployment/bootstrap.js";
import { ensureLocalBoardCompanyMembership } from "../services/user-company-access-lock.js";
import { loadConfig } from "../config.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("production user membership writer fences", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;
  const config = { ...loadConfig(), deploymentMode: "authenticated" as const,
    authBaseUrlMode: "explicit" as const, authPublicBaseUrl: "http://localhost:3100", authDisableSignUp: true };
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-membership-writers-");
    db = createDb(database.connectionString);
    root = await mkdtemp(join(tmpdir(), "paperclip-membership-writers-"));
    await writeFile(join(root, "password"), "fixture-only-membership-operator-password", { mode: 0o600 });
    vi.stubEnv("BETTER_AUTH_SECRET", "membership-writer-fixture-signing-secret-at-least-32-characters");
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "membership-writer-fixture-token");
  }, 30_000);
  afterEach(async () => {
    await initializeBoardClaimChallenge(db, { deploymentMode: "local_trusted" });
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(instanceUserRoles);
    await db.delete(instanceSettings);
    await db.delete(authSessions);
    await db.delete(authAccounts);
    await db.delete(authVerifications);
    await db.delete(authUsers);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function holdUser(userId: string) {
    let ready!: (pid: number) => void, failed!: (error: unknown) => void, release!: () => void;
    const held = new Promise<number>((resolve, reject) => { ready = resolve; failed = reject; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const done = db.transaction(async tx => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'paperclip.user-company-access:' + userId}, 0))`);
      ready(backend.pid);
      await gate;
    });
    void done.catch(failed);
    return { pid: await held, release, done };
  }

  async function waitForBlocker(pid: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [waiter] = await db.execute(sql`select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid)) limit 1`);
      if (waiter) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("Production membership writer did not wait on the user fence");
  }

  it.each(["cloud sync", "board claim", "existing bootstrap", "local board startup"] as const)(
    "%s waits before company or instance-role ownership", async operation => {
      const userId = `production-fence-${randomUUID()}`;
      const email = `${userId}@example.test`;
      const stackId = `stack-${randomUUID()}`;
      const cloudHeaders = (role: string) => cloudActorHeaderSourceFromHeaders({
        "x-paperclip-cloud-tenant-token": "membership-writer-fixture-token", "x-paperclip-cloud-user-id": userId,
        "x-paperclip-cloud-user-email": email, "x-paperclip-cloud-stack-id": stackId, "x-paperclip-cloud-stack-role": role,
      });
      const [company] = await db.insert(companies).values({ name: `Production fence ${randomUUID()}`,
        issuePrefix: `PF${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
      let targetCompanyId = company.id;
      let run!: () => Promise<unknown>;
      if (operation === "cloud sync") {
        const actor = await resolveCloudTenantActor(db, cloudHeaders("owner"));
        expect(actor?.companyIds).toHaveLength(1);
        targetCompanyId = actor!.companyIds![0];
        run = () => resolveCloudTenantActor(db, cloudHeaders("member"));
      } else {
        await db.insert(authUsers).values({ id: userId, name: "Fence fixture", email, emailVerified: true,
          createdAt: new Date(), updatedAt: new Date() });
        if (operation === "board claim") {
          await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
          await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
          const url = new URL(getBoardClaimWarningUrl("localhost", 3100)!);
          run = () => claimBoardOwnership(db, { token: url.pathname.split("/").pop()!, code: url.searchParams.get("code")!, userId });
        } else if (operation === "existing bootstrap") {
          await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
          run = () => bootstrapOperator(db, config, { email, name: "Fence fixture", passwordFile: join(root, "password") });
        } else run = () => ensureLocalBoardCompanyMembership(db, targetCompanyId, userId);
      }
      const originalMemberships = await db.select().from(companyMemberships).orderBy(companyMemberships.id);
      const originalRoles = await db.select().from(instanceUserRoles).orderBy(instanceUserRoles.id);
      const blocker = await holdUser(userId);
      const write = run();
      void write.catch(() => undefined);
      try {
        await waitForBlocker(blocker.pid);
        expect(await db.select().from(companyMemberships).orderBy(companyMemberships.id)).toEqual(originalMemberships);
        expect(await db.select().from(instanceUserRoles).orderBy(instanceUserRoles.id)).toEqual(originalRoles);
        await db.transaction(async tx => {
          await tx.select().from(companies).where(eq(companies.id, targetCompanyId)).for("update", { noWait: true });
          // An existing-actor bootstrap must not hold the role table lock while
          // waiting for a board claimant's user fence.
          await tx.execute(sql`lock table ${instanceUserRoles} in share row exclusive mode nowait`);
        });
        blocker.release();
        await blocker.done;
        await write;
      } finally {
        blocker.release();
        await Promise.allSettled([blocker.done, write]);
      }
    }, 15_000,
  );

  it("reserves a fresh bootstrap identity and rejects raced adoption of another administrator", async () => {
    const userId = randomUUID();
    const input = { email: "reserved-operator@example.test", name: "Reserved operator", passwordFile: join(root, "password") };
    const created = await bootstrapOperator(db, config, input, true, userId);
    expect(created).toBe(userId);
    const before = await db.select().from(authUsers);
    await expect(bootstrapOperator(db, config, input, true, randomUUID())).rejects.toThrow("Bootstrap identity changed; retry preflight");
    expect(await db.select().from(authUsers)).toEqual(before);
    expect(await bootstrapOperator(db, config, input, true, userId)).toBe(userId);
  });
});
