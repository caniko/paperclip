import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composerCandidateDockerArgs } from "../composer-candidate-sandbox.mjs";
import { startComposerProviderBridge } from "../composer-provider-bridge.mjs";

test("isolated runtime talks to a trusted provider without call-log or provider write authority", async t => {
  const root = mkdtempSync(join(tmpdir(), "composer-provider-boundary-"));
  let bridge;
  t.after(async () => {
    try { if (bridge) await bridge.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const candidate = join(root, "candidate"), trusted = join(root, "trusted");
  mkdirSync(candidate); mkdirSync(trusted);
  const provider = join(trusted, "provider"), callLog = join(trusted, "calls.log"), socketPath = join(trusted, "provider.sock");
  const verifier = join(trusted, "verifier.mjs");
  writeFileSync(verifier, "independently trusted verifier\n");
  writeFileSync(callLog, "independently trusted log\n");
  // A fixed host-owned protocol fixture, never code or arguments from the client.
  writeFileSync(provider, `#!${process.execPath}
    const { createInterface } = require("node:readline");
    const { appendFileSync } = require("node:fs");
    const log = process.argv[process.argv.indexOf("--call-log") + 1];
    createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line);
      appendFileSync(log, JSON.stringify({ method: request.method }) + "\\n");
      process.stdout.write(JSON.stringify({ id: request.id, result: "trusted-provider-response", pid: process.pid }) + "\\n");
    });`, { mode: 0o755 });
  const providerBytes = readFileSync(provider);
  bridge = await startComposerProviderBridge({ socketPath, provider, callLog, stateDirectory: trusted });
  writeFileSync(join(candidate, "client.mjs"), `import { createConnection } from "node:net";
    import { writeFileSync } from "node:fs";
    for (const target of ${JSON.stringify([provider, callLog, verifier])}) {
      try { writeFileSync(target, "candidate forged acceptance\\n"); } catch {}
    }
    const socket = createConnection("/provider.sock", () => socket.end(JSON.stringify({ id: 1, method: "turn/interrupt" }) + "\\n"));
    socket.on("data", chunk => process.stdout.write(chunk));
    socket.on("error", error => { console.error(error.message); process.exitCode = 1; });`);
  const name = `composer-provider-${randomUUID()}`;
  const args = composerCandidateDockerArgs({ candidate, phase: "runtime", command: ["node", "/candidate/client.mjs"], uid: process.getuid(), gid: process.getgid() });
  args.splice(1, 0, "--name", name, "--mount", `type=bind,src=${socketPath},dst=/provider.sock,readonly`);
  let stdout = "", stderr = "";
  try {
    const child = spawn("docker", args, { timeout: 90_000 });
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-16_384); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16_384); });
    const [status] = await once(child, "close");
    assert.equal(status, 0, `isolated client must execute: ${stderr}`);
    const response = JSON.parse(stdout);
    assert.deepEqual({ id: response.id, result: response.result }, { id: 1, result: "trusted-provider-response" });
    assert.ok(Number.isSafeInteger(response.pid) && response.pid > 0);
    await bridge.close();
    bridge = undefined;
    assert.throws(() => process.kill(response.pid, 0), error => error.code === "ESRCH", "trusted provider must exit before bridge cleanup completes");
    assert.equal(readFileSync(callLog, "utf8"), 'independently trusted log\n{"method":"turn/interrupt"}\n');
    assert.deepEqual(readFileSync(provider), providerBytes);
    assert.equal(readFileSync(verifier, "utf8"), "independently trusted verifier\n");
  } finally {
    spawnSync("docker", ["rm", "--force", name], { encoding: "utf8", timeout: 20_000 });
  }
});

test("provider bridge refuses relative paths before opening a listener or spawning a process", async () => {
  const paths = { socketPath: "/trusted/provider.sock", provider: "/trusted/provider", callLog: "/trusted/calls.log", stateDirectory: "/trusted/state" };
  for (const field of Object.keys(paths)) {
    await assert.rejects(startComposerProviderBridge({ ...paths, [field]: "candidate-controlled" }), /absolute trusted paths/);
  }
});
