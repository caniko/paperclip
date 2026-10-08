import { and, eq, ne, sql } from "drizzle-orm";
import { activityLog, mcpCompanyRetiredEnrollments, mcpCompanyRetiredLaunches, mcpCompanyRetirements,
  mcpWorkerEnrollments, type Db } from "@paperclipai/db";
import { isMcpAdmissionIdentifier } from "@paperclipai/adapter-utils/mcp-admission";
import { conflict } from "../errors.js";
import { assertMcpOperatorInTx, type McpOperatorActor } from "./mcp-operator-authorization.js";
import { retireMcpCompanyPreparedLaunchesInTx } from "./mcp-prepared-launch.js";
import { requireSettledCompanyRuntimeServices } from "./mcp-retirement-ownership.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const RECEIPT_MAX_BYTES = 1024 * 1024;

/** Same transaction as companyService.remove, with company UPDATE already held.
 * Does no remote cleanup. Unsettled ownership preserves every recovery pointer.
 * Empty legacy companies retain their existing board deletion behavior. */
export async function retireMcpCompanyInTx(tx: Tx, company: { id: string; status: string },
  input: { controllerInstanceId?: string; actor?: McpOperatorActor }): Promise<boolean> {
  const [scope] = await tx.execute<{ present: boolean }>(sql`select
    exists (select 1 from mcp_worker_enrollments where company_id = ${company.id}) or
    exists (select 1 from mcp_prepared_launches where company_id = ${company.id}) as present`);
  if (!scope?.present) return false;
  // PostgreSQL 17+ bounds the transaction work, including subsequent deletion
  // and deferred checks. Its timer is disabled before durable commit/WAL work;
  // this is not a hard deadline on durable commit completion.
  const [engine] = await tx.execute<{ version: number }>(sql`select current_setting('server_version_num')::int as version`);
  if (!engine || engine.version < 170000) throw conflict("MCP retirement requires transaction-deadline support.");
  // Changing an already active timer's value does not shorten its scheduled
  // timeout (PG17 assign_transaction_timeout). Explicitly disarm/rearm and
  // charge all work since BEGIN, including the initial company-lock wait.
  await tx.execute(sql`do $deadline$
    declare remaining_ms integer;
    begin
      perform set_config('transaction_timeout', '0', true);
      remaining_ms := 30000 - ceil(extract(epoch from (clock_timestamp() - transaction_timestamp())) * 1000)::integer;
      if remaining_ms <= 0 then raise exception 'MCP retirement transaction budget exhausted'; end if;
      perform set_config('transaction_timeout', remaining_ms::text, true);
    end $deadline$`);
  await assertMcpOperatorInTx(tx, company.id, input.actor);
  if (company.status !== "archived") throw conflict("Archive the company and settle execution before MCP retirement.");
  if (!isMcpAdmissionIdentifier(input.controllerInstanceId)) throw conflict("MCP retirement requires a valid controller identity.");
  // Native cleanup's SQL "settled" marker precedes final runtime ownership
  // release and activation-marker removal. Native retirement remains unavailable
  // until the owning workflow has durable final settlement and qualified purge
  // dependencies. Preserve even apparently committed/superseded evidence.
  const [native] = await tx.execute<{ present: boolean }>(sql`select
    exists (select 1 from heartbeat_runs where company_id = ${company.id} and runtime_mode = 'native') or
    exists (select 1 from native_run_finalizations where company_id = ${company.id}) or
    exists (select 1 from native_run_results where company_id = ${company.id}) or
    exists (select 1 from work_assessments where company_id = ${company.id}) or
    exists (select 1 from status_decisions where company_id = ${company.id}) or
    exists (select 1 from status_decision_effects where company_id = ${company.id}) or
    exists (select 1 from completion_contracts where company_id = ${company.id}) as present`);
  if (native?.present) throw conflict("Native execution retirement requires final ownership qualification.");
  // Archive is a dispatch gate, not proof of terminal execution. Include runs
  // without preparations as well as those referenced by the MCP ledger.
  const [pending] = await tx.execute<{ present: boolean }>(sql`select
    exists (select 1 from heartbeat_runs where company_id = ${company.id}
      and status not in ('succeeded', 'interrupted', 'failed', 'cancelled', 'timed_out')) as present`);
  if (pending?.present) throw conflict("Settle company execution before MCP retirement.");
  await requireSettledCompanyRuntimeServices(tx, company.id);
  const enrolled = await tx.select({ id: mcpWorkerEnrollments.id, revision: mcpWorkerEnrollments.revision,
    state: mcpWorkerEnrollments.state }).from(mcpWorkerEnrollments).where(eq(mcpWorkerEnrollments.companyId, company.id))
    .orderBy(mcpWorkerEnrollments.id).limit(1025).for("update");
  if (enrolled.length > 1024) throw conflict("MCP retirement scope exceeds its bounded receipt limit.");
  await retireMcpCompanyPreparedLaunchesInTx(tx, company.id, async launches => {
    const revoked = enrolled.some(row => row.state !== "revoked") ? await tx.update(mcpWorkerEnrollments).set({ state: "revoked",
      revision: sql`gen_random_uuid()`, revokedAt: sql`clock_timestamp()` }).where(and(eq(mcpWorkerEnrollments.companyId, company.id),
      ne(mcpWorkerEnrollments.state, "revoked"))).returning({ id: mcpWorkerEnrollments.id, revision: mcpWorkerEnrollments.revision }) : [];
    const finalRevision = new Map(revoked.map(row => [row.id, row.revision]));
    const entries = enrolled.map(row => ({ companyId: company.id, enrollmentId: row.id, revision: finalRevision.get(row.id) ?? row.revision }));
    const launchEntries = launches.map(({ id, ...scope }) => ({ ...scope, launchId: id }));
    const header = { companyId: company.id, controllerInstanceId: input.controllerInstanceId!, actorId: input.actor!.actorId,
      enrollmentCount: entries.length, launchCount: launchEntries.length };
    if (Buffer.byteLength(JSON.stringify({ header, entries, launchEntries }), "utf8") > RECEIPT_MAX_BYTES) {
      throw conflict("MCP retirement scope exceeds its bounded receipt limit.");
    }
    if (revoked.length) await tx.insert(activityLog).values(revoked.map(row => ({ companyId: company.id, actorType: "user",
      actorId: input.actor!.actorId, action: "mcp_worker.revoked", entityType: "mcp_worker_enrollment", entityId: row.id,
      details: { version: 1, revision: row.revision } })));
    await tx.insert(mcpCompanyRetirements).values(header);
    if (entries.length) await tx.insert(mcpCompanyRetiredEnrollments).values(entries);
    if (launchEntries.length) await tx.insert(mcpCompanyRetiredLaunches).values(launchEntries);
  });
  return true;
}
