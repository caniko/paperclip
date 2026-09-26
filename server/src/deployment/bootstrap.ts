import { and, eq } from "drizzle-orm";
import { authUsers, instanceUserRoles, type Db } from "@paperclipai/db";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import { claimFirstInstanceAdmin } from "../first-admin-claim.js";
import type { Config } from "../config.js";
import { readCredential, type DeploymentDescriptor } from "./runtime.js";

/** Only called before the HTTP listener exists, under the deployment transaction. */
export async function bootstrapOperator(db: Db, config: Config, input: DeploymentDescriptor["bootstrap"], apply: boolean) {
  if (!input) return null;
  const [existing] = await db.select().from(authUsers).where(eq(authUsers.email, input.email));
  const admins = await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.role, "instance_admin"));
  if (existing) {
    if (!admins.some((a) => a.userId === existing.id)) throw new Error("Bootstrap refuses to adopt an existing non-administrator account");
    return existing.id;
  }
  if (admins.length) throw new Error("Bootstrap refuses to replace an existing administrator");
  const password = readCredential(input.passwordFile).trimEnd();
  if (password.length < 12) throw new Error("Bootstrap password must contain at least 12 characters");
  if (!apply) return null;
  const auth = createBetterAuthInstance(db, { ...config, authDisableSignUp: false }, []);
  const base = config.authPublicBaseUrl ?? "http://localhost:3100";
  const response = await auth.handler(new Request(new URL("/api/auth/sign-up/email", base), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: input.email, name: input.name, password }),
  }));
  if (!response.ok) throw new Error("Local operator bootstrap failed");
  const [created] = await db.select().from(authUsers).where(eq(authUsers.email, input.email));
  if (!created) throw new Error("Local operator bootstrap did not create an account");
  const claim = await claimFirstInstanceAdmin(db, { userId: created.id });
  if (claim.status !== "claimed") throw new Error("Administrator changed during bootstrap");
  return created.id;
}
