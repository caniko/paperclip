import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { normalizeBaseUrl } from "./http-config.js";

export { execute, normalizeBaseUrl, resolveSessionKey, parseSseFramesForTest, mapFinalResultForTest } from "./execute.js";
export { testEnvironment } from "./test.js";
export { getConfigSchema } from "./config-schema.js";
export { reconcileExecution } from "./recovery.js";
export { prepareWorkspaceOwnership, reconcileWorkspaceOwnership } from "./ownership.js";

export function executionAffinityScope(config: Record<string, unknown>, context: Record<string, unknown>): {
  scope: "agent" | "issue"; taskKey: string | null; primaryEndpoint: string;
} | null {
  const strategy = String(config.sessionKeyStrategy ?? "issue").trim().toLowerCase();
  const primaryUrl = normalizeBaseUrl(String(config.apiBaseUrl ?? config.url ?? ""));
  // Bindings contain public endpoint identity, never URL credentials.
  if (!primaryUrl || primaryUrl.username || primaryUrl.password) return null;
  const primaryEndpoint = primaryUrl.toString().replace(/\/+$/, "");
  if (strategy === "agent") return { scope: "agent", taskKey: null, primaryEndpoint };
  // Match resolveSessionKey's actual provider conversation, not the controller's
  // task-session alias or synthetic __heartbeat__ cache key.
  const taskKey = readString(context.taskId) ?? readString(context.issueId);
  if (strategy === "run" || strategy === "none" || !taskKey) return null;
  return { scope: "issue", taskKey, primaryEndpoint };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const hermesSessionId = readString(record.hermesSessionId) ?? readString(record.sessionId);
    const sessionKey = readString(record.sessionKey);
    const hermesRunId = readString(record.hermesRunId);
    const strategy = readString(record.strategy);
    const executionContextFingerprint = readString(record.executionContextFingerprint);
    const executorBaseUrl = readString(record.executorBaseUrl);
    if (!hermesSessionId && !sessionKey && !hermesRunId) return null;
    return {
      ...(hermesRunId ? { hermesRunId } : {}),
      ...(hermesSessionId ? { hermesSessionId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(strategy ? { strategy } : {}),
      ...(executionContextFingerprint ? { executionContextFingerprint } : {}),
      ...(executorBaseUrl ? { executorBaseUrl } : {}),
    };
  },
  serialize(params) {
    if (!params) return null;
    const hermesSessionId = readString(params.hermesSessionId) ?? readString(params.sessionId);
    const sessionKey = readString(params.sessionKey);
    const hermesRunId = readString(params.hermesRunId);
    const strategy = readString(params.strategy);
    const executionContextFingerprint = readString(params.executionContextFingerprint);
    const executorBaseUrl = readString(params.executorBaseUrl);
    if (!hermesSessionId && !sessionKey && !hermesRunId) return null;
    return {
      ...(hermesRunId ? { hermesRunId } : {}),
      ...(hermesSessionId ? { hermesSessionId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(strategy ? { strategy } : {}),
      ...(executionContextFingerprint ? { executionContextFingerprint } : {}),
      ...(executorBaseUrl ? { executorBaseUrl } : {}),
    };
  },
  getDisplayId(params) {
    if (!params) return null;
    return readString(params.hermesSessionId) ?? readString(params.sessionKey) ?? readString(params.hermesRunId);
  },
};
