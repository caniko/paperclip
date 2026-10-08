import { agents, createDb, heartbeatRuns } from "@paperclipai/db";
import { and, inArray } from "drizzle-orm";
import type { heartbeatService } from "../../services/heartbeat.js";

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;

// Await every background heartbeat run until the run table is quiescent. A route
// dispatches a wakeup fire-and-forget (void heartbeat.wakeup(...) in
// routes/issues.ts). Such a wakeup, or a run it dispatches, can write issues,
// issue_comments, and heartbeat_runs rows during teardown and race the deletes
// in a suite afterEach or afterAll (a heartbeat_runs delete deadlocks on the ON
// DELETE SET NULL cascade to issues; an issue_comments insert breaks the later
// delete of issues). drainActiveRunExecutions() awaits both in-flight wakeup
// promises and in-flight run executions, so it also waits for a wakeup that is
// still before run registration. Re-check the run table after the drain as a
// backstop, and give a late run a macrotask before the next attempt, until no
// run is queued or running.
export async function drainHeartbeatRunsToQuiescence(db: Db, heartbeat: Pick<Heartbeat, "drainActiveRunExecutions">) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await heartbeat.drainActiveRunExecutions();
    const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    const hasPending = runs.some((run) => run.status === "queued" || run.status === "running");
    if (!hasPending) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Heartbeat fixture still has queued or running work; retain its database until settlement");
}

/** Explicit disposal of caller-owned runs in a fresh disposable fixture DB.
 * Retry/scope tests deliberately leave synthetic running rows or future queued
 * retries. Stop new dispatch for their exact companies, then use the ordinary
 * owning cancellation workflow; a refusal/unfinished Stop remains a failure.
 * This is never an option on the passive quiescence check above. */
export async function cancelFixtureHeartbeatRuns(db: Db,
  heartbeat: Pick<Heartbeat, "drainActiveRunExecutions" | "cancelRun">, companyIds: string[]) {
  if (companyIds.length) {
    await db.update(agents).set({ status: "paused" }).where(inArray(agents.companyId, companyIds));
    await heartbeat.drainActiveRunExecutions();
    const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      inArray(heartbeatRuns.companyId, companyIds), inArray(heartbeatRuns.status, ["queued", "scheduled", "running"]),
    )).orderBy(heartbeatRuns.id).limit(1001);
    if (pending.length > 1000) throw new Error("Fixture cancellation exceeds its bounded scope; retain its database");
    for (const run of pending) await heartbeat.cancelRun(run.id, "Disposable fixture is closing", {
      skipQueuedRunStart: true, suppressImmediateRecovery: true,
    });
  }
  await drainHeartbeatRunsToQuiescence(db, heartbeat);
}
