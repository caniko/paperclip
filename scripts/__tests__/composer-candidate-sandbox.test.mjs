import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composerCandidateDockerArgs } from "../composer-candidate-sandbox.mjs";
import { composerCandidateProcessAlive } from "../composer-candidate-process.mjs";
import { startComposerCandidateRuntime } from "../composer-candidate-runtime.mjs";

test("candidate boundary exposes only the candidate directory, never host tools, state or credentials", (t) => {
  const candidate = mkdtempSync(join(tmpdir(), "composer-candidate-"));
  t.after(() => rmSync(candidate, { recursive: true, force: true }));
  for (const phase of ["install", "build", "runtime"]) {
    const args = composerCandidateDockerArgs({ candidate, phase, command: ["true"], uid: 1001, gid: 1001 });
    assert.equal(args.filter(arg => arg.startsWith("type=bind,")).length, 1);
    assert.ok(args.includes(`type=bind,src=${candidate},dst=/candidate`));
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("no-new-privileges"));
    assert.ok(args.includes("ALL"));
    assert.ok(args.includes("1001:1001"));
    // Dependency stores exceed the temporary filesystem; keep them on the
    // sole candidate-owned mount, without exposing any host cache.
    for (const cache of ["CARGO_HOME=/candidate/.composer-tools/cargo", "npm_config_cache=/candidate/.composer-tools/npm-cache", "npm_config_store_dir=/candidate/.composer-tools/pnpm-store"]) {
      assert.ok(args.includes(cache), cache);
    }
    assert.equal(args.includes("CARGO_PROFILE_DEV_DEBUG=0"), phase === "build");
    assert.ok(args.some(arg => /@sha256:[0-9a-f]{64}$/.test(arg)));
    for (const forbidden of ["--privileged", "--pid=host", "--network=host", "GITHUB_ENV", "GH_TOKEN", "docker.sock", ".trusted-composer-stop", "RUNNER_TEMP"]) {
      assert.ok(args.every(arg => !arg.includes(forbidden)), forbidden);
    }
  }
  for (const override of [{ uid: 0 }, { gid: 0 }, { candidate: "/" }, { phase: "unknown" }, { command: [] }]) {
    assert.throws(() => composerCandidateDockerArgs({ candidate, phase: "runtime", command: ["true"], uid: 1001, gid: 1001, ...override }));
  }
});

test("hostile lifecycle, Cargo build script and runtime actually execute without rewriting trusted state", (t) => {
  const root = mkdtempSync(join(tmpdir(), "composer-sandbox-hostile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate");
  const trusted = join(root, "trusted");
  mkdirSync(candidate);
  mkdirSync(trusted);
  const targets = ["verifier.mjs", "browser-tool.mjs", "manifest.sha256", "github-env"].map(name => join(trusted, name));
  for (const target of targets) writeFileSync(target, "independently trusted bytes\n");
  writeFileSync(join(candidate, "attack.mjs"), `import { writeFileSync } from "node:fs";
    if (process.env.GITHUB_ENV || process.env.GH_TOKEN) throw new Error("host environment leaked");
    for (const target of ${JSON.stringify(targets)}) {
      try { writeFileSync(target, "forged acceptance\\n"); } catch {}
    }
    writeFileSync("/candidate/" + process.argv[2] + ".executed", "executed\\n");`);
  writeFileSync(join(candidate, "package.json"), JSON.stringify({ name: "hostile-candidate", scripts: { postinstall: "node attack.mjs install" } }));
  mkdirSync(join(candidate, "src"));
  writeFileSync(join(candidate, "Cargo.toml"), '[package]\nname = "hostile-candidate"\nversion = "0.0.0"\nedition = "2021"\n');
  writeFileSync(join(candidate, "src", "main.rs"), "fn main() {}\n");
  writeFileSync(join(candidate, "build.rs"), `fn main() {
    assert_eq!(std::env::var("CARGO_PROFILE_DEV_DEBUG").unwrap(), "0");
    for target in ${JSON.stringify(targets)} { let _ = std::fs::write(target, "forged acceptance\\n"); }
    std::fs::write("/candidate/build.executed", "executed\\n").unwrap();
  }`);
  const phases = [
    ["install", ["node", "--run", "postinstall"]],
    ["build", ["cargo", "build", "--offline", "--target-dir", "/candidate/target"]],
    ["runtime", ["node", "/candidate/attack.mjs", "runtime"]],
  ];
  for (const [phase, command] of phases) {
    const name = `composer-boundary-${randomUUID()}`;
    const args = composerCandidateDockerArgs({ candidate, phase, command, uid: process.getuid(), gid: process.getgid() });
    args.splice(1, 0, "--name", name);
    try {
      const result = spawnSync("docker", args, { encoding: "utf8", timeout: 180_000,
        env: { ...process.env, GH_TOKEN: "host-only-fixture-not-a-credential", GITHUB_ENV: targets[3] } });
      assert.equal(result.status, 0, `${phase} fixture must execute, not skip: ${result.error ?? result.stderr}`);
      assert.equal(readFileSync(join(candidate, `${phase}.executed`), "utf8"), "executed\n");
      for (const target of targets) assert.equal(readFileSync(target, "utf8"), "independently trusted bytes\n", `${phase} rewrote ${target}`);
    } finally {
      // Only this test's random, explicitly named container; also cleans a timed-out client.
      spawnSync("docker", ["rm", "--force", name], { encoding: "utf8", timeout: 20_000 });
    }
  }
});

test("trusted kernel PID observation binds the owned container and preserves the unrelated child", { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "composer-pid-"));
  const candidate = join(root, "candidate"), trusted = join(root, "trusted");
  mkdirSync(candidate); mkdirSync(trusted);
  mkdirSync(join(candidate, ".composer-native-target/debug"), { recursive: true });
  writeFileSync(join(candidate, ".composer-native-target/debug/paperclip-runnerd"), "fixture runner artifact\n");
  const provider = join(trusted, "provider");
  writeFileSync(provider, "#!/bin/sh\ncat\n", { mode: 0o700 });
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  runtime = await startComposerCandidateRuntime({ candidate, provider, callLog: join(trusted, "calls.log"), stateDirectory: trusted, port: 0 });
  const env = { ...runtime.env, PAPERCLIP_STOP_REQUIRE_NATIVE: "true" };
  const container = env.COMPOSER_STOP_CONTAINER_ID;
  assert.match(container, /^[0-9a-f]{64}$/);
  const execute = source => execFileSync("docker", ["exec", "--env", "NODE_OPTIONS=", "--env", "NODE_PATH=", container,
    "/usr/local/bin/node", "-e", source], { encoding: "utf8", timeout: 10000 });
  const [parentPid, childPid] = JSON.parse(execute(`const { spawn } = require('node:child_process');
    const children = [0, 1].map(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }));
    children.forEach(child => child.unref()); console.log(JSON.stringify(children.map(child => child.pid)));`));
  const hostPids = execFileSync("docker", ["top", container, "-eo", "pid"], { encoding: "utf8", timeout: 10000 }).trim().split(/\s+/).slice(1).map(Number);
  // Independently corroborate namespace/host identities without inventing a
  // second observer API; the production API retains its own start-time fence.
  const identity = pid => {
    const hostPid = hostPids.find(host => Number(readFileSync(`/proc/${host}/status`, "utf8").match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).at(-1)) === pid);
    assert.ok(hostPid, "the container child must have an independently observed host identity");
    return { hostPid, namespace: readlinkSync(`/proc/${hostPid}/ns/pid`) };
  };
  const parent = identity(parentPid), child = identity(childPid);
  assert.equal(composerCandidateProcessAlive(parentPid, env), true);
  assert.equal(composerCandidateProcessAlive(childPid, env), true);
  assert.notEqual(parent.hostPid, parentPid, "container PIDs must not be interpreted as host PIDs");
  assert.notEqual(parent.namespace, readlinkSync("/proc/self/ns/pid"));
  assert.equal(parent.namespace, child.namespace);
  for (const override of [{ COMPOSER_STOP_CONTAINER_OWNER: randomUUID() }, { COMPOSER_STOP_CONTAINER_ID: "unowned-name" }]) {
    assert.throws(() => composerCandidateProcessAlive(parentPid, { ...env, ...override }));
  }
  assert.throws(() => composerCandidateProcessAlive(0, env));
  assert.equal(composerCandidateProcessAlive(1, env), true, "PID 1 is bound to this owned runtime, not the host");
  assert.equal(composerCandidateProcessAlive(2147483647, env), false);
  execute(`process.kill(${parentPid}, 'SIGTERM')`);
  // Await kernel state, not a candidate-authored status or kill(pid, 0) on the host.
  const deadline = Date.now() + 3000;
  while (composerCandidateProcessAlive(parentPid, env) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(composerCandidateProcessAlive(parentPid, env), false);
  assert.equal(composerCandidateProcessAlive(childPid, env), true);
});
