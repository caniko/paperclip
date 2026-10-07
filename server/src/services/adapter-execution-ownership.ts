import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, workspaceOperations, type Db } from "@paperclipai/db";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";

interface OwnershipIdentity {
  companyId: string;
  runId: string;
  leaseId: string;
}

const KEY = "adapterExecution";
const WORKSPACE_KEY = "workspaceOwnership";
const KEYS = [KEY, WORKSPACE_KEY] as const;
const SCHEMA = "paperclip.adapter-execution.v1";

/** Host-owned sealing/binding validation shared by dispatch and recovery. A
 * malformed or unavailable checkpoint retains ownership and is never authority. */
export async function readPendingAdapterExecutionCheckpoint(
  lease: typeof environmentLeases.$inferSelect,
  key: typeof KEYS[number] = KEY,
): Promise<{ adapterType: string; checkpoint: Record<string, unknown> } | null> {
  if (!lease.metadata || !(key in lease.metadata) || record(lease.metadata[key]).state === "settled") return null;
  try {
    const ownership = record(lease.metadata[key]);
    if (ownership.version !== 1 || ownership.state !== "pending" || typeof ownership.adapterType !== "string") throw new Error();
    const plaintext = await getSecretProvider("local_encrypted").resolveVersion({ material: record(ownership.material), externalRef: null });
    const envelope = record(JSON.parse(plaintext));
    if (envelope.schema !== (key === KEY ? SCHEMA : `${SCHEMA}.workspace`) || envelope.companyId !== lease.companyId ||
        envelope.runId !== lease.heartbeatRunId || envelope.leaseId !== lease.id || envelope.adapterType !== ownership.adapterType ||
        !envelope.checkpoint || typeof envelope.checkpoint !== "object" || Array.isArray(envelope.checkpoint)) throw new Error();
    return { adapterType: ownership.adapterType, checkpoint: envelope.checkpoint as Record<string, unknown> };
  } catch { throw new Error("Adapter recovery checkpoint is unavailable."); }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function hasPendingAdapterExecution(metadata: unknown): boolean {
  const value = record(metadata);
  return KEYS.some((key) => key in value && record(value[key]).state !== "settled");
}

export function publicAdapterExecutionMetadata(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) return metadata;
  const result = { ...metadata };
  for (const key of KEYS) {
    if (!(key in result)) continue;
    const { version, adapterType, state } = record(result[key]);
    result[key] = { version, adapterType, state };
  }
  return result;
}

/** Ordinary lease writes cannot create, replace or drop the admission checkpoint. */
export function preserveAdapterExecutionMetadata(metadata: Record<string, unknown> | null) {
  const publicMetadata = metadata ? { ...metadata } : null;
  if (publicMetadata) for (const key of KEYS) delete publicMetadata[key];
  const encoded = publicMetadata === null ? null : JSON.stringify(publicMetadata);
  return sql`case when coalesce(${environmentLeases.metadata}, '{}'::jsonb) ?| array['adapterExecution', 'workspaceOwnership']
    then coalesce(${encoded}::jsonb, '{}'::jsonb) ||
      case when ${environmentLeases.metadata} ? 'adapterExecution'
        then jsonb_build_object('adapterExecution', ${environmentLeases.metadata}->'adapterExecution')
        else '{}'::jsonb end ||
      case when ${environmentLeases.metadata} ? 'workspaceOwnership'
        then jsonb_build_object('workspaceOwnership', ${environmentLeases.metadata}->'workspaceOwnership')
        else '{}'::jsonb end
    else ${encoded}::jsonb end`;
}

export function leaseAdapterExecutionNotHeldCondition() {
  return sql`(not (coalesce(${environmentLeases.metadata}, '{}'::jsonb) ? 'adapterExecution')
    or ${environmentLeases.metadata}->'adapterExecution'->>'state' = 'settled') and
    (not (coalesce(${environmentLeases.metadata}, '{}'::jsonb) ? 'workspaceOwnership')
    or ${environmentLeases.metadata}->'workspaceOwnership'->>'state' = 'settled')`;
}

/** Call inside the terminal writer's transaction, BEFORE its conditional update.
 * A subquery in an UPDATE alone keeps a pre-lock statement snapshot and can miss
 * an admission that commits while it waits for this row. The next statement must
 * see the checkpoint committed by prepareAdapterExecution under the same lock.
 * Settlement changes no parent key. NO KEY UPDATE still fences admission and
 * terminal writers, while permitting audit inserts' foreign-key KEY SHARE. */
export async function lockRunForAdapterSettlement(db: Pick<Db, "select">, runId: string): Promise<void> {
  await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId)).for("no key update");
}

/** Serialize protected finalization writes with recovery and remote release.
 * Retain the originally claimed generation rather than refreshing it from a
 * run row after another controller has taken cleanup authority. */
export async function withProtectedWorkspaceFinalizationWrite<T>(db: Db, input: OwnershipIdentity & {
  controllerBootId: string | null;
}, write: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await lockRunForAdapterSettlement(tx, input.runId);
    const [run] = input.controllerBootId ? await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
      eq(heartbeatRuns.controllerBootId, input.controllerBootId),
      sql`${heartbeatRuns.controllerLeaseExpiresAt} > clock_timestamp()`,
    )) : [];
    if (!run) throw new Error("Protected workspace finalization no longer owns the run.");
    const [lease] = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, input.leaseId), eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.heartbeatRunId, input.runId), eq(environmentLeases.status, "active"),
    )).for("update");
    const ownership = record(lease?.metadata?.[WORKSPACE_KEY]);
    if (!lease || lease.releasedAt || ownership.state !== "pending" || !ownership.material || "finalization" in ownership) {
      throw new Error("Protected workspace finalization no longer owns the workspace.");
    }
    return write(tx);
  });
}

export function adapterExecutionOwnershipNotHeldCondition() {
  return sql`not exists (select 1 from ${environmentLeases}
    where ${environmentLeases.heartbeatRunId} = ${heartbeatRuns.id}
      and ${environmentLeases.companyId} = ${heartbeatRuns.companyId}
      and ((${environmentLeases.metadata} ? 'adapterExecution'
      and coalesce(${environmentLeases.metadata}->'adapterExecution'->>'state', '') <> 'settled')
      or (${environmentLeases.metadata} ? 'workspaceOwnership'
      and coalesce(${environmentLeases.metadata}->'workspaceOwnership'->>'state', '') <> 'settled')))`;
}

/** Private recovery state extends the run's existing lease, not its public log.
 * Bind the encrypted envelope to the company/run/lease to reject copied material. */
async function prepareCheckpoint(db: Db, input: OwnershipIdentity & {
  adapterType: string;
  checkpoint: Record<string, unknown>;
}, key: typeof KEYS[number]): Promise<void> {
  const { checkpoint, ...identity } = input;
  const prepared = await getSecretProvider("local_encrypted").createSecret({
    value: JSON.stringify({ schema: key === KEY ? SCHEMA : `${SCHEMA}.workspace`, ...identity, checkpoint }),
  });
  await db.transaction(async (tx) => {
    const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
      eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
      sql`${heartbeatRuns.controllerLeaseExpiresAt} > clock_timestamp()`,
      sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ? 'startupCancellation')`,
    )).for("update");
    if (!run) throw new Error("Adapter admission no longer owns the controller lease");
    const [lease] = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, input.leaseId), eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.heartbeatRunId, input.runId), eq(environmentLeases.status, "active"),
    )).for("update");
    if (!lease) throw new Error("Adapter admission no longer owns the environment lease");
    const previous = record(lease.metadata?.[key]);
    if (lease.metadata && key in lease.metadata) {
      if (previous.state === "pending" && previous.fingerprint === prepared.valueSha256) return;
      throw new Error("Adapter admission cannot replace an existing execution checkpoint");
    }
    await tx.update(environmentLeases).set({ metadata: {
      ...lease.metadata, [key]: { version: 1, adapterType: input.adapterType, state: "pending",
        fingerprint: prepared.valueSha256, material: prepared.material },
    }, updatedAt: new Date() }).where(eq(environmentLeases.id, lease.id));
  });
}

export function prepareAdapterExecution(db: Db, input: OwnershipIdentity & { adapterType: string; checkpoint: Record<string, unknown> }) {
  return prepareCheckpoint(db, input, KEY);
}

export function prepareWorkspaceOwnershipCheckpoint(db: Db, input: OwnershipIdentity & { adapterType: string; checkpoint: Record<string, unknown> }) {
  return prepareCheckpoint(db, input, WORKSPACE_KEY);
}

export async function recordWorkspaceOwnershipGrant(db: Db, input: OwnershipIdentity & { grant: Record<string, unknown> }): Promise<void> {
  await db.transaction(async (tx) => {
    await lockRunForAdapterSettlement(tx, input.runId);
    const [lease] = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, input.leaseId), eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.heartbeatRunId, input.runId), eq(environmentLeases.status, "active"),
    )).for("update");
    const ownership = record(lease?.metadata?.[WORKSPACE_KEY]);
    if (ownership.state !== "pending") throw new Error("Workspace grant has no pending durable intent");
    if (ownership.grant && !isDeepStrictEqual(ownership.grant, input.grant)) throw new Error("Workspace grant is immutable");
    await tx.update(environmentLeases).set({ metadata: { ...lease.metadata,
      [WORKSPACE_KEY]: { ...ownership, grant: input.grant } }, updatedAt: new Date(),
    }).where(eq(environmentLeases.id, input.leaseId));
  });
}

export async function settleAdapterExecution(db: Db, input: OwnershipIdentity): Promise<void> {
  await db.update(environmentLeases).set({
    metadata: sql`jsonb_set(${environmentLeases.metadata}, '{adapterExecution}',
      ((${environmentLeases.metadata}->'adapterExecution') - 'material') || '{"state":"settled"}'::jsonb)`,
    updatedAt: new Date(),
  }).where(and(eq(environmentLeases.id, input.leaseId), eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.heartbeatRunId, input.runId), sql`${environmentLeases.metadata} ? 'adapterExecution'`));
}

/** Recovery takes finalization authority before any teardown or terminal write.
 * Cancellation may retain the controller generation while remote stop is pending;
 * the durable pending boundary fences its old live recorder across every await. */
async function beginWorkspaceFinalizationBoundary(db: Db, input: OwnershipIdentity): Promise<void> {
  await db.transaction(async (tx) => {
    await lockRunForAdapterSettlement(tx, input.runId);
    const [lease] = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, input.leaseId), eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.heartbeatRunId, input.runId), eq(environmentLeases.status, "active"),
    )).for("update");
    const ownership = record(lease?.metadata?.[WORKSPACE_KEY]);
    if (!lease || lease.releasedAt || ownership.state !== "pending" || !ownership.material
      || (lease.metadata && KEY in lease.metadata && record(lease.metadata[KEY]).state !== "settled")) {
      throw new Error("Workspace finalization no longer owns a stopped execution");
    }
    if ("finalization" in ownership) return;
    await tx.update(environmentLeases).set({ metadata: {
      ...lease.metadata, [WORKSPACE_KEY]: { ...ownership, finalization: { state: "pending" } },
    }, updatedAt: new Date() }).where(eq(environmentLeases.id, input.leaseId));
  });
}

async function recordWorkspaceFinalizationBoundary(db: Db, input: OwnershipIdentity): Promise<void> {
  await db.transaction(async (tx) => {
    await lockRunForAdapterSettlement(tx, input.runId);
    const [lease] = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, input.leaseId), eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.heartbeatRunId, input.runId), eq(environmentLeases.status, "active"),
    )).for("update");
    const ownership = record(lease?.metadata?.[WORKSPACE_KEY]);
    if (ownership.state !== "pending"
      || (lease?.metadata && KEY in lease.metadata && record(lease.metadata[KEY]).state !== "settled")) {
      throw new Error("Workspace finalization no longer owns a stopped execution");
    }
    if (record(ownership.finalization).operationId) return;
    const [finalized] = await tx.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.heartbeatRunId, input.runId),
      eq(workspaceOperations.phase, "workspace_finalize"), inArray(workspaceOperations.status, ["succeeded", "failed"]),
      isNotNull(workspaceOperations.finishedAt),
    )).limit(1);
    if (!finalized) throw new Error("Workspace finalization has no durable terminal operation");
    await tx.update(environmentLeases).set({ metadata: {
      ...lease.metadata, [WORKSPACE_KEY]: { ...ownership,
        finalization: { operationId: finalized.id, completedAt: new Date().toISOString() } },
    }, updatedAt: new Date() }).where(eq(environmentLeases.id, input.leaseId));
  });
}

/** Run one bounded recovery attempt. Missing adapters, invalid ciphertext, and
 * unavailable workers retain the run and every associated lease. */
export async function reconcileAdapterExecution(db: Db, input: {
  companyId: string;
  runId: string;
  /** Runs only after provider settlement. Must finalize the protected in-place
   * workspace and complete controller teardown; errors retain the authority grant. */
  finalizeWorkspace?: (checkpoint: Record<string, unknown>) => Promise<void>;
}): Promise<"unmanaged" | "pending" | "settled"> {
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, input.runId),
    sql`(${environmentLeases.metadata} ? 'adapterExecution' or ${environmentLeases.metadata} ? 'workspaceOwnership')`,
  ));
  for (const lease of leases) {
    for (const key of KEYS) {
    if (!lease.metadata || !(key in lease.metadata) || record(lease.metadata[key]).state === "settled") continue;
    try {
       const ownership = record(lease.metadata[key]);
       const recovered = await readPendingAdapterExecutionCheckpoint(lease, key);
       if (!recovered || lease.companyId !== input.companyId || lease.heartbeatRunId !== input.runId) return "pending";
      const { findServerAdapter } = await import("../adapters/registry.js");
       const adapter = findServerAdapter(recovered.adapterType);
      if (key === WORKSPACE_KEY && !record(ownership.finalization).operationId) {
        // Observing a stopped provider cannot release a filesystem grant. A
        // recovered controller must cross the same durable workspace/teardown
        // boundary as the live executor, and persist it before remote release.
        if (!input.finalizeWorkspace) return "pending";
        await beginWorkspaceFinalizationBoundary(db, { companyId: input.companyId, runId: input.runId, leaseId: lease.id });
         await input.finalizeWorkspace(recovered.checkpoint);
        await recordWorkspaceFinalizationBoundary(db, { companyId: input.companyId, runId: input.runId, leaseId: lease.id });
      }
      const reconcile = key === KEY ? adapter?.reconcileExecution : adapter?.reconcileWorkspaceOwnership;
       if (await reconcile?.(recovered.checkpoint) !== "settled") return "pending";
      if (key === KEY) await settleAdapterExecution(db, { ...input, leaseId: lease.id });
      else await db.update(environmentLeases).set({
        metadata: sql`jsonb_set(${environmentLeases.metadata}, '{workspaceOwnership}',
          ((${environmentLeases.metadata}->'workspaceOwnership') - 'material') || '{"state":"settled"}'::jsonb)`,
        updatedAt: new Date(),
      }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, input.companyId),
        eq(environmentLeases.heartbeatRunId, input.runId)));
    } catch {
      // Errors can contain provider credentials or checkpoint material. The run's
      // nonterminal state is the public recovery signal; never log the payload.
      return "pending";
    }
    }
  }
  return leases.length ? "settled" : "unmanaged";
}
