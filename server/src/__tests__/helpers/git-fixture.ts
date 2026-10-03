import { execFileSync } from "node:child_process";

export function configureFixtureGitIdentity(repo: string, callerCwd = process.cwd()): void {
  // Read the caller's effective config before writing fixture-local identity.
  // Managed hooks and signing must keep using the operator's identity.
  const readConfig = (key: string): string | null => {
    try {
      return execFileSync("git", ["config", "--get", key], {
        cwd: callerCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).replace(/\r?\n$/, "");
    } catch (error) {
      if ((error as { status?: unknown }).status === 1) return null; // Absent config key.
      throw error;
    }
  };
  let name = readConfig("user.name");
  let email = readConfig("user.email");
  if (name === null && email === null) {
    // Identity-free CI still needs an identity for its disposable repositories.
    name = "Paperclip Test";
    email = "paperclip@example.com";
  }
  if (!name || !email) {
    throw new Error("Git fixtures require both user.name and user.email when a caller identity is configured.");
  }
  execFileSync("git", ["config", "--local", "user.name", name], { cwd: repo });
  execFileSync("git", ["config", "--local", "user.email", email], { cwd: repo });
}
