import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, environmentLeases, heartbeatRuns, issues, mcpPreparedLaunches, type Db } from "@paperclipai/db";
import type { McpLaunchAuthorizationReceipt, McpLaunchChallenge, McpPreparedLaunchSnapshot } from "@paperclipai/shared";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { readPendingAdapterExecutionCheckpoint } from "./adapter-execution-ownership.js";
import { validateManagedMcpExecutionCheckpoint } from "@paperclipai/hermes-paperclip-adapter/gateway/server";
import { McpLaunchBlockedError, MCP_LAUNCH_ENVELOPE_MAX_BYTES, parseMcpLaunchSnapshot, prepareMcpLaunchEnvelope, readMcpLaunchEnvelope, verifyMcpLaunchProof } from "./mcp-prepared-launch-contract.js";
import { lockMcpCompanyScope } from "./mcp-company-scope.js";
import { requireSettledMcpCompanyLeases } from "./mcp-retirement-ownership.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Row = typeof mcpPreparedLaunches.$inferSelect;
type Scope = Pick<McpPreparedLaunchSnapshot, "companyId" | "agentId" | "runId" | "issueId" | "projectId" | "controllerBootId" | "generation">;
interface Subject { companyId: string; runId: string; launchId: string; launchDigest: string }

/** A trusted controller resolver MUST rebuild current grants, enrollment and the
 * complete launch in the supplied transaction. It receives identifiers only;
 * neither request fields nor saved endpoint/key labels authenticate authority. */
export interface McpLaunchAuthorityResolver {
  /** Return null for revoked/missing authority; throw for a transient resolver
   * outage. Reads must be bounded and lock mutable grant/enrollment rows until
   * this transaction commits. This callback is never an HTTP input. */
  resolveCurrent(tx: Tx, scope: Readonly<Scope>): Promise<unknown>;
}

const blocked = () => { throw new McpLaunchBlockedError(); };
const denied = Symbol("mcp_launch_denied");
const scopeOf = (s: Scope): Scope => ({ companyId: s.companyId, agentId: s.agentId, runId: s.runId,
  issueId: s.issueId, projectId: s.projectId, controllerBootId: s.controllerBootId, generation: s.generation });

async function clock(tx: Tx): Promise<number> {
  const [row] = await tx.execute<{ now: string }>(sql`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as now`);
  const now = Number(row?.now);
  if (!Number.isSafeInteger(now) || now <= 0) return blocked();
  return now;
}

async function lockScope(tx: Tx, scope: Scope): Promise<boolean> {
  if (!await lockMcpCompanyScope(tx, scope.companyId)) return false;
  // Same task-before-run ordering as identity initialization and settlement.
  let taskMatches = true;
  if (scope.issueId) {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, scope.issueId), eq(issues.companyId, scope.companyId))).for("no key update");
    taskMatches = Boolean(issue && issue.projectId === scope.projectId && issue.assigneeAgentId === scope.agentId && issue.executionRunId === scope.runId);
  }
  const [run] = await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId),
  )).for("no key update");
  return Boolean(taskMatches && run && run.agentId === scope.agentId && run.status === "running" && run.runtimeMode === "legacy" &&
    run.controllerBootId === legacyControllerBootId && scope.controllerBootId === legacyControllerBootId &&
    run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt.getTime() > await clock(tx) &&
    !Object.hasOwn(run.resultJson ?? {}, "startupCancellation") && (run.contextSnapshot?.issueId ?? null) === scope.issueId);
}

async function open(row: Row) {
  try {
    const bytes = await getSecretProvider("local_encrypted").resolveVersion({ material: row.material, externalRef: null });
    if (Buffer.byteLength(bytes, "utf8") > MCP_LAUNCH_ENVELOPE_MAX_BYTES) blocked();
    const envelope = readMcpLaunchEnvelope(JSON.parse(bytes), row.id, row.launchDigest);
    const s = envelope.snapshot;
    if (JSON.stringify(scopeOf(s)) !== JSON.stringify(scopeOf(row)) || s.expiresAt !== row.expiresAt.getTime()) blocked();
    return s;
  } catch { return blocked(); }
}

function challengeOf(row: Row, s: McpPreparedLaunchSnapshot): McpLaunchChallenge {
  if (!row.nonce || !row.challengeExpiresAt) return blocked();
  return { version: 1, launchId: row.id, launchDigest: row.launchDigest, companyId: s.companyId, runId: s.runId,
    controllerInstanceId: s.controllerInstanceId, controllerBootId: s.controllerBootId, generation: s.generation,
    workerId: s.worker.id, keyId: s.worker.keyId, gatewayUrl: s.worker.gatewayUrl, executionHostId: s.worker.executionHostId,
    nonce: row.nonce, expiresAt: row.challengeExpiresAt.getTime() };
}

function receiptOf(row: Row, s: McpPreparedLaunchSnapshot): McpLaunchAuthorizationReceipt {
  if (!row.authorizedAt) return blocked();
  return { version: 1, launchId: row.id, launchDigest: row.launchDigest, workerId: s.worker.id, generation: s.generation,
    authorizedAt: row.authorizedAt.getTime(), expiresAt: row.expiresAt.getTime() };
}

async function audit(tx: Tx, row: Pick<Row, "companyId" | "controllerBootId" | "agentId" | "runId" | "id" | "generation">, action: string) {
  // No endpoints, prompt/config bytes, key material, nonce or credentials.
  await tx.insert(activityLog).values({ companyId: row.companyId, actorType: "system", actorId: row.controllerBootId,
    agentId: row.agentId, runId: row.runId, entityType: "mcp_prepared_launch", entityId: row.id,
    action: `mcp_launch.${action}`, details: { version: 1, generation: row.generation } });
}

/** Company UPDATE is held by the caller. Task-before-run ordering is retained;
 * sealed material is not read, decrypted, or handed to deletion orchestration. */
export async function retireMcpCompanyPreparedLaunchesInTx(tx: Tx, companyId: string,
  recordScopes: (launches: Array<Scope & { id: string }>) => Promise<void>): Promise<void> {
  const scopedIssues = tx.select({ id: mcpPreparedLaunches.issueId }).from(mcpPreparedLaunches)
    .where(eq(mcpPreparedLaunches.companyId, companyId));
  await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId),
    sql`${issues.id} in (${scopedIssues})`)).orderBy(issues.id).limit(1025).for("no key update");
  const runs = await tx.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.id} in (
      select run_id from mcp_prepared_launches where company_id = ${companyId})`))
    .orderBy(heartbeatRuns.id).limit(1025).for("no key update");
  const launches = await tx.select({ id: mcpPreparedLaunches.id, companyId: mcpPreparedLaunches.companyId,
    agentId: mcpPreparedLaunches.agentId, runId: mcpPreparedLaunches.runId, issueId: mcpPreparedLaunches.issueId,
    projectId: mcpPreparedLaunches.projectId, controllerBootId: mcpPreparedLaunches.controllerBootId,
    generation: mcpPreparedLaunches.generation }).from(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.companyId, companyId))
    .orderBy(mcpPreparedLaunches.id).limit(1025).for("update");
  const byRun = new Map(runs.map(run => [run.id, run]));
  if (launches.length > 1024 || runs.length > 1024 || launches.some(launch => {
    const run = byRun.get(launch.runId);
    return !run || run.agentId !== launch.agentId || !["succeeded", "interrupted", "failed", "cancelled", "timed_out"].includes(run.status);
  })) return blocked();
  await requireSettledMcpCompanyLeases(tx, companyId);
  // The immutable receipt must be committed BEFORE recovery references vanish.
  await recordScopes(launches);
  if (launches.length) {
    await tx.insert(activityLog).values(launches.map(row => ({ companyId, actorType: "system", actorId: row.controllerBootId,
      agentId: row.agentId, runId: row.runId, entityType: "mcp_prepared_launch", entityId: row.id,
      action: "mcp_launch.retired", details: { version: 1, generation: row.generation } })));
    await tx.delete(mcpPreparedLaunches).where(eq(mcpPreparedLaunches.companyId, companyId));
  }
}

/** Controller-only foundation. No producer route or capability enablement. */
export function mcpPreparedLaunchService(db: Db, authority: McpLaunchAuthorityResolver) {
  async function currentMatches(tx: Tx, s: McpPreparedLaunchSnapshot): Promise<boolean> {
    const raw = await authority.resolveCurrent(tx, Object.freeze(scopeOf(s)));
    try { return JSON.stringify(parseMcpLaunchSnapshot(raw)) === JSON.stringify(s); }
    catch { return false; }
  }

  async function requireLive(tx: Tx, s: McpPreparedLaunchSnapshot) {
    if (!await lockScope(tx, s)) return blocked();
    const now = await clock(tx);
    if (s.expiresAt <= now) return blocked();
    return now;
  }

  async function revoke(tx: Tx, row: Row): Promise<typeof denied> {
    const [revoked] = await tx.update(mcpPreparedLaunches).set({ state: "revoked" }).where(eq(mcpPreparedLaunches.id, row.id)).returning();
    await audit(tx, revoked, "revoked");
    // Commit revocation, then throw the redacted denial outside the transaction.
    return denied;
  }

  async function transaction<T>(work: (tx: Tx) => Promise<T | typeof denied>): Promise<T> {
    try {
      const result = await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '15s'`);
        return work(tx);
      });
      if (result === denied) return blocked();
      return result;
    } catch (error) {
      if (error instanceof McpLaunchBlockedError) throw error;
      return blocked();
    }
  }

  async function withLaunch<T>(subject: Subject, work: (tx: Tx, row: Row, s: McpPreparedLaunchSnapshot) => Promise<T>): Promise<T> {
    return transaction(async tx => {
      const where = and(eq(mcpPreparedLaunches.id, subject.launchId), eq(mcpPreparedLaunches.companyId, subject.companyId),
        eq(mcpPreparedLaunches.runId, subject.runId), eq(mcpPreparedLaunches.launchDigest, subject.launchDigest));
      const [observed] = await tx.select().from(mcpPreparedLaunches).where(where).limit(1);
      if (!observed) return blocked();
      const ownsScope = await lockScope(tx, observed);
      const [row] = await tx.select().from(mcpPreparedLaunches).where(where).for("update");
      if (!row || row.state === "revoked") return blocked();
      const snapshot = await open(row);
      if (!ownsScope) return revoke(tx, row);
      if (!await currentMatches(tx, snapshot)) return revoke(tx, row);
      await requireLive(tx, snapshot);
      const result = await work(tx, row, snapshot);
      await requireLive(tx, snapshot);
      return result;
    });
  }

  return {
    /** Explicit retirement for entity deletion, after the terminal run and all
     * provider/filesystem ownership have settled. Expiry alone never releases
     * recovery ownership or removes the immutable retry barrier. */
    retireForDeletion(subject: Subject) {
      return transaction(async tx => {
        // An UPDATE barrier also fences new company-scoped ownership inserts.
        // Acquire it before all task/run/launch/lease locks.
        if (!await lockMcpCompanyScope(tx, subject.companyId, "update")) return false;
        const where = and(eq(mcpPreparedLaunches.id, subject.launchId), eq(mcpPreparedLaunches.companyId, subject.companyId),
          eq(mcpPreparedLaunches.runId, subject.runId), eq(mcpPreparedLaunches.launchDigest, subject.launchDigest));
        const [observed] = await tx.select().from(mcpPreparedLaunches).where(where).limit(1);
        if (!observed) return false;
        await lockScope(tx, observed);
        const [row] = await tx.select().from(mcpPreparedLaunches).where(where).for("update");
        if (!row) return false;
        const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, subject.runId),
          eq(heartbeatRuns.companyId, subject.companyId), eq(heartbeatRuns.agentId, row.agentId))).for("no key update");
        if (!run || !["succeeded", "interrupted", "failed", "cancelled", "timed_out"].includes(run.status)) return blocked();
        // Include orphan teardown rows with null run pointers. Never purge the
        // only recovery reference because an associated launch expired.
        await requireSettledMcpCompanyLeases(tx, row.companyId);
        await audit(tx, row, "retired");
        await tx.delete(mcpPreparedLaunches).where(where);
        return true;
      });
    },

    async prepare(input: unknown) {
      const candidate = prepareMcpLaunchEnvelope(input);
      const s = candidate.envelope.snapshot;
      return transaction(async tx => {
        const where = and(eq(mcpPreparedLaunches.companyId, s.companyId), eq(mcpPreparedLaunches.runId, s.runId));
        const [observed] = await tx.select().from(mcpPreparedLaunches).where(where).limit(1);
        // Existing scope comes from the stored row, never the candidate labels.
        const ownsScope = await lockScope(tx, observed ?? s);
        const [existing] = await tx.select().from(mcpPreparedLaunches).where(where).for("update");
        if (existing) {
          if (existing.state === "revoked") return blocked();
          const stored = await open(existing);
          if (!ownsScope) return revoke(tx, existing);
          if (!await currentMatches(tx, stored)) return revoke(tx, existing);
          if (JSON.stringify(stored) !== JSON.stringify(s)) return blocked();
          await requireLive(tx, stored);
          return { launchId: existing.id, launchDigest: existing.launchDigest };
        }
        if (!ownsScope) return blocked();
        if (!await currentMatches(tx, s)) return blocked();
        const now = await requireLive(tx, s);
        if (s.expiresAt > now + 15 * 60_000) return blocked();
        const sealed = await getSecretProvider("local_encrypted").createSecret({ value: JSON.stringify(candidate.envelope) });
        if (s.expiresAt <= await clock(tx)) return blocked();
        const [row] = await tx.insert(mcpPreparedLaunches).values({ id: candidate.id, ...scopeOf(s),
          launchDigest: candidate.digest, material: sealed.material, expiresAt: new Date(s.expiresAt) }).returning();
        await audit(tx, row, "prepared");
        await requireLive(tx, s);
        return { launchId: row.id, launchDigest: row.launchDigest };
      });
    },

    challenge(subject: Subject) {
      return withLaunch(subject, async (tx, row, s) => {
        if (!row.nonce || (row.state === "prepared" && row.challengeExpiresAt!.getTime() <= await clock(tx))) {
          if (row.state !== "prepared") return blocked();
          const now = await clock(tx);
          const [issued] = await tx.update(mcpPreparedLaunches).set({ nonce: randomBytes(32).toString("hex"),
            challengeExpiresAt: new Date(Math.min(now + 60_000, s.expiresAt)) }).where(eq(mcpPreparedLaunches.id, row.id)).returning();
          await audit(tx, issued, row.nonce ? "challenge_renewed" : "challenge_issued");
          return challengeOf(issued, s);
        }
        return challengeOf(row, s);
      });
    },

    authorize(input: Subject & { signature: string }) {
      return withLaunch(input, async (tx, row, s) => {
        if (!verifyMcpLaunchProof(challengeOf(row, s), input.signature, s.worker.publicKey)) return blocked();
        if (row.state !== "prepared") return receiptOf(row, s);
        const [accepted] = await tx.update(mcpPreparedLaunches).set({ state: "authorized", authorizedAt: sql`clock_timestamp()` }).where(and(
          eq(mcpPreparedLaunches.id, row.id), sql`${mcpPreparedLaunches.expiresAt} > clock_timestamp()`,
          sql`${mcpPreparedLaunches.challengeExpiresAt} > clock_timestamp()`,
        )).returning();
        if (!accepted) return blocked();
        await audit(tx, accepted, "authorized");
        return receiptOf(accepted, s);
      });
    },

    claimDispatch(subject: Subject) {
      return withLaunch(subject, async (tx, row, s) => {
        if (row.state === "dispatching") return false;
        if (row.state !== "authorized") return blocked();
        const leases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, s.companyId),
          eq(environmentLeases.heartbeatRunId, s.runId), eq(environmentLeases.status, "active"))).for("update");
        let owned = false;
        for (const lease of leases) {
          if (lease.releasedAt) continue;
          const recovered = await readPendingAdapterExecutionCheckpoint(lease);
          if (recovered?.adapterType === "hermes_gateway" && validateManagedMcpExecutionCheckpoint(recovered.checkpoint, {
            runId: s.runId, gatewayUrl: s.worker.gatewayUrl, body: s.launchJson, headers: s.launchHeaders,
            launchId: row.id, launchDigest: row.launchDigest,
          })) owned = true;
        }
        if (!owned) return blocked();
        const [claimed] = await tx.update(mcpPreparedLaunches).set({ state: "dispatching", dispatchClaimedAt: sql`clock_timestamp()` })
          .where(and(eq(mcpPreparedLaunches.id, row.id), sql`${mcpPreparedLaunches.expiresAt} > clock_timestamp()`)).returning();
        if (!claimed) return blocked();
        await audit(tx, claimed, "dispatch_claimed");
        return true;
      });
    },
  };
}
