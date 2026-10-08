import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
