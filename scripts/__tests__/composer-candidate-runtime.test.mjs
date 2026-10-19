import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startComposerCandidateRuntime, verifyComposerCandidateRuntime } from "../composer-candidate-runtime.mjs";
import { composerCandidateProcessAlive } from "../composer-candidate-process.mjs";

test("mandatory process observation refuses missing or unowned container identity", () => {
  const required = { PAPERCLIP_STOP_REQUIRE_NATIVE: "true" };
  assert.throws(() => composerCandidateProcessAlive(process.pid, required), /trusted container identity/);
  for (const id of ["../host", "name", "a".repeat(64)]) {
    assert.throws(() => verifyComposerCandidateRuntime({ ...required, COMPOSER_STOP_CONTAINER_ID: id }), /trusted container identity/);
  }
  for (const pid of [0, -1, 1.5, "2", 2 ** 32]) {
    assert.throws(() => composerCandidateProcessAlive(pid, required), /Invalid process ID/);
  }
});

test("runtime refuses candidate custody and symlinked runner artifacts before execution", async t => {
  const root = mkdtempSync(join(tmpdir(), "composer-runtime-refusal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate"), trusted = join(root, "trusted");
  mkdirSync(candidate); mkdirSync(trusted);
  const options = { candidate, provider: join(trusted, "provider"), callLog: join(trusted, "calls.log"), stateDirectory: candidate };
  await assert.rejects(startComposerCandidateRuntime(options), /outside candidate storage/);
  mkdirSync(join(candidate, ".composer-native-target/debug"), { recursive: true });
  writeFileSync(join(trusted, "host-file"), "must not be read as a runner");
  symlinkSync(join(trusted, "host-file"), join(candidate, ".composer-native-target/debug/paperclip-runnerd"));
  await assert.rejects(startComposerCandidateRuntime({ ...options, stateDirectory: trusted }), /must not traverse symlinks/);
});

test("runtime isolates candidate code and observes PIDs in the owned container, not the host", { timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "composer-runtime-boundary-"));
  const candidate = join(root, "candidate"), trusted = join(root, "trusted");
  mkdirSync(candidate); mkdirSync(trusted);
  mkdirSync(join(candidate, ".composer-native-target/debug"), { recursive: true });
  writeFileSync(join(candidate, ".composer-native-target/debug/paperclip-runnerd"), "fixture runner artifact\n");
  const provider = join(trusted, "provider"), callLog = join(trusted, "calls.log");
  writeFileSync(provider, "#!/bin/sh\ncat\n", { mode: 0o700 });
  let runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  runtime = await startComposerCandidateRuntime({ candidate, provider, callLog, stateDirectory: trusted, port: 0 });
  const env = { ...runtime.env, PAPERCLIP_STOP_REQUIRE_NATIVE: "true" };
  const inspected = verifyComposerCandidateRuntime(env);
  assert.equal(inspected.HostConfig.NetworkMode, "none");
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspected.HostConfig.Privileged, false);
  assert.deepEqual(inspected.Mounts.map(mount => mount.Destination).sort(), ["/candidate", "/composer-provider.sock", "/composer-runner", "/etc/passwd"]);
  const accountMount = inspected.Mounts.find(mount => mount.Destination === "/etc/passwd");
  assert.equal(accountMount.RW, false);
  assert.equal(accountMount.Source, join(trusted, "account-passwd"));
  assert.throws(() => verifyComposerCandidateRuntime({ ...env, COMPOSER_STOP_CONTAINER_OWNER: "00000000-0000-4000-8000-000000000000" }), /ownership/);
  const execute = source => execFileSync("docker", ["exec", "--env", "NODE_OPTIONS=", runtime.env.COMPOSER_STOP_CONTAINER_ID,
    "/usr/local/bin/node", "--input-type=module", "-e", source], { encoding: "utf8", timeout: 10000 });
  const account = JSON.parse(execute('import { userInfo } from "node:os"; console.log(JSON.stringify(userInfo()));'));
  assert.deepEqual(account, { uid: process.getuid(), gid: process.getgid(), username: "paperclip", homedir: "/tmp", shell: "/usr/sbin/nologin" });
  execute('import { writeFileSync } from "node:fs"; import { userInfo } from "node:os"; writeFileSync(userInfo().homedir + "/account-home-probe", "writable isolated home");');
  assert.throws(() => execute('import { writeFileSync } from "node:fs"; writeFileSync("/etc/passwd", "forged account")'), /EROFS|EACCES/);
  assert.throws(() => execute('import { writeFileSync } from "node:fs"; writeFileSync("/composer-runner", "forged runner")'), /EROFS|EACCES/);
  execute('import { writeFileSync, readFileSync } from "node:fs"; writeFileSync("/candidate/.composer-native-target/debug/paperclip-runnerd", "replacement"); if (readFileSync("/composer-runner", "utf8") !== "fixture runner artifact\\n") process.exit(1);');
  execute('import { createServer } from "node:http"; import { spawn } from "node:child_process"; const child = spawn(process.execPath, ["-e", \'require("node:http").createServer((q,s)=>s.end("isolated runtime")).listen(3199,"127.0.0.1")\'], { detached: true, stdio: "ignore" }); child.unref();');
  await t.test("trusted HTTP relay reaches only the container loopback", async () => {
    const deadline = Date.now() + 10000;
    let result;
    while (Date.now() < deadline) {
      try { result = await fetch(`http://127.0.0.1:${runtime.port}`, { signal: AbortSignal.timeout(2000) }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.equal(await result?.text(), "isolated runtime");
  });
  assert.equal(composerCandidateProcessAlive(1, env), true, "PID 1 is owned by the isolated runtime");
  assert.equal(composerCandidateProcessAlive(2147483647, env), false);
  const pid = Number(execute('import { spawn } from "node:child_process"; const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached:true, stdio:"ignore" }); child.unref(); console.log(child.pid);'));
  assert.equal(composerCandidateProcessAlive(pid, env), true);
  execute(`process.kill(${pid}, "SIGTERM")`);
  assert.equal(composerCandidateProcessAlive(pid, env), false, "terminated or zombie container processes are not alive");
  assert.throws(() => execute(`import { readFileSync } from "node:fs"; readFileSync(${JSON.stringify(provider)});`));
  await runtime.close();
  runtime = undefined;
  assert.throws(() => composerCandidateProcessAlive(1, env), /container/);
});
