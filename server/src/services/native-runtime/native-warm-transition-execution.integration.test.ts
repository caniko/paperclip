import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import * as runtime from "../../vendor/paperclip-runner/index.js";
import {
  defaultCapabilityRunnerdBinary,
  executeNativeSession,
  type NativeExecutionInput,
  type NativeSession,
} from "../../vendor/paperclip-runner/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { runnerPrpWebSocketInternals, setupRunnerPrpWebSocketServer } from "../../realtime/runner-prp-ws.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { createRunnerdBackend } from "./native-session-executor.js";
import { claimNativeRestartRecoveries } from "./native-restart-recovery.js";
import { nativeToolContractFingerprintForTarget, rebindNativeSessionCheckpoint } from "./native-session-resume.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

const runnerBinary = defaultCapabilityRunnerdBinary();
const fakeCodex = join(dirname(runnerBinary), "fake-codex-app-server");
const support = await getEmbeddedPostgresTestSupport();
const generated = support.supported && existsSync(runnerBinary) && existsSync(fakeCodex)
  ? describe
  : describe.skip;
const cases = [
  ["before-result", false],
  ["after-result", false],
  ["after-activation", false],
  ["before-confirmation", false],
  ["after-confirmation", false],
  ["before-result", true],
] as const;

function absent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return true;
  }
}

// Only the provider is synthetic. The native backend, driver, PRP routes,
// runner, restart classifier, database event/result writer and tool authority
// are production implementations. Fault injection ends before recovery begins.
generated("warm transition → restarted native execution", () => {
  it.each(cases)("completes exactly once after %s (managed=%s)", async (lossPoint, managed) => {
    const temporary = await startEmbeddedPostgresTestDatabase("native-warm-execution-db-");
    const db = createDb(temporary.connectionString);
    const scratch = await mkdtemp(join(tmpdir(), "native-warm-execution-"));
    const stateBase = join(scratch, "sessions");
    const workspace = join(scratch, "workspace");
    const home = join(scratch, "home");
    const bin = join(scratch, "bin");
    const callsPath = join(scratch, "calls.log");
    const completionPath = join(scratch, "completion.json");
    const expectedContextPath = join(scratch, "expected-context.json");
    const previousEnvironment = { state: process.env.PAPERCLIP_RUNNER_STATE_DIR, binary: process.env.PAPERCLIP_RUNNER_BINARY };
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const oldRunId = randomUUID(), newRunId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID();
    const contractId = randomUUID(), executionWorkspaceId = randomUUID();
    const cores: runtime.DurablePrpControlPlane[] = [];
    const bundles: ReturnType<typeof runtime.createRunnerdCodexTransport>[] = [];
    const server = createServer();
    let session: NativeSession | undefined;
    let resumed: NativeSession | undefined;
    let commitSpy: ReturnType<typeof vi.spyOn> | undefined;
    let providerPid: number | null = null;
    let runnerPid: number | null = null;
    let detached: Promise<void> | undefined;
    let attachment: Promise<void> | undefined;
    const diagnostics: string[] = [];
    // Installed Codex takes precedence over PATH; this recovery fixture must
    // always execute its deterministic provider, never an installed real one.
    const codexCommandResolver = await vi.importActual<{ resolveCodexCommand: () => string }>(
      "../../../../packages/paperclip-runner/src/drivers/codex/codex-command.js",
    );
    const resolveFixtureCodex = vi.spyOn(codexCommandResolver, "resolveCodexCommand")
      .mockReturnValue(join(bin, "codex"));
    const createTransport = runtime.createRunnerdCodexTransport;
    const transportSpy = vi.spyOn(runtime, "createRunnerdCodexTransport").mockImplementation(options => {
      const register = options!.controlPlaneRegistration!;
      const bundle = createTransport({ ...options, controlPlaneRegistration: (authority, identity) => {
        if (!cores.includes(authority)) cores.push(authority);
        return register(authority, identity);
      } });
      bundles.push(bundle);
      return bundle;
    });
    try {
      process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
      process.env.PAPERCLIP_RUNNER_BINARY = runnerBinary;
      await Promise.all([workspace, home, bin].map(path => mkdir(path, { recursive: true })));
      await writeFile(completionPath, JSON.stringify({
        reportedWorkDisposition: "done", summary: "Warm restart completed.",
        completionClaim: { contractRevision: "warm-execution-v1", objectiveSatisfied: true,
          criteria: [{ criterionId: "recovered", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
        evidence: [], verification: [], attentionRequests: [], artifacts: [],
      }), { mode: 0o600 });
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await writeFile(expectedContextPath, JSON.stringify({ companyId, actorId: agentId, taskId: issueId, runId: newRunId }), { mode: 0o600 });
      await writeFile(join(bin, "codex"), `#!/bin/sh\nexec ${quote(fakeCodex)} --state-file-in-codex-home --call-log ${quote(callsPath)} --record-process-start --durable-turn-ids --emit-tool-call --expected-native-task-context-file ${quote(expectedContextPath)} --completion-result-file ${quote(completionPath)} "$@"\n`);
      await chmod(join(bin, "codex"), 0o700);
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing PRP listener");
      setupRunnerPrpWebSocketServer(server, { apiUrl: `http://127.0.0.1:${address.port}` });
      const execution = (runId: string): NativeExecutionInput => {
        const { runtimeContext: _context, ...input } = buildNativeExecutionInput({
          companyId, agentId, runId, normalizedSessionId: sessionId,
          issue: { id: issueId, identifier: "WEX-1", title: "Recover warm execution", description: null, workMode: "standard" },
          taskPrompt: "Read the real task context, then complete this recovered run.",
          workspace: { id: managed ? executionWorkspaceId : runId, cwd: workspace, repoUrl: null, repoRef: null, branchName: null },
          provider: "codex", lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
          completionContract: { id: contractId, sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
            contract: { revision: "warm-execution-v1", objective: "Recover the original provider thread",
              criteria: [{ id: "recovered", requirement: "Complete on the recovered thread exactly once" }] } },
          runtimeContext: nativeRuntimeContextFixture(),
        });
        return { ...input, schema: "paperclip.native-execution-input.v2", provider: { kind: "codex", model: "gpt-5.6-luna" } };
      };
      const priorExecution = execution(oldRunId), currentExecution = execution(newRunId);
      await db.insert(companies).values({ id: companyId, name: "Warm execution", issuePrefix: "WEX" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Warm owner", status: "active", adapterType: "paperclip_runner" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Recover warm execution", status: "in_progress", assigneeAgentId: agentId });
      await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
        schemaVersion: "paperclip.completion-contract.v1", policyVersion: "warm-execution-v1", risk: "standard",
        completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: { ...currentExecution.completionContract.contract }, canonicalSha256: currentExecution.completionContract.sha256,
        createdByActorType: "system", createdByActorId: "test" });
      const common = { companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
        nativeSessionId: sessionId, runnerInstanceId, completionContractId: contractId,
        completionContractSha256: currentExecution.completionContract.sha256 };
      await db.insert(heartbeatRuns).values([
        { ...common, id: oldRunId, runnerProfileJson: { nativeExecutionInput: priorExecution } },
        { ...common, id: newRunId, runnerProfileJson: { nativeExecutionInput: currentExecution } },
      ]);
      const backendOptions = { db, runnerInstanceId, runnerEnvironment: { PATH: `${bin}:${process.env.PATH}`, HOME: home, CODEX_HOME: home },
        onLog: async (_stream: "stdout" | "stderr", chunk: string) => { diagnostics.push(chunk); } };
      const backend = await createRunnerdBackend({ ...backendOptions, execution: priorExecution });
      session = await backend.openSession({ identity: { companyId, agentId, issueId, runId: oldRunId, sessionId }, workingDirectory: workspace });
      const checkpoint = { ...await session.snapshot(), process: bundles[0]!.evidence() };
      providerPid = checkpoint.process.providerPid;
      runnerPid = checkpoint.process.runnerPid;
      expect(providerPid).toBeGreaterThan(0);
      expect(runnerPid).toBeGreaterThan(0);
      expect(cores).toHaveLength(1);
      const root = join(stateBase, (await readdir(stateBase)).find(name => /^[a-f0-9]{64}$/.test(name))!);
      const providerStatePath = join(root, "codex-home", "fake-codex-state.json");
      const beforeProvider = await readFile(providerStatePath);
      const oldProfile = { nativeExecutionInput: priorExecution, nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("local"), sessionCheckpoint: checkpoint };
      const rebound = rebindNativeSessionCheckpoint({ previousRun: { id: oldRunId, companyId, agentId, nativeSessionId: sessionId, runnerProfileJson: oldProfile }, currentExecution });
      expect(rebound).not.toBeNull();
      const processStartedAt = await readProcessStartedAt(runnerPid!);
      if (!processStartedAt) throw new Error("Runner process start fingerprint unavailable");
      const processFields = { processPid: runnerPid!, processGroupId: checkpoint.process.runnerProcessGroupId, processStartedAt: new Date(processStartedAt) };
      await db.update(heartbeatRuns).set({ ...processFields, status: "succeeded", finishedAt: new Date(), runnerProfileJson: oldProfile }).where(eq(heartbeatRuns.id, oldRunId));
      await db.update(heartbeatRuns).set({ ...processFields, runnerProfileJson: { nativeExecutionInput: currentExecution,
        nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("local"), sessionCheckpoint: rebound } }).where(eq(heartbeatRuns.id, newRunId));
      await db.update(issues).set({ executionRunId: newRunId }).where(eq(issues.id, issueId));
      await db.insert(nativeRunFinalizations).values({ runId: newRunId, companyId, issueId, phase: "observed" });
      const core = cores[0]!;
      const store = core.store as typeof core.store & { commit(candidate: typeof core.store.state): void };
      const commit = store.commit.bind(store);
      let lossObserved = false;
      commitSpy = vi.spyOn(store, "commit").mockImplementation(candidate => {
        if (lossObserved) throw new Error("fixture controller unavailable after loss");
        const atBoundary = lossPoint.includes("confirmation")
          ? candidate.completedWarmTransition !== undefined && candidate.warmTransition === undefined
          : candidate.warmTransition?.phase === (lossPoint === "after-activation" ? "activated" : "prepared");
        if (atBoundary) {
          lossObserved = true;
          if (lossPoint !== "before-result" && lossPoint !== "before-confirmation") commit(candidate);
          runnerPrpWebSocketInternals.resetForTests();
          core.disconnectActiveRunner();
          detached = session!.detachControllerForRestart!();
          throw new Error("fixture interrupted exact result commit");
        }
        commit(candidate);
      });
      attachment = session.attachRun!({ identity: { companyId, agentId, issueId, runId: newRunId, sessionId } });
      void attachment.catch(() => undefined);
      await vi.waitFor(() => expect(lossObserved).toBe(true), { timeout: 5_000 });
      await detached;
      // Both owners were observed at launch by this exact transport. Refuse to
      // signal a recycled runner; never derive termination authority from disk.
      expect(await readProcessStartedAt(runnerPid!)).toBe(processStartedAt);
      process.kill(-runnerPid!, "SIGKILL");
      await vi.waitFor(() => expect(absent(runnerPid!) && absent(-runnerPid!)).toBe(true));
      if (!absent(-providerPid!)) process.kill(-providerPid!, "SIGKILL");
      await vi.waitFor(() => expect(absent(providerPid!) && absent(-providerPid!)).toBe(true));
      await attachment.catch(() => undefined);
      session = undefined;
      commitSpy.mockRestore();
      commitSpy = undefined;
      expect(lossObserved).toBe(true);
      expect(await readFile(providerStatePath)).toEqual(beforeProvider);
      const crashedRunner = JSON.parse(await readFile(join(root, "runner", "runner-state.json"), "utf8"));
      const transitionId = crashedRunner.warmTransition.receipt.transitionId;
      const evidenceRoot = process.env.PAPERCLIP_WARM_TRANSITION_EXECUTION_EVIDENCE;
      if (evidenceRoot) await cp(root, join(evidenceRoot, `${lossPoint}-${managed ? "managed" : "transient"}`, "capture"), { recursive: true, errorOnExist: true, force: false });
      // A fresh core/transport uses the same endpoint, configuration and paths.
      // No copied journal is rewritten, and the original Rust provider state stays in place.
      transportSpy.mockRestore();
      setupRunnerPrpWebSocketServer(server, { apiUrl: `http://127.0.0.1:${address.port}` });
      const [claim] = await claimNativeRestartRecoveries({ db, runIds: [newRunId], restartKind: "hard" });
      expect(claim?.kind).toBe("resume_dead_runner");
      if (claim?.kind !== "resume_dead_runner") throw new Error("Missing exact dead-runner recovery claim");
      const restarted = await createRunnerdBackend({ ...backendOptions, execution: currentExecution, restartRecovery: claim });
      const controlPlaneInstanceId = randomUUID();
      const port = new PaperclipControlPlanePort(db, { companyId, agentId, issueId, runId: newRunId, sessionId,
        completionContractId: contractId, completionContractSha256: currentExecution.completionContract.sha256,
        sourceInstanceId: runnerInstanceId, controlPlaneSourceInstanceId: controlPlaneInstanceId });
      const result = await executeNativeSession({ input: currentExecution, backend: restarted, persistedSession: rebound!,
        runnerInstanceId, controlPlaneInstanceId, controlPlane: port, timeoutMs: 20_000,
        onSession: value => { resumed = value ?? undefined; } });
      expect(result).toMatchObject({ normalizedSessionId: sessionId, result: { summary: "Warm restart completed.", reportedWorkDisposition: "done" }, terminal: { runTerminalState: "succeeded" } });
      const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);
      expect(calls.filter(call => call === "process-start")).toHaveLength(2);
      expect(calls.filter(call => call === "thread/start")).toHaveLength(1);
      expect(calls.filter(call => call === "turn/start")).toHaveLength(1);
      expect(calls.filter(call => call === "completion-response:accepted")).toHaveLength(1);
      const control = JSON.parse(await readFile(join(root, "control-plane", "control-plane-state.json"), "utf8"));
      const finalRunner = JSON.parse(await readFile(join(root, "runner", "runner-state.json"), "utf8"));
      expect(control.identity.runId).toBe(newRunId);
      expect(finalRunner.runId).toBe(newRunId);
      expect(control.warmTransition).toBeUndefined();
      expect(finalRunner.warmTransition).toBeUndefined();
      expect(control.completedWarmTransition.receipt.transitionId).toBe(transitionId);
      const activatedIdentity = control.completedWarmTransition.receipt.newIdentity;
      expect(finalRunner).toMatchObject(activatedIdentity);
      expect(activatedIdentity.turnId).toMatch(/^turn_attachment_[a-f0-9]{32}$/);
      expect(activatedIdentity.itemId).toMatch(/^item_attachment_[a-f0-9]{32}$/);
      expect(JSON.parse(await readFile(providerStatePath, "utf8"))).toMatchObject({ threadId: checkpoint.sessionId, nextTurn: 1, activeTurnId: null });
      const accepted = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, newRunId));
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({ companyId, issueId, runId: newRunId, schemaStatus: "accepted", resultJson: { result: { summary: "Warm restart completed." } } });
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, newRunId));
      expect(events.length).toBeGreaterThan(0);
      expect(new Set(events.map(event => event.sourceEventId)).size).toBe(events.length);
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, oldRunId))).toHaveLength(0);
      if (evidenceRoot) {
        const destination = join(evidenceRoot, `${lossPoint}-${managed ? "managed" : "transient"}`);
        await cp(root, join(destination, "completed"), { recursive: true, errorOnExist: true, force: false });
        await writeFile(join(destination, "execution.json"), JSON.stringify({ lossPoint, managed, priorExecution, currentExecution, checkpoint, rebound, claim, transitionId, result, accepted, events, calls }, null, 2), { flag: "wx", mode: 0o600 });
      }
    } catch (error) {
      const evidenceRoot = process.env.PAPERCLIP_WARM_TRANSITION_EXECUTION_EVIDENCE;
      if (evidenceRoot) {
        const destination = join(evidenceRoot, `${lossPoint}-${managed ? "managed" : "transient"}`);
        await mkdir(destination, { recursive: true });
         if (existsSync(stateBase))
           await cp(stateBase, join(destination, "failure"), { recursive: true, errorOnExist: true, force: false });
        await writeFile(join(destination, "failure.json"), JSON.stringify({
          error: error instanceof Error ? error.stack : String(error), diagnostics,
          calls: await readFile(callsPath, "utf8").catch(() => null),
          runs: await db.select().from(heartbeatRuns),
          events: await db.select().from(heartbeatRunEvents),
          results: await db.select().from(nativeRunResults),
        }, null, 2), { flag: "wx", mode: 0o600 });
      }
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nNative warm execution diagnostics:\n${diagnostics.join("").slice(-16000)}`, { cause: error });
    } finally {
      resolveFixtureCodex.mockRestore();
      commitSpy?.mockRestore();
      transportSpy.mockRestore();
      await resumed?.close({ reason: "Warm execution cleanup" });
      await session?.close({ reason: "Warm execution cleanup" });
      for (const core of cores) await core.stop();
      runnerPrpWebSocketInternals.resetForTests();
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      await db.$client.end({ timeout: 1 });
      await temporary.cleanup();
      if (previousEnvironment.state === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousEnvironment.state;
      if (previousEnvironment.binary === undefined) delete process.env.PAPERCLIP_RUNNER_BINARY;
      else process.env.PAPERCLIP_RUNNER_BINARY = previousEnvironment.binary;
      await rm(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
