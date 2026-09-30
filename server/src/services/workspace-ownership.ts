import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { Environment, FilesystemOwnershipPolicy } from "@paperclipai/shared";
import type { ServerAdapterModule, WorkspaceOwnershipContext, WorkspaceOwnershipIntent } from "@paperclipai/adapter-utils";
import { parseObject } from "../adapters/utils.js";
import { parseEnvironmentDriverConfig } from "./environment-config.js";
import { resolveEnvironmentExecutionTarget } from "./environment-execution-target.js";
import type { EnvironmentAcquisitionResult } from "./environment-run-orchestrator.js";
import { prepareWorkspaceOwnershipCheckpoint, recordWorkspaceOwnershipGrant } from "./adapter-execution-ownership.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";

export const filesystemOwnershipStateColumn = sql<string | null>`${heartbeatRuns.contextSnapshot} #>> '{filesystemOwnership,state}'`.as("filesystemOwnershipState");

export function readFilesystemOwnershipState(value: unknown): "waiting" | "acquired" | null {
  return value === "waiting" || value === "acquired" ? value : null;
}

export function filesystemOwnershipPolicy(environment: Environment | null): FilesystemOwnershipPolicy | null {
  if (!environment || !("filesystemOwnership" in environment.config)) return null;
  const parsed = parseEnvironmentDriverConfig(environment);
  if (parsed.driver !== "local" && parsed.driver !== "ssh") {
    throw new Error("Filesystem ownership requires a local or SSH in-place environment.");
  }
  return parsed.config.filesystemOwnership ?? null;
}

/** The fixed-target adapter owns every target-side writer. Controller-side
 * provisioners/services cannot join that target supervisor's lifetime yet. */
export function assertOwnedWorkspacePreparation(config: Record<string, unknown>, adapter: ServerAdapterModule): void {
  if (!adapter.prepareWorkspaceOwnership || !adapter.reconcileWorkspaceOwnership || adapter.supportsInstructionsBundle) {
    throw new Error("The selected adapter cannot supervise filesystem ownership and workspace preparation.");
  }
  const strategy = parseObject(config.workspaceStrategy);
  const commands = [config, strategy].flatMap((value) =>
    [value.provisionCommand, value.runtimeProvisionCommand, value.cleanupCommand, value.teardownCommand]);
  if (strategy.type === "git_worktree" || commands.some((value) => typeof value === "string" && value.trim())
    || Object.keys(parseObject(config.workspaceRuntime)).length > 0) {
    throw new Error("Protected workspaces require provisioning, services, and cleanup to run through the target supervisor.");
  }
}

export async function prepareRunWorkspaceOwnership(db: Db, input: {
  acquired: EnvironmentAcquisitionResult;
  adapter: ServerAdapterModule;
  context: Omit<WorkspaceOwnershipContext, "policy" | "executionTarget" | "onCheckpoint" | "onGranted">;
  cwd: string;
}): Promise<WorkspaceOwnershipIntent> {
  const { acquired, adapter, context, cwd } = input;
  const policy = filesystemOwnershipPolicy(acquired.environment);
  if (!policy || !adapter.prepareWorkspaceOwnership) throw new Error("Filesystem ownership policy is unavailable.");
  const target = await resolveEnvironmentExecutionTarget({ db, companyId: context.agent.companyId,
    adapterType: adapter.type, environment: acquired.environment, leaseId: acquired.lease.id,
    leaseMetadata: acquired.lease.metadata, lease: acquired.lease });
  if (!target) throw new Error("Filesystem ownership target is unavailable.");
  const identity = { companyId: context.agent.companyId, runId: context.runId, leaseId: acquired.lease.id };
  return adapter.prepareWorkspaceOwnership({ ...context, policy,
    executionTarget: { ...target, workspaceRealization: {
      mode: "in_place", authoritativeRoot: cwd, pathAliases: [], outboundRestorePaths: [],
    } },
    onCheckpoint: checkpoint => prepareWorkspaceOwnershipCheckpoint(db, { ...identity, adapterType: adapter.type, checkpoint }),
    onGranted: grant => recordWorkspaceOwnershipGrant(db, { ...identity, grant }),
    assertActive: async () => {
      await context.assertActive();
      const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, context.runId), eq(heartbeatRuns.companyId, context.agent.companyId),
        eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
        sql`${heartbeatRuns.controllerLeaseExpiresAt} > clock_timestamp()`,
        sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ? 'startupCancellation')`,
      ));
      if (!active) throw new Error("Filesystem preparation no longer owns the run.");
      context.signal?.throwIfAborted();
    },
  });
}
