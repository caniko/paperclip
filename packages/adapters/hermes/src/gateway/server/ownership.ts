import { createHash } from "node:crypto";
import type { WorkspaceOwnershipContext, WorkspaceOwnershipIntent } from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { buildHeaders, normalizeBaseUrl, parseHeaders } from "./execute.js";
import { requireWorkspaceCapability, resolveWorkspaceBinding } from "./execution-context.js";
import { allowsInsecureRemoteHttp, isRemotePlainHttp } from "./transport-security.js";

class FilesystemOwnershipRejectedError extends Error {}

async function observe(checkpoint: Record<string, unknown>, operation: "reserve" | "stop" | "release") {
  if (checkpoint.version !== 1 || typeof checkpoint.baseUrl !== "string") throw new Error("Invalid ownership checkpoint");
  const headers = parseObject(checkpoint.headers);
  if (!Object.values(headers).every((value) => typeof value === "string")) throw new Error("Invalid ownership headers");
  const response = await fetch(`${checkpoint.baseUrl}/v1/filesystem-ownership`, {
    method: "POST", headers: headers as Record<string, string>, redirect: "error", signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ operation, execution_context: checkpoint.executionContext }),
  });
  const receipt = parseObject(await response.json());
  if (response.status === 409 && receipt.code === "rejected") {
    throw new FilesystemOwnershipRejectedError("Filesystem authority rejected the ownership request");
  }
  if (!response.ok) throw new Error("Filesystem ownership observation is unavailable");
  return receipt;
}

export async function reconcileWorkspaceOwnership(checkpoint: Record<string, unknown>): Promise<"pending" | "settled"> {
  try {
    await observe(checkpoint, "stop");
    return (await observe(checkpoint, "release")).state === "settled" ? "settled" : "pending";
  } catch {
    return "pending";
  }
}

export async function prepareWorkspaceOwnership(ctx: WorkspaceOwnershipContext): Promise<WorkspaceOwnershipIntent> {
  const baseUrl = normalizeBaseUrl(String(ctx.config.apiBaseUrl ?? ctx.config.url ?? ""));
  const apiKey = String(ctx.config.apiKey ?? ctx.config.token ?? "").trim();
  if (!baseUrl || !apiKey || (isRemotePlainHttp(baseUrl) && !allowsInsecureRemoteHttp(ctx.config))) {
    throw new Error("Filesystem ownership requires an authenticated, securely configured Hermes gateway");
  }
  const ownership: WorkspaceOwnershipIntent = {
    ...ctx.policy, roots: [...ctx.policy.roots], request: ctx.runId,
    fingerprint: createHash("sha256").update(JSON.stringify([ctx.agent.companyId, ctx.runId, ctx.policy])).digest("hex"),
  };
  const binding = resolveWorkspaceBinding({ ...ctx, workspaceOwnership: ownership }, baseUrl.toString());
  if (!binding || ctx.executionTarget?.workspaceRealization?.mode !== "in_place") {
    throw new Error("Filesystem ownership requires an in-place execution target");
  }
  const headers = buildHeaders({
    apiKey, sessionKey: null, runId: ctx.runId, extraHeaders: parseHeaders(ctx.config.headers),
    accept: "application/json", contentType: "application/json",
  });
  const endpoint = baseUrl.toString().replace(/\/+$/, "");
  const capability = await fetch(`${endpoint}/v1/capabilities`, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!capability.ok) throw new Error("Filesystem ownership capabilities are unavailable");
  requireWorkspaceCapability(await capability.json(), binding);
  const checkpoint = { version: 1, baseUrl: endpoint, headers, executionContext: binding.context };
  await ctx.onCheckpoint(checkpoint); // No target mutation precedes the durable intent.
  const retryMs = Math.max(250, Math.min(10_000, Number(ctx.config.pollIntervalMs) || 1_000));
  let cancelled = false;
  let waitingReported = false;
  for (;;) {
    try { await ctx.assertActive(); } catch { cancelled = true; }
    cancelled ||= ctx.signal?.aborted === true;
    let receipt: Record<string, unknown>;
    try {
      receipt = await observe(checkpoint, cancelled ? "stop" : "reserve");
      if (cancelled) receipt = await observe(checkpoint, "release");
    }
    catch (error) {
      // Refusal is actionable, but does not erase the durable intent: an older
      // grant reply may have been lost. The caller still fences and reconciles it.
      if (error instanceof FilesystemOwnershipRejectedError) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      continue; // A lost grant reply is not a failed acquisition.
    }
    if (receipt.state === "settled") throw new Error("Filesystem ownership request was cancelled");
    if (!cancelled && receipt.state === "active" && typeof receipt.claim === "string") {
      await ctx.onGranted({ claim: receipt.claim, authority: ownership.authority });
      await ctx.assertActive();
      return ownership;
    }
    if (!cancelled && !waitingReported) {
      await ctx.onWaiting?.();
      waitingReported = true;
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}
