import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Test-only: expose named support tools, never the inherited provider PATH.
const FIXTURE_SUPPORT_TOOLS = [
  "sh", "bash", "mkdir", "rm", "base64", "mv", "tar", "cp", "find", "wc", "dd", "cat", "chmod",
] as const;
type FixtureSupportTool = (typeof FIXTURE_SUPPORT_TOOLS)[number];

export async function createFixtureSupportBin(
  root: string,
  names: readonly FixtureSupportTool[],
): Promise<string> {
  const inheritedDirectories = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry));
  const tools = [...new Set(names)];
  for (const name of tools) {
    if (!FIXTURE_SUPPORT_TOOLS.includes(name)) {
      throw new Error(`Unsupported fixture support tool: ${name}`);
    }
  }

  // Exclusive creation under the real temp root keeps this outside workspaces.
  const supportBin = path.join(await fs.realpath(root), "support-bin");
  await fs.mkdir(supportBin, { mode: 0o700 });
  const binStat = await fs.lstat(supportBin);
  if (
    !binStat.isDirectory() ||
    (binStat.mode & 0o7777) !== 0o700 ||
    (typeof process.getuid === "function" && binStat.uid !== process.getuid())
  ) {
    throw new Error("Fixture support bin must be an owned private directory");
  }

  for (const name of tools) {
    let executable: string | null = null;
    for (const directory of inheritedDirectories) {
      try {
        const candidate = path.join(directory, name);
        await fs.access(candidate, constants.X_OK);
        const resolved = await fs.realpath(candidate);
        if (!(await fs.stat(resolved)).isFile()) continue;
        await fs.access(resolved, constants.X_OK);
        executable = resolved;
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES" && code !== "ELOOP") {
          throw error;
        }
      }
    }
    if (!executable) {
      throw new Error(`Required fixture support tool is not executable on inherited absolute PATH entries: ${name}`);
    }
    await fs.symlink(executable, path.join(supportBin, name));
  }
  return supportBin;
}
