import { parseObject } from "./server-utils.js";

/** Run scratch paths the server assigns on every heartbeat wake. */
export const RUN_SCRATCH_PATH_ENV_KEYS = [
  "PAPERCLIP_RUN_SCRATCH_DIR",
  "PAPERCLIP_TASK_SCRATCH_DIR",
  "PAPERCLIP_SCRATCH_DIR",
  "PAPERCLIP_TMPDIR",
] as const;

/** Process temp dirs the server fills only when the run config leaves them unset. */
export const RUN_SCRATCH_TEMP_ENV_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;

/**
 * Server-owned run scratch env recorded on the execution context, or null when
 * the context carries none. `keys` are the env keys the server assigned to
 * `dir`; a value that differs from `dir` came from config, not from the server.
 */
export function serverRunScratchEnv(context: unknown): { dir: string; keys: ReadonlySet<string> } | null {
  const scratch = parseObject(parseObject(context).paperclipScratch);
  if (scratch.type !== "heartbeat_run" || typeof scratch.dir !== "string") return null;
  const applied = Array.isArray(scratch.tempKeysApplied) ? scratch.tempKeysApplied : [];
  const keys: string[] = [...RUN_SCRATCH_PATH_ENV_KEYS];
  for (const key of applied) {
    if (typeof key === "string" && (RUN_SCRATCH_TEMP_ENV_KEYS as readonly string[]).includes(key)) keys.push(key);
  }
  return { dir: scratch.dir, keys: new Set(keys) };
}
