import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agents, companies, createDb, deploymentResources, environments, environmentLeases, executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issues, projects, projectWorkspaces, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { EnvironmentCapacityExhaustedError, environmentService } from "../environments.js";
import { executionWorkspaceService } from "../execution-workspaces.js";
import { instanceSettingsService } from "../instance-settings.js";
import { buildNativeExecutionInput } from "../native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../native-runtime/runtime-context.test-fixture.js";
import { resolveSshAuthenticationBeforeRouting, selectHeartbeatEnvironment, selectHeartbeatOverflowEnvironmentId, type HeartbeatEnvironmentSelectionInput } from "./environment-selection.js";
import { acquireAtlasExecution, assertAtlasDispatch, atlasAdmissionForAgent } from "./atlas-execution.js";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { atlasExecutionPolicy, type AtlasAdmission } from "../../deployment/runtime.js";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { materializeIsolatedTaskDirectory } from "../isolated-task-directory.js";

vi.mock("../../deployment/runtime.js", async (original) => ({
  ...await original<typeof import("../../deployment/runtime.js")>(),
  atlasExecutionPolicy: vi.fn(() => null),
}));

it("checks the same Atlas OpenCode pins at declaration and final dispatch", () => {
  const binding: AtlasAdmission = {
    companyId: randomUUID(), agentId: randomUUID(), environmentId: randomUUID(), adapterType: "opencode_local",
    host: "127.0.0.1", port: 2222, username: "worker", hostKey: "ssh-ed25519 fixture", privateKeyCredential: "worker-key",
    workspaceClass: "copy-scratch", remoteWorkspacePath: "/worker/work", command: "/worker/opencode", sshExecutable: "/bin/ssh",
    standalone: true, model: "provider/model", variant: "high",
  };
  const config = { engine: "cli", command: binding.command, standalone: true, model: binding.model, variant: binding.variant };
  const agent = { id: binding.agentId, companyId: binding.companyId, adapterType: binding.adapterType,
    defaultEnvironmentId: binding.environmentId, adapterConfig: config, runtimeConfig: {} };
  const cwd = "/controller/scratch";
  const { host, port, username, remoteWorkspacePath: remoteCwd } = binding;
  const target = { kind: "remote", transport: "ssh", environmentId: binding.environmentId, leaseId: randomUUID(), remoteCwd,
    spec: { host, port, username, remoteCwd, remoteWorkspacePath: remoteCwd, workspaceRealizationMode: "copy",
      knownHosts: `[${host}]:${port} ${binding.hostKey}`, strictHostKeyChecking: true, privateKey: "fixture",
      atlas: { sshExecutable: binding.sshExecutable, scratchDir: cwd } },
  } as const satisfies AdapterExecutionTarget;
  vi.mocked(atlasExecutionPolicy).mockReturnValue({ admissions: [binding], home: "/controller", credentialFiles: {} });
  try {
    expect(atlasAdmissionForAgent(agent, agent.companyId)).toBe(binding);
    expect(() => assertAtlasDispatch(binding, target, { ...config, env: {} }, cwd)).not.toThrow();
    for (const change of [
      { command: undefined }, { command: "/other/opencode" }, { standalone: undefined }, { standalone: false },
      { model: undefined }, { model: "provider/other" }, { variant: undefined }, { variant: "low" },
      { managedService: true }, { managedAiConnection: true }, { extraArgs: [] }, { args: [] },
      { provider: "elsewhere" }, { config: {} }, { baseUrl: "http://example.invalid" }, { xdgConfigHome: "/elsewhere" },
      { env: { OPENAI_API_KEY: "fixture" } },
    ]) {
      const drifted = { ...config, ...change };
      expect(() => atlasAdmissionForAgent({ ...agent, adapterConfig: drifted }, agent.companyId)).toThrow("No qualified Atlas");
      expect(() => assertAtlasDispatch(binding, target, drifted, cwd)).toThrow("Final Atlas dispatch");
    }
    expect(() => atlasAdmissionForAgent({ ...agent, adapterConfig: { ...config, env: {} } }, agent.companyId)).toThrow();
    expect(() => assertAtlasDispatch(binding, target, { ...config, env: [] }, cwd)).toThrow();
    for (const drifted of [
      { ...target, leaseId: null }, { ...target, environmentId: randomUUID() }, { ...target, remoteCwd: "/other" },
      { ...target, spec: { ...target.spec, knownHosts: "different" } },
      { ...target, spec: { ...target.spec, atlas: { ...target.spec.atlas, probe: true as const } } },
    ]) expect(() => assertAtlasDispatch(binding, drifted, config, cwd)).toThrow("Final Atlas dispatch");
  } finally {
    vi.mocked(atlasExecutionPolicy).mockReturnValue(null);
  }
});

it("releases an Atlas slot if the actual acquired target differs before preparation", async () => {
  const binding: AtlasAdmission = {
    companyId: "company", agentId: "agent", environmentId: "environment", adapterType: "claude_local",
    host: "127.0.0.1", port: 2222, username: "worker", hostKey: "ssh-ed25519 fixture", privateKeyCredential: "worker-key",
    workspaceClass: "copy-scratch", remoteWorkspacePath: "/worker/work", command: "/worker/claude", sshExecutable: "/bin/ssh",
  };
  const environment: Environment = { id: binding.environmentId, name: "Atlas", description: null, metadata: null,
    createdAt: new Date(), updatedAt: new Date(), driver: "ssh", status: "active", envVars: {}, config: {
    host: binding.host, port: binding.port, username: binding.username, remoteWorkspacePath: binding.remoteWorkspacePath,
    knownHosts: `[${binding.host}]:${binding.port} ${binding.hostKey}`, strictHostKeyChecking: true,
    privateKeyCredential: binding.privateKeyCredential, workspaceRealizationMode: "copy",
  } };
  const getById = vi.fn<() => Promise<Environment | null>>()
    .mockResolvedValueOnce(environment).mockResolvedValueOnce({ ...environment, driver: "local" });
  const releaseLease = vi.fn(async () => null);
  await expect(acquireAtlasExecution({ binding, issueId: null, runId: "run", environments: {
    getById, acquireLease: vi.fn(async () => ({ id: "lease", environmentId: environment.id }) as EnvironmentLease), releaseLease,
  } })).rejects.toThrow("differs from the controller pin");
  expect(releaseLease).toHaveBeenCalledExactlyOnceWith("lease", "failed");
});

const restoration = vi.hoisted(() => ({ removed: false }));
vi.mock("../git-workspace-restoration.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../git-workspace-restoration.js")>();
  return { ...actual, readGitCacheExpiration: (workspace: Parameters<typeof actual.readGitCacheExpiration>[0]) =>
    restoration.removed ? { workspaceRemoved: true } as ReturnType<typeof actual.readGitCacheExpiration> : actual.readGitCacheExpiration(workspace) };
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("heartbeat environment selection boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "heartbeat-environment-selection-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "environment-selection");
    await mkdir(resolvePaperclipInstanceRoot(), { recursive: true });
    database = await startEmbeddedPostgresTestDatabase("heartbeat-environment-selection-");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Environment selection", issuePrefix: "ENV" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Selecting agent", status: "running", adapterType: "process" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Project" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Select this environment", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    const input: HeartbeatEnvironmentSelectionInput = {
      run, agent,
      task: { issueRef: issue, issueContext: issue, issueId: issue.id, executionProjectId: project.id, workspaceProjectContext: { hasWorkspace: false }, boundSourceWorkspace: null, hasSelectedWorkspaceSource: false, taskWorkspaceIntent: null, responsibleUserId: null, context: { issueId: issue.id } },
      policy: {
        trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
        requestedExecutionWorkspaceMode: "shared_workspace", isolatedWorkspacesEnabled: true,
        projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null,
      },
      config: { config: {}, sourceWorkspaceConfig: {}, issueAssigneeOverrides: null },
      services: { environmentsSvc: environmentService(db), executionWorkspacesSvc: executionWorkspaceService(db), instanceSettings: instanceSettingsService(db), findSharedWorkspaceHolder: vi.fn(async () => null), findExecutionWorkspaceHolder: vi.fn(async () => null) },
    };
    const workspace = async () => {
      const created = await executionWorkspaceService(db).create({ companyId: company.id, projectId: project.id, sourceIssueId: issue.id, name: "Saved workspace", mode: "isolated_workspace", strategyType: "git_worktree", cwd: home, providerRef: home });
      if (!created) throw new Error("Workspace fixture was not created");
      return created;
    };
    const recover = (workspaceId: string) => {
      input.run.runtimeMode = "native";
      input.run.runnerProfileJson = { nativeExecutionInput: buildNativeExecutionInput({
        companyId: company.id, runId: run.id, agentId: agent.id,
        issue: { id: issue.id, identifier: "ENV-1", title: issue.title, description: null, workMode: "standard" },
        taskPrompt: "Continue the same task", normalizedSessionId: randomUUID(), provider: "codex",
        workspace: { id: workspaceId, cwd: home, repoUrl: null, repoRef: null, branchName: null },
        completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Select the environment", criteria: [{ id: "objective", requirement: "Preserve the workspace" }] } },
        runtimeContext: nativeRuntimeContextFixture(),
      }) };
    };
    return { input, issue, project, workspace, recover };
  }

  it("denies Atlas implicit/local, unmanaged, stale, foreign and overridden bindings before selecting workspace or local/overflow state", async () => {
    const { input } = await fixture();
    const binding: AtlasAdmission = {
      companyId: input.agent.companyId, agentId: input.agent.id, environmentId: randomUUID(), adapterType: "claude_local",
      host: "127.0.0.1", port: 2222, username: "worker", hostKey: "ssh-ed25519 fixture", privateKeyCredential: "worker-key",
      workspaceClass: "copy-scratch", remoteWorkspacePath: "/worker/work", command: "/worker/claude", sshExecutable: "/bin/ssh",
    };
    const getById = vi.fn(async () => null);
    const ensureLocalEnvironment = vi.fn(async () => { throw new Error("unexpected local environment or overflow"); });
    const getStoredById = vi.fn(async () => { throw new Error("unexpected workspace lookup"); });
    const qualified = { ...input, agent: { ...input.agent, adapterType: "claude_local" as const,
      defaultEnvironmentId: binding.environmentId, adapterConfig: { engine: "cli", command: binding.command }, runtimeConfig: {} },
      services: { ...input.services, environmentsSvc: { ...input.services.environmentsSvc, getById, ensureLocalEnvironment },
        executionWorkspacesSvc: { ...input.services.executionWorkspacesSvc, getStoredById } } };
    vi.mocked(atlasExecutionPolicy).mockReturnValue({ admissions: [binding], home, credentialFiles: {} });
    try {
      for (const agent of [
        { ...qualified.agent, defaultEnvironmentId: null }, { ...qualified.agent, defaultEnvironmentId: randomUUID() },
        { ...qualified.agent, id: randomUUID() }, { ...qualified.agent, companyId: randomUUID() },
        { ...qualified.agent, adapterType: "process" as const },
        { ...qualified.agent, adapterConfig: { ...qualified.agent.adapterConfig, env: { ANTHROPIC_API_KEY: "fixture" } } },
        { ...qualified.agent, runtimeConfig: { fallbackEnvironmentIds: [randomUUID()] } },
      ]) await expect(selectHeartbeatEnvironment(db, { ...qualified, agent })).rejects.toThrow("No qualified Atlas");
      await expect(selectHeartbeatEnvironment(db, { ...qualified, run: { ...qualified.run, runtimeMode: "native" } })).rejects.toThrow("controller-selected scratch");
      expect(getById).not.toHaveBeenCalled();
      await expect(selectHeartbeatEnvironment(db, qualified)).rejects.toThrow("environment is unavailable");
      expect(getById).toHaveBeenCalledExactlyOnceWith(binding.environmentId);
      expect(getStoredById).not.toHaveBeenCalled();
      expect(ensureLocalEnvironment).not.toHaveBeenCalled();
    } finally { vi.mocked(atlasExecutionPolicy).mockReturnValue(null); }
  });

  it("places a new run by the agent default, not by its project", async () => {
    const f = await fixture();
    const local = await environmentService(db).ensureLocalEnvironment(f.input.agent.companyId);
    const [other] = await db.insert(projects).values({ companyId: f.input.agent.companyId, name: "Other project" }).returning();
    f.input.agent.defaultEnvironmentId = local.id;
    f.input.policy.isolatedWorkspacesEnabled = false;
    expect((await selectHeartbeatEnvironment(db, f.input)).environmentResolution).toEqual({ environmentId: local.id, source: "agent" });
    f.input.task.executionProjectId = other.id;
    expect((await selectHeartbeatEnvironment(db, f.input)).environmentResolution).toEqual({ environmentId: local.id, source: "agent" });
  });

  it("restores the admitted environment after a default change and rejects a foreign lease", async () => {
    const f = await fixture();
    const local = await environmentService(db).ensureLocalEnvironment(f.input.agent.companyId);
    const [next] = await db.insert(environments).values({ name: `Next target ${randomUUID()}`, driver: "ssh", config: { host: "next.example.test" } }).returning();
    const saved = await f.workspace();
    f.recover(saved.id);
    f.input.agent.defaultEnvironmentId = next.id;
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.project.companyId, environmentId: local.id,
      heartbeatRunId: f.input.run.id, issueId: f.issue.id, executionWorkspaceId: saved.id, metadata: { agentId: f.input.agent.id } }).returning();
    f.input.run.contextSnapshot = { paperclipEnvironment: { id: local.id, leaseId: lease.id } };
    expect((await selectHeartbeatEnvironment(db, f.input)).environmentResolution).toEqual({ environmentId: local.id, source: "run" });
    await db.update(environmentLeases).set({ metadata: { agentId: randomUUID() } }).where(eq(environmentLeases.id, lease.id));
    await expect(selectHeartbeatEnvironment(db, f.input)).rejects.toThrow("Cannot restore the admitted execution environment");
  });

  it("keeps the admitted workspace binding when the issue points at a newer workspace", async () => {
    const { input, workspace, recover } = await fixture();
    const original = await workspace();
    const newer = await workspace();
    input.task.issueRef!.executionWorkspaceId = newer.id;
    input.task.issueRef!.executionWorkspacePreference = null;
    recover(original.id);
    const result = await selectHeartbeatEnvironment(db, input);
    expect(result.nativeRecoveryExecutionWorkspaceId).toBe(original.id);
    expect(result.reusableExistingExecutionWorkspace?.id).toBe(original.id);
    expect(result.requestedShouldReuseExisting).toBe(true);
    expect(input.task.issueRef!.executionWorkspaceId).toBe(newer.id);
    expect(result.persistedNativeExecutionInput?.binding.executionWorkspaceId).toBe(original.id);
  });

  it.each(["bound", "issue_moved"] as const)(
    "re-prepares a restarted fresh Retry attempt as its task directory, never as a git worktree base (RC-58, %s)", async binding => {
      const { input, issue, workspace, recover } = await fixture();
      // A project-less task's fresh Retry attempt directory, created and bound by the first preparation.
      await db.update(issues).set({ projectId: null }).where(eq(issues.id, issue.id));
      const attemptCwd = await materializeIsolatedTaskDirectory({ companyId: input.agent.companyId, issueId: issue.id, attemptId: input.run.id });
      const created = await executionWorkspaceService(db).create({ companyId: input.agent.companyId, projectId: null,
        sourceIssueId: issue.id, name: "Fresh attempt", mode: "isolated_workspace", strategyType: "project_primary",
        providerType: "local_fs", cwd: attemptCwd });
      if (!created) throw new Error("Attempt workspace fixture was not created");
      await db.update(issues).set({ executionWorkspaceId: created.id, executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" } }).where(eq(issues.id, issue.id));
      const issueRef = { ...input.task.issueRef!, projectId: null, executionWorkspaceId: created.id,
        executionWorkspacePreference: "reuse_existing" };
      input.task.issueRef = issueRef;
      input.task.executionProjectId = null;
      input.policy.requestedExecutionWorkspaceMode = "isolated_workspace";
      input.policy.issueExecutionWorkspaceSettings = { mode: "isolated_workspace" };
      if (binding === "issue_moved") issueRef.executionWorkspaceId = (await workspace()).id;
      // The restart re-prepares from the admitted native input; readiness is no longer "fresh".
      recover(created.id);
      input.task.freshWorkspace = null;
      const result = await selectHeartbeatEnvironment(db, input);
      expect(result.nativeRecoveryExecutionWorkspaceId).toBe(created.id);
      expect(result.reusableExistingExecutionWorkspace?.id).toBe(created.id);
      // Only the task's current binding may resume as a task directory.
      expect(result.useIsolatedTaskDirectory).toBe(binding === "bound");
    });

  it("selects the saved execution workspace without inspecting live Git delivery state", async () => {
    const { input, workspace, recover } = await fixture();
    const saved = await workspace();
    recover(saved.id);
    input.services.executionWorkspacesSvc = executionWorkspaceService(db, {
      inspectGitCloseReadiness: async () => {
        throw new Error("Live Git inspection is unavailable");
      },
    });

    const result = await selectHeartbeatEnvironment(db, input);

    expect(result.reusableExistingExecutionWorkspace).toMatchObject({
      id: saved.id,
      companyId: input.agent.companyId,
      cwd: home,
      strategyType: "git_worktree",
    });
    expect(result.nativeRecoveryExecutionWorkspaceId).toBe(saved.id);
  });

  it("does not treat a synthetic run-id recovery binding as a persisted workspace", async () => {
    const { input, recover } = await fixture();
    recover(input.run.id);
    const result = await selectHeartbeatEnvironment(db, input);
    expect(result).toMatchObject({ existingExecutionWorkspace: null, nativeRecoveryExecutionWorkspaceId: null, requestedShouldReuseExisting: false, reusableExistingExecutionWorkspace: null });
    expect(result.persistedNativeExecutionInput?.binding.executionWorkspaceId).toBe(input.run.id);
  });

  it.each((["resume_stopped_native_workspace", "reuse_issue_workspace"] as const).flatMap(retainedMode =>
    ["preserved", "changed_binding", "changed_cwd"].map(mode => [retainedMode, mode] as const)))(
    "pins the verified Retry workspace during environment selection (%s, %s)", async (retainedMode, mode) => {
    const { input, issue, workspace } = await fixture();
    const saved = await workspace();
    await db.update(issues).set({ executionWorkspaceId: saved.id }).where(eq(issues.id, issue.id));
    input.task.issueRef!.executionWorkspaceId = saved.id;
    input.task.issueRef!.executionWorkspacePreference = null;
    input.task.freshWorkspace = { mode: retainedMode, retryIntentId: randomUUID(),
      sourceRunId: randomUUID(), workspaceId: saved.id, cwd: home };
    if (mode === "changed_binding") input.task.issueRef!.executionWorkspaceId = (await workspace()).id;
    if (mode === "changed_cwd") await executionWorkspaceService(db).update(saved.id, { cwd: join(home, "changed") });
    if (mode !== "preserved") {
      await expect(selectHeartbeatEnvironment(db, input)).rejects.toThrow("The saved Retry workspace binding changed.");
      return;
    }
    const result = await selectHeartbeatEnvironment(db, input);
    expect(result.requestedShouldReuseExisting).toBe(true);
    expect(result.reusableExistingExecutionWorkspace).toMatchObject({ id: saved.id, cwd: home });
    expect(result.nativeRecoveryExecutionWorkspaceId).toBeNull();
  });

  it("does not make an archived issue workspace available for reuse", async () => {
    const { input, workspace } = await fixture();
    const saved = await workspace();
    await executionWorkspaceService(db).update(saved.id, { status: "archived" });
    input.task.issueRef!.executionWorkspaceId = saved.id;
    input.task.issueRef!.executionWorkspacePreference = "reuse_existing";
    const result = await selectHeartbeatEnvironment(db, input);
    expect(result.requestedShouldReuseExisting).toBe(true);
    expect(result.reusableExistingExecutionWorkspace).toBeNull();
    expect(result.requestedReusableExecutionWorkspaceConfig).toBeNull();
  });

  it("restores a reopened task's terminal workspace under its own admitted run", async () => {
    const { input, issue, workspace } = await fixture();
    const saved = await workspace();
    await writeFile(join(home, "saved-work.txt"), "Retain the completed investigation\n");
    await executionWorkspaceService(db).update(saved.id, { status: "archived", strategyType: "project_primary",
      cleanupReason: "issue_terminal", closedAt: new Date("2020-01-01T00:00:00Z") });
    await db.update(issues).set({ executionWorkspaceId: saved.id, executionWorkspacePreference: "reuse_existing" })
      .where(eq(issues.id, issue.id));
    input.task.issueRef!.executionWorkspaceId = saved.id;
    input.task.issueRef!.executionWorkspacePreference = "reuse_existing";

    const result = await selectHeartbeatEnvironment(db, input);

    expect(result.reusableExistingExecutionWorkspace).toMatchObject({ id: saved.id, status: "active" });
    expect(await readFile(join(home, "saved-work.txt"), "utf8")).toBe("Retain the completed investigation\n");
    expect(await executionWorkspaceService(db).getStoredById(input.agent.companyId, saved.id))
      .toMatchObject({ status: "active", closedAt: null, sourceIssueId: issue.id });
  });

  describe("workspaces removed by git cache expiration", () => {
    async function expired() {
      const f = await fixture();
      const saved = await f.workspace();
      await executionWorkspaceService(db).update(saved.id, { status: "archived" });
      f.input.task.issueRef!.executionWorkspaceId = saved.id;
      f.input.task.issueRef!.executionWorkspacePreference = "reuse_existing";
      await db.update(issues).set({ executionWorkspaceId: saved.id, executionWorkspacePreference: "reuse_existing" }).where(eq(issues.id, f.issue.id));
      restoration.removed = true;
      const svc = executionWorkspaceService(db);
      f.input.services.executionWorkspacesSvc = svc;
      return { ...f, saved, svc };
    }

    it("reopens the issue's expired workspace before the run binds it", async () => {
      const { input, issue, saved, svc } = await expired();
      const reopen = vi.spyOn(svc, "reopenClosedIsolatedExecutionWorkspaceForIssue").mockImplementation(async () => {
        await executionWorkspaceService(db).update(saved.id, { status: "active" });
        return { ok: true, reopened: true, workspace: (await svc.getStoredById(issue.companyId, saved.id))!, generation: 4 };
      });
      const clear = vi.spyOn(svc, "clearReopenPendingConsumptionForUnconsumedReopen").mockResolvedValue({ cleared: true });
      try {
        const result = await selectHeartbeatEnvironment(db, input);
        expect(reopen).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: saved.id,
          issue: { id: issue.id, companyId: issue.companyId, projectId: issue.projectId },
          authorizationActor: expect.objectContaining({ type: "agent", agentId: input.agent.id, runId: input.run.id }) }));
        expect(clear).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: saved.id, expectedGeneration: 4 }));
        expect(result.reusableExistingExecutionWorkspace).toMatchObject({ id: saved.id, status: "active" });
      } finally { restoration.removed = false; }
    });

    it("fails the run instead of binding a new workspace when the restore fails", async () => {
      const { input, svc } = await expired();
      vi.spyOn(svc, "reopenClosedIsolatedExecutionWorkspaceForIssue")
        .mockResolvedValue({ ok: false, code: "rebuild_failed", message: "Workspace restore failed" });
      try {
        await expect(selectHeartbeatEnvironment(db, input)).rejects.toThrow("Workspace restore failed");
      } finally { restoration.removed = false; }
    });

    it("leaves a workspace archived for other reasons alone", async () => {
      const { input, svc } = await expired();
      restoration.removed = false;
      const reopen = vi.spyOn(svc, "reopenClosedIsolatedExecutionWorkspaceForIssue");
      const result = await selectHeartbeatEnvironment(db, input);
      expect(reopen).not.toHaveBeenCalled();
      expect(result.reusableExistingExecutionWorkspace).toBeNull();
    });

    async function migratedToRemoteStorage(generation: number) {
      const f = await expired();
      restoration.removed = false;
      const worktreePath = join(home, "removed-worktree");
      const snapshotId = randomUUID();
      await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId: f.issue.companyId, executionWorkspaceId: f.saved.id,
        sourceOperationId: randomUUID(), generation: 1, epoch: 1, status: "committed" });
      await db.update(executionWorkspaces).set({
        cwd: `/workspaces/${f.saved.id}`, providerRef: null, providerType: "cloud_sandbox",
        cleanupReason: "reproducible_git_cache_expired", closedAt: new Date("2020-01-01T00:00:00Z"),
        metadata: { createdByRuntime: true, gitBranchOwnershipVersion: 1, lifecycleGeneration: generation,
          gitCacheRestoration: { schema: "paperclip.git-cache-restoration.v1", companyId: f.issue.companyId, workspaceId: f.saved.id,
            sourceIssueId: f.issue.id, repoUrl: null, commit: "a".repeat(40), branchName: null, sourceKind: "managed_project",
            projectId: f.project.id, sourcePath: home, worktreePath, gitBranchOwnershipVersion: 1, verifiedAt: "2020-01-01T00:00:00.000Z" },
          gitCacheExpiration: { schema: "paperclip.git-cache-expiration.v1", generation: 3, workspaceRemoved: true, completed: true,
            worktreeTrash: join(home, ".expired"), worktreeAdmin: join(home, ".git", "worktrees", "removed"), baseTrash: null },
          remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId, location: null, writerRunId: null,
            dirty: false, source: { kind: "git", repoUrl: "https://example.test/repo.git", ref: "a".repeat(40), branchName: "saved" } } },
      }).where(eq(executionWorkspaces.id, f.saved.id));
      return f;
    }

    it("reopens an expired workspace migrated to remote storage from its saved snapshot", async () => {
      const { input, issue, saved } = await migratedToRemoteStorage(3);
      const result = await selectHeartbeatEnvironment(db, input);
      expect(result.reusableExistingExecutionWorkspace).toMatchObject({ id: saved.id, status: "active" });
      const stored = await executionWorkspaceService(db).getStoredById(issue.companyId, saved.id);
      expect(stored).toMatchObject({ id: saved.id, status: "active", closedAt: null, cleanupReason: null, cwd: `/workspaces/${saved.id}` });
      expect(stored?.metadata?.lifecycleGeneration).toBe(4);
      const [bound] = await db.select({ executionWorkspaceId: issues.executionWorkspaceId }).from(issues).where(eq(issues.id, issue.id));
      expect(bound?.executionWorkspaceId).toBe(saved.id);
    });

    it("does not treat a remote workspace's expiration from an earlier lifecycle as current", async () => {
      const { input, svc } = await migratedToRemoteStorage(4);
      const reopen = vi.spyOn(svc, "reopenClosedIsolatedExecutionWorkspaceForIssue");
      const result = await selectHeartbeatEnvironment(db, input);
      expect(reopen).not.toHaveBeenCalled();
      expect(result.reusableExistingExecutionWorkspace).toBeNull();
    });
  });

  it.each(["muse", "openai_dot", "grok_bot"] as const)("keeps %s managed placement without adopting the task's selected workspace", async provider => {
    const { input, issue, workspace } = await fixture();
    const source = await workspace();
    const [sandbox] = await db.insert(environments).values({ name: `External controller ${provider}`, driver: "sandbox", status: "active", config: { provider: "fake" } }).returning();
    input.agent.adapterType = "paperclip_runner";
    input.agent.adapterConfig = { provider };
    input.agent.defaultEnvironmentId = sandbox.id;
    input.task.issueRef!.executionWorkspaceId = source.id;
    input.task.issueRef!.projectWorkspaceId = randomUUID();
    input.task.boundSourceWorkspace = source;
    input.task.workspaceProjectContext = { hasWorkspace: true };
    input.task.hasSelectedWorkspaceSource = true;
    input.task.taskWorkspaceIntent = { version: 1, source: "explicit", selection: { kind: "task_directory" } };
    await db.update(issues).set({ originKind: "chat_channel" }).where(eq(issues.id, issue.id));
    const read = vi.spyOn(input.services.executionWorkspacesSvc, "getStoredById").mockRejectedValue(new Error("Task source must remain inaccessible"));
    const select = vi.spyOn(input.services.executionWorkspacesSvc, "validateStoredSelectionForRun").mockRejectedValue(new Error("Task selection must remain inaccessible"));
    try {
      const result = await selectHeartbeatEnvironment(db, input);
      expect(result).toMatchObject({ isDotRun: true, selectedEnvironmentId: sandbox.id,
        existingExecutionWorkspace: null, reusableExistingExecutionWorkspace: null,
        nativeChatWorkspaceScope: null, useIsolatedTaskDirectory: false, explicitTaskDirectory: false });
      expect(read).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(input.services.findSharedWorkspaceHolder).not.toHaveBeenCalled();
      expect(input.task.issueRef!.executionWorkspaceId).toBe(source.id);
    } finally { read.mockRestore(); select.mockRestore(); }
  });

  it("uses the low-trust task sandbox even when workspace feature gates hide issue settings", async () => {
    const { input, issue } = await fixture();
    const [sandbox] = await db.insert(environments).values({ name: "Task sandbox", driver: "sandbox", status: "active", config: { provider: "fake" } }).returning();
    input.task.issueContext!.executionWorkspaceSettings = { mode: "isolated_workspace", environmentId: sandbox.id };
    input.policy.trustPreset = { kind: "low_trust_review", preset: "low_trust_review", sourcePresets: {}, boundary: { mode: "low_trust_review", companyId: input.agent.companyId, rootIssueId: issue.id } };
    input.policy.requestedExecutionWorkspaceMode = "isolated_workspace";
    input.policy.isolatedWorkspacesEnabled = false;
    const result = await selectHeartbeatEnvironment(db, input);
    expect(result.selectedEnvironmentForConfig?.id).toBe(sandbox.id);
    expect(result.useIsolatedTaskDirectory).toBe(true);
  });

  it("returns the task-owned local chat root before workspace realization", async () => {
    const { input, issue } = await fixture();
    await db.update(issues).set({ originKind: "chat_channel", projectId: null }).where(eq(issues.id, issue.id));
    input.agent.adapterType = "paperclip_runner";
    input.task.executionProjectId = null;
    input.task.workspaceProjectContext = null;
    const result = await selectHeartbeatEnvironment(db, input);
    expect(result.nativeChatWorkspaceScope).toMatchObject({ companyId: input.agent.companyId, agentId: input.agent.id, issueId: issue.id, projectId: null });
    expect(result.nativeChatExpectedCwd).toBe(result.nativeChatWorkspaceScope?.taskRoot);
    expect(result.nativeChatExpectedCwd).toContain(`isolated-workspaces/${input.agent.companyId}/${issue.id}`);
  });

  it.each(["git_worktree", "project_primary"] as const)("only prepares fresh native chat isolation with a %s source strategy", async (strategy) => {
    const { input, issue, project } = await fixture();
    const [source] = await db.insert(projectWorkspaces).values({ companyId: input.agent.companyId, projectId: project.id,
      name: "Chat source", cwd: home, sourceType: "local_path", isPrimary: true }).returning();
    const intent = { version: 1 as const, source: "explicit" as const, selection: { kind: "configured_source" as const, projectWorkspaceId: source.id, mode: "managed_isolated" as const } };
    await db.update(issues).set({ originKind: "chat_channel", projectWorkspaceId: source.id, workspaceSelection: intent }).where(eq(issues.id, issue.id));
    input.task.issueRef!.projectWorkspaceId = source.id;
    input.task.workspaceProjectContext = { hasWorkspace: true };
    input.task.hasSelectedWorkspaceSource = true;
    input.task.taskWorkspaceIntent = intent;
    input.agent.adapterType = "paperclip_runner";
    input.policy.requestedExecutionWorkspaceMode = "isolated_workspace";
    input.config.sourceWorkspaceConfig = { workspaceStrategy: { type: strategy } };
    if (strategy === "project_primary") {
      await expect(selectHeartbeatEnvironment(db, input)).rejects.toThrow("External chat requires a task-owned isolated workspace");
    } else {
      const result = await selectHeartbeatEnvironment(db, input);
      expect(result).toMatchObject({ materializeNativeChatWorktree: true, nativeChatExpectedCwd: null, existingExecutionWorkspace: null });
      expect(result.nativeChatWorkspaceScope?.projectId).toBe(project.id);
      expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].executionWorkspaceId).toBeNull();
    }
  });

  describe("agent environment overflow", () => {
    async function overflowFixture() {
      const { input, issue } = await fixture();
      const local = await environmentService(db).ensureLocalEnvironment(input.agent.companyId);
      await db.update(environments).set({ config: { capacity: { maxConcurrentRuns: 1 } } }).where(eq(environments.id, local.id));
      const [remote] = await db.insert(environments).values({ name: `Overflow host ${randomUUID()}`, driver: "ssh", status: "active",
        config: { host: "overflow.invalid", port: 22, username: "agent", remoteWorkspacePath: "/srv/work" } }).returning();
      input.agent.defaultEnvironmentId = local.id;
      input.agent.runtimeConfig = { fallbackEnvironmentIds: [remote.id] };
      const lease = (environmentId: string, values: Partial<typeof environmentLeases.$inferInsert> = {}) =>
        db.insert(environmentLeases).values({ companyId: input.agent.companyId, environmentId, status: "active", ...values });
      return { input, issue, local, remote, lease };
    }

    it("overflows only while the agent default is full", async () => {
      const { input, local, remote, lease } = await overflowFixture();
      expect((await selectHeartbeatEnvironment(db, input)).selectedEnvironmentId).toBe(local.id);
      await lease(local.id);
      expect((await selectHeartbeatEnvironment(db, input)).selectedEnvironmentId).toBe(remote.id);
    });

    it("routes credentials for the chosen overflow host before preparing its workspace", async () => {
      const { input, issue, local, remote, lease } = await overflowFixture();
      const { environmentsSvc, instanceSettings } = input.services;
      await lease(local.id);
      const authenticate = () => resolveSshAuthenticationBeforeRouting({
        agentDefaultEnvironmentId: local.id, lowTrustIssueEnvironmentId: null, environmentsSvc, instanceSettings,
        resolveAgentEnvironmentId: async primaryEnvironmentId => {
          const selectedEnvironmentId = await selectHeartbeatOverflowEnvironmentId(db, {
            primaryEnvironmentId, run: input.run, agent: input.agent, issueId: issue.id,
            wasIssueAssignee: true, getEnvironment: environmentsSvc.getById,
          });
          input.config.overflowPlacement = { primaryEnvironmentId, selectedEnvironmentId };
          return selectedEnvironmentId;
        },
      });
      await expect(authenticate()).resolves.toBe("host");
      expect((await selectHeartbeatEnvironment(db, input)).selectedEnvironmentId).toBe(remote.id);
      await db.update(environments).set({ config: { ...remote.config, useHostAuth: false } }).where(eq(environments.id, remote.id));
      await expect(authenticate()).resolves.toBe("managed");
    });

    it("shares a deployment-declared local host but refuses a foreign declared SSH fallback", async () => {
      const { input, local, remote, lease } = await overflowFixture();
      const [owner] = await db.insert(companies).values({ name: "Environment owner", issuePrefix: "OWN" }).returning();
      await db.insert(deploymentResources).values([local, remote].map(environment => ({
        owner: "fixture", kind: "environment", key: environment.id,
        resourceId: environment.id, companyId: owner.id, fields: {},
      })));
      try {
        expect((await selectHeartbeatEnvironment(db, input)).selectedEnvironmentId).toBe(local.id);
        const environmentsSvc = environmentService(db);
        const acquire = (environmentId: string) => environmentsSvc.acquireLease({
          companyId: input.agent.companyId, environmentId, assertCompanyBinding: true,
        });
        await expect(acquire(remote.id)).rejects.toMatchObject({ status: 403 });
        await expect(acquire(local.id)).resolves.toMatchObject({ environmentId: local.id });
        await lease(local.id);
        await expect(selectHeartbeatEnvironment(db, input)).rejects.toMatchObject({ capacityEnvironmentId: local.id });
      } finally {
        await db.delete(deploymentResources).where(eq(deploymentResources.companyId, owner.id));
      }
    });

    it("does not overflow placements that do not come from the agent default", async () => {
      const { input, local, lease } = await overflowFixture();
      await lease(local.id);
      input.agent.defaultEnvironmentId = null;
      expect((await selectHeartbeatEnvironment(db, input)).selectedEnvironmentId).toBe(local.id);
    });

    it("defers while every candidate is full and admits once a slot frees", async () => {
      const { input, local, remote, lease } = await overflowFixture();
      await db.update(environments).set({ config: { ...remote.config, capacity: { maxConcurrentRuns: 1 } } }).where(eq(environments.id, remote.id));
      await lease(local.id);
      const [held] = await lease(remote.id).returning();
      await expect(selectHeartbeatEnvironment(db, input)).rejects.toMatchObject({ name: "WorkspaceBusyDeferral", capacityEnvironmentId: local.id });
      await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, held!.id));
      expect((await selectHeartbeatEnvironment(db, input)).selectedEnvironmentId).toBe(remote.id);
    });

    it("lets only one concurrent run lease take the last slot", async () => {
      const { input, local } = await overflowFixture();
      const take = () => environmentService(db).acquireLease({ companyId: input.agent.companyId, environmentId: local.id, maxConcurrentRuns: 1 });
      const results = await Promise.allSettled([take(), take()]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.any(EnvironmentCapacityExhaustedError) });
    });

    it("reacquires a same-run lease without charging its slot twice", async () => {
      const { input, issue, remote } = await overflowFixture();
      const environmentsSvc = environmentService(db);
      const scope = {
        companyId: input.agent.companyId, environmentId: remote.id, issueId: issue.id,
        heartbeatRunId: input.run.id, providerLeaseId: "same-lease",
        leasePolicy: "reuse_by_environment" as const, metadata: { agentId: input.agent.id },
        assertCompanyBinding: true, maxConcurrentRuns: 1,
      };
      const lease = await environmentsSvc.acquireLease(scope);
      await expect(environmentsSvc.acquireLease({ ...scope, reusesReusableLeaseId: lease.id }))
        .resolves.toMatchObject({ id: lease.id, status: "active" });
      await expect(environmentsSvc.acquireLease(scope)).rejects.toBeInstanceOf(EnvironmentCapacityExhaustedError);
      await environmentsSvc.releaseLease(lease.id);
      await expect(environmentsSvc.acquireLease(scope)).resolves.toMatchObject({ status: "active" });
    });

    it("returns an issue session to the host that last ran it", async () => {
      const { input, issue, remote, lease } = await overflowFixture();
      await lease(remote.id, { status: "released", issueId: issue.id, metadata: { agentId: input.agent.id } });
      expect((await selectHeartbeatEnvironment(db, input)).selectedEnvironmentId).toBe(remote.id);
    });
  });
});
