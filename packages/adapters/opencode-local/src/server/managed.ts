import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { serverRunScratchEnv } from "@paperclipai/adapter-utils/run-scratch-env";
import {
  adapterExecutionTargetRemoteCwd,
  readAdapterExecutionTarget,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { discoverManagedService, OpenCodeHttpError, type ManagedService } from "./managed-service.js";

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
type Body = {
  owner: string;
  location: { directory: string };
  model: { providerID: string; id: string };
  environment: Record<string, string>;
  prompt: { text: string; files: Array<{ uri: string; name?: string }> };
};
type Receipt = {
  version: 1;
  backendID: string;
  backendGeneration: string;
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
  ctx: Pick<
    AdapterExecutionContext,
    "config" | "context" | "executionTarget" | "onExecutionCheckpoint" | "onCancellationReady"
  >,
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
  // The server assigns run scratch paths (including temp dirs) to this run; only
  // those server-owned values may reach the backend. Anything else stays personal.
  const scratch = serverRunScratchEnv(ctx.context);
  if (
    Object.entries(parseObject(ctx.config.env)).some(
      ([key, value]) =>
        !/^PAPERCLIP_[A-Z0-9_]+$/.test(key) && !(scratch !== null && scratch.keys.has(key) && value === scratch.dir),
    )
  )
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
  const id = createHash("sha256").update(`${ctx.agent.companyId}\0${ctx.agent.id}\0${ctx.runId}`).digest("hex");
  const model = asString(ctx.config.model, "").trim();
  const slash = model.indexOf("/");
  // Variants are backend-owned (see validateManagedConfig); OpenCode would split "#variant" out of the id.
  if (slash <= 0 || slash === model.length - 1 || model.includes("#"))
    throw new Error("Managed OpenCode requires a provider/model identifier without a variant");
  let backend = await discoverManagedService(base);
  const files = await Promise.all(input.files.map(async (file) =>
    target.kind === "remote"
      ? { uri: `data:text/plain;base64,${(await readFile(file)).toString("base64")}`, name: basename(file) }
      : { uri: pathToFileURL(file).href },
  ));
  const requestBody = {
    version: 1,
    backendID: backend.backendID,
    owner: `paperclip:${ctx.agent.companyId}:${ctx.agent.id}`,
    sessionID: `ses_external_${id}`,
    inputID: `msg_external_${id}`,
    location: { directory: adapterExecutionTargetRemoteCwd(target, input.cwd) },
    model: { providerID: model.slice(0, slash), id: model.slice(slash + 1) },
    environment: input.environment,
    prompt: { text: input.prompt, files },
  };
  const body = JSON.stringify(requestBody);
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
  const reconnect = async (error: unknown) => {
    const replacement = await rediscover(admission, deadline, ctx.signal);
    if (replacement.generation === backend.generation) throw error;
    backend = replacement;
  };
  try {
    if (!ctx.signal?.aborted) {
      await admit(backend, admission, requestBody, ctx.signal).catch(async (error) => {
        await reconnect(error);
        await admit(backend, admission, requestBody, ctx.signal);
      });
    }
    while (!ctx.signal?.aborted) {
      try {
        latest = await observe(backend, admission, requestBody);
        if (latest.settled) {
          await pause(ctx.signal);
          latest = await observe(backend, admission, requestBody);
          if (latest.settled) latest.result = await readResult(backend, admission, latest);
        }
      } catch (error) {
        await reconnect(error);
        await restoreEnvironment(backend, admission, requestBody, ctx.signal);
        continue;
      }
      if (latest.settled) break;
      if (Date.now() >= deadline) break;
      await ctx.onExecutionProgress?.({ version: 1, backendID: admission.backendID, receipt: latest });
      await pause(ctx.signal);
    }
  } catch {
    failure = !ctx.signal?.aborted;
  }
  const timedOut = !failure && !ctx.signal?.aborted && !latest?.settled && Date.now() >= deadline;
  if (!latest?.settled || ctx.signal?.aborted || failure) {
    latest = await discoverBoundService(admission)
      .then(async (service) => {
        const stopped = await stop(service, admission, requestBody);
        if (stopped.settled && stopped.admitted)
          stopped.result = await promptProjected(service, admission)
            .then((projected) => projected ? readResult(service, admission, stopped) : undefined)
            .catch(() => undefined);
        return stopped;
      })
      .catch(() => undefined);
    if (!latest?.stopRequested || !latest.settled)
      throw Object.assign(
        new Error("Managed OpenCode Stop is pending; keep execution ownership and reconcile the immutable checkpoint"),
        { code: "opencode_managed_stop_pending" },
      );
  }
  // Progress is mutable observation; the settled receipt, not its persistence, decides the outcome.
  await ctx.onExecutionProgress?.({ version: 1, backendID: admission.backendID, receipt: latest }).catch(() => undefined);
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
    // Checkpoints from before the Model.Ref fix carry model as { provider, model }. OpenCode decodes model as
    // Model.Ref and rejects excess properties, so such a body was never admitted and owns nothing.
    const model = body.model;
    if (model && typeof model === "object" && "provider" in model && !("providerID" in model)) return "settled";
    if (body.version !== 1 || !admission.backendID.startsWith("upstream:") ||
      !/^ses_external_[\da-f]{64}$/.test(admission.sessionID) ||
      admission.inputID !== admission.sessionID.replace(/^ses_/, "msg_") ||
      admission.key !== admission.sessionID.replace(/^ses_external_/, "paperclip:") ||
      typeof body.owner !== "string")
      return "pending";
    const receipt = await stop(await discoverBoundService(admission), admission, { owner: body.owner });
    return receipt.stopRequested && receipt.settled ? "settled" : "pending";
  } catch {
    return "pending";
  }
}

const sessionRoute = (id: string) => `/api/session/${encodeURIComponent(id)}`;
const inboxRoute = (id: string, item: string) => `${sessionRoute(id)}/inbox/${encodeURIComponent(item)}`;
const pause = (signal?: AbortSignal) => setTimeout(250, undefined, { signal }).catch((error) => {
  if (!signal?.aborted) throw error;
});
const notFound = (error: unknown) => error instanceof OpenCodeHttpError && error.status === 404;

async function discoverBoundService(admission: Admission) {
  const service = await discoverManagedService(admission);
  if (service.backendID !== admission.backendID) throw new Error("Managed OpenCode database changed");
  return service;
}

async function rediscover(admission: Admission, deadline: number, signal?: AbortSignal) {
  const retryUntil = Math.min(deadline, Date.now() + 5000);
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await discoverBoundService(admission);
    } catch (error) {
      if (Date.now() >= retryUntil) throw error;
      await pause(signal);
    }
  }
}

function arrayData(raw: unknown) {
  const { data } = parseObject(raw);
  if (!Array.isArray(data)) throw new Error("Invalid managed OpenCode collection");
  return data.map(parseObject);
}

function objectData(raw: unknown) {
  const { data } = parseObject(raw);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Invalid managed OpenCode response");
  return parseObject(data);
}

function ownerFields(admission: Admission, body: Pick<Body, "owner">) {
  return { paperclipOwner: body.owner, paperclipAdmissionSha256: admission.bodySha256 };
}

function verifyRoot(root: Record<string, unknown>, admission: Admission, body: Pick<Body, "owner">) {
  const metadata = parseObject(root.metadata);
  if (root.id !== admission.sessionID || root.parentID != null ||
    Object.entries(ownerFields(admission, body)).some(([key, value]) => metadata[key] !== value))
    throw new Error("Managed OpenCode root does not match the immutable admission");
  const phase = metadata.paperclipPhase ?? "created";
  if (phase !== "created" && phase !== "dispatching" && phase !== "admitted" && phase !== "stopping")
    throw new Error("Invalid managed OpenCode admission phase");
  return phase;
}

async function markPhase(service: ManagedService, root: Record<string, unknown>, id: string, phase: string) {
  await service.request(sessionRoute(id), "PATCH", { metadata: { ...parseObject(root.metadata), paperclipPhase: phase } });
}

async function inbox(service: ManagedService, id: string) {
  const items = arrayData(await service.request(`${sessionRoute(id)}/inbox`));
  if (items.some((item) => typeof item.id !== "string" || item.sessionID !== id))
    throw new Error("Invalid managed OpenCode inbox");
  return items;
}

async function promptProjected(service: ManagedService, admission: Admission) {
  try {
    const message = objectData(await service.request(`${sessionRoute(admission.sessionID)}/message/${admission.inputID}`));
    if (message.id !== admission.inputID || message.type !== "user") throw new Error("Invalid managed OpenCode prompt");
    return true;
  } catch (error) {
    if (notFound(error)) return false;
    throw error;
  }
}

async function armPrompt(service: ManagedService, admission: Admission, body: Body, signal?: AbortSignal) {
  const pending = (await inbox(service, admission.sessionID)).find(({ id }) => id === admission.inputID);
  if (!pending) return;
  const root = objectData(await service.request(sessionRoute(admission.sessionID)));
  if (verifyRoot(root, admission, body) !== "admitted") throw new Error("Managed OpenCode run is not ready to resume");
  const active = objectData(await service.request("/api/session/active"));
  if (Object.hasOwn(active, admission.sessionID)) return;
  const route = inboxRoute(admission.sessionID, admission.inputID);
  signal?.throwIfAborted();
  try {
    if (pending.delivery === "steer") await service.request(route, "PATCH", { delivery: "queue" });
    signal?.throwIfAborted();
    await service.request(route, "PATCH", { delivery: "steer" });
  } catch (error) {
    if (!(error instanceof OpenCodeHttpError && error.status === 409 && await promptProjected(service, admission)))
      throw error;
  }
}

async function restoreEnvironment(service: ManagedService, admission: Admission, body: Body, signal?: AbortSignal) {
  const root = objectData(await service.request(sessionRoute(admission.sessionID)));
  if (verifyRoot(root, admission, body) !== "admitted")
    throw new Error("Managed OpenCode prompt is not admitted for execution");
  await service.setEnvironment(`${sessionRoute(admission.sessionID)}/environment`, body.environment);
  await armPrompt(service, admission, body, signal);
}

async function admit(service: ManagedService, admission: Admission, body: Body, signal?: AbortSignal) {
  const { sessionID, inputID } = admission;
  await service.assertCurrent();
  signal?.throwIfAborted();
  const root = objectData(await service.request("/api/session", "POST", {
    id: sessionID, location: body.location, model: body.model, metadata: ownerFields(admission, body),
  }));
  const phase = verifyRoot(root, admission, body);
  if (phase === "stopping") throw new Error("Managed OpenCode run was stopped");
  await service.setEnvironment(`${sessionRoute(sessionID)}/environment`, body.environment);
  signal?.throwIfAborted();
  if (phase === "created") {
    await markPhase(service, root, sessionID, "dispatching");
    const accepted = await service.request(`${sessionRoute(sessionID)}/prompt`, "POST", {
      ...body.prompt, id: inputID, delivery: "queue", resume: false,
    }).then(objectData).catch(async (error) => {
      if (error instanceof OpenCodeHttpError && error.status === 400)
        await markPhase(service, root, sessionID, "stopping");
      throw error;
    });
    if (accepted.id !== inputID || accepted.sessionID !== sessionID || accepted.type !== "user")
      throw new Error("Managed OpenCode prompt admission does not match the checkpoint");
  } else if (phase === "dispatching" &&
    !(await inbox(service, sessionID)).some(({ id }) => id === inputID) && !await promptProjected(service, admission)) {
    throw new Error("Managed OpenCode prior prompt admission is unresolved");
  }
  if (phase !== "admitted") await markPhase(service, root, sessionID, "admitted");
  await service.assertCurrent();
  await armPrompt(service, admission, body, signal);
}

async function members(service: ManagedService, root: Record<string, unknown>) {
  const family = [root];
  const seen = new Set([root.id]);
  for (const parent of family) {
    const query = new URLSearchParams({ parentID: String(parent.id), limit: "100" });
    const cursors = new Set<string>();
    for (;;) {
      const page = parseObject(await service.request(`/api/session?${query}`));
      const children = arrayData(page);
      for (const child of children) {
        if (typeof child.id !== "string" || !child.id.startsWith("ses") || child.parentID !== parent.id ||
          seen.has(child.id) || seen.size >= 256)
          throw new Error("Invalid managed OpenCode session lineage");
        seen.add(child.id);
        family.push(child);
      }
      const next = parseObject(page.cursor).next;
      if (next == null) break;
      if (typeof next !== "string" || !next || cursors.has(next) || !children.length)
        throw new Error("Invalid managed OpenCode lineage cursor");
      cursors.add(next);
      query.delete("parentID");
      query.set("cursor", next);
    }
  }
  return family;
}

function receipt(service: ManagedService, admission: Admission, stopRequested: boolean): Receipt {
  return {
    version: 1, backendID: service.backendID, backendGeneration: service.generation,
    key: admission.key, bodySha256: admission.bodySha256, sessionID: admission.sessionID, inputID: admission.inputID,
    admitted: false, stopRequested, settled: false, lineage: [],
  };
}

async function observe(
  service: ManagedService, admission: Admission, body: Pick<Body, "owner">, stopping = false,
): Promise<Receipt> {
  await service.assertCurrent();
  const { sessionID } = admission;
  const observation = receipt(service, admission, stopping);
  const root = objectData(await service.request(sessionRoute(sessionID)));
  const phase = verifyRoot(root, admission, body);
  const family = await members(service, root);
  const jobs = arrayData(await service.request(`/api/experimental/job?${new URLSearchParams({ sessionID, descendants: "true" })}`));
  const pending = await Promise.all(family.map((member) => inbox(service, String(member.id))));
  const active = objectData(await service.request("/api/session/active"));
  observation.admitted = phase === "admitted" || (phase === "stopping" && await promptProjected(service, admission));
  observation.lineage = family.map((member, index) => {
    if (!member.time || typeof member.time !== "object" || Array.isArray(member.time))
      throw new Error("Invalid managed OpenCode session time");
    const time = parseObject(member.time);
    if ([time.busy, time.idle].some((value) => value !== undefined && (typeof value !== "number" || !Number.isFinite(value))))
      throw new Error("Invalid managed OpenCode session time");
    const isActive = Object.hasOwn(active, String(member.id));
    return {
      sessionID: String(member.id), active: isActive, pending: pending[index]!.length,
      suspended: !isActive && typeof time.busy === "number" && (typeof time.idle !== "number" || time.busy > time.idle),
      outcome: ["succeeded", "failed", "interrupted"].includes(String(member.outcome)) ? String(member.outcome) : undefined,
    };
  });
  observation.settled =
    jobs.length === 0 &&
    observation.lineage.every((member) => !member.active && !member.suspended && member.pending === 0) &&
    (stopping ? phase === "stopping" : (phase === "admitted" && observation.lineage[0]?.outcome !== undefined &&
      await promptProjected(service, admission)));
  await service.assertCurrent();
  return observation;
}

async function stop(service: ManagedService, admission: Admission, body: Pick<Body, "owner">) {
  await service.assertCurrent();
  const root = await service.request(sessionRoute(admission.sessionID)).then(objectData).catch((error) => {
    if (notFound(error)) return undefined;
    throw error;
  });
  if (!root) {
    await service.assertCurrent();
    return { ...receipt(service, admission, true), settled: true };
  }
  const phase = verifyRoot(root, admission, body);
  if (phase === "dispatching" && !(await inbox(service, admission.sessionID)).some(({ id }) => id === admission.inputID) &&
    !await promptProjected(service, admission)) return receipt(service, admission, true);
  if (phase !== "stopping") await markPhase(service, root, admission.sessionID, "stopping");
  const family = await members(service, root);
  await Promise.all(family.map(async (item) => {
    const id = String(item.id);
    for (const pending of await inbox(service, id))
      await service.request(inboxRoute(id, String(pending.id)), "DELETE");
    await service.request(`${sessionRoute(id)}/interrupt`, "POST");
    await service.request(`/api/experimental/session/${encodeURIComponent(id)}/wait`, "POST");
  }));
  const first = await observe(service, admission, body, true);
  if (!first.settled) return first;
  await pause();
  return observe(service, admission, body, true);
}

async function readResult(service: ManagedService, admission: Admission, observation: Receipt): Promise<Receipt["result"]> {
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  let costUsd = 0;
  for (const member of observation.lineage) {
    const info = objectData(await service.request(sessionRoute(member.sessionID)));
    const usage = parseObject(info.tokens);
    const cache = parseObject(usage.cache);
    const count = (value: unknown) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        throw new Error("Invalid managed OpenCode token count");
      return value;
    };
    tokens.input += count(usage.input);
    tokens.output += count(usage.output);
    tokens.reasoning += count(usage.reasoning);
    tokens.cache.read += count(cache.read);
    tokens.cache.write += count(cache.write);
    if (typeof info.cost !== "number" || !Number.isFinite(info.cost) || info.cost < 0)
      throw new Error("Invalid managed OpenCode cost");
    costUsd += info.cost;
  }
  if (!Number.isFinite(costUsd) || [tokens.input + tokens.cache.write, tokens.output + tokens.reasoning, tokens.cache.read]
    .some((value) => value > 2_147_483_647)) throw new Error("Invalid managed OpenCode accounting");
  let summary = "";
  const query = new URLSearchParams({ type: "assistant", limit: "50", order: "desc" });
  const cursors = new Set<string>();
  while (!summary) {
    const page = parseObject(await service.request(`${sessionRoute(admission.sessionID)}/message?${query}`));
    const messages = arrayData(page);
    const message = messages.find((item) => item.type === "assistant" && typeof parseObject(item.time).completed === "number");
    if (message) {
      if (!Array.isArray(message.content)) throw new Error("Invalid managed OpenCode assistant message");
      summary = message.content.map(parseObject).filter((part) => part.type === "text")
        .map((part) => typeof part.text === "string" ? part.text : "").join("").slice(0, 2000);
      break;
    }
    const next = parseObject(page.cursor).next;
    if (summary || next == null) break;
    if (typeof next !== "string" || !next || cursors.has(next) || !messages.length)
      throw new Error("Invalid managed OpenCode message cursor");
    cursors.add(next);
    query.delete("order");
    query.set("cursor", next);
  }
  await service.assertCurrent();
  return { summary, costUsd, tokens };
}
