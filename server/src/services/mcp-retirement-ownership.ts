import { eq, sql, type SQL } from "drizzle-orm";
import { environmentLeases, workspaceRuntimeServices, type Db } from "@paperclipai/db";
import { McpLaunchBlockedError } from "./mcp-prepared-launch-contract.js";
import { conflict } from "../errors.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Runtime status/exposure bookkeeping is not owning-workflow settlement proof.
 * In-flight starts and unregistered backends can both carry a stopped marker.
 * Keep every runtime recovery pointer until generation-fenced process, provision
 * and exposure settlement is implemented and qualified. Caller holds company
 * UPDATE and has reauthorized before child locks. */
export async function requireSettledCompanyRuntimeServices(tx: Tx, companyId: string): Promise<void> {
  const rows = await tx.select({ id: workspaceRuntimeServices.id })
    .from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.companyId, companyId))
    .orderBy(workspaceRuntimeServices.id).limit(1).for("update");
  if (rows.length) {
    throw conflict("Runtime ownership settlement is not qualified for company deletion. Retain runtime recovery records.");
  }
}

function termination(table: SQL, state: "stopped" | "destroyed") {
  const receipt = sql`${table}.metadata->'remoteExecutionTermination'`;
  return sql`jsonb_typeof(${receipt}) = 'object'
    and ${receipt}->>'schema' = 'paperclip.remote-termination.v1'
    and ${receipt}->>'companyId' = ${table}.company_id::text
    and ${receipt}->>'runId' = ${table}.heartbeat_run_id::text
    and ${receipt}->>'leaseId' = ${table}.id::text
    and ${receipt}->>'provider' = ${table}.provider
    and ${receipt}->>'providerLeaseId' = ${table}.provider_lease_id
    and ${receipt}->>'state' = ${state}`;
}

function settledCheckpoint(key: "adapterExecution" | "workspaceOwnership") {
  const marker = sql`${environmentLeases.metadata}->${key}`;
  const finalization = sql`${marker}->'finalization'`;
  return sql`not (coalesce(${environmentLeases.metadata}, '{}'::jsonb) ? ${key}) or (
    jsonb_typeof(${marker}) = 'object' and ${marker}->'version' = '1'::jsonb
    and ${marker}->>'state' = 'settled' and jsonb_typeof(${marker}->'adapterType') = 'string'
    and length(trim(${marker}->>'adapterType')) > 0 and jsonb_typeof(${marker}->'fingerprint') = 'string'
    and ${marker}->>'fingerprint' ~ '^[a-f0-9]{64}$'
    and not (${marker} ? 'material') and ${key === "adapterExecution" ? sql`not (${marker} ? 'finalization')` : sql`(
      jsonb_typeof(${finalization}) = 'object' and not (${finalization} ? 'state')
      and ${finalization}->>'completedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
      and exists (select 1 from workspace_operations finalized
        where finalized.id::text = ${finalization}->>'operationId'
          and finalized.company_id = ${environmentLeases.companyId}
          and finalized.heartbeat_run_id = ${environmentLeases.heartbeatRunId}
          and finalized.phase = 'workspace_finalize' and finalized.status in ('succeeded', 'failed')
          and finalized.finished_at is not null
          and (${finalization}->>'completedAt')::timestamptz >= finalized.finished_at
          and (${finalization}->>'completedAt')::timestamptz <= clock_timestamp()))`})`;
}

/** The caller holds company UPDATE before task/run/lease locks. Return only IDs
 * and SQL-computed validity: encrypted checkpoints and provider metadata never
 * cross this boundary. Expiry/revocation cannot discharge cleanup ownership. */
export async function requireSettledMcpCompanyLeases(tx: Tx, companyId: string, managedMcp = true): Promise<void> {
  const original = sql`environment_leases`, successor = sql`successor`;
  const metadata = sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb)`;
  const historicalHandoff = sql`${environmentLeases.leasePolicy} = 'reuse_by_environment'
    and ${environmentLeases.status} = 'expired' and ${termination(original, "stopped")}
    and exists (select 1 from environment_leases successor
      where successor.id <> ${environmentLeases.id} and successor.company_id = ${environmentLeases.companyId}
        and ${environmentLeases.environmentId} is not null and successor.environment_id = ${environmentLeases.environmentId}
        and successor.provider = ${environmentLeases.provider} and successor.provider_lease_id = ${environmentLeases.providerLeaseId}
        and successor.metadata->'pluginId' is not distinct from ${environmentLeases.metadata}->'pluginId'
        and successor.acquired_at >= ${environmentLeases.updatedAt}
        and ((${environmentLeases.executionWorkspaceId} is not null and successor.execution_workspace_id = ${environmentLeases.executionWorkspaceId})
          or (${environmentLeases.executionWorkspaceId} is null and successor.execution_workspace_id is null
            and ${environmentLeases.issueId} is not null and successor.issue_id = ${environmentLeases.issueId}
            and jsonb_typeof(${environmentLeases.metadata}->'agentId') = 'string'
            and length(${environmentLeases.metadata}->>'agentId') > 0
            and successor.metadata->>'agentId' = ${environmentLeases.metadata}->>'agentId'))
        and successor.released_at is not null and successor.cleanup_status = 'success'
        and successor.status in ('released', 'expired', 'failed') and ${termination(successor, "destroyed")})`;
  const rows = await tx.select({ id: environmentLeases.id, settled: sql<boolean>`coalesce((
    ${environmentLeases.releasedAt} is not null and ${environmentLeases.status} in ('released', 'expired', 'failed')
    and (${environmentLeases.metadata} is null or jsonb_typeof(${environmentLeases.metadata}) = 'object')
    and ${environmentLeases.leasePolicy} in ('ephemeral', 'reuse_by_environment', 'reuse_by_execution_workspace', 'retain_on_failure')
    and (${environmentLeases.cleanupStatus} is null or ${environmentLeases.cleanupStatus} = 'success')
    and not (${metadata} ?| array['sandboxStopAndRetain', 'nativeWorkspaceExportResume'])
    and (not (${metadata} ? 'pendingCleanupInFlight') or ${metadata}->'pendingCleanupInFlight' = 'false'::jsonb)
    and (not (${metadata} ? 'pendingCleanupLeaseExpiresAtMs') or ${metadata}->'pendingCleanupLeaseExpiresAtMs' = '0'::jsonb)
    and (${settledCheckpoint("adapterExecution")}) and (${settledCheckpoint("workspaceOwnership")})
    and (${environmentLeases.leasePolicy} not in ('reuse_by_environment', 'reuse_by_execution_workspace')
      or (${environmentLeases.status} = 'expired' and ${environmentLeases.cleanupStatus} = 'success'))
    and (${environmentLeases.providerLeaseId} is null or (length(${environmentLeases.provider}) > 0 and
      (${environmentLeases.provider} = 'local' or ${environmentLeases.cleanupStatus} = 'success')))
    and (not (${metadata} ? 'remoteExecutionTermination') or ${termination(original, "destroyed")} or (${historicalHandoff}))
  ), false)` }).from(environmentLeases).where(eq(environmentLeases.companyId, companyId))
    .orderBy(environmentLeases.id).limit(1025).for("update");
  if (rows.length > 1024 || rows.some(row => !row.settled)) {
    if (managedMcp) throw new McpLaunchBlockedError();
    throw conflict("Settle company execution and environment cleanup before company deletion.");
  }
}
