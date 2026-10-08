import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** Operator-pinned key possession, never self-asserted physical-host attestation.
 * Immutable pins and non-deletable revocation tombstones are guarded in SQL. */
export const mcpWorkerEnrollments = pgTable("mcp_worker_enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The insert trigger locks/validates a live company. SQL retirement guards
  // replace the company FK atomically so immutable key tombstones survive it.
  companyId: uuid("company_id").notNull(),
  controllerInstanceId: text("controller_instance_id").notNull(),
  workerId: text("worker_id").notNull(),
  keyId: text("key_id").notNull(),
  publicKey: text("public_key").notNull(),
  gatewayUrl: text("gateway_url").notNull(),
  executionHostId: text("execution_host_id").notNull(),
  revision: uuid("revision").notNull().defaultRandom(),
  state: text("state").$type<"pending" | "enrolled" | "revoked">().notNull().default("pending"),
  bootstrapTokenHash: text("bootstrap_token_hash").notNull(),
  nonce: text("nonce").notNull(),
  challengeExpiresAt: timestamp("challenge_expires_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("mcp_worker_enrollments_key_uq").on(t.companyId, t.workerId, t.keyId),
  uniqueIndex("mcp_worker_enrollments_live_worker_uq").on(t.companyId, t.workerId).where(sql`${t.state} <> 'revoked'`),
  index("mcp_worker_enrollments_company_idx").on(t.companyId),
  check("mcp_worker_enrollments_state_ck", sql`${t.state} in ('pending', 'enrolled', 'revoked')`),
  check("mcp_worker_enrollments_hash_ck", sql`${t.bootstrapTokenHash} ~ '^[a-f0-9]{64}$' and ${t.nonce} ~ '^[a-f0-9]{64}$'`),
  check("mcp_worker_enrollments_expiry_ck", sql`${t.challengeExpiresAt} > ${t.createdAt} and ${t.challengeExpiresAt} <= ${t.expiresAt} and
    ${t.challengeExpiresAt} <= ${t.createdAt} + interval '5 minutes' and ${t.expiresAt} <= ${t.createdAt} + interval '720 hours'`),
  check("mcp_worker_enrollments_acceptance_ck", sql`
    (${t.state} = 'pending' and ${t.enrolledAt} is null and ${t.revokedAt} is null) or
    (${t.state} = 'enrolled' and ${t.enrolledAt} is not null and ${t.revokedAt} is null) or
    (${t.state} = 'revoked' and ${t.revokedAt} is not null)`),
]);
