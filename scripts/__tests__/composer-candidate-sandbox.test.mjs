import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { composerCandidateDockerArgs } from "../composer-candidate-sandbox.mjs";

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
  // The test-only predecessor exercises the browser's existing host-PID probe.
  // Once implemented, use the real trusted observer against this same container.
  const { createComposerProcessProbe } = existsSync(new URL("../composer-candidate-process.mjs", import.meta.url))
    ? await import("../composer-candidate-process.mjs")
    : { createComposerProcessProbe: ({ pid }) => ({ alive: () => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    } }) };
  const candidate = mkdtempSync(join(tmpdir(), "composer-pid-"));
  const owner = randomUUID();
  const name = `composer-pid-${owner}`;
  const args = composerCandidateDockerArgs({ candidate, phase: "runtime", uid: process.getuid(), gid: process.getgid(),
    command: ["node", "-e", `const { spawn } = require('node:child_process');
      const children = [0, 1].map(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']));
      console.log(JSON.stringify(children.map(child => child.pid)));
      setInterval(() => {}, 1000);`] });
  args.splice(1, 0, "--detach", "--name", name, "--label", `paperclip.composer-owner=${owner}`);
  t.after(() => {
    const label = spawnSync("docker", ["inspect", "--format", '{{ index .Config.Labels "paperclip.composer-owner" }}', name],
      { encoding: "utf8", timeout: 10000 });
    if (label.status === 0 && label.stdout.trim() === owner) spawnSync("docker", ["rm", "--force", name], { encoding: "utf8", timeout: 10000 });
    rmSync(candidate, { recursive: true, force: true });
  });
  const started = spawnSync("docker", args, { encoding: "utf8", timeout: 30000 });
  assert.equal(started.status, 0, `actual PID fixture must start, not skip: ${started.error ?? started.stderr}`);
  const container = started.stdout.trim();
  assert.match(container, /^[0-9a-f]{64}$/);
  const logs = spawn("docker", ["logs", "--follow", container], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = createInterface({ input: logs.stdout });
  const [line] = await once(lines, "line", { signal: AbortSignal.timeout(10000) }).finally(() => {
    lines.close(); logs.kill("SIGTERM");
  });
  const [parentPid, childPid] = JSON.parse(line);
  const parent = createComposerProcessProbe({ container, owner, pid: parentPid });
  const child = createComposerProcessProbe({ container, owner, pid: childPid });
  assert.equal(parent.alive(), true);
  assert.equal(child.alive(), true);
  assert.ok(parent.identity, "the legacy host-PID probe cannot establish the candidate's kernel namespace identity");
  assert.ok(child.identity, "both children need independently bound kernel identities");
  assert.notEqual(parent.identity.hostPid, parentPid, "container PIDs must not be interpreted as host PIDs");
  assert.notEqual(parent.identity.namespace, readlinkSync("/proc/self/ns/pid"));
  assert.equal(parent.identity.namespace, child.identity.namespace);
  for (const override of [{ owner: randomUUID() }, { container: name }, { pid: 0 }, { pid: 1 }, { pid: 2147483647 }]) {
    assert.throws(() => createComposerProcessProbe({ container, owner, pid: parentPid, ...override }));
  }
  const stop = spawnSync("docker", ["exec", container, "node", "-e", `process.kill(${parentPid}, 'SIGTERM')`],
    { encoding: "utf8", timeout: 10000 });
  assert.equal(stop.status, 0, stop.stderr);
  // Await kernel state, not a candidate-authored status or kill(pid, 0) on the host.
  const deadline = Date.now() + 3000;
  while (parent.alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(parent.alive(), false);
  assert.equal(child.alive(), true);
});
