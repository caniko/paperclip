import { createHash } from "node:crypto";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";

/** This checkpoint is private. The host seals it before admission so recovery
 * can fence the original idempotent admission even after agent config changes. */
export function executionCheckpoint(baseUrl: URL, headers: Record<string, string>, body: string): Record<string, unknown> {
  return { version: 1, baseUrl: baseUrl.toString().replace(/\/+$/, ""), headers, body };
}

export function lineageStopSettled(receipt: Record<string, unknown>, runId: string, knownMembers: Iterable<string> = [runId]): boolean {
  if (!runId.trim() || receipt.run_id !== runId || receipt.stop_requested !== true || receipt.lineage_settled !== true
    || !Array.isArray(receipt.lineage) || receipt.lineage.length === 0) return false;
  const members = new Set<string>();
  for (const item of receipt.lineage) {
    const run = parseObject(item);
    if (typeof run.run_id !== "string" || !run.run_id.trim() || run.run_id !== run.run_id.trim() || members.has(run.run_id)
      || !["completed", "failed", "cancelled", "interrupted", "superseded", "unrecoverable"].includes(String(run.status))) return false;
    members.add(run.run_id);
  }
  return members.has(runId) && [...knownMembers].every(member => members.has(member));
}

export async function reconcileExecution(checkpoint: Record<string, unknown>, progress?: Record<string, unknown>): Promise<"pending" | "settled"> {
  try {
    if (checkpoint.version !== 1 || typeof checkpoint.baseUrl !== "string" || typeof checkpoint.body !== "string") return "pending";
    const headers = parseObject(checkpoint.headers);
    if (!Object.values(headers).every((value) => typeof value === "string") || !headers["Idempotency-Key"]) return "pending";
    const body = parseObject(JSON.parse(checkpoint.body));
    const context = parseObject(body.execution_context);
    const request = async (suffix: string, method = "GET", payload?: string) => {
      const response = await fetch(`${checkpoint.baseUrl}${suffix}`, { method, headers: headers as Record<string, string>,
        ...(payload === undefined ? {} : { body: payload }), signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!response.ok) throw new Error("Recovery observation unavailable");
      return parseObject(await response.json());
    };
    const features = parseObject((await request("/v1/capabilities")).features);
    const recovery = parseObject(features.runs_recovery);
    const capability = parseObject(features.runs_execution_context);
    const lineageAware = recovery.version === 1 && recovery.durable_lineage_stop === true;
    if (!lineageAware && (context.lifetime !== "wait_for_jobs" || capability.version !== 1 || capability.stop_admission !== true)) return "pending";
    // Atomically stop the key without starting missing work. A delayed create
    // sees the same terminal tombstone even if no create was ever acknowledged.
    // The worker must bind its reserved root to the original authenticated
    // admission, including a before-create tombstone. Never compare a receipt's
    // root to itself as the only recovery identity check.
    const receipt = await request("/v1/runs/stop", "POST", checkpoint.body);
    if (typeof receipt.run_id !== "string" || !receipt.run_id) return "pending";
    if (lineageAware) {
      const admission = parseObject(receipt.admission);
      const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
      if (recovery.admission_binding !== 1 || admission.version !== 1
        || admission.key_sha256 !== sha256(String(headers["Idempotency-Key"]).trim())
        || admission.body_sha256 !== sha256(checkpoint.body)
        || typeof admission.root_run_id !== "string") return "pending";
      let knownMembers = [admission.root_run_id];
      if (progress && Object.keys(progress).length) {
        if (progress.version !== 1 || progress.rootRunId !== admission.root_run_id
          || typeof progress.runId !== "string" || !progress.runId.trim()
          || !Array.isArray(progress.lineage) || !progress.lineage.every(member => typeof member === "string" && member.trim())) return "pending";
        knownMembers = [...progress.lineage, progress.runId];
      }
      return lineageStopSettled(receipt, admission.root_run_id, knownMembers) ? "settled" : "pending";
    }
    if ("lineage" in receipt || "lineage_settled" in receipt) return "pending";
    if (["completed", "failed", "cancelled", "interrupted"].includes(String(receipt.status))) return "settled";
    const runPath = `/v1/runs/${encodeURIComponent(receipt.run_id)}`;
    const status = await request(runPath);
    return ["completed", "failed", "cancelled", "interrupted"].includes(String(status.status)) ? "settled" : "pending";
  } catch {
    return "pending";
  }
}

export async function settleOwnedAdmission(checkpoint: Record<string, unknown>, retryMs: number): Promise<void> {
  while (await reconcileExecution(checkpoint) !== "settled") {
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}
