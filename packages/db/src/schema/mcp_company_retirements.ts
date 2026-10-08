import { sql } from "drizzle-orm";
import { check, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Permanent, content-free deletion provenance. No entity/user FK may erase the
 * company UUID barrier or its exact enrollment/launch transition receipts. */
export const mcpCompanyRetirements = pgTable("mcp_company_retirements", {
  companyId: uuid("company_id").primaryKey(),
  controllerInstanceId: text("controller_instance_id").notNull(),
  actorId: text("actor_id").notNull(),
  revision: uuid("revision").notNull().defaultRandom(),
  retiredAt: timestamp("retired_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  enrollmentCount: integer("enrollment_count").notNull(),
  launchCount: integer("launch_count").notNull(),
}, t => [
  check("mcp_company_retirements_identity_ck", sql`length(trim(${t.actorId})) between 1 and 256 and length(${t.controllerInstanceId}) between 1 and 128`),
  check("mcp_company_retirements_counts_ck", sql`${t.enrollmentCount} between 0 and 1024 and ${t.launchCount} between 0 and 1024 and ${t.enrollmentCount} + ${t.launchCount} > 0`),
]);

export const mcpCompanyRetiredEnrollments = pgTable("mcp_company_retired_enrollments", {
  companyId: uuid("company_id").notNull().references(() => mcpCompanyRetirements.companyId),
  enrollmentId: uuid("enrollment_id").notNull(),
  revision: uuid("revision").notNull(),
}, t => [primaryKey({ columns: [t.companyId, t.enrollmentId] })]);

export const mcpCompanyRetiredLaunches = pgTable("mcp_company_retired_launches", {
  companyId: uuid("company_id").notNull().references(() => mcpCompanyRetirements.companyId),
  launchId: uuid("launch_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  runId: uuid("run_id").notNull(),
  issueId: uuid("issue_id"),
  projectId: uuid("project_id"),
  controllerBootId: uuid("controller_boot_id").notNull(),
  generation: integer("generation").notNull(),
}, t => [
  primaryKey({ columns: [t.companyId, t.launchId] }),
  check("mcp_company_retired_launches_generation_ck", sql`${t.generation} > 0`),
]);
