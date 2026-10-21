import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/** Reset tombstones fence a first-turn admission still preparing on an old controller. */
export const adapterSessionAffinities = pgTable("adapter_session_affinities", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  adapterType: text("adapter_type").notNull(),
  scopeKey: text("scope_key").notNull(),
  taskKey: text("task_key"),
  endpoint: text("endpoint"),
  generation: integer("generation").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  scopeUnique: uniqueIndex("adapter_session_affinities_scope_uniq").on(table.companyId, table.agentId, table.adapterType, table.scopeKey),
  agentIndex: index("adapter_session_affinities_agent_idx").on(table.companyId, table.agentId),
}));
