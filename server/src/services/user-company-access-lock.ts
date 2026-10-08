import { and, eq, sql } from "drizzle-orm";
import { companies, companyMemberships, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";

type AccessTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** All user membership writers acquire this fence before company/child locks.
 * READ COMMITTED is required even in nested transactions: a snapshot acquired
 * before waiting could hide the preceding writer from exact-set discovery. */
export async function lockUserCompanyAccess(tx: AccessTransaction, userId: string) {
  const [isolation] = await tx.execute<{ isolation: string }>(sql`select current_setting('transaction_isolation') as isolation`);
  if (isolation?.isolation !== "read committed") {
    throw conflict("Company access requires READ COMMITTED isolation");
  }
  await tx.execute(sql`set local lock_timeout = '5s'`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'paperclip.user-company-access:' + userId}, 0))`);
}

/** Company deletion takes UPDATE before its children. Access mutations retain
 * the parent first, including archived companies that are settling access. */
export async function lockCompanyAccessScope(tx: AccessTransaction, companyId: string) {
  await tx.execute(sql`set local lock_timeout = '5s'`);
  const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("key share");
  return Boolean(company);
}

/** Startup may fill missing local-board membership, never replace a decision. */
export async function ensureLocalBoardCompanyMembership(db: Db, companyId: string, userId: string) {
  return db.transaction(async tx => {
    await lockUserCompanyAccess(tx, userId);
    if (!(await lockCompanyAccessScope(tx, companyId))) return;
    const [existing] = await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
    )).for("update");
    if (existing) return;
    await tx.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
  }, { isolationLevel: "read committed" });
}
