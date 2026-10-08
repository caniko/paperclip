import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, environmentLeases, heartbeatRuns, instanceUserRoles,
  issues, mcpPreparedLaunches, mcpWorkerEnrollments, nativeRunFinalizations, projects, goals, costEvents, financeEvents,
  workspaceRuntimeServices, decisionQueues, chatEndpoints, toolApplications, toolConnections, decisionQueueItems,
  decisionTriage, decisionTriageEvents, decisionRetention, decisionArchiveNotificationOutbox } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { mcpWorkerEnrollmentService } from "../services/mcp-worker-enrollment.js";
import { companyService } from "../services/companies.js";
import { retireMcpCompanyInTx } from "../services/mcp-company-retirement.js";
import { accessService } from "../services/access.js";
import { resetRuntimeServicesForTests, setWorkspaceRuntimeExposureDepsForTests, startRuntimeServicesForWorkspaceControl,
  ensureRuntimeServicesForRun, stopRuntimeServicesForExecutionWorkspace, type RealizedExecutionWorkspace } from "../services/workspace-runtime.js";

describe("permanent MCP company retirement SQL boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-mcp-retirement-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retirement fixture", issuePrefix: companyId.slice(0, 8), status: "archived" });
    // Direct SQL is a disposable fixture producer, never an operator enrollment
    // endpoint. The production service must still validate keys and all pins.
    const [enrollment] = await db.insert(mcpWorkerEnrollments).values({ companyId, controllerInstanceId: "controller-a",
      workerId: "worker-a", keyId: "key-a", publicKey: "fixture-key", gatewayUrl: "https://private-worker.example",
      executionHostId: "host-a", bootstrapTokenHash: "a".repeat(64), nonce: "b".repeat(64),
      challengeExpiresAt: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 120_000) }).returning();
    return { companyId, enrollment };
  }

  async function receipt(tx: Tx, f: Awaited<ReturnType<typeof fixture>>, count = 1, launchCount = 0) {
    await tx.select().from(companies).where(eq(companies.id, f.companyId)).for("update");
    const [revoked] = await tx.update(mcpWorkerEnrollments).set({ state: "revoked", revision: randomUUID(), revokedAt: sql`clock_timestamp()` })
      .where(eq(mcpWorkerEnrollments.id, f.enrollment.id)).returning();
    await tx.execute(sql`insert into mcp_company_retirements (company_id, controller_instance_id, actor_id, enrollment_count, launch_count)
      values (${f.companyId}, 'controller-a', 'fixture-operator', ${count}, ${launchCount})`);
    await tx.execute(sql`insert into mcp_company_retired_enrollments (company_id, enrollment_id, revision)
      values (${f.companyId}, ${revoked.id}, ${revoked.revision})`);
    return revoked;
  }

  async function launchFixture(companyId: string) {
    const agentId = randomUUID(), runId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Settled worker" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "cancelled", finishedAt: new Date() });
    const [launch] = await db.insert(mcpPreparedLaunches).values({ id: randomUUID(), companyId, agentId, runId,
      controllerBootId: randomUUID(), generation: 7, launchDigest: "a".repeat(64), material: { private: "fixture" }, expiresAt: new Date() }).returning();
    return launch;
  }

  async function launchReceipt(tx: Tx, launch: typeof mcpPreparedLaunches.$inferSelect) {
    await tx.execute(sql`insert into mcp_company_retired_launches
      (company_id, launch_id, agent_id, run_id, issue_id, project_id, controller_boot_id, generation)
      values (${launch.companyId}, ${launch.id}, ${launch.agentId}, ${launch.runId}, ${launch.issueId},
        ${launch.projectId}, ${launch.controllerBootId}, ${launch.generation})`);
  }

  async function retire(f: Awaited<ReturnType<typeof fixture>>) {
    return db.transaction(async tx => {
      const revoked = await receipt(tx, f);
      await tx.delete(activityLog).where(eq(activityLog.companyId, f.companyId));
      await tx.delete(companies).where(eq(companies.id, f.companyId));
      return revoked;
    });
  }

  async function operator(companyId: string) {
    const userId = `retirement-${randomUUID()}`;
    await db.insert(instanceUserRoles).values({ userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "admin" });
    return { actorType: "user" as const, actorId: userId, actorSource: "session" as const };
  }

  it("preserves ordinary no-MCP company deletion's board behavior", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Ordinary company", issuePrefix: companyId.slice(0, 8) });
    expect(await companyService(db).remove(companyId)).toMatchObject({ id: companyId });
    expect(await db.execute(sql`select * from mcp_company_retirements where company_id = ${companyId}`)).toHaveLength(0);
  });

  it.each(["active", "pending_cleanup"])("preserves ordinary no-MCP lease recovery ownership: %s", async status => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Ordinary retained company", issuePrefix: companyId.slice(0, 8) });
    const [lease] = await db.insert(environmentLeases).values({ companyId, status, provider: "test_remote",
      providerLeaseId: `retained-${randomUUID()}`, environmentId: null, heartbeatRunId: null,
      metadata: { pluginId: "fixture-provider", pendingCleanupInFlight: false, pendingCleanupLeaseExpiresAtMs: 0 } }).returning();
    await expect(companyService(db).remove(companyId)).rejects.toThrow();
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id))).toEqual([lease]);
    expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(1);
    expect(await db.execute(sql`select * from mcp_company_retirements where company_id = ${companyId}`)).toHaveLength(0);
  });

  it("deletes a settled ordinary no-MCP lease without MCP operator or archive requirements", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Ordinary settled company", issuePrefix: companyId.slice(0, 8) });
    await db.insert(environmentLeases).values({ companyId, status: "released", provider: "test_remote",
      providerLeaseId: `destroyed-${randomUUID()}`, cleanupStatus: "success", releasedAt: new Date() });
    expect(await companyService(db).remove(companyId)).toMatchObject({ id: companyId });
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, companyId))).toHaveLength(0);
    expect(await db.execute(sql`select * from mcp_company_retirements where company_id = ${companyId}`)).toHaveLength(0);
  });

  it("retains an unregistered persisted backend after bookkeeping Stop instead of treating it as settled", async () => {
    const f = await fixture(), actor = await operator(f.companyId);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const closed = once(child, "close");
    await once(child, "spawn");
    try {
      const [runtime] = await db.insert(workspaceRuntimeServices).values({ id: randomUUID(), companyId: f.companyId,
        scopeType: "run", serviceName: "Unregistered live backend", status: "running", lifecycle: "ephemeral",
        provider: "local_process", providerRef: String(child.pid) }).returning();
      await stopRuntimeServicesForExecutionWorkspace({ db, executionWorkspaceId: randomUUID(), runtimeServiceId: runtime.id });
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      const [stopped] = await db.select().from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.id, runtime.id));
      expect(stopped).toMatchObject({ status: "stopped", providerRef: runtime.providerRef });
      await expect(companyService(db, { mcpControllerInstanceId: "controller-a" }).remove(f.companyId, actor))
        .rejects.toThrow("Runtime ownership settlement is not qualified");
      expect(await db.select().from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.id, runtime.id))).toEqual([stopped]);
      expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id))).toEqual([f.enrollment]);
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  });

  it.each(["manual", "run"] as const)("blocks retirement while the real %s runtime start owns an unpublished HTTPS reservation", async kind => {
    const f = await fixture(), actor = await operator(f.companyId);
    const launch = kind === "run" ? await launchFixture(f.companyId) : null;
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
    const cwd = await mkdtemp(join(tmpdir(), "paperclip-retirement-reserve-"));
    let reserved!: () => void, release!: () => void, failed!: (error: unknown) => void;
    const held = new Promise<void>((resolve, reject) => { reserved = resolve; failed = reject; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    setWorkspaceRuntimeExposureDepsForTests({
      broker: {
        async reserve() { reserved(); await gate; throw new Error("fixture reservation settled without spawning"); },
        async expose() { throw new Error("Fixture must never expose"); },
        async remove() { return { removedPorts: [] }; },
        async list() { return []; },
      },
      isPortAvailable: async () => true, isBrokerAvailable: async () => true,
      resolveHostname: async () => "fixture.tail.test", probeHealth: async () => false,
      now: () => new Date().toISOString(),
    });
    const startInput = { db, actor: { id: null, name: "Fixture operator", companyId: f.companyId },
      issue: null, workspace: { baseCwd: cwd, cwd, source: "agent_home", projectId: null, workspaceId: null, repoUrl: null,
        repoRef: null, strategy: "project_primary", branchName: null, worktreePath: null, warnings: [], created: false, branchCreatedByRuntime: false } satisfies RealizedExecutionWorkspace,
      config: { workspaceRuntime: { services: [{ name: "fixture-owned", command: `${JSON.stringify(process.execPath)} -e 'process.exit(0)'`,
        port: { type: "auto", envKey: "PORT" }, expose: { type: "tailscale_https", hostname: "auto", publicPort: "same",
          includePaperclipViteHmr: false, failurePolicy: "fail_closed" }, lifecycle: "ephemeral", reuseScope: "run" }] } }, adapterEnv: {} };
    const start = launch ? ensureRuntimeServicesForRun({ ...startInput,
      agent: { id: launch.agentId, name: "Fixture worker", companyId: f.companyId }, runId: launch.runId })
      : startRuntimeServicesForWorkspaceControl(startInput);
    const outcome = start.then(value => ({ value }), error => { failed(error); return { error }; });
    try {
      await held;
      await db.update(companies).set({ status: "archived" }).where(eq(companies.id, f.companyId));
      await expect(companyService(db, { mcpControllerInstanceId: "controller-a" }).remove(f.companyId, actor))
        .rejects.toThrow("Runtime ownership settlement is not qualified");
      expect(await db.select().from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id))).toEqual([f.enrollment]);
    } finally {
      release();
      await outcome;
      await resetRuntimeServicesForTests({ terminateProcesses: true });
      await rm(cwd, { recursive: true, force: true });
    }
    expect(await outcome).toHaveProperty("error");
  });

  it("rejects the real runtime starter before broker ownership when company deletion wins the parent barrier", async () => {
    const f = await fixture(), actor = await operator(f.companyId);
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
    const cwd = await mkdtemp(join(tmpdir(), "paperclip-retirement-first-"));
    let ready!: (pid: number) => void, failed!: (error: unknown) => void, release!: () => void, reserveCalls = 0;
    const held = new Promise<number>((resolve, reject) => { ready = resolve; failed = reject; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const removal = db.transaction(async tx => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx.select().from(companies).where(eq(companies.id, f.companyId)).for("update");
      ready(backend.pid);
      await gate;
      await tx.update(companies).set({ status: "archived" }).where(eq(companies.id, f.companyId));
      return companyService(tx as unknown as typeof db, { mcpControllerInstanceId: "controller-a" }).remove(f.companyId, actor);
    });
    void removal.catch(failed);
    const removalOutcome = removal.then(value => ({ value }), error => ({ error }));
    const holderPid = await held;
    setWorkspaceRuntimeExposureDepsForTests({
      broker: { async reserve() { reserveCalls++; throw new Error("Fixture must never reserve"); },
        async expose() { throw new Error("Fixture must never expose"); }, async remove() { return { removedPorts: [] }; }, async list() { return []; } },
      isPortAvailable: async () => true, isBrokerAvailable: async () => true, resolveHostname: async () => "fixture.tail.test",
      probeHealth: async () => false, now: () => new Date().toISOString(),
    });
    const startOutcome = startRuntimeServicesForWorkspaceControl({ db, actor: { id: null, name: "Fixture operator", companyId: f.companyId },
      issue: null, workspace: { baseCwd: cwd, cwd, source: "agent_home", projectId: null, workspaceId: null, repoUrl: null, repoRef: null,
        strategy: "project_primary", branchName: null, worktreePath: null, warnings: [], created: false, branchCreatedByRuntime: false },
      config: { workspaceRuntime: { services: [{ name: "fixture-owned", command: `${JSON.stringify(process.execPath)} -e 'process.exit(0)'`,
        port: { type: "auto", envKey: "PORT" }, expose: { type: "tailscale_https", hostname: "auto", publicPort: "same",
          includePaperclipViteHmr: false, failurePolicy: "fail_closed" }, lifecycle: "ephemeral", reuseScope: "run" }] } }, adapterEnv: {} })
      .then(value => ({ value }), error => ({ error }));
    try {
      await waitForWriter(holderPid);
      expect(reserveCalls).toBe(0);
    } finally {
      release();
      await removalOutcome;
      await startOutcome;
      await resetRuntimeServicesForTests({ terminateProcesses: true });
      await rm(cwd, { recursive: true, force: true });
    }
    expect(await removalOutcome).toHaveProperty("value", expect.objectContaining({ id: f.companyId }));
    expect(await startOutcome).toHaveProperty("error");
    expect(reserveCalls).toBe(0);
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(0);
  });

  it("rejects an oversized enrollment receipt scope before any revocation", async () => {
    const f = await fixture(), actor = await operator(f.companyId);
    await db.insert(mcpWorkerEnrollments).values(Array.from({ length: 1024 }, (_, index) => ({ ...f.enrollment,
      id: randomUUID(), workerId: `bounded-worker-${index}`, keyId: `bounded-key-${index}` })));
    await expect(companyService(db, { mcpControllerInstanceId: "controller-a" }).remove(f.companyId, actor))
      .rejects.toThrow("bounded receipt limit");
    const [count] = await db.execute<{ pending: number }>(sql`select count(*)::int as pending from mcp_worker_enrollments
      where company_id = ${f.companyId} and state = 'pending'`);
    expect(count.pending).toBe(1025);
    expect(await db.execute(sql`select * from mcp_company_retirements where company_id = ${f.companyId}`)).toHaveLength(0);
  });

  it("companyService.remove atomically authorizes, revokes, retires, and preserves exact enrollment and launch receipts", async () => {
    const f = await fixture(), actor = await operator(f.companyId);
    const agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID(), projectId = randomUUID(), launchId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: f.companyId, name: "Retired worker" });
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Retired project" });
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, projectId, title: "Settled task" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId, status: "cancelled" });
    const launch = { id: launchId, companyId: f.companyId, agentId, runId, issueId, projectId,
      controllerBootId: randomUUID(), generation: 7, launchDigest: "a".repeat(64), material: { fixture: "sealed-private-content" }, expiresAt: new Date() };
    await db.insert(mcpPreparedLaunches).values(launch);
    const service = companyService(db, { mcpControllerInstanceId: "controller-a" });
    expect(await service.remove(f.companyId, actor)).toMatchObject({ id: f.companyId });
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(0);
    expect(await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.companyId, f.companyId))).toHaveLength(0);
    const [enrollment] = await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id));
    expect(enrollment).toMatchObject({ state: "revoked", companyId: f.companyId, keyId: "key-a" });
    expect(enrollment.revision).not.toBe(f.enrollment.revision);
    const [header] = await db.execute(sql`select * from mcp_company_retirements where company_id = ${f.companyId}`);
    const [entry] = await db.execute(sql`select * from mcp_company_retired_launches where company_id = ${f.companyId}`);
    expect(header).toMatchObject({ actor_id: actor.actorId, enrollment_count: 1, launch_count: 1 });
    expect(entry).toEqual({ company_id: f.companyId, launch_id: launchId, agent_id: agentId, run_id: runId, issue_id: issueId,
      project_id: projectId, controller_boot_id: launch.controllerBootId, generation: 7 });
    expect(JSON.stringify(header) + JSON.stringify(entry)).not.toContain("sealed-private-content");
    expect(await service.remove(f.companyId, actor)).toBeNull();
  });

  it.each(["run-linked finance", "goal-linked project", "attributed decision queue", "chat endpoint", "combined"] as const)(
    "retires a populated legacy company atomically: %s", async scenario => {
      const f = await fixture(), actor = await operator(f.companyId), launch = await launchFixture(f.companyId);
      const [goal] = await db.insert(goals).values({ companyId: f.companyId, title: "Company objective", level: "company" }).returning();
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Goal-linked project",
        goalId: scenario === "goal-linked project" || scenario === "combined" ? goal.id : null }).returning();
      if (scenario === "run-linked finance" || scenario === "combined") {
        const [cost] = await db.insert(costEvents).values({ companyId: f.companyId, agentId: launch.agentId,
          heartbeatRunId: launch.runId, projectId: project.id, goalId: goal.id, provider: "test", model: "test", costCents: 1, occurredAt: new Date() }).returning();
        await db.insert(financeEvents).values({ companyId: f.companyId, agentId: launch.agentId, heartbeatRunId: launch.runId,
          costEventId: cost.id, projectId: project.id, goalId: goal.id, eventKind: "cost", biller: "test", amountCents: 1, occurredAt: new Date() });
      }
      if (scenario === "attributed decision queue" || scenario === "combined") {
        const [queue] = await db.insert(decisionQueues).values({ companyId: f.companyId, key: "retirement", title: "Historical decisions",
          createdByType: "agent", createdByAgentId: launch.agentId, createdByRunId: launch.runId }).returning();
        await db.insert(decisionQueueItems).values({ companyId: f.companyId, queueId: queue.id, sourceKind: "issue", sourceId: launch.runId,
          addedByType: "agent", addedByAgentId: launch.agentId, addedByRunId: launch.runId });
        await db.insert(decisionTriage).values({ companyId: f.companyId, sourceKind: "issue", sourceId: launch.runId,
          setByType: "agent", setByAgentId: launch.agentId, setByRunId: launch.runId });
        await db.insert(decisionTriageEvents).values({ companyId: f.companyId, queueId: queue.id, action: "queued", actorType: "agent",
          actorAgentId: launch.agentId, actorRunId: launch.runId });
        await db.insert(decisionRetention).values({ companyId: f.companyId, sourceKind: "issue", sourceId: launch.runId,
          sourceActivityAt: new Date(), archivedAt: new Date(), archivedByType: "agent", archivedByAgentId: launch.agentId, archivedByRunId: launch.runId });
        await db.insert(decisionArchiveNotificationOutbox).values({ companyId: f.companyId, sourceKind: "issue", sourceId: launch.runId,
          archiveVersion: 1, originAgentId: launch.agentId, originIssueId: randomUUID() });
      }
      if (scenario === "chat endpoint" || scenario === "combined") {
        const [app] = await db.insert(toolApplications).values({ companyId: f.companyId, name: "Historical chat",
          applicationKey: `fixture-chat-${randomUUID()}`, type: "mcp" }).returning();
        const [connection] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: app.id,
          name: "Historical chat", uid: randomUUID(), transport: "mcp_remote", authKind: "none" }).returning();
        await db.insert(chatEndpoints).values({ companyId: f.companyId, connectionId: connection.id, provider: "slack", publicId: randomUUID(),
          assignedAgentId: launch.agentId, status: "archived" });
      }
      expect(await companyService(db, { mcpControllerInstanceId: "controller-a" }).remove(f.companyId, actor)).toMatchObject({ id: f.companyId });
      for (const table of [companies, mcpPreparedLaunches, heartbeatRuns, agents, projects, goals, costEvents, financeEvents,
        workspaceRuntimeServices, decisionQueues, chatEndpoints]) {
        const column = table === companies ? companies.id : "companyId" in table ? table.companyId : companies.id;
        expect(await db.select().from(table).where(eq(column, f.companyId))).toHaveLength(0);
      }
      expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id))).toMatchObject([{ state: "revoked" }]);
      expect(await db.execute(sql`select * from mcp_company_retirements where company_id = ${f.companyId}`)).toHaveLength(1);
      expect(await db.execute(sql`select * from mcp_company_retired_launches where launch_id = ${launch.id}`)).toHaveLength(1);
    });

  it.each(["running", "no completion time", "exposure handle", "cleanup pending", "bookkeeping stopped"] as const)(
    "preserves runtime and MCP recovery ownership on incomplete runtime settlement: %s", async scenario => {
      const f = await fixture(), actor = await operator(f.companyId), launch = await launchFixture(f.companyId);
      const [runtime] = await db.insert(workspaceRuntimeServices).values({ id: randomUUID(), companyId: f.companyId,
        ownerAgentId: launch.agentId, startedByRunId: launch.runId, scopeType: "project", serviceName: "Retained runtime", lifecycle: "task", provider: "local",
        status: scenario === "running" ? "running" : "stopped", stoppedAt: scenario === "no completion time" ? null : new Date(),
        exposureHandle: scenario === "exposure handle" ? "private-retained-handle" : null,
        exposure: scenario === "cleanup pending" ? { provider: "tailscale_https", state: "cleanup_pending", publicUrl: null,
          hostname: null, listeners: [], brokerRef: null, lastError: null, updatedAt: null } : null }).returning();
      await expect(companyService(db, { mcpControllerInstanceId: "controller-a" }).remove(f.companyId, actor))
        .rejects.toThrow("Runtime ownership settlement is not qualified");
      expect(await db.select().from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.id, runtime.id))).toEqual([runtime]);
      expect(await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, launch.id))).toEqual([launch]);
      expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id))).toEqual([f.enrollment]);
      expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
      expect(await db.execute(sql`select * from mcp_company_retirements where company_id = ${f.companyId}`)).toHaveLength(0);
    });

  it("rolls back populated purge and every retirement transition when the final company deletion fails", async () => {
    const f = await fixture(), actor = await operator(f.companyId), launch = await launchFixture(f.companyId);
    const [cost] = await db.insert(costEvents).values({ companyId: f.companyId, agentId: launch.agentId,
      heartbeatRunId: launch.runId, provider: "test", model: "test", costCents: 1, occurredAt: new Date() }).returning();
    const [finance] = await db.insert(financeEvents).values({ companyId: f.companyId, heartbeatRunId: launch.runId,
      costEventId: cost.id, eventKind: "cost", biller: "test", amountCents: 1, occurredAt: new Date() }).returning();
    const [goal] = await db.insert(goals).values({ companyId: f.companyId, title: "Retained goal", level: "company" }).returning();
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Retained project", goalId: goal.id }).returning();
    await db.execute(sql`create function fixture_final_company_failure() returns trigger language plpgsql as $$
      begin raise exception 'fixture final deletion failed'; end $$`);
    await db.execute(sql`create trigger fixture_final_company_failure before delete on companies
      for each row execute function fixture_final_company_failure()`);
    try {
      await expect(companyService(db, { mcpControllerInstanceId: "controller-a" }).remove(f.companyId, actor)).rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger fixture_final_company_failure on companies`);
      await db.execute(sql`drop function fixture_final_company_failure()`);
    }
    expect(await db.select().from(costEvents).where(eq(costEvents.id, cost.id))).toEqual([cost]);
    expect(await db.select().from(financeEvents).where(eq(financeEvents.id, finance.id))).toEqual([finance]);
    expect(await db.select().from(goals).where(eq(goals.id, goal.id))).toEqual([goal]);
    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toEqual([project]);
    expect(await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, launch.id))).toEqual([launch]);
    expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id))).toEqual([f.enrollment]);
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
    expect(await db.execute(sql`select * from mcp_company_retirements where company_id = ${f.companyId}`)).toHaveLength(0);
    expect(await db.execute(sql`select * from mcp_company_retired_launches where company_id = ${f.companyId}`)).toHaveLength(0);
    expect(await db.execute(sql`select * from mcp_company_retired_enrollments where company_id = ${f.companyId}`)).toHaveLength(0);
  });

  it.each(["generation", "scope substitution", "launch substitution"] as const)(
    "rolls back direct SQL retirement when a receipted launch attempts %s", async scenario => {
      const f = await fixture(), launch = await launchFixture(f.companyId);
      await expect(db.transaction(async tx => {
        await receipt(tx, f, 1, 1);
        await launchReceipt(tx, launch);
        if (scenario === "launch substitution") {
          await tx.delete(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, launch.id));
          await tx.insert(mcpPreparedLaunches).values({ ...launch, id: randomUUID(), generation: 8 });
        } else {
          await tx.update(mcpPreparedLaunches).set(scenario === "generation" ? { generation: 8 } : { controllerBootId: randomUUID() })
            .where(eq(mcpPreparedLaunches.id, launch.id));
        }
        await tx.delete(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.companyId, f.companyId));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
        await tx.delete(agents).where(eq(agents.companyId, f.companyId));
        await tx.delete(companies).where(eq(companies.id, f.companyId));
      })).rejects.toThrow();
      expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id))).toEqual([f.enrollment]);
      expect(await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, launch.id))).toEqual([launch]);
      expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
      expect(await db.execute(sql`select * from mcp_company_retirements where company_id = ${f.companyId}`)).toHaveLength(0);
    });

  it("requires the exact launch receipt at deletion, before the recovery reference is erased", async () => {
    const f = await fixture(), launch = await launchFixture(f.companyId);
    let deletionRejected = false;
    await expect(db.transaction(async tx => {
      await receipt(tx, f, 1, 1);
      // The statement itself must reject, not a later deferred count check.
      await expect(tx.delete(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, launch.id))).rejects.toThrow();
      deletionRejected = true;
      throw new Error("Roll back fixture transaction");
    })).rejects.toThrow();
    expect(deletionRejected).toBe(true);
    expect(await db.select().from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.id, launch.id))).toEqual([launch]);
    expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id))).toEqual([f.enrollment]);
  });

  it.each([true, false].flatMap(managed => ["grants", "bulk access"].map(operation => ({ managed, operation }))))(
    "orders a real $operation update before company removal (MCP=$managed)", async ({ managed, operation }) => {
    const companyId = managed ? (await fixture()).companyId : randomUUID();
    if (!managed) await db.insert(companies).values({ id: companyId, name: "Ordinary access", issuePrefix: companyId.slice(0, 8) });
    const actor = await operator(companyId);
    const [member] = await db.update(companyMemberships).set({ membershipRole: "owner", status: operation === "bulk access" ? "suspended" : "active" })
      .where(eq(companyMemberships.principalId, actor.actorId)).returning();
    let held!: () => void, failed!: (error: unknown) => void, release!: () => void, gatePid = 0;
    const locked = new Promise<void>((resolve, reject) => { held = resolve; failed = reject; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    // Pause the real update after it has locked the memberships, without
    // replacing its transaction or introducing an artificial child-first lock.
    await db.execute(sql`create function fixture_access_update_gate() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(17306, 1); return NEW; end $$`);
    await db.execute(sql`create trigger fixture_access_update_gate after update on company_memberships
      for each row execute function fixture_access_update_gate()`);
    const holder = db.transaction(async tx => {
      gatePid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0].pid;
      await tx.execute(sql`select pg_advisory_xact_lock(17306, 1)`);
      held();
      await gate;
    });
    void holder.catch(failed);
    await locked;
    const access = accessService(db);
    const update = operation === "bulk access" ? access.setUserCompanyAccess(actor.actorId, [companyId])
      : access.updateMemberAndPermissions(companyId, member.id,
        { membershipRole: "owner", grants: [{ permissionKey: "agents:create" }] }, actor.actorId);
    const updateOutcome = update.then(value => ({ value, error: null }), error => ({ value: null, error }));
    let removalOutcome: Promise<{ value: unknown; error: unknown }> | undefined;
    try {
      const memberPid = await waitForWriter(gatePid);
      const removal = companyService(db, { mcpControllerInstanceId: "controller-a" }).remove(companyId, actor);
      removalOutcome = removal.then(value => ({ value, error: null }), error => ({ value: null, error }));
      const removalPid = await waitForWriter(memberPid);
      const [blocked] = await db.execute<{ query: string }>(sql`select query from pg_stat_activity where pid = ${removalPid}`);
      // The removal must wait at its parent barrier, before authorization or
      // purge acquires any membership lock. Child-first bulk access violates it.
      expect(blocked.query).toContain('from "companies"');
    } finally {
      release();
      await holder;
      await Promise.all([updateOutcome, removalOutcome]);
      await db.execute(sql`drop trigger fixture_access_update_gate on company_memberships`);
      await db.execute(sql`drop function fixture_access_update_gate()`);
    }
    expect((await updateOutcome).error).toBeNull();
    expect((await removalOutcome)?.error).toBeNull();
    expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(0);
    expect(await db.execute(sql`select * from mcp_company_retirements where company_id = ${companyId}`)).toHaveLength(managed ? 1 : 0);
  });

  it.each(["missing actor", "agent", "no admin", "no company access", "inactive membership", "active company"] as const)(
    "rejects MCP company deletion before mutation: %s", async scenario => {
      const f = await fixture(), actor = await operator(f.companyId);
      if (scenario === "no admin") await db.delete(instanceUserRoles).where(eq(instanceUserRoles.userId, actor.actorId));
      if (scenario === "no company access") await db.delete(companyMemberships).where(eq(companyMemberships.principalId, actor.actorId));
      if (scenario === "inactive membership") await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, actor.actorId));
      if (scenario === "active company") await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
      await expect(companyService(db, { mcpControllerInstanceId: "controller-a" }).remove(f.companyId,
        scenario === "missing actor" ? undefined : scenario === "agent" ? { ...actor, actorType: "agent" } : actor)).rejects.toThrow();
      expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
      expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id))).toEqual([f.enrollment]);
    });

  it("refuses orphan pending cleanup before revocation, receipts, activity or identity deletion", async () => {
    const f = await fixture(), actor = await operator(f.companyId);
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: null, status: "pending_cleanup", releasedAt: new Date() });
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "user", actorId: actor.actorId,
      action: "fixture-retained", entityType: "company", entityId: f.companyId });
    await expect(companyService(db, { mcpControllerInstanceId: "controller-a" }).remove(f.companyId, actor)).rejects.toThrow();
    expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id))).toEqual([f.enrollment]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(1);
    expect(await db.execute(sql`select * from mcp_company_retirements where company_id = ${f.companyId}`)).toHaveLength(0);
  });

  it.each(["active lease", "expired lease", "operator required", "SQL settled before owner release", "empty history"])(
    "preserves native retirement evidence until final ownership is qualified: %s", async scenario => {
      const f = await fixture(), actor = await operator(f.companyId);
      const agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId: f.companyId, name: "Native owner" });
      await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Retained native work" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId,
        runtimeMode: "native", nativeIssueId: issueId, status: "failed", finishedAt: new Date() });
      const [coordinator] = await db.insert(nativeRunFinalizations).values({ runId, companyId: f.companyId, issueId, phase: "committed",
        leaseOwner: scenario.includes("lease") ? "native-cleanup:fixture" : null,
        leaseExpiresAt: scenario.includes("lease") ? new Date(Date.now() + (scenario === "expired lease" ? -1000 : 60_000)) : null,
        recoveryHistory: scenario === "empty history" ? [] : [{ kind: "native_cleanup_maintenance", version: 1,
          requestId: "native-cleanup:fixture", phase: scenario === "SQL settled before owner release" ? "settled" : "operator_required" }],
      }).returning();
      await expect(companyService(db, { mcpControllerInstanceId: "controller-a" }).remove(f.companyId, actor))
        .rejects.toThrow("Native execution retirement requires final ownership qualification");
      expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId))).toEqual([coordinator]);
      expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id))).toEqual([f.enrollment]);
      expect(await db.execute(sql`select * from mcp_company_retirements where company_id = ${f.companyId}`)).toHaveLength(0);
    });

  it("disarms a longer inherited transaction timer and charges elapsed preparation against the retirement budget", async () => {
    const f = await fixture(), actor = await operator(f.companyId);
    const start = performance.now();
    let reachedDeadlineWait = false;
    let deadlineWaitReturned = false;
    await expect(db.transaction(async tx => {
      await tx.execute(sql`set local transaction_timeout = '60s'`);
      await tx.execute(sql`select pg_sleep(5)`);
      await tx.select().from(companies).where(eq(companies.id, f.companyId)).for("update");
      await retireMcpCompanyInTx(tx, { id: f.companyId, status: "archived" }, { controllerInstanceId: "controller-a", actor });
      reachedDeadlineWait = true;
      await tx.execute(sql`select pg_sleep(26)`);
      deadlineWaitReturned = true;
      await tx.delete(activityLog).where(eq(activityLog.companyId, f.companyId));
      await tx.delete(companyMemberships).where(eq(companyMemberships.companyId, f.companyId));
      await tx.delete(companies).where(eq(companies.id, f.companyId));
    })).rejects.toThrow();
    expect(reachedDeadlineWait).toBe(true);
    expect(deadlineWaitReturned).toBe(false);
    expect(performance.now() - start).toBeLessThan(33_000);
    expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id))).toEqual([f.enrollment]);
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
    expect(await db.execute(sql`select * from mcp_company_retirements where company_id = ${f.companyId}`)).toHaveLength(0);
  }, 45_000);

  it("retains the original pins and exact final revision after company/activity deletion, and permanently rejects UUID reuse", async () => {
    const f = await fixture(), revoked = await retire(f);
    const [row] = await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id));
    expect(row).toEqual(revoked);
    expect({ ...row, state: f.enrollment.state, revision: f.enrollment.revision, revokedAt: f.enrollment.revokedAt }).toEqual(f.enrollment);
    const [header] = await db.execute(sql`select * from mcp_company_retirements where company_id = ${f.companyId}`);
    const [entry] = await db.execute(sql`select * from mcp_company_retired_enrollments where company_id = ${f.companyId}`);
    expect(header).toMatchObject({ company_id: f.companyId, controller_instance_id: "controller-a", actor_id: "fixture-operator", enrollment_count: 1, launch_count: 0 });
    expect(entry).toMatchObject({ company_id: f.companyId, enrollment_id: row.id, revision: row.revision });
    for (const bytes of [JSON.stringify(header), JSON.stringify(entry)]) {
      expect(bytes).not.toContain(f.enrollment.gatewayUrl);
      expect(bytes).not.toContain(f.enrollment.bootstrapTokenHash);
      expect(bytes).not.toContain(f.enrollment.nonce);
    }
    await expect(db.insert(companies).values({ id: f.companyId, name: "Reused UUID", issuePrefix: f.companyId.slice(0, 8) })).rejects.toThrow();
    const otherId = randomUUID();
    await db.insert(companies).values({ id: otherId, name: "Other company", issuePrefix: otherId.slice(0, 8) });
    await expect(db.update(companies).set({ id: f.companyId }).where(eq(companies.id, otherId))).rejects.toThrow();
    await expect(db.insert(mcpWorkerEnrollments).values({ ...f.enrollment, id: randomUUID(), workerId: "worker-b", keyId: "key-b" })).rejects.toThrow();
    await expect(mcpWorkerEnrollmentService(db, { controllerInstanceId: "controller-a" }).prove({ enrollmentId: row.id,
      bearerToken: `pcmwe_${"a".repeat(43)}`, signature: "a".repeat(86) })).rejects.toThrow();
  });

  it("refuses deletion without a complete immutable receipt, regardless of prior revocation", async () => {
    const f = await fixture();
    await db.update(mcpWorkerEnrollments).set({ state: "revoked", revision: randomUUID(), revokedAt: sql`clock_timestamp()` })
      .where(eq(mcpWorkerEnrollments.id, f.enrollment.id));
    await expect(db.delete(companies).where(eq(companies.id, f.companyId))).rejects.toThrow();
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
  });

  it("rolls revocation, receipt and company deletion back when durable receipt counts do not match", async () => {
    const f = await fixture();
    await expect(db.transaction(async tx => {
      await receipt(tx, f, 2);
      await tx.delete(companies).where(eq(companies.id, f.companyId));
    })).rejects.toThrow();
    expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id))).toEqual([f.enrollment]);
    expect(await db.execute(sql`select * from mcp_company_retirements where company_id = ${f.companyId}`)).toHaveLength(0);
  });

  it.each(["mcp_company_retirements", "mcp_company_retired_enrollments", "mcp_company_retired_launches"])(
    "makes %s receipts immutable and non-truncatable", async table => {
      const f = await fixture();
      await retire(f);
      const identifier = sql.identifier(table);
      await expect(db.execute(sql`delete from ${identifier} where company_id = ${f.companyId}`)).rejects.toThrow();
      await expect(db.execute(sql`update ${identifier} set company_id = ${randomUUID()} where company_id = ${f.companyId}`)).rejects.toThrow();
      await expect(db.execute(sql`truncate table ${identifier} cascade`)).rejects.toThrow();
    });

  it.each(["read committed", "repeatable read", "serializable"] as const)("rejects UUID reuse waiting on uniqueness across retirement at %s", async isolationLevel => {
    const f = await fixture();
    let held!: () => void, failed!: (error: unknown) => void, release!: () => void, writerPid = 0;
    const locked = new Promise<void>((resolve, reject) => { held = resolve; failed = reject; }), gate = new Promise<void>(resolve => { release = resolve; });
    const writer = db.transaction(async tx => {
      writerPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0].pid;
      await receipt(tx, f);
      await tx.delete(companies).where(eq(companies.id, f.companyId));
      held();
      await gate;
    });
    void writer.catch(failed);
    await locked;
    const contender = db.transaction(async tx => {
      // Establish the contender's snapshot before retirement commits. At
      // repeatable-read the AFTER INSERT guard must deny this supported-isolation
      // violation rather than trusting its pre-retirement snapshot.
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, f.companyId));
      return tx.insert(companies).values({ id: f.companyId, name: "Waiting UUID reuse", issuePrefix: randomUUID().slice(0, 8) });
    }, { isolationLevel });
    const outcome = contender.then(value => ({ value, error: null }), error => ({ value: null, error }));
    try { await waitForWriter(writerPid); }
    finally { release(); await writer; }
    expect((await outcome).error).toBeInstanceOf(Error);
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(0);
  });

  it.each(["repeatable read", "serializable"] as const)("explicitly rejects fresh company insertion and deletion at %s", async isolationLevel => {
    const companyId = randomUUID();
    await expect(db.transaction(tx => tx.insert(companies).values({ id: companyId, name: "Unsupported isolation", issuePrefix: companyId.slice(0, 8) }),
      { isolationLevel })).rejects.toMatchObject({ cause: { message: expect.stringContaining("READ COMMITTED") } });
    await db.insert(companies).values({ id: companyId, name: "Ordinary company", issuePrefix: companyId.slice(0, 8) });
    await expect(db.transaction(tx => tx.delete(companies).where(eq(companies.id, companyId)), { isolationLevel }))
      .rejects.toMatchObject({ cause: { message: expect.stringContaining("READ COMMITTED") } });
    expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(1);
  });

  it("refuses company TRUNCATE instead of bypassing scoped MCP retirement", async () => {
    const f = await fixture();
    await expect(db.execute(sql`truncate companies cascade`)).rejects.toThrow();
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
    expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.id, f.enrollment.id))).toEqual([f.enrollment]);
  });

  it("blocks enrollment INSERT at the parent barrier and rejects it after company deletion", async () => {
    const f = await fixture();
    let held!: () => void, failed!: (error: unknown) => void, release!: () => void, writerPid = 0;
    const locked = new Promise<void>((resolve, reject) => { held = resolve; failed = reject; }), gate = new Promise<void>(resolve => { release = resolve; });
    const writer = db.transaction(async tx => {
      writerPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0].pid;
      await tx.select().from(companies).where(eq(companies.id, f.companyId)).for("update");
      held();
      await gate;
      await receipt(tx, f);
      await tx.delete(companies).where(eq(companies.id, f.companyId));
    });
    void writer.catch(failed);
    await locked;
    const contender = db.insert(mcpWorkerEnrollments).values({ ...f.enrollment, id: randomUUID(), workerId: "waiting-worker", keyId: "waiting-key" });
    const outcome = contender.then(value => ({ value, error: null }), error => ({ value: null, error }));
    try { await waitForWriter(writerPid); }
    finally { release(); await writer; }
    expect((await outcome).error).toBeInstanceOf(Error);
    expect(await db.select().from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.companyId, f.companyId))).toHaveLength(1);
  });

  async function waitForWriter(writerPid: number) {
    for (let attempts = 0; attempts < 50; attempts++) {
      const [waiting] = await db.execute<{ pid: number }>(sql`select pid from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and ${writerPid} = any(pg_blocking_pids(pid)) limit 1`);
      if (waiting) return waiting.pid;
      await db.execute(sql`select pg_sleep(0.02)`);
    }
    throw new Error("Contender never reached the expected SQL barrier");
  }
});
