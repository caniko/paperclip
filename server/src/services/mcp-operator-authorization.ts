import { and, eq } from "drizzle-orm";
import { companyMemberships, instanceUserRoles, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { instanceSettingsService } from "./instance-settings.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Authentication-owned identity only; never a request-body grant or admin flag. */
export interface McpOperatorActor {
  actorType: string;
  actorId: string;
  actorSource?: string;
  /** Set only by trusted-header authentication; never inferred from DB roles. */
  cloudStackRole?: "owner" | "admin" | "member" | "support";
}

/** Call after the company barrier and before child locks. Lock both mutable
 * authorization rows through commit, so stale middleware claims cannot retire
 * keys or grant operator access after membership/role revocation. */
export async function assertMcpOperatorInTx(tx: Tx, companyId: string, actor?: McpOperatorActor): Promise<void> {
  if (!actor || actor.actorType !== "user" || !actor.actorId.trim() || actor.actorId.length > 256) {
    throw forbidden("MCP administration requires instance-admin and company access.");
  }
  if (actor.actorSource === "local_implicit" && actor.actorId === "local-board") return;
  let elevated = false;
  if (actor.actorSource === "cloud_tenant") {
    // Match canonical Cloud authorization: stale instance_user_roles elevate
    // nobody. Owner identity comes from authenticated headers; the mutable flag
    // is resolved through the same managed overlay and locked until commit.
    if (actor.cloudStackRole === "owner") {
      elevated = (await instanceSettingsService(tx).getExperimental({ lock: "share" })).enableOwnerInstanceAdmin === true;
    }
  } else if (actor.actorSource === "session" || actor.actorSource === "board_key") {
    const [role] = await tx.select({ id: instanceUserRoles.id }).from(instanceUserRoles).where(and(
      eq(instanceUserRoles.userId, actor.actorId), eq(instanceUserRoles.role, "instance_admin"),
    )).for("share");
    elevated = Boolean(role);
  }
  const [membership] = await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
    eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.principalId, actor.actorId), eq(companyMemberships.status, "active"),
  )).for("share");
  if (!elevated || !membership) throw forbidden("MCP administration requires instance-admin and company access.");
}
