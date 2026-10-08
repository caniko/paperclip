import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, mcpWorkerEnrollments, type Db } from "@paperclipai/db";
import type { McpWorkerEnrollment, McpWorkerEnrollmentChallenge, McpWorkerEnrollmentPreparation } from "@paperclipai/shared";
import { isMcpAdmissionIdentifier } from "@paperclipai/adapter-utils/mcp-admission";
import { McpLaunchBlockedError } from "./mcp-prepared-launch-contract.js";
import { mcpWorkerEnrollmentProofBytes, parseMcpWorkerEnrollmentPins } from "./mcp-worker-enrollment-contract.js";
import { verifyMcpWorkerSignature } from "./mcp-worker-key.js";
import { lockMcpCompanyScope } from "./mcp-company-scope.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Row = typeof mcpWorkerEnrollments.$inferSelect;
type Operator = { actorType: "user"; actorId: string };
const blocked = () => { throw new McpLaunchBlockedError(); };
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

async function clock(tx: Tx) {
  const [row] = await tx.execute<{ now: string }>(sql`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as now`);
  const now = Number(row?.now);
  if (!Number.isSafeInteger(now) || now <= 0) return blocked();
  return now;
}

function inspect(row: Row): McpWorkerEnrollment {
  return { id: row.id, companyId: row.companyId, controllerInstanceId: row.controllerInstanceId,
    workerId: row.workerId, keyId: row.keyId, publicKey: row.publicKey, gatewayUrl: row.gatewayUrl,
    executionHostId: row.executionHostId, revision: row.revision, state: row.state,
    expiresAt: row.expiresAt.getTime(), createdAt: row.createdAt.getTime(),
    enrolledAt: row.enrolledAt?.getTime() ?? null, revokedAt: row.revokedAt?.getTime() ?? null };
}

function challenge(row: Row): McpWorkerEnrollmentChallenge {
  return { version: 1, enrollmentId: row.id, companyId: row.companyId, controllerInstanceId: row.controllerInstanceId,
    workerId: row.workerId, keyId: row.keyId, publicKey: row.publicKey, gatewayUrl: row.gatewayUrl,
    executionHostId: row.executionHostId, nonce: row.nonce, expiresAt: row.expiresAt.getTime(),
    challengeExpiresAt: row.challengeExpiresAt.getTime() };
}

async function audit(tx: Tx, row: Row, action: string, actor: { actorType: "user" | "system"; actorId: string }) {
  await tx.insert(activityLog).values({ companyId: row.companyId, ...actor,
    action: `mcp_worker.${action}`, entityType: "mcp_worker_enrollment", entityId: row.id,
    details: { version: 1, revision: row.revision } });
}

/** For the trusted authority resolver, on its existing locked transaction.
 * Launch validity MUST fit inside enrollment validity: row locks cannot stop time. */
export async function readEnrolledMcpWorker(tx: Tx, input: {
  companyId: string; enrollmentId: string; controllerInstanceId: string; launchExpiresAt: number;
}): Promise<McpWorkerEnrollment | null> {
  if (!await lockMcpCompanyScope(tx, input.companyId)) return null;
  const [row] = await tx.select().from(mcpWorkerEnrollments).where(and(eq(mcpWorkerEnrollments.id, input.enrollmentId),
    eq(mcpWorkerEnrollments.companyId, input.companyId))).for("share");
  if (!row || row.state !== "enrolled" || row.controllerInstanceId !== input.controllerInstanceId ||
      !Number.isSafeInteger(input.launchExpiresAt) || input.launchExpiresAt > row.expiresAt.getTime() ||
      input.launchExpiresAt <= await clock(tx)) return null;
  try { parseMcpWorkerEnrollmentPins({ workerId: row.workerId, keyId: row.keyId, publicKey: row.publicKey,
    gatewayUrl: row.gatewayUrl, executionHostId: row.executionHostId, expiresAt: row.expiresAt.getTime() }); }
  catch { return null; }
  return inspect(row);
}

/** Controller-only enrollment foundation. Operator routes must enforce instance
 * admin + company access before provisioning; the bootstrap authorizes proof only. */
export function mcpWorkerEnrollmentService(db: Db, policy: { controllerInstanceId: string }) {
  if (!isMcpAdmissionIdentifier(policy.controllerInstanceId)) return blocked();
  const controllerInstanceId = policy.controllerInstanceId;
  async function transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '15s'`);
        return work(tx);
      });
    } catch { return blocked(); }
  }
  function requireOperator(actor: Operator) {
    if (actor.actorType !== "user" || typeof actor.actorId !== "string" || !actor.actorId.trim() || actor.actorId.length > 256) blocked();
  }
  return {
    /** Header authentication grants permission to receive a bounded proof only.
     * The mutation rechecks this credential and current authority under its lock. */
    async authenticateBootstrap(input: { enrollmentId: string; bearerToken: string }) {
      if (!/^pcmwe_[A-Za-z0-9_-]{43}$/.test(input.bearerToken)) return blocked();
      return transaction(async tx => {
        const [row] = await tx.select().from(mcpWorkerEnrollments).where(and(eq(mcpWorkerEnrollments.id, input.enrollmentId),
          eq(mcpWorkerEnrollments.bootstrapTokenHash, hash(input.bearerToken)))).limit(1);
        if (!row || row.controllerInstanceId !== controllerInstanceId || row.state === "revoked" ||
            row.challengeExpiresAt.getTime() <= await clock(tx)) return blocked();
      });
    },
    async prepare(companyId: string, input: unknown, actor: Operator): Promise<McpWorkerEnrollmentPreparation> {
      requireOperator(actor);
      const pins = parseMcpWorkerEnrollmentPins(input);
      return transaction(async tx => {
        if (!await lockMcpCompanyScope(tx, companyId)) return blocked();
        const now = await clock(tx);
        if (pins.expiresAt <= now || pins.expiresAt > now + 30 * 24 * 60 * 60_000) return blocked();
        const bearerToken = `pcmwe_${randomBytes(32).toString("base64url")}`;
        const [row] = await tx.insert(mcpWorkerEnrollments).values({ companyId, controllerInstanceId,
          ...pins, expiresAt: new Date(pins.expiresAt), createdAt: new Date(now),
          bootstrapTokenHash: hash(bearerToken), nonce: randomBytes(32).toString("hex"),
          challengeExpiresAt: new Date(Math.min(now + 5 * 60_000, pins.expiresAt)) }).returning();
        await audit(tx, row, "enrollment_prepared", actor);
        if (row.challengeExpiresAt.getTime() <= await clock(tx)) return blocked();
        return { enrollment: inspect(row), challenge: challenge(row), bearerToken };
      });
    },
    async prove(input: { enrollmentId: string; bearerToken: string; signature: string }) {
      if (!/^pcmwe_[A-Za-z0-9_-]{43}$/.test(input.bearerToken) || typeof input.signature !== "string" || input.signature.length !== 86) return blocked();
      return transaction(async tx => {
        // An unlocked identifier lookup discovers scope only. Authenticate again
        // after the parent barrier and the enrollment lock, never from this read.
        const [observed] = await tx.select({ companyId: mcpWorkerEnrollments.companyId }).from(mcpWorkerEnrollments)
          .where(eq(mcpWorkerEnrollments.id, input.enrollmentId)).limit(1);
        if (!observed || !await lockMcpCompanyScope(tx, observed.companyId)) return blocked();
        const [row] = await tx.select().from(mcpWorkerEnrollments).where(and(eq(mcpWorkerEnrollments.id, input.enrollmentId),
          eq(mcpWorkerEnrollments.companyId, observed.companyId), eq(mcpWorkerEnrollments.bootstrapTokenHash, hash(input.bearerToken)))).for("update");
        if (!row || row.controllerInstanceId !== controllerInstanceId || row.state === "revoked" ||
            row.challengeExpiresAt.getTime() <= await clock(tx) ||
            !verifyMcpWorkerSignature(mcpWorkerEnrollmentProofBytes(challenge(row)), input.signature, row.publicKey)) return blocked();
        if (row.state === "enrolled") {
          if (row.challengeExpiresAt.getTime() <= await clock(tx)) return blocked();
          return inspect(row);
        }
        const [enrolled] = await tx.update(mcpWorkerEnrollments).set({ state: "enrolled", revision: randomUUID(), enrolledAt: sql`clock_timestamp()` })
          .where(and(eq(mcpWorkerEnrollments.id, row.id), sql`${mcpWorkerEnrollments.challengeExpiresAt} > clock_timestamp()`)).returning();
        if (!enrolled) return blocked();
        await audit(tx, enrolled, "enrolled", { actorType: "system", actorId: row.workerId });
        if (row.challengeExpiresAt.getTime() <= await clock(tx)) return blocked();
        return inspect(enrolled);
      });
    },
    inspect(companyId: string, enrollmentId: string) {
      return transaction(async tx => {
        const [row] = await tx.select().from(mcpWorkerEnrollments).where(and(eq(mcpWorkerEnrollments.companyId, companyId),
          eq(mcpWorkerEnrollments.id, enrollmentId))).limit(1);
        return row ? inspect(row) : null;
      });
    },
    async revoke(companyId: string, enrollmentId: string, actor: Operator) {
      requireOperator(actor);
      return transaction(async tx => {
        if (!await lockMcpCompanyScope(tx, companyId)) return blocked();
        const [row] = await tx.select().from(mcpWorkerEnrollments).where(and(eq(mcpWorkerEnrollments.companyId, companyId),
          eq(mcpWorkerEnrollments.id, enrollmentId))).for("update");
        if (!row || row.controllerInstanceId !== controllerInstanceId) return blocked();
        if (row.state === "revoked") return inspect(row);
        const [revoked] = await tx.update(mcpWorkerEnrollments).set({ state: "revoked", revision: randomUUID(), revokedAt: sql`clock_timestamp()` })
          .where(eq(mcpWorkerEnrollments.id, row.id)).returning();
        await audit(tx, revoked, "revoked", actor);
        return inspect(revoked);
      });
    },
  };
}
