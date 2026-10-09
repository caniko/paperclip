import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { adapterSessionAffinities, agentTaskSessions, agents, companies, createDb, environmentLeases, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.js";
import { loadExecutionAffinity, resetExecutionAffinities } from "../services/adapter-session-affinity.js";
import { prepareAdapterExecution, reconcileAdapterExecution } from "../services/adapter-execution-ownership.js";
import { legacyControllerBootId } from "../services/legacy-controller-lease.js";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";

// Use the real gateway protocol; unrelated runtime tool delivery is outside this fixture.
vi.mock("../adapters/index.js", async () => {
  const { createHermesGatewayServerAdapter } = await import("@paperclipai/hermes-paperclip-adapter");
  return { getServerAdapter: createHermesGatewayServerAdapter, findActiveServerAdapter: createHermesGatewayServerAdapter, runningProcesses: new Map() };
});

describe("controller conversation executor affinity", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let origin: string;
  let primarySlots = 0;
  let secondarySlots = 1;
  const admissions: Array<{ worker: string; key: string; body: string; pinnedBeforeAdmission: boolean }> = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer fixture-key") return res.writeHead(401).end();
    const worker = req.url!.split("/")[1]!;
    if (req.url!.endsWith("/capabilities")) return res.end(JSON.stringify({ features: {
      runs_executor_admission: { version: 1, accepting: true, available_slots: worker === "atlas" ? primarySlots : secondarySlots },
      runs_recovery: { version: 1, durable_lineage_stop: true, ordinary_stop_admission: true, admission_binding: 1 },
    } }));
    if (req.url!.endsWith("/v1/runs") || req.url!.endsWith("/v1/runs/stop")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const key = String(req.headers["idempotency-key"]);
      if (!req.url!.endsWith("/stop")) {
        // This database assertion occurs before the remote service accepts work.
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, key));
        const pins = await db.select().from(adapterSessionAffinities).where(eq(adapterSessionAffinities.agentId, run!.agentId));
        const pinnedBeforeAdmission = pins.some(pin => pin.endpoint === `${origin}/${worker}`
          && (pin.scopeKey === "agent" || pin.taskKey === run!.issueId));
        admissions.push({ worker, key, body, pinnedBeforeAdmission });
        if (run?.issueId) await db.update(issues).set({ status: "done" }).where(eq(issues.id, run.issueId));
        return res.end(JSON.stringify({ run_id: key, status: "completed", output: "complete" }));
      }
      return res.end(JSON.stringify({ run_id: key, status: "completed", stop_requested: true, lineage_settled: true,
        lineage: [{ run_id: key, status: "completed" }], admission: { version: 1, root_run_id: key,
          key_sha256: createHash("sha256").update(key).digest("hex"), body_sha256: createHash("sha256").update(body).digest("hex") } }));
    }
    if (req.url!.endsWith("/events")) {
      res.setHeader("Content-Type", "text/event-stream");
      return res.end();
    }
    res.end(JSON.stringify({ run_id: req.url!.split("/").at(-1), status: "completed", output: "complete" }));
  });

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-affinity-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-affinity-db-");
    db = createDb(database.connectionString);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);
  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function seed(strategy = "agent") {
    primarySlots = 0; secondarySlots = 1;
    const companyId = randomUUID(), agentId = randomUUID(), first = randomUUID(), second = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Affinity", issuePrefix: companyId.slice(0, 8), defaultResponsibleUserId: "fixture-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Gateway", role: "engineer", adapterType: "hermes_gateway",
      adapterConfig: { apiBaseUrl: `${origin}/atlas`, executorEndpoints: [`${origin}/atlas`, `${origin}/nomad`],
        apiKey: "fixture-key", sessionKeyStrategy: strategy, timeoutSec: 5, pollIntervalMs: 250, eventReconnectMs: 250 },
    });
    await db.insert(issues).values([first, second].map(id => ({ id, companyId, title: "Affinity turn", status: "todo", assigneeAgentId: agentId, responsibleUserId: "fixture-user" })));
    return { companyId, agentId, first, second };
  }

  async function turn(service: ReturnType<typeof heartbeatService>, agentId: string, issueId: string) {
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    const run = await service.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId }, contextSnapshot: { issueId, taskId: issueId, skipIssueComment: true } });
    expect(run).toBeTruthy();
    await drainHeartbeatRunsToQuiescence(db, service);
    const saved = await service.getRun(run!.id);
    expect(saved?.status).toBe("succeeded");
    return saved!;
  }

  it("pins agent-wide turns across issues and a new controller until explicit reset", async () => {
    const fixture = await seed();
    await turn(heartbeatService(db), fixture.agentId, fixture.first);
    primarySlots = 1;
    const restarted = heartbeatService(db);
    await turn(restarted, fixture.agentId, fixture.second);
    expect(admissions.slice(-2).map(row => row.worker)).toEqual(["nomad", "nomad"]);
    expect(JSON.parse(admissions.at(-1)!.body).session_id).toBe(JSON.parse(admissions.at(-2)!.body).session_id);
    expect(admissions.slice(-2).every(row => row.pinnedBeforeAdmission)).toBe(true);
    await restarted.resetRuntimeSession(fixture.agentId);
    await turn(heartbeatService(db), fixture.agentId, fixture.first);
    expect(admissions.at(-1)!.worker).toBe("atlas");
  });

  it.each(["issue", "run", "none"])("uses %s scope rather than sharing unrelated turns", async strategy => {
    const fixture = await seed(strategy);
    const service = heartbeatService(db);
    await turn(service, fixture.agentId, fixture.first);
    primarySlots = 1;
    await turn(service, fixture.agentId, strategy === "issue" ? fixture.second : fixture.first);
    expect(admissions.slice(-2).map(row => row.worker)).toEqual(["nomad", "atlas"]);
    if (strategy === "issue") {
      await turn(service, fixture.agentId, fixture.first);
      expect(admissions.at(-1)!.worker).toBe("nomad");
    }
  });

  it("refuses a pinned unavailable worker instead of failing over", async () => {
    const fixture = await seed();
    const service = heartbeatService(db);
    await turn(service, fixture.agentId, fixture.first);
    primarySlots = 1; secondarySlots = 0;
    const before = admissions.length;
    const run = await service.wakeup(fixture.agentId, { source: "automation", reason: "issue_commented", payload: { issueId: fixture.second },
      contextSnapshot: { issueId: fixture.second, taskId: fixture.second, skipIssueComment: true } });
    await drainHeartbeatRunsToQuiescence(db, service);
    expect((await service.getRun(run!.id))?.errorCode).toBe("hermes_gateway_executor_unavailable");
    expect(admissions).toHaveLength(before);
  });

  it("retains the first-turn pin through recovery without a finalized task session", async () => {
    const fixture = await seed();
    const runId = randomUUID(), leaseId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: fixture.companyId, agentId: fixture.agentId, issueId: fixture.first,
      status: "running", invocationSource: "manual", controllerBootId: legacyControllerBootId,
      controllerLeaseExpiresAt: sql`clock_timestamp() + interval '1 minute'`, contextSnapshot: { issueId: fixture.first } });
    await db.insert(environmentLeases).values({ id: leaseId, companyId: fixture.companyId, agentId: fixture.agentId,
      heartbeatRunId: runId, status: "active", provider: "local", scope: "run", metadata: {} });
    const input = { companyId: fixture.companyId, agentId: fixture.agentId, adapterType: "hermes_gateway", scope: "agent" as const,
      taskKey: fixture.first, primaryEndpoint: `${origin}/atlas` };
    const affinity = await loadExecutionAffinity(db, input);
    const checkpoint = { version: 1, baseUrl: `${origin}/nomad`, headers: { Authorization: "Bearer fixture-key", "Idempotency-Key": runId }, body: JSON.stringify({ input: "first turn" }) };
    await prepareAdapterExecution(db, { companyId: fixture.companyId, runId, leaseId, adapterType: "hermes_gateway", checkpoint,
      affinity: { ...affinity, selectedEndpoint: `${origin}/nomad` } });
    primarySlots = 1;
    expect(await reconcileAdapterExecution(db, { companyId: fixture.companyId, runId })).toBe("settled");
    expect((await loadExecutionAffinity(db, { ...input, taskKey: fixture.second })).endpoint).toBe(`${origin}/nomad`);
    const [lost] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await terminalizeLegacyExecution({ db, run: lost!, status: "failed", patch: { error: "Lost controller", errorCode: "process_lost", finishedAt: new Date() } });
    await turn(heartbeatService(db), fixture.agentId, fixture.second);
    expect(admissions.at(-1)!.worker).toBe("nomad");
  });

  it("adopts unambiguous historical agent memory and refuses conflicting worker history", async () => {
    const fixture = await seed();
    const scope = { companyId: fixture.companyId, agentId: fixture.agentId, adapterType: "hermes_gateway" };
    await db.insert(agentTaskSessions).values({ ...scope, taskKey: fixture.first,
      sessionParamsJson: { sessionKey: "old-agent-memory", strategy: "agent" } });
    const adopted = await loadExecutionAffinity(db, { ...scope, scope: "agent", taskKey: fixture.second, primaryEndpoint: `${origin}/atlas` });
    expect(adopted.endpoint).toBe(`${origin}/atlas`);
    primarySlots = 1;
    await turn(heartbeatService(db), fixture.agentId, fixture.second);
    expect(admissions.at(-1)!.worker).toBe("atlas");
    expect(admissions.at(-1)!.pinnedBeforeAdmission).toBe(true);

    const conflicting = await seed();
    await db.insert(agentTaskSessions).values([conflicting.first, conflicting.second].map((taskKey, index) => ({
      companyId: conflicting.companyId, agentId: conflicting.agentId, adapterType: "hermes_gateway", taskKey,
      sessionParamsJson: { sessionKey: "shared-agent-memory", strategy: "agent", executorBaseUrl: `${origin}/${index ? "nomad" : "atlas"}` },
    })));
    await expect(loadExecutionAffinity(db, { companyId: conflicting.companyId, agentId: conflicting.agentId,
      adapterType: "hermes_gateway", scope: "agent", taskKey: conflicting.first, primaryEndpoint: `${origin}/atlas` }))
      .rejects.toThrow("Conflicting conversation executor history");
    await heartbeatService(db).resetRuntimeSession(conflicting.agentId);
    expect((await loadExecutionAffinity(db, { companyId: conflicting.companyId, agentId: conflicting.agentId,
      adapterType: "hermes_gateway", scope: "agent", taskKey: conflicting.first, primaryEndpoint: `${origin}/atlas` })).endpoint).toBeNull();
  });

  it("keeps a pre-pool runtime-only conversation primary and fences company ownership", async () => {
    const fixture = await seed();
    const input = { companyId: fixture.companyId, agentId: fixture.agentId, adapterType: "hermes_gateway", scope: "agent" as const,
      taskKey: null, primaryEndpoint: `${origin}/atlas`, runtime: { sessionId: "old-runtime-session", sessionParams: null } };
    expect((await loadExecutionAffinity(db, input)).endpoint).toBe(`${origin}/atlas`);
    await expect(loadExecutionAffinity(db, { ...input, companyId: randomUUID() })).rejects.toThrow("outside the company");
  });

  it("fences resets and conflicting concurrent selections atomically before checkpoint persistence", async () => {
    const fixture = await seed();
    const affinity = await loadExecutionAffinity(db, { companyId: fixture.companyId, agentId: fixture.agentId,
      adapterType: "hermes_gateway", scope: "agent", taskKey: fixture.first, primaryEndpoint: `${origin}/atlas` });
    async function preparing() {
      const runId = randomUUID(), leaseId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: fixture.companyId, agentId: fixture.agentId,
        status: "running", invocationSource: "manual", controllerBootId: legacyControllerBootId,
        controllerLeaseExpiresAt: sql`clock_timestamp() + interval '1 minute'` });
      await db.insert(environmentLeases).values({ id: leaseId, companyId: fixture.companyId, agentId: fixture.agentId,
        heartbeatRunId: runId, status: "active", provider: "local", scope: "run", metadata: {} });
      return { companyId: fixture.companyId, runId, leaseId, adapterType: "hermes_gateway", checkpoint: { body: "immutable" } };
    }
    const first = await preparing(), second = await preparing();
    await prepareAdapterExecution(db, { ...first, affinity: { ...affinity, selectedEndpoint: `${origin}/nomad` } });
    await expect(prepareAdapterExecution(db, { ...second, affinity: { ...affinity, selectedEndpoint: `${origin}/atlas` } }))
      .rejects.toThrow("pinned to another worker");
    const third = await preparing();
    await resetExecutionAffinities(db, fixture.companyId, fixture.agentId);
    await expect(prepareAdapterExecution(db, { ...third, affinity: { ...affinity, selectedEndpoint: `${origin}/nomad` } }))
      .rejects.toThrow("reset");
    for (const attempt of [second, third]) {
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, attempt.leaseId));
      expect(lease?.metadata).toEqual({});
    }
    // These fixture admissions never reach a provider; remove the synthetic live status for teardown.
    for (const attempt of [first, second, third]) await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, attempt.runId));
  });
});
