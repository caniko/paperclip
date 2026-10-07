import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

/** Private controller ledger. Payload, credentials and enrollment keys are sealed. */
export const mcpPreparedLaunches = pgTable("mcp_prepared_launches", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  agentId: uuid("agent_id").notNull(),
  runId: uuid("run_id").notNull(),
  issueId: uuid("issue_id"),
  projectId: uuid("project_id"),
  controllerBootId: uuid("controller_boot_id").notNull(),
  generation: integer("generation").notNull(),
  launchDigest: text("launch_digest").notNull(),
  material: jsonb("material").$type<Record<string, unknown>>().notNull(),
  state: text("state").$type<"prepared" | "authorized" | "dispatching" | "revoked">().notNull().default("prepared"),
  nonce: text("nonce"),
  challengeExpiresAt: timestamp("challenge_expires_at", { withTimezone: true }),
  authorizedAt: timestamp("authorized_at", { withTimezone: true }),
  dispatchClaimedAt: timestamp("dispatch_claimed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  // A retry/restart cannot manufacture a successor for the same run.
  uniqueIndex("mcp_prepared_launches_run_uq").on(t.runId),
  index("mcp_prepared_launches_company_expiry_idx").on(t.companyId, t.expiresAt),
  foreignKey({ columns: [t.companyId, t.agentId, t.runId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.agentId, heartbeatRuns.id], name: "mcp_prepared_launches_run_owner_fk" }),
  foreignKey({ columns: [t.companyId, t.issueId], foreignColumns: [issues.companyId, issues.id], name: "mcp_prepared_launches_issue_owner_fk" }),
  foreignKey({ columns: [t.companyId, t.projectId], foreignColumns: [projects.companyId, projects.id], name: "mcp_prepared_launches_project_owner_fk" }),
  check("mcp_prepared_launches_generation_ck", sql`${t.generation} > 0`),
  check("mcp_prepared_launches_digest_ck", sql`${t.launchDigest} ~ '^[a-f0-9]{64}$'`),
  check("mcp_prepared_launches_state_ck", sql`${t.state} in ('prepared', 'authorized', 'dispatching', 'revoked')`),
  check("mcp_prepared_launches_challenge_ck", sql`(${t.nonce} is null and ${t.challengeExpiresAt} is null) or (${t.nonce} is not null and ${t.nonce} ~ '^[a-f0-9]{64}$' and ${t.challengeExpiresAt} is not null)`),
  check("mcp_prepared_launches_acceptance_ck", sql`${t.state} = 'revoked' or
    (${t.state} = 'prepared' and ${t.authorizedAt} is null and ${t.dispatchClaimedAt} is null) or
    (${t.state} = 'authorized' and ${t.nonce} is not null and ${t.authorizedAt} is not null and ${t.dispatchClaimedAt} is null) or
    (${t.state} = 'dispatching' and ${t.nonce} is not null and ${t.authorizedAt} is not null and ${t.dispatchClaimedAt} is not null)`),
]);
