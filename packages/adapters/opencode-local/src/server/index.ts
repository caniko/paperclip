import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSession(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const sessionId =
    readNonEmptyString(record.sessionId) ??
    readNonEmptyString(record.session_id) ??
    readNonEmptyString(record.sessionID);
  if (!sessionId) return null;
  const cwd = readNonEmptyString(record.cwd) ?? readNonEmptyString(record.workdir) ?? readNonEmptyString(record.folder);
  const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
  const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
  const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
  const managedBackendID = readNonEmptyString(record.managedBackendID);
  if (record.managedBackendID !== undefined && !managedBackendID) return null;
  const remoteExecution = readRemoteIdentity(record.remoteExecution);
  if (remoteExecution === null) return null;
  return {
    sessionId,
    ...(cwd ? { cwd } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(repoRef ? { repoRef } : {}),
    ...(managedBackendID ? { managedBackendID } : {}),
    ...(remoteExecution ? { remoteExecution } : {}),
  };
}

function readRemoteIdentity(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  const remoteCwd = readNonEmptyString(saved.remoteCwd);
  if (!remoteCwd?.startsWith("/")) return null;
  if (saved.transport === "ssh") {
    const host = readNonEmptyString(saved.host),
      username = readNonEmptyString(saved.username);
    if (!host || !username || !Number.isInteger(saved.port) || Number(saved.port) < 1 || Number(saved.port) > 65535)
      return null;
    return { transport: "ssh", host, port: saved.port, username, remoteCwd };
  }
  if (saved.transport !== "sandbox") return null;
  if (![saved.providerKey, saved.environmentId, saved.leaseId].every((v) => v == null || typeof v === "string"))
    return null;
  return {
    transport: "sandbox",
    providerKey: saved.providerKey ?? null,
    environmentId: saved.environmentId ?? null,
    leaseId: saved.leaseId ?? null,
    remoteCwd,
  };
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize: readSession,
  serialize: readSession,
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID)
    );
  },
};

export { execute } from "./execute.js";
export { reconcileExecution } from "./managed.js";
export { listOpenCodeSkills, syncOpenCodeSkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export {
  listOpenCodeModels,
  discoverOpenCodeModels,
  ensureOpenCodeModelConfiguredAndAvailable,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";
export { parseOpenCodeJsonl, isOpenCodeUnknownSessionError } from "./parse.js";
