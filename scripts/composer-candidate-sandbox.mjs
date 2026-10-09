import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { GROK_PUBLIC_INSTALL_IMAGE } from "./grok-public-install-sandbox.mjs";

// Reuse the public-install boundary: candidate code receives one disposable
// directory, not the checkout, host tools, trusted harness, Docker socket or env.
// The caller must stage candidate-only bytes outside all trusted state first.
export function composerCandidateDockerArgs({ candidate, phase, command, uid, gid }) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) {
    throw new Error("Candidate execution requires an unprivileged user");
  }
  if (!isAbsolute(candidate) || candidate.includes(",")) throw new Error("Invalid candidate directory");
  const root = realpathSync(candidate);
  if (root === dirname(root) || root.includes(",") || !statSync(root).isDirectory()) throw new Error("Invalid candidate directory");
  if (!["install", "build", "runtime"].includes(phase) || !Array.isArray(command) || !command.length || command.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("Invalid candidate phase or command");
  }
  return [
    "run", "--rm", "--platform", "linux/amd64", "--user", `${uid}:${gid}`,
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "512", "--memory", "3g", "--cpus", "2",
    "--network", phase === "runtime" ? "none" : "bridge",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
    "--env", "HOME=/tmp", "--env", "CARGO_HOME=/tmp/cargo",
    "--mount", `type=bind,src=${root},dst=/candidate`, "--workdir", "/candidate",
    phase === "build"
      ? "rust:1.97-bookworm@sha256:408fe88047cef61a2087653b0c5255fa51c0f2d6d94ddedd7a2562a9b91a46f6"
      : GROK_PUBLIC_INSTALL_IMAGE,
    ...command,
  ];
}
