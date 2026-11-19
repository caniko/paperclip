const REMOTE_EXECUTION_ENV_IDENTITY_KEYS = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "NVM_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
]);

// Exact keys only. The SSH account owns PATH, HOME, provider and forge state.
const atlasEnvKeys = new Set([
  "PAPERCLIP_AGENT_ID", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_RUN_ID", "PAPERCLIP_TASK_ID",
  "PAPERCLIP_WAKE_REASON", "PAPERCLIP_WAKE_COMMENT_ID", "PAPERCLIP_APPROVAL_ID", "PAPERCLIP_APPROVAL_STATUS",
  "PAPERCLIP_WORKSPACE_CWD", "PAPERCLIP_API_URL", "PAPERCLIP_API_BRIDGE_MODE", "PAPERCLIP_BRIDGE_QUEUE_DIR",
  "PAPERCLIP_BRIDGE_HOST", "PAPERCLIP_BRIDGE_PORT", "PAPERCLIP_BRIDGE_POLL_INTERVAL_MS",
  "PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS", "PAPERCLIP_BRIDGE_MAX_QUEUE_DEPTH", "PAPERCLIP_BRIDGE_MAX_BODY_BYTES",
]);

export function atlasSshEnv(env: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => atlasEnvKeys.has(key)));
}

function readEnvValueCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (typeof direct === "string") return direct;
  const upper = key.toUpperCase();
  for (const [candidateKey, candidateValue] of Object.entries(env)) {
    if (candidateKey.toUpperCase() === upper && typeof candidateValue === "string") {
      return candidateValue;
    }
  }
  return undefined;
}

export function sanitizeRemoteExecutionEnv(
  env: Record<string, string>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase();
    if (!REMOTE_EXECUTION_ENV_IDENTITY_KEYS.has(normalizedKey)) {
      sanitized[key] = value;
      continue;
    }
    const inheritedValue = readEnvValueCaseInsensitive(inheritedEnv, key);
    if (typeof inheritedValue === "string" && inheritedValue === value) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
