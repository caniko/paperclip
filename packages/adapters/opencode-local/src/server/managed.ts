import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  adapterExecutionTargetRemoteCwd,
  readAdapterExecutionTarget,
  runAdapterExecutionTargetProcess,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";

type Admission = {
  version: 1;
  kind: "opencode_managed";
  runId: string;
  command: string;
  cwd: string;
  target: AdapterExecutionTarget;
  key: string;
  body: string;
  bodySha256: string;
  backendID: string;
  sessionID: string;
  inputID: string;
};
type Backend = { version: 1; backendID: string; backendGeneration: string };
type Receipt = Backend & {
  key: string;
  bodySha256: string;
  sessionID: string;
  inputID: string;
  admitted: boolean;
  stopRequested: boolean;
  settled: boolean;
  lineage: Array<{ sessionID: string; active: boolean; pending: number; suspended: boolean; outcome?: string }>;
  result?: {
    summary: string;
    costUsd: number;
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  };
};

export function validateManagedConfig(
  ctx: Pick<AdapterExecutionContext, "config" | "executionTarget" | "onExecutionCheckpoint" | "onCancellationReady">,
) {
  if (!ctx.onExecutionCheckpoint || !ctx.onCancellationReady)
    throw new Error("Managed OpenCode requires durable execution checkpoint and cancellation hooks");
  if (ctx.config.dangerouslySkipPermissions !== false)
    throw new Error("Managed OpenCode must preserve personal permissions (dangerouslySkipPermissions=false)");
  if (ctx.executionTarget?.kind === "remote" && ctx.executionTarget.transport !== "ssh")
    throw new Error("Managed OpenCode requires a native SSH environment");
  if (
    ctx.config.variant ||
    ctx.config.managedAiConnection ||
    [ctx.config.args, ctx.config.extraArgs].some((value) => Array.isArray(value) && value.length)
  )
    throw new Error("Managed OpenCode uses the backend's model configuration and native lifecycle arguments");
  if (Object.keys(parseObject(ctx.config.env)).some((key) => !/^PAPERCLIP_[A-Z0-9_]+$/.test(key)))
    throw new Error(
      "Managed OpenCode environment overrides must be Paperclip-scoped; personal HOME, XDG, authentication and configuration stay backend-owned",
    );
}

export async function executeManaged(
  ctx: AdapterExecutionContext,
  input: {
    command: string;
    cwd: string;
    target: AdapterExecutionTarget | null;
    prompt: string;
    files: string[];
    environment: Record<string, string>;
    onSettled(): void;
  },
): Promise<AdapterExecutionResult> {
  const target = input.target ?? { kind: "local" };
  const base = { runId: ctx.runId, command: input.command, cwd: input.cwd, target };
  const backend = readBackend(await control(base, "info"));
  const id = createHash("sha256").update(`${ctx.agent.companyId}\0${ctx.agent.id}\0${ctx.runId}`).digest("hex");
  const model = asString(ctx.config.model, "").trim();
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1)
    throw new Error("Managed OpenCode requires a provider/model identifier");
  const body = JSON.stringify({
    version: 1,
    backendID: backend.backendID,
    owner: `paperclip:${ctx.agent.companyId}:${ctx.agent.id}`,
    sessionID: `ses_external_${id}`,
    inputID: `msg_external_${id}`,
    location: { directory: adapterExecutionTargetRemoteCwd(target, input.cwd) },
    model: { provider: model.slice(0, slash), model: model.slice(slash + 1) },
    environment: input.environment,
    prompt: { text: input.prompt, files: input.files.map((file) => ({ uri: pathToFileURL(file).href })) },
  });
  const admission: Admission = {
    ...base,
    version: 1,
    kind: "opencode_managed",
    key: `paperclip:${id}`,
    body,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    backendID: backend.backendID,
    sessionID: `ses_external_${id}`,
    inputID: `msg_external_${id}`,
  };
  // This callback is encrypted by the host. Never log the body, SSH credentials, or backend registration.
  await ctx.onExecutionCheckpoint!(admission);
  await ctx.onCancellationReady!();
  const timeout =
    typeof ctx.config.timeoutSec === "number" && ctx.config.timeoutSec > 0 ? ctx.config.timeoutSec * 1000 : 0;
  const deadline = timeout ? Date.now() + timeout : Infinity;
  let latest: Receipt | undefined;
  let failure = false;
  try {
    if (!ctx.signal?.aborted) latest = readReceipt(await control(admission, "admit"), admission);
    while (!ctx.signal?.aborted && Date.now() < deadline && latest && !latest.settled) {
      if (!latest.stopRequested)
        latest = readReceipt(await control(admission, "resume", latest.backendGeneration), admission);
      await ctx.onExecutionProgress?.({ version: 1, backendID: admission.backendID, receipt: latest });
      if (latest.settled) break;
      latest = readReceipt(await control(admission, "status"), admission);
      if (!latest.settled)
        await setTimeout(250, undefined, { signal: ctx.signal }).catch((error) => {
          if (!ctx.signal?.aborted) throw error;
        });
    }
  } catch {
    // An uncertain admission is fenced by Stop using the original bytes; never replay admit or select another backend.
    failure = true;
  }
  const timedOut = !failure && !ctx.signal?.aborted && !latest?.settled && Date.now() >= deadline;
  if (!latest?.settled || ctx.signal?.aborted || failure) {
    latest = await control(admission, "stop")
      .then((value) => readReceipt(value, admission))
      .catch(() => undefined);
    if (!latest?.stopRequested || !latest.settled)
      throw Object.assign(
        new Error("Managed OpenCode Stop is pending; keep execution ownership and reconcile the immutable checkpoint"),
        { code: "opencode_managed_stop_pending" },
      );
  }
  await ctx.onExecutionProgress?.({ version: 1, backendID: admission.backendID, receipt: latest });
  input.onSettled();
  const stopped = latest.stopRequested;
  const succeeded =
    !failure &&
    !stopped &&
    latest.lineage.find((member) => member.sessionID === admission.sessionID)?.outcome === "succeeded";
  const usage = latest.result?.tokens;
  return {
    exitCode: succeeded ? 0 : 1,
    signal: stopped ? "SIGTERM" : null,
    timedOut,
    ...(!succeeded
      ? {
          errorCode: stopped ? "opencode_managed_cancelled" : "opencode_managed_failed",
          errorMessage: failure
            ? "OpenCode control failed; owned work was stopped and settled"
            : "OpenCode owned execution did not succeed",
        }
      : {}),
    summary: latest.result?.summary,
    model,
    provider: model.slice(0, slash),
    usageBasis: "per_run",
    billingType: "unknown",
    ...(usage
      ? {
          usage: {
            inputTokens: usage.input + usage.cache.write,
            outputTokens: usage.output + usage.reasoning,
            cachedInputTokens: usage.cache.read,
            cacheWriteTokens: usage.cache.write,
          },
        }
      : {}),
    ...(latest.result
      ? { costUsd: latest.result.costUsd, costStatus: "estimated" as const }
      : { costStatus: "unpriced" as const }),
    sessionId: admission.sessionID,
    sessionDisplayId: admission.sessionID,
    sessionParams: { sessionId: admission.sessionID, cwd: input.cwd, managedBackendID: admission.backendID },
    resultJson: {
      backendID: admission.backendID,
      sessionID: admission.sessionID,
      inputID: admission.inputID,
      bodySha256: admission.bodySha256,
      stopRequested: stopped,
      settled: latest.settled,
    },
  };
}

export async function reconcileExecution(raw: Record<string, unknown>): Promise<"pending" | "settled"> {
  try {
    const target = readAdapterExecutionTarget({ executionTarget: raw.target });
    if (
      raw.version !== 1 ||
      raw.kind !== "opencode_managed" ||
      !target ||
      (target.kind === "remote" && target.transport !== "ssh") ||
      ![
        raw.runId,
        raw.command,
        raw.cwd,
        raw.key,
        raw.body,
        raw.bodySha256,
        raw.backendID,
        raw.sessionID,
        raw.inputID,
      ].every((value) => typeof value === "string" && value.length)
    )
      return "pending";
    const admission = { ...raw, target } as Admission;
    if (createHash("sha256").update(admission.body).digest("hex") !== admission.bodySha256) return "pending";
    const body = parseObject(JSON.parse(admission.body));
    if (
      body.backendID !== admission.backendID ||
      body.sessionID !== admission.sessionID ||
      body.inputID !== admission.inputID
    )
      return "pending";
    const receipt = readReceipt(await control(admission, "stop"), admission);
    return receipt.stopRequested && receipt.settled ? "settled" : "pending";
  } catch {
    return "pending";
  }
}

async function control(
  base: Pick<Admission, "runId" | "command" | "cwd" | "target"> & Partial<Admission>,
  operation: string,
  backendGeneration?: string,
): Promise<unknown> {
  const result = await runAdapterExecutionTargetProcess(
    `${base.runId}:opencode-control`,
    base.target,
    base.command,
    ["session", "external", operation],
    {
      cwd: base.cwd,
      env: {},
      stdin:
        operation === "info"
          ? undefined
          : JSON.stringify({ key: base.key, body: base.body, ...(backendGeneration ? { backendGeneration } : {}) }),
      timeoutSec: 15,
      graceSec: 5,
      onLog: async () => {},
    },
  );
  if (result.exitCode !== 0 || result.signal || result.timedOut)
    throw new Error("Managed OpenCode control channel is unavailable");
  return JSON.parse(result.stdout);
}

function readBackend(raw: unknown): Backend {
  const record = parseObject(raw);
  if (
    record.version !== 1 ||
    typeof record.backendID !== "string" ||
    !record.backendID ||
    typeof record.backendGeneration !== "string" ||
    !record.backendGeneration
  )
    throw new Error("Invalid managed OpenCode backend identity");
  return record as Backend;
}

function readReceipt(raw: unknown, admission: Admission): Receipt {
  const backend = readBackend(raw);
  const record = parseObject(raw);
  if (
    backend.backendID !== admission.backendID ||
    record.key !== admission.key ||
    record.bodySha256 !== admission.bodySha256 ||
    record.sessionID !== admission.sessionID ||
    record.inputID !== admission.inputID ||
    ![record.admitted, record.stopRequested, record.settled].every((value) => typeof value === "boolean") ||
    !Array.isArray(record.lineage)
  )
    throw new Error("Managed OpenCode ownership receipt does not match the immutable admission");
  for (const rawMember of record.lineage) {
    const member = parseObject(rawMember);
    if (
      typeof member.sessionID !== "string" ||
      typeof member.active !== "boolean" ||
      typeof member.suspended !== "boolean" ||
      typeof member.pending !== "number" ||
      !Number.isInteger(member.pending) ||
      member.pending < 0 ||
      (record.settled && (member.active || member.suspended || member.pending !== 0))
    )
      throw new Error("Invalid managed OpenCode lineage settlement");
  }
  if (
    record.settled &&
    record.admitted &&
    !record.lineage.some((member) => parseObject(member).sessionID === admission.sessionID)
  )
    throw new Error("Managed OpenCode settlement omits the owned root");
  if (record.result !== undefined) {
    const result = parseObject(record.result);
    const tokens = parseObject(result.tokens),
      cache = parseObject(tokens.cache);
    if (
      typeof result.summary !== "string" ||
      !(typeof result.costUsd === "number" && Number.isFinite(result.costUsd) && result.costUsd >= 0) ||
      // Accounting persists each recorded usage total as a nonnegative 32-bit integer.
      ![tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write].every(
        (value) => Number.isInteger(value) && (value as number) >= 0,
      ) ||
      [
        (tokens.input as number) + (cache.write as number),
        (tokens.output as number) + (tokens.reasoning as number),
        cache.read as number,
      ].some((value) => value > 2_147_483_647)
    )
      throw new Error("Invalid managed OpenCode accounting receipt");
  }
  return record as Receipt;
}
