import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";

/** Company deletion takes UPDATE; MCP writers take KEY SHARE before any child
 * lock. Reread after waiting, so a deleted scope never authenticates a tombstone.
 * This barrier authenticates company existence only, not actor permissions. */
export async function lockMcpCompanyScope(db: Pick<Db, "select">, companyId: string, mode: "key share" | "update" = "key share") {
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for(mode);
  return Boolean(company);
}
