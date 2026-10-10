import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { normalizeBaseUrl, parseHeaders } from "./http-config.js";
import { requiresWorkspaceBinding } from "./execution-context.js";
import { allowsInsecureRemoteHttp, isRemotePlainHttp } from "./transport-security.js";

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export function executorInventory(config: Record<string, unknown>): string[] | null {
  if (config.executorEndpoints === undefined) return null;
  let values = config.executorEndpoints;
  if (typeof values === "string") {
    try { values = JSON.parse(values); } catch { values = null; }
  }
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) {
    throw failure("hermes_gateway_executor_config_invalid", "executorEndpoints requires one to eight ordered worker URLs.");
  }
  const endpoints = values.map((value) => {
    let raw: URL | null = null;
    try { raw = typeof value === "string" ? new URL(value.trim()) : null; } catch { /* Invalid inventory. */ }
    const url = typeof value === "string" ? normalizeBaseUrl(value.trim()) : null;
    if (!raw || !url || raw.username || raw.password || raw.search || raw.hash
      || (isRemotePlainHttp(url) && !allowsInsecureRemoteHttp(config))) {
      throw failure("hermes_gateway_executor_config_invalid", "Executor URLs require secure transport and cannot contain credentials, queries or fragments.");
    }
    return url.toString().replace(/\/+$/, "");
  });
  const primary = normalizeBaseUrl(String(config.apiBaseUrl ?? config.url ?? ""))?.toString().replace(/\/+$/, "");
  if (endpoints[0] !== primary || new Set(endpoints).size !== endpoints.length) {
    throw failure("hermes_gateway_executor_config_invalid", "executorEndpoints must start with apiBaseUrl and contain distinct URLs.");
  }
  return endpoints;
}

/** Read-only selection. Once an ownership/admission checkpoint exists, recovery
 * uses its endpoint exclusively; it must never call this selector. */
export async function selectExecutor(input: {
  config: Record<string, unknown>;
  runtime: { sessionId?: string | null; sessionParams?: Record<string, unknown> | null };
  context?: Record<string, unknown>;
  executionAffinity?: AdapterExecutionContext["executionAffinity"];
  executionTarget?: AdapterExecutionContext["executionTarget"];
  workspaceOwnership?: AdapterExecutionContext["workspaceOwnership"];
  signal?: AbortSignal;
}): Promise<string | null> {
  const endpoints = executorInventory(input.config);
  const strategy = String(input.config.sessionKeyStrategy ?? "issue").trim().toLowerCase();
  const hasIssue = [input.context?.taskId, input.context?.issueId].some(value => typeof value === "string" && value.trim().length > 0);
  const continuousSession = !["run", "none"].includes(strategy)
    && (strategy === "agent" || !input.context || hasIssue);
  const storedAffinity = input.executionAffinity
    ? input.executionAffinity.endpoint ?? undefined
    : input.runtime.sessionParams?.executorBaseUrl;
  const affinity = continuousSession ? storedAffinity : undefined;
  if (!endpoints) {
    const primary = normalizeBaseUrl(String(input.config.apiBaseUrl ?? input.config.url ?? ""))?.toString().replace(/\/+$/, "");
    if (affinity !== undefined && affinity !== primary) {
      throw failure("hermes_gateway_executor_affinity_invalid", "The session's executor differs from apiBaseUrl; explicitly reset the session before changing workers.");
    }
    return null; // Single-worker compatibility does not require this capability.
  }
  if (affinity !== undefined && (typeof affinity !== "string" || !endpoints.includes(affinity))) {
    throw failure("hermes_gateway_executor_affinity_invalid", "The session's executor is no longer in the configured inventory; explicitly reset the session before selecting another worker.");
  }
  // Protected target enrollment and pre-pool conversation history belong to
  // the original endpoint. A selection pool grants no filesystem authority.
  const targetBound = requiresWorkspaceBinding(input);
  if (targetBound && affinity && affinity !== endpoints[0]) {
    throw failure("hermes_gateway_executor_affinity_invalid", "A protected execution target cannot adopt a secondary-worker session.");
  }
  const candidates = affinity ? [affinity] : targetBound || (continuousSession && !input.executionAffinity && (input.runtime.sessionId || input.runtime.sessionParams))
    ? [endpoints[0]!] : endpoints;
  const apiKey = String(input.config.apiKey ?? input.config.token ?? "").trim();
  if (!apiKey) throw failure("hermes_gateway_api_key_missing", "Executor selection requires an authenticated Hermes gateway.");
  const headers = { ...parseHeaders(input.config.headers), Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  for (const endpoint of candidates) {
    input.signal?.throwIfAborted();
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(2_000);
      response = await fetch(`${endpoint}/v1/capabilities`, { headers, redirect: "error",
        signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout });
    } catch {
      input.signal?.throwIfAborted();
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw failure("hermes_gateway_executor_auth_failed", "An executor refused the configured credential.");
    }
    if (!response.ok) continue;
    let features: Record<string, unknown>;
    try { features = parseObject(parseObject(await response.json()).features); } catch { continue; }
    const admission = parseObject(features.runs_executor_admission);
    const recovery = parseObject(features.runs_recovery);
    const slots = admission.available_slots;
    if (admission.version === 1 && admission.accepting === true
      && (slots === null || (typeof slots === "number" && Number.isSafeInteger(slots) && slots > 0))
      && recovery.version === 1 && recovery.durable_lineage_stop === true
      && recovery.admission_binding === 1 && recovery.ordinary_stop_admission === true) return endpoint;
  }
  throw failure("hermes_gateway_executor_unavailable", "No eligible executor has available capacity; session and target affinity remain pinned.");
}
