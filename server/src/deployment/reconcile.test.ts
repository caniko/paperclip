import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, startEmbeddedPostgresTestDatabase, deploymentResources, agents, companies, companySecrets, companySecretVersions, authAccounts, routines, routineTriggers, agentApiKeys, acquireDeploymentLease, assertDeploymentSchemaCompatible } from "@paperclipai/db";
import { reconcileDeployment } from "./reconcile.js";
import { loadConfig } from "../config.js";
import { secretService } from "../services/secrets.js";
import type { DeploymentDescriptor } from "./runtime.js";
import { ensurePostgresDatabase, runDatabaseBackup, runDatabaseRestore } from "@paperclipai/db";
import { findServerAdapter } from "../adapters/registry.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
const requests: { authorization?: string; session?: string; body: string }[] = [];
const gateway = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (request.method === "POST" && request.url === "/v1/runs") {
    requests.push({ authorization: request.headers.authorization, session: request.headers["x-hermes-session-key"] as string, body });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ run_id: `fake-${requests.length}`, status: "started" }));
  } else if (request.url?.endsWith("/events")) {
    response.setHeader("content-type", "text/event-stream");
    response.end('event: run.completed\ndata: {"status":"completed","output":"fixture complete"}\n\n');
  } else {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "completed", output: "fixture complete" }));
  }
});
const root = mkdtempSync(join(tmpdir(), "paperclip-deployment-"));
const config = { ...loadConfig(), deploymentMode: "authenticated" as const, authBaseUrlMode: "explicit" as const, authPublicBaseUrl: "http://localhost:3100" };
const descriptor: DeploymentDescriptor = {
  version: 1, home: root, instance: "test", configFile: "/unused",
  credentialFiles: { gateway: join(root, "gateway"), bridge: join(root, "bridge") }, serverCredentials: { encryption: join(root, "master.key") },
  bootstrap: { name: "Test operator", email: "operator@example.test", passwordFile: join(root, "password") },
};
const manifest = {
  version: 1, owner: "test",
  companies: { example: { fields: { name: "Example", budgetMonthlyCents: 10000 } } },
  projects: { main: { company: "example", fields: { name: "Main" } } },
  agents: { worker: { company: "example", fields: { name: "Worker", adapterType: "hermes_gateway", adapterConfig: { apiBaseUrl: "http://127.0.0.1:8642" }, budgetMonthlyCents: 2000 }, credentials: { apiKey: "gateway" } } },
  routines: { daily: { company: "example", project: "main", agent: "worker", fields: { title: "Daily work" }, schedule: { kind: "schedule", cronExpression: "0 12 * * *", timezone: "UTC" } } },
  taskBridges: { tasks: { agent: "worker", project: "main", credential: "bridge", allowedAssignees: ["worker"] } },
};
beforeAll(async () => {
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  manifest.agents.worker.fields.adapterConfig.apiBaseUrl = `http://127.0.0.1:${address.port}`;
  process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = join(root, "master.key");
  writeFileSync(descriptor.serverCredentials.encryption!, "11".repeat(32), { mode: 0o600 });
  process.env.BETTER_AUTH_SECRET = "fixture-auth-secret-not-for-real-deployments";
  writeFileSync(descriptor.bootstrap!.passwordFile, "fixture-only-password", { mode: 0o600 });
  writeFileSync(descriptor.credentialFiles.gateway, "fixture-only-gateway-key", { mode: 0o600 });
  writeFileSync(descriptor.credentialFiles.bridge, "fixture-only-task-bridge-key-at-least-32-characters", { mode: 0o600 });
  database = await startEmbeddedPostgresTestDatabase("paperclip-declarative-db-");
  db = createDb(database.connectionString);
}, 90000);
afterAll(async () => { gateway.closeAllConnections(); gateway.close(); await database?.cleanup(); rmSync(root, { recursive: true, force: true }); });
const reconcile = (raw: unknown, apply = true) => reconcileDeployment(db, raw, { descriptor, config, apply });

it("plans without writes, bootstraps once and preserves identities, pauses and spending", async () => {
  const plan = await reconcile(manifest, false);
  expect(plan.differences.length).toBeGreaterThan(0);
  expect(await db.select().from(companies)).toHaveLength(0);
  expect(await db.select().from(authAccounts)).toHaveLength(0);
  const first = await reconcile(manifest);
  expect(await db.select().from(authAccounts)).toHaveLength(1);
  const agentId = first.bindings["agent/worker"];
  const routineId = first.bindings["routine/daily"];
  await db.update(routines).set({ status: "paused" }).where(eq(routines.id, routineId));
  await db.update(agents).set({ status: "paused", pauseReason: "manual", spentMonthlyCents: 123 }).where(eq(agents.id, agentId));
  const second = await reconcile(manifest);
  expect(second.differences).toEqual([]);
  expect(second.bindings).toEqual(first.bindings);
  expect(await db.select().from(companySecretVersions)).toHaveLength(1);
  expect(await db.select().from(authAccounts)).toHaveLength(1);
  const changed = structuredClone(manifest); changed.agents.worker.fields.name = "Renamed worker";
  const third = await reconcile(changed);
  expect(third.bindings["agent/worker"]).toBe(agentId);
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  expect(agent).toMatchObject({ name: "Renamed worker", status: "paused", pauseReason: "manual", spentMonthlyCents: 123 });
  expect((await db.select().from(routines).where(eq(routines.id, routineId)))[0].status).toBe("paused");
  await expect(db.update(routineTriggers).set({ cronExpression: "* * * * *" }).where(eq(routineTriggers.id, first.bindings["schedule/daily"]))).rejects.toThrow();
  await expect(db.update(agentApiKeys).set({ scopeConfig: null }).where(eq(agentApiKeys.id, first.bindings["taskBridge/tasks"]))).rejects.toThrow();
  const resolved = await secretService(db).resolveAdapterConfigForRuntime(agent.companyId, agent.adapterConfig, { consumerType: "agent", consumerId: agent.id }, { adapterType: "hermes_gateway" });
  expect(resolved.config.apiKey).toBe("fixture-only-gateway-key");
  const logs: string[] = [];
  for (const issueId of ["issue-one", "issue-two"]) {
    const result = await findServerAdapter("hermes_gateway")!.execute({
      runId: `run-${issueId}`, agent, config: resolved.config,
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      context: { issueId, wakeReason: "manual" },
      onLog: async (_stream, chunk) => { logs.push(chunk); }, onMeta: async () => {},
    });
    expect(result.exitCode).toBe(0);
  }
  expect(requests).toHaveLength(2);
  expect(requests.every((r) => r.authorization === "Bearer fixture-only-gateway-key")).toBe(true);
  expect(requests[0].session).not.toBe(requests[1].session);
  expect(logs.join("")).not.toContain("fixture-only-gateway-key");
  await expect(db.update(agents).set({ name: "UI drift" }).where(eq(agents.id, agentId))).rejects.toThrow();
  await expect(secretService(db).rotate(first.bindings["secret/worker.apiKey"], { value: "UI rotation" })).rejects.toThrow();
  const removed = { ...changed, agents: {}, routines: {}, taskBridges: {} };
  await reconcile(removed);
  expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(1);
  await expect(db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId))).rejects.toThrow();
  expect((await db.select().from(agentApiKeys).where(eq(agentApiKeys.id, first.bindings["taskBridge/tasks"])))[0].revokedAt).not.toBeNull();
  expect(JSON.stringify(plan)).not.toContain("fixture-only");
}, 90000);

it("rejects invalid references and ownership conflicts without partial writes", async () => {
  const before = await db.select().from(deploymentResources);
  await expect(reconcile({ ...manifest, agents: { bad: { ...manifest.agents.worker, company: "missing" } } })).rejects.toThrow();
  const [owned] = before.filter((r) => r.kind === "company");
  await expect(reconcile({ version: 1, owner: "other", companies: { stolen: { adopt: owned.resourceId, fields: { name: "Stolen" } } } })).rejects.toThrow("ownership");
  expect(await db.select().from(deploymentResources)).toEqual(before);
});

it("reconciles structured native adapter configuration and resolves process credentials", async () => {
  const declaration = {
    version: 1, owner: "structured",
    companies: { example: { fields: { name: "Structured contracts" } } },
    agents: {
      process: { company: "example", enabled: false, fields: {
        name: "Trusted local process", adapterType: "process",
        adapterConfig: { command: "worker", args: ["--once"], env: { MODE: "test" } },
      }, credentials: { "env.WORKER_TOKEN": "gateway" } },
      http: { company: "example", enabled: false, fields: {
        name: "HTTP worker", adapterType: "http", adapterConfig: {
          url: "https://worker.example.test", headers: { Accept: "application/json" },
          payloadTemplate: { task: { labels: ["fixture"] } }, timeoutMs: 1000,
        },
      } },
    },
  };
  const first = await reconcile(declaration);
  expect((await reconcile(declaration, false)).differences).toEqual([]);
  const [agent] = await db.select().from(agents).where(eq(agents.id, first.bindings["agent/process"]));
  const resolved = await secretService(db).resolveAdapterConfigForRuntime(agent.companyId, agent.adapterConfig,
    { consumerType: "agent", consumerId: agent.id }, { adapterType: "process" });
  expect(resolved.config).toMatchObject({ command: "worker", args: ["--once"], env: {
    MODE: "test", WORKER_TOKEN: "fixture-only-gateway-key",
  } });
  expect(agent.status).toBe("paused");
  const [http] = await db.select().from(agents).where(eq(agents.id, first.bindings["agent/http"]));
  expect(http.adapterConfig).toEqual(declaration.agents.http.fields.adapterConfig);
});

it("validates unchanged encrypted material before planning or applying without secret access writes", async () => {
  const declaration = { ...manifest, owner: "key-readiness", companies: { example: { fields: { name: "Key readiness" } } }, routines: {}, taskBridges: {} };
  await reconcile(declaration);
  const snapshot = async () => ({
    secrets: await db.select().from(companySecrets),
    versions: await db.select().from(companySecretVersions),
    ledger: await db.select().from(deploymentResources),
  });
  const before = await snapshot();
  const file = descriptor.serverCredentials.encryption!;
  const key = readFileSync(file, "utf8");
  try {
    expect((await reconcile(declaration, false)).differences).toEqual([]);
    for (const apply of [false, true]) {
      writeFileSync(file, "22".repeat(32), { mode: 0o600 });
      await expect(reconcile(declaration, apply)).rejects.toThrow("Deployment encryption key cannot decrypt stored secrets");
      rmSync(file);
      await expect(reconcile(declaration, apply)).rejects.toThrow("Deployment credential");
      expect(existsSync(file)).toBe(false);
    }
    expect(await snapshot()).toEqual(before);
  } finally { writeFileSync(file, key, { mode: 0o600 }); }
  expect((await reconcile(declaration)).differences).toEqual([]);
});

it("fences concurrent writers and refuses an unknown migration journal", async () => {
  const release = await acquireDeploymentLease(database.connectionString);
  try {
    await expect(acquireDeploymentLease(database.connectionString)).rejects.toThrow("already owns");
    await assertDeploymentSchemaCompatible(database.connectionString);
  } finally { await release(); }
  const again = await acquireDeploymentLease(database.connectionString); await again();
  let lost = false;
  const releaseLost = await acquireDeploymentLease(database.connectionString, () => { lost = true; });
  await db.execute(sql`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and objid = 1735289202 and database = (select oid from pg_database where datname = current_database())`);
  await expect.poll(() => lost).toBe(true);
  await releaseLost();
  await db.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('unknown-future-migration', 9999999999999)`);
  try { await expect(assertDeploymentSchemaCompatible(database.connectionString)).rejects.toThrow("unknown or newer"); }
  finally { await db.execute(sql`delete from drizzle.__drizzle_migrations where hash = 'unknown-future-migration'`); }
});

it("requires explicit adoption and rolls back an apply that fails after creating resources", async () => {
  const [unmanaged] = await db.insert(companies).values({ name: "Existing", issuePrefix: "EXI" }).returning();
  const adoption = { version: 1, owner: "adoption", companies: { existing: { fields: { name: "Existing" } } } };
  await expect(reconcile(adoption)).rejects.toThrow("explicit adoption");
  const adopted = await reconcile({ ...adoption, companies: { existing: { ...adoption.companies.existing, adopt: unmanaged.id } } });
  expect(adopted.bindings["company/existing"]).toBe(unmanaged.id);
  const before = await db.select().from(companies);
  // Fail at the database boundary after company/project/agent creation.
  await db.execute(sql`create function deployment_test_failure() returns trigger language plpgsql as $$ begin raise exception 'injected write failure'; end; $$`);
  await db.execute(sql`create trigger deployment_test_failure before insert on routines for each row execute function deployment_test_failure()`);
  const invalid = { ...manifest, owner: "rollback", companies: { example: { fields: { name: "Rollback" } } },
    agents: { worker: { ...manifest.agents.worker, enabled: false } }, taskBridges: {} };
  try { await expect(reconcile(invalid)).rejects.toThrow(); }
  finally {
    await db.execute(sql`drop trigger deployment_test_failure on routines`);
    await db.execute(sql`drop function deployment_test_failure()`);
  }
  expect(await db.select().from(companies)).toEqual(before);
  expect(await db.select().from(deploymentResources).where(eq(deploymentResources.owner, "rollback"))).toEqual([]);
});

it("restores ownership, stable IDs, encrypted credentials and schema guards from a logical backup", async () => {
  const restoredManifest = { ...manifest, owner: "restore", companies: { example: { fields: { name: "Restore fixture" } } }, routines: {}, taskBridges: {} };
  const original = await reconcile(restoredManifest);
  const backup = await runDatabaseBackup({ connectionString: database.connectionString, backupDir: join(root, "backups"),
    retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 }, backupEngine: "javascript" });
  const admin = new URL(database.connectionString); admin.pathname = "/postgres";
  await ensurePostgresDatabase(admin.toString(), "deployment_restore");
  const target = new URL(database.connectionString); target.pathname = "/deployment_restore";
  await runDatabaseRestore({ connectionString: target.toString(), backupFile: backup.backupFile });
  await assertDeploymentSchemaCompatible(target.toString());
  const restored = createDb(target.toString());
  const after = await reconcileDeployment(restored, restoredManifest, { descriptor, config, apply: false });
  expect(after.differences).toEqual([]);
  expect(after.bindings).toEqual(original.bindings);
  const [agent] = await restored.select().from(agents).where(eq(agents.id, after.bindings["agent/worker"]));
  const resolved = await secretService(restored).resolveAdapterConfigForRuntime(agent.companyId, agent.adapterConfig, { consumerType: "agent", consumerId: agent.id }, { adapterType: "hermes_gateway" });
  expect(resolved.config.apiKey).toBe("fixture-only-gateway-key");
  await expect(restored.update(agents).set({ name: "bypass after restore" }).where(eq(agents.id, agent.id))).rejects.toThrow();
}, 90000);
