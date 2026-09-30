import { parseObject } from "@paperclipai/adapter-utils/server-utils";

/** This checkpoint is private. The host seals it before admission so recovery
 * can fence the original idempotent admission even after agent config changes. */
export function executionCheckpoint(baseUrl: URL, headers: Record<string, string>, body: string): Record<string, unknown> {
  return { version: 1, baseUrl: baseUrl.toString().replace(/\/+$/, ""), headers, body };
}

export async function reconcileExecution(checkpoint: Record<string, unknown>): Promise<"pending" | "settled"> {
  try {
    if (checkpoint.version !== 1 || typeof checkpoint.baseUrl !== "string" || typeof checkpoint.body !== "string") return "pending";
    const headers = parseObject(checkpoint.headers);
    if (!Object.values(headers).every((value) => typeof value === "string") || !headers["Idempotency-Key"]) return "pending";
    const body = parseObject(JSON.parse(checkpoint.body));
    const context = parseObject(body.execution_context);
    if (context.version !== 1 || context.lifetime !== "wait_for_jobs") return "pending";
    const request = async (suffix: string, method = "GET", payload?: string) => {
      const response = await fetch(`${checkpoint.baseUrl}${suffix}`, { method, headers: headers as Record<string, string>,
        ...(payload === undefined ? {} : { body: payload }), signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!response.ok) throw new Error("Recovery observation unavailable");
      return parseObject(await response.json());
    };
    const capability = parseObject(parseObject((await request("/v1/capabilities")).features).runs_execution_context);
    if (capability.version !== 1 || capability.stop_admission !== true) return "pending";
    // Atomically stop the key without starting missing work. A delayed create
    // sees the same terminal tombstone even if no create was ever acknowledged.
    const receipt = await request("/v1/runs/stop", "POST", checkpoint.body);
    if (typeof receipt.run_id !== "string" || !receipt.run_id) return "pending";
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
