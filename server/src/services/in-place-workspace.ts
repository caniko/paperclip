import { stat } from "node:fs/promises";
import path from "node:path";
import { filesystemOwnershipSchema } from "@paperclipai/shared";

/** Resolve an authoritative path before any host-side materialization or fallback. */
export async function resolveInPlaceWorkspacePath(input: {
  driver?: string | null;
  environmentConfig?: Record<string, unknown> | null;
  cwd?: string | null;
}): Promise<string | null> {
  if (input.environmentConfig?.workspaceRealizationMode !== "in_place") return null;
  const remote = input.driver === "ssh";
  if (!remote && input.driver !== "local") return null;
  const cwd = remote ? input.environmentConfig.remoteWorkspacePath : input.cwd;
  const paths = remote ? path.posix : path;
  if (typeof cwd !== "string" || !paths.isAbsolute(cwd) || cwd.includes("\0")) {
    throw new Error("In-place workspace requires an explicit absolute directory.");
  }
  const ownership = input.environmentConfig.filesystemOwnership;
  if (ownership !== undefined) filesystemOwnershipSchema.parse(ownership);
  // Protected roots are checked by the enrolled authority as the execution user.
  // The controller may be unable to see them. Unprotected SSH paths are checked
  // by their driver on the execution host.
  if (!remote && ownership === undefined && !(await stat(cwd).catch(() => null))?.isDirectory()) {
    throw new Error(`In-place workspace directory is unavailable: ${cwd}`);
  }
  return cwd;
}
