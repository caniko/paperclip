import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composerCandidateDockerArgs } from "./composer-candidate-sandbox.mjs";

export function stageComposerCandidate({ source, revision, temporaryDirectory }) {
  if (typeof source !== "string" || typeof temporaryDirectory !== "string" ||
      !isAbsolute(source) || !isAbsolute(temporaryDirectory) || /[\r\n,]/.test(temporaryDirectory) || !/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("Candidate staging requires absolute paths and an exact revision");
  }
  const location = relative(realpathSync(source), realpathSync(temporaryDirectory));
  if (!location || (!location.startsWith("../") && !isAbsolute(location))) {
    throw new Error("Candidate staging must be outside the source workspace");
  }
  const head = execFileSync("git", ["--no-replace-objects", "-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== revision) throw new Error("Candidate checkout is not the declared PR head");
  // Archive only committed candidate bytes, never the enclosing workspace or its
  // untracked trusted checkout, tools, credentials, env files or provenance.
  const directory = mkdtempSync(join(temporaryDirectory, "composer-candidate-"));
  const candidate = join(directory, "source");
  const archive = join(directory, "source.tar");
  mkdirSync(candidate);
  execFileSync("git", ["--no-replace-objects", "-C", source, "archive", "--format=tar", "--output", archive, revision]);
  execFileSync("tar", ["--extract", "--file", archive, "--directory", candidate, "--no-same-owner", "--no-same-permissions"]);
  rmSync(archive);
  return candidate;
}

export function runComposerCandidatePhase({ candidate, phase }) {
  const commands = {
    // Do not execute an npm-exec shell shim from its ephemeral cache. Bootstrap
    // pinned pnpm in candidate-only storage and use the image's Node interpreter.
    // Only this tool bootstrap ignores scripts; candidate lifecycle still runs.
    install: ["sh", "-c",
      "npm install --prefix /candidate/.composer-tools --ignore-scripts --no-save --package-lock=false pnpm@9.15.4 && " +
      "{ node /candidate/.composer-tools/node_modules/pnpm/bin/pnpm.cjs install --frozen-lockfile || " +
      "{ node /candidate/.composer-tools/node_modules/pnpm/bin/pnpm.cjs install --resolution-only --ignore-scripts --no-frozen-lockfile && " +
      "node /candidate/.composer-tools/node_modules/pnpm/bin/pnpm.cjs install --frozen-lockfile; }; }"],
    build: ["env", "CARGO_TARGET_DIR=/candidate/.composer-native-target", "cargo", "build",
      "--manifest-path", "packages/paperclip-runner/runner/Cargo.toml", "--locked", "--bin", "paperclip-runnerd"],
  };
  if (!Object.hasOwn(commands, phase)) throw new Error("Unsupported candidate preparation phase");
  const owner = randomUUID();
  const name = `composer-${phase}-${owner}`;
  const args = composerCandidateDockerArgs({ candidate, phase, command: commands[phase],
    uid: process.getuid(), gid: process.getgid() });
  args.splice(1, 0, "--name", name, "--label", `paperclip.composer-owner=${owner}`);
  try {
    execFileSync("docker", args, { stdio: "inherit", timeout: 10 * 60_000 });
  } finally {
    // A timed-out Docker client does not stop its container. Revalidate ownership
    // before removing only this invocation's disposable preparation container.
    let label;
    try {
      label = execFileSync("docker", ["inspect", "--format", '{{ index .Config.Labels "paperclip.composer-owner" }}', name],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim();
    } catch { /* --rm already removed a normally completed container. */ }
    if (label === owner) execFileSync("docker", ["rm", "--force", name], { stdio: "ignore", timeout: 10000 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [phase, candidate] = process.argv.slice(2);
  if (phase === "stage") {
    const source = stageComposerCandidate({ source: process.env.GITHUB_WORKSPACE,
      revision: process.env.COMPOSER_STOP_HEAD_REVISION, temporaryDirectory: process.env.RUNNER_TEMP });
    appendFileSync(process.env.GITHUB_ENV, `COMPOSER_STOP_CANDIDATE_ROOT=${source}\n`);
  } else {
    runComposerCandidatePhase({ candidate, phase });
  }
}
