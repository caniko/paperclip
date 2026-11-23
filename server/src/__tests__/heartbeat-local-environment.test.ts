import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { agentEnvironmentTestService } from "../services/agent-environment-test.js";
import * as deployment from "../deployment/runtime.js";
import * as environmentServices from "../services/environments.js";
import * as atlas from "../services/heartbeat/atlas-execution.js";
import * as adapters from "../adapters/index.js";
import * as router from "../services/ai-connection-router.js";
import * as secrets from "../services/secrets.js";
import * as workspaces from "../services/heartbeat/workspace-preparation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat environment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

async function waitForRunLeasesToRelease(
  db: ReturnType<typeof createDb>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const leases = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, runId));
    if (leases.length > 0 && leases.every((lease) => lease.status !== "active")) return leases;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await db
    .select()
    .from(environmentLeases)
    .where(eq(environmentLeases.heartbeatRunId, runId));
}

describeEmbeddedPostgres("heartbeat local environment lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousAgentJwtSecret: string | undefined;

  beforeAll(async () => {
    previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "heartbeat-local-environment-test-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-local-environment-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    // A run reaches its terminal status before finalizeRun finishes writing
    // its trailing lifecycle events and side effects (see the comment on
    // drainActiveRunExecutions in heartbeat.ts). Drain those in-flight writes
    // before the TRUNCATE below, or a write that lands after the company row
    // is gone violates heartbeat_run_events' foreign key.
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    // Same reasoning as the afterEach drain: closing the embedded database
    // while a run's finalize work is still in flight lets a queued write hit
    // a socket that cleanup() already tore down.
    await heartbeat.drainActiveRunExecutions();
    await tempDb?.cleanup();
    if (previousAgentJwtSecret === undefined) {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    } else {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
    }
  });

  it.each(["claude_local", "opencode_local"] as const)(
    "denies Atlas %s queue resume if the saved binding changes during lease acquisition", async (adapterType) => {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID();
    const common = {
      companyId, agentId, environmentId, workspaceClass: "copy-scratch",
      command: `/fixture/${adapterType}`, sshExecutable: "/fixture/ssh", host: "127.0.0.1", port: 2222,
      username: "worker", remoteWorkspacePath: "/fixture/workspace", privateKeyCredential: "atlas-key",
      hostKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"A".repeat(43)}`,
    } as const;
    const openCodePins = { standalone: true, model: "openai/gpt-4.1", variant: "high" } as const;
    const binding: deployment.AtlasAdmission = adapterType === "opencode_local"
      ? { ...common, adapterType, ...openCodePins } : { ...common, adapterType };
    await db.insert(companies).values({ id: companyId, name: "Atlas resume fixture", issuePrefix: "ATLR",
      defaultResponsibleUserId: "responsible-user" });
    const { host, port, username, remoteWorkspacePath, privateKeyCredential, hostKey, command } = binding;
    await db.insert(environments).values({ id: environmentId, name: "Atlas worker", driver: "ssh", status: "active",
      config: { host, port, username, remoteWorkspacePath, privateKeyCredential,
        knownHosts: `[${host}]:${port} ${hostKey}`, strictHostKeyChecking: true } });
    await db.insert(agents).values({ id: agentId, companyId, name: "Resumed agent", status: "idle",
      adapterType, adapterConfig: { engine: "cli", command, ...(adapterType === "opencode_local" ? openCodePins : {}) },
      defaultEnvironmentId: environmentId });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", runtimeMode: "legacy",
      invocationSource: "on_demand", runnerProfileJson: { nativeExecutionInput: { model: "historical" } },
      contextSnapshot: { aiRouterSelection: { poolId: randomUUID() } } }).returning();

    vi.spyOn(deployment, "atlasExecutionPolicy").mockReturnValue({ admissions: [binding], home: "/unused", credentialFiles: {} });
    const service = environmentServices.environmentService(db);
    const realAcquire = service.acquireLease;
    const acquire = vi.spyOn(service, "acquireLease").mockImplementation(async (input) => {
      const lease = await realAcquire(input);
      await db.update(agents).set(adapterType === "opencode_local"
        ? { adapterConfig: { engine: "cli", command, ...openCodePins, variant: "low" } }
        : { defaultEnvironmentId: null }).where(eq(agents.id, agentId));
      return lease;
    });
    const route = vi.spyOn(router, "aiConnectionRouterService").mockImplementation(() => { throw new Error("Unexpected provider routing"); });
    const prepareWorkspace = vi.spyOn(workspaces, "prepareHeartbeatWorkspace").mockRejectedValue(new Error("Unexpected workspace preparation"));
    const prepareScratch = vi.spyOn(atlas, "prepareAtlasScratch");
    const credential = vi.spyOn(deployment, "readCredential").mockImplementation(() => { throw new Error("Unexpected credential read"); });
    const probe = vi.spyOn(adapters.requireServerAdapter(adapterType), "testEnvironment").mockRejectedValue(new Error("Unexpected adapter probe"));
    const realSecrets = secrets.secretService;
    const resolveAdapterConfigForRuntime = vi.fn().mockRejectedValue(new Error("Unexpected adapter secret resolution"));
    const resolveEnvBindings = vi.fn().mockRejectedValue(new Error("Unexpected environment secret resolution"));
    vi.spyOn(secrets, "secretService").mockImplementation((...args) => ({
      ...realSecrets(...args), resolveAdapterConfigForRuntime, resolveEnvBindings,
    }));
    const realFactory = environmentServices.environmentService;
    vi.spyOn(environmentServices, "environmentService").mockImplementation((...args) => args[0] === db ? service : realFactory(...args));
    const resumed = heartbeatService(db);
    try {
      await resumed.resumeQueuedRunsForAgent(companyId, agentId);
      expect(await waitForRunToFinish(resumed, run.id)).toMatchObject({ status: "failed", error: "No qualified Atlas agent execution binding" });
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(await waitForRunLeasesToRelease(db, run.id)).toEqual([expect.objectContaining({ status: "failed" })]);
      for (const sideEffect of [route, prepareWorkspace, prepareScratch, credential, probe, resolveAdapterConfigForRuntime, resolveEnvBindings]) {
        expect(sideEffect).not.toHaveBeenCalled();
      }
    } finally {
      await resumed.drainActiveRunExecutions();
      vi.restoreAllMocks();
    }
  });

  it("tests the saved Atlas OpenCode binding on a probe-only lease and releases it", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID();
    const binding: deployment.AtlasAdmission = {
      companyId, agentId, environmentId, adapterType: "opencode_local", workspaceClass: "copy-scratch",
      command: "/fixture/opencode", standalone: true, model: "openai/gpt-4.1", variant: "high",
      sshExecutable: "/fixture/ssh", host: "127.0.0.1", port: 2222,
      username: "worker", remoteWorkspacePath: "/fixture/workspace", privateKeyCredential: "atlas-key",
      hostKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"A".repeat(43)}`,
    };
    await db.insert(companies).values({ id: companyId, name: "Atlas probe fixture", issuePrefix: "ATLP" });
    const { host, port, username, remoteWorkspacePath, privateKeyCredential, hostKey, command, standalone, model, variant } = binding;
    await db.insert(environments).values({ id: environmentId, name: "Atlas worker", driver: "ssh", status: "active",
      config: { host, port, username, remoteWorkspacePath, privateKeyCredential,
        knownHosts: `[${host}]:${port} ${hostKey}`, strictHostKeyChecking: true } });
    const adapterConfig = { engine: "cli", command, standalone, model, variant };
    const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Saved agent", status: "idle",
      adapterType: binding.adapterType, adapterConfig, defaultEnvironmentId: environmentId }).returning();
    const home = await mkdtemp(join(tmpdir(), "paperclip-atlas-probe-"));
    const credential = join(home, "worker-key");
    try {
      await writeFile(credential, "fixture-key", { mode: 0o600 });
      vi.spyOn(deployment, "atlasExecutionPolicy").mockReturnValue({ admissions: [binding], home,
        credentialFiles: { [privateKeyCredential]: credential } });
      const report = { adapterType: binding.adapterType, status: "pass" as const, checks: [], testedAt: new Date().toISOString() };
      const openCodeProbe = vi.spyOn(adapters.requireServerAdapter("opencode_local"), "testEnvironment").mockResolvedValue(report);
      const claudeProbe = vi.spyOn(adapters.requireServerAdapter("claude_local"), "testEnvironment");
      expect(await agentEnvironmentTestService(db).testAtlasEnvironment(agent!)).toEqual(report);
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.environmentId, environmentId));
      expect(lease).toMatchObject({ status: "released", provider: "ssh", heartbeatRunId: null });
      expect(openCodeProbe).toHaveBeenCalledExactlyOnceWith({
        companyId, adapterType: binding.adapterType, config: adapterConfig, environmentName: "Atlas worker",
        executionTarget: expect.objectContaining({ environmentId, leaseId: lease!.id, transport: "ssh",
          spec: expect.objectContaining({ atlas: expect.objectContaining({ probe: true, sshExecutable: binding.sshExecutable }) }) }),
      });
      expect(claudeProbe).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("runs work through the default Local environment lease", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {},
      permissions: {},
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const localRows = await db
      .select()
      .from(environments)
      .where(eq(environments.driver, "local"));
    expect(localRows).toHaveLength(1);
    expect(localRows[0]?.name).toBe("Local");

    const leases = await waitForRunLeasesToRelease(db, queued!.id);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.environmentId).toBe(localRows[0]?.id);
    expect(leases[0]?.status).toBe("released");
    expect(leases[0]?.provider).toBe("local");
    expect(leases[0]?.releasedAt).not.toBeNull();

    const context = finished?.contextSnapshot as Record<string, unknown>;
    expect(context.paperclipEnvironment).toMatchObject({
      id: localRows[0]?.id,
      name: "Local",
      driver: "local",
      leaseId: leases[0]?.id,
    });
  });

  it("injects run-scoped Paperclip env into process agents", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const tempDir = await mkdtemp(join(tmpdir(), "paperclip-process-env-"));
    const envPath = join(tempDir, "env.json");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({`,
            "agentId: process.env.PAPERCLIP_AGENT_ID ?? null,",
            "companyId: process.env.PAPERCLIP_COMPANY_ID ?? null,",
            "apiUrl: process.env.PAPERCLIP_API_URL ?? null,",
            "runId: process.env.PAPERCLIP_RUN_ID ?? null,",
            "apiKeyPresent: Boolean(process.env.PAPERCLIP_API_KEY),",
            "}));",
          ].join(" "),
        ],
      },
      runtimeConfig: {},
      permissions: {},
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const captured = JSON.parse(await readFile(envPath, "utf8")) as Record<string, unknown>;
    expect(captured).toMatchObject({
      agentId,
      companyId,
      runId: queued!.id,
      apiKeyPresent: true,
    });
    expect(captured.apiUrl).toEqual(expect.stringMatching(/^https?:\/\//));
  });
});
