import { eq, inArray, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as database from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

const databaseExports: unknown[] = Object.values(database);
const companyTables = databaseExports
  .filter((value): value is PgTable => is(value, PgTable))
  .filter(table => getTableConfig(table).columns.some(column => column.name === "company_id"));
const protectedTables = companyTables.filter(table => getTableConfig(table).name.startsWith("mcp_"));

// Delete children first, including CASCADE children whose other FKs restrict
// deletion. SET NULL edges do not constrain deletion order. Self references are
// handled by deleting all selected rows in one statement.
function deletionOrder() {
  const pending = new Set(companyTables.filter(table => !protectedTables.includes(table)));
  const ordered: PgTable[] = [];
  while (pending.size) {
    const leaves = [...pending].filter(parent => ![...pending].some(child => child !== parent &&
      getTableConfig(child).foreignKeys.some(key => key.reference().foreignTable === parent && key.onDelete !== "set null")));
    if (!leaves.length) throw new Error("Company fixture schema has an unresolved deletion cycle");
    for (const table of leaves) {
      pending.delete(table);
      ordered.push(table);
    }
  }
  return ordered;
}
const orderedTables = deletionOrder();

/** Reset only caller-owned disposable fixtures, after background work settles. */
export async function resetCompanyFixtures(db: Db, companyIds?: string[]): Promise<void> {
  if (companyIds?.length === 0) return;
  await db.transaction(async tx => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '15s'`);
    const rows = await tx.select({ id: database.companies.id }).from(database.companies)
      .where(companyIds ? inArray(database.companies.id, companyIds) : undefined)
      .orderBy(database.companies.id).for("update");
    const ids = rows.map(row => row.id);
    if (!ids.length) return;
    // Never mutate permanent receipts, keys, or launch recovery. Tests exercising
    // these ledgers must own a fresh disposable database instead of resetting it.
    for (const table of protectedTables) {
      const column = getTableConfig(table).columns.find(column => column.name === "company_id")!;
      const protectedRows = await tx.select({ companyId: column }).from(table).where(inArray(column, ids)).limit(1);
      if (protectedRows.length) throw new Error("Protected MCP fixtures require a fresh disposable database");
    }
    // This child lacks company_id and also restricts issue deletion. Its own
    // company-scoped decision determines which fixture owns it.
    await tx.delete(database.decisionEffectExecutions).where(inArray(database.decisionEffectExecutions.decisionId,
      tx.select({ id: database.decisions.id }).from(database.decisions).where(inArray(database.decisions.companyId, ids))));
    for (const table of orderedTables) {
      const column = getTableConfig(table).columns.find(column => column.name === "company_id")!;
      await tx.delete(table).where(inArray(column, ids));
    }
    for (const id of ids) await tx.delete(database.companies).where(eq(database.companies.id, id));
  }, { isolationLevel: "read committed" });
}
