import { execFileSync } from "node:child_process";

// Several commits plus hook/signing round trips are fixture setup, not the
// operation under test. Keep that complete integration workload bounded.
export const SIGNED_GIT_FIXTURE_TEST_TIMEOUT_MS = 30_000;

export function configureFixtureGitIdentity(repo, callerCwd = process.cwd()) {
  // Read the caller's effective config before writing fixture-local identity.
  // Managed hooks and signing must keep using the operator's identity.
  const readConfig = (key) => {
    try {
      return execFileSync("git", ["config", "--get", key], {
        cwd: callerCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).replace(/\r?\n$/, "");
    } catch (error) {
      if (error.status === 1) return null; // Absent config key.
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
  // The managed launcher clears global/system configuration to isolate GitHub
  // credentials. Preserve only the caller's explicit local signing policy.
  for (const key of ["commit.gpgsign", "gpg.format", "gpg.program", "gpg.openpgp.program",
    "gpg.ssh.program", "gpg.x509.program", "user.signingkey", "gpg.ssh.allowedSignersFile"]) {
    const value = readConfig(key);
    if (value !== null) execFileSync("git", ["config", "--local", key, value], { cwd: repo });
  }
}
