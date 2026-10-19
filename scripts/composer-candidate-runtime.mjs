import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import { appendFileSync, closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { composerCandidateDockerArgs } from "./composer-candidate-sandbox.mjs";
import { startComposerProviderBridge } from "./composer-provider-bridge.mjs";
import { GROK_PUBLIC_INSTALL_IMAGE } from "./grok-public-install-sandbox.mjs";

const docker = (args, timeout = 10000) => execFileSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
const ownerLabel = "paperclip.composer-owner";

export function verifyComposerCandidateRuntime(env = process.env) {
  const id = env.COMPOSER_STOP_CONTAINER_ID, owner = env.COMPOSER_STOP_CONTAINER_OWNER;
  assert.match(id ?? "", /^[a-f0-9]{64}$/, "Mandatory Stop requires trusted container identity");
  assert.match(owner ?? "", /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, "Mandatory Stop requires trusted container identity");
  let inspected;
  try { [inspected] = JSON.parse(docker(["inspect", "--type", "container", id])); }
  catch (cause) { throw new Error("Owned composer container is unavailable", { cause }); }
  assert.equal(inspected.Id, id, "Composer container identity changed");
  assert.equal(inspected.Config.Labels?.[ownerLabel], owner, "Composer container ownership mismatch");
  assert.equal(inspected.Config.Image, GROK_PUBLIC_INSTALL_IMAGE);
  assert.equal(inspected.State.Running, true, "Composer container must be running");
  assert.equal(inspected.HostConfig.NetworkMode, "none");
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspected.HostConfig.Privileged, false);
  assert.ok(inspected.HostConfig.CapDrop.includes("ALL"));
  assert.notEqual(inspected.HostConfig.PidMode, "host");
  assert.notEqual(inspected.HostConfig.IpcMode, "host");
  assert.match(inspected.Config.User, /^[1-9][0-9]*:[1-9][0-9]*$/);
  return inspected;
}

export async function startComposerCandidateRuntime({ candidate, provider, callLog, stateDirectory, port = 3199 }) {
  for (const path of [candidate, provider, callLog, stateDirectory]) assert.ok(typeof path === "string" && isAbsolute(path) && !/[\r\n,]/.test(path), "Runtime requires absolute trusted paths");
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, "Invalid runtime port");
  const stateLocation = relative(realpathSync(candidate), realpathSync(stateDirectory));
  assert.ok(stateLocation === ".." || stateLocation.startsWith("../") || isAbsolute(stateLocation), "Runtime custody must remain outside candidate storage");
  // Preparation containers have exited. Capture one regular candidate binary,
  // without following candidate symlinks, before starting any candidate writer.
  const binary = join(realpathSync(candidate), ".composer-native-target/debug/paperclip-runnerd");
  assert.equal(realpathSync(binary), binary, "Candidate runner must not traverse symlinks");
  const fd = openSync(binary, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const runnerBinary = join(stateDirectory, "paperclip-runnerd");
  try {
    const stat = fstatSync(fd);
    // ponytail: cap the frozen runner at 256 MiB; larger debug builds need review.
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 256 * 1024 * 1024, "Invalid candidate runner artifact");
    const bytes = readFileSync(fd);
    assert.equal(bytes.length, stat.size, "Candidate runner changed during capture");
    writeFileSync(runnerBinary, bytes, { flag: "wx", mode: 0o500 });
  } finally { closeSync(fd); }
  const socketPath = join(stateDirectory, "provider.sock");
  const bridge = await startComposerProviderBridge({ socketPath, provider, callLog, stateDirectory });
  const owner = randomUUID(), name = `composer-runtime-${owner}`;
  let env, server, closing;
  const connections = new Set();
  const close = () => closing ??= (async () => {
    for (const { socket, child } of connections) { socket.destroy(); child.kill("SIGTERM"); }
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    try {
      const [inspected] = JSON.parse(docker(["inspect", "--type", "container", env?.COMPOSER_STOP_CONTAINER_ID ?? name]));
      if (inspected.Config.Labels?.[ownerLabel] !== owner) throw new Error("Refusing cleanup of an unowned composer container");
      docker(["rm", "--force", inspected.Id]);
    } catch (error) {
      // A normally removed --rm container is absent; never remove by a reused name.
      if (env && !String(error.stderr ?? "").includes("No such container") && !String(error.stderr ?? "").includes("No such object")) throw error;
    } finally { await bridge.close(); }
  })();
  try {
    const uid = process.getuid(), gid = process.getgid();
    const args = composerCandidateDockerArgs({ candidate, phase: "runtime", uid, gid,
      command: ["/usr/local/bin/node", "-e", "setInterval(() => {}, 1000)"] });
    // GitHub's UID need not exist in the image. Supply only synthetic accounts,
    // never the host passwd file or a candidate-writable identity source.
    const passwd = join(stateDirectory, "account-passwd");
    writeFileSync(passwd, `root:x:0:0:root:/root:/usr/sbin/nologin\npaperclip:x:${uid}:${gid}:Paperclip verification:/tmp:/usr/sbin/nologin\n`, { flag: "wx", mode: 0o444 });
    args.splice(1, 0, "--detach", "--name", name, "--label", `${ownerLabel}=${owner}`,
      "--mount", `type=bind,src=${passwd},dst=/etc/passwd,readonly`,
      "--mount", `type=bind,src=${socketPath},dst=/composer-provider.sock,readonly`,
      "--mount", `type=bind,src=${runnerBinary},dst=/composer-runner,readonly`);
    env = { COMPOSER_STOP_CONTAINER_ID: docker(args, 90000).trim(), COMPOSER_STOP_CONTAINER_OWNER: owner, PAPERCLIP_RUNNER_BINARY: runnerBinary };
    const inspected = verifyComposerCandidateRuntime(env);
    assert.deepEqual(inspected.Mounts.map(mount => mount.Destination).sort(), ["/candidate", "/composer-provider.sock", "/composer-runner", "/etc/passwd"]);
    assert.equal(inspected.Mounts.find(mount => mount.Destination === "/candidate").Source, realpathSync(candidate));
    assert.equal(inspected.Mounts.find(mount => mount.Destination === "/etc/passwd").Source, realpathSync(passwd));
    for (const destination of ["/composer-provider.sock", "/composer-runner", "/etc/passwd"]) {
      assert.equal(inspected.Mounts.find(mount => mount.Destination === destination).RW, false);
    }
    const runtimeReceipt = join(stateDirectory, "runtime.json");
    const environment = JSON.parse(docker(["exec", inspected.Id, "/usr/local/bin/node", "-e",
      "console.log(JSON.stringify({platform:process.platform,architecture:process.arch,nodeVersion:process.versions.node,account:require('node:os').userInfo()}))"]));
    assert.equal(environment.platform, "linux");
    assert.equal(environment.architecture, "x64");
    assert.deepEqual(environment.account, { uid, gid, username: "paperclip", homedir: "/tmp", shell: "/usr/sbin/nologin" });
    writeFileSync(runtimeReceipt, JSON.stringify({ schema: "paperclip.composer-stop-runtime.v1", containerId: inspected.Id,
      owner, image: inspected.Config.Image, imageId: inspected.Image, ...environment,
      network: inspected.HostConfig.NetworkMode, readOnlyRoot: true, uid: inspected.Config.User,
      runnerSha256: createHash("sha256").update(readFileSync(runnerBinary)).digest("hex"),
      mounts: inspected.Mounts.map(({ Destination, RW }) => ({ destination: Destination, writable: RW })),
    }, null, 2), { flag: "wx", mode: 0o600 });
    env.COMPOSER_STOP_RUNTIME_RECEIPT = runtimeReceipt;
    // Keep network=none. Relay browser TCP over Docker exec stdio, never connect
    // the host to a candidate-controlled socket path or expose the Docker socket.
    server = createServer(socket => {
      // ponytail: 64 concurrent browser connections; larger suites need a bounded pool.
      if (connections.size >= 64) { socket.destroy(); return; }
      const child = spawn("docker", ["exec", "--interactive", "--env", "NODE_OPTIONS=", "--env", "NODE_PATH=", env.COMPOSER_STOP_CONTAINER_ID,
        "/usr/local/bin/node", "-e", 'const s=require("node:net").connect(3199,"127.0.0.1");s.on("error",()=>process.exit(1));process.stdin.pipe(s);s.pipe(process.stdout);'],
      { stdio: ["pipe", "pipe", "ignore"] });
      const connection = { socket, child };
      connections.add(connection);
      socket.setTimeout(30000, () => socket.destroy());
      socket.on("error", () => socket.destroy());
      child.on("error", () => socket.destroy());
      child.stdin.on("error", () => socket.destroy());
      socket.once("close", () => { child.kill("SIGTERM"); connections.delete(connection); });
      child.once("close", () => socket.destroy());
      socket.pipe(child.stdin); child.stdout.pipe(socket);
    });
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    return { env, port: server.address().port, close };
  } catch (error) { await close(); throw error; }
}

// This bootstrap executes only in the isolated container. Its provider client
// has protocol access, not the immutable provider executable, call log or state.
export async function serveInsideComposerContainer() {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");
  const directory = "/tmp/composer-runtime";
  await mkdir(`${directory}/codex-home`, { recursive: true });
  await writeFile(`${directory}/codex`, `#!/usr/local/bin/node
if (process.argv.includes("--version")) { console.log("codex-cli 0.999.0 (composer fixture)"); process.exit(0); }
if (process.argv[2] === "login") { console.log("Logged in using an API key"); process.exit(0); }
const socket = require("node:net").connect("/composer-provider.sock");
socket.on("error", error => { console.error(error.message); process.exit(1); });
process.stdin.pipe(socket); socket.pipe(process.stdout);
socket.on("end", () => process.exit(0));
`, { mode: 0o700 });
  await writeFile(`${directory}/preload.mjs`, `import { registerHooks } from "node:module";
registerHooks({ load(url, context, next) {
  if (/\\/packages\\/paperclip-runner\\/(src|dist)\\/drivers\\/codex\\/codex-command\\.(js|ts)$/.test(url))
    return { format: "module", shortCircuit: true, source: 'export const resolveCodexCommand = () => "/tmp/composer-runtime/codex"; export const resolvePinnedCodexCommand = resolveCodexCommand;' };
  return next(url, context);
} });
`);
  const env = {
    PATH: `${directory}:/candidate/.composer-tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`, HOME: directory,
    NODE_ENV: "test", NODE_OPTIONS: `--import=${directory}/preload.mjs`, CI: "true",
    CODEX_HOME: `${directory}/codex-home`, OPENAI_API_KEY: "composer-stop-fixture-key",
    PAPERCLIP_RUNNER_BINARY: "/composer-runner",
    PAPERCLIP_HOME: `${directory}/paperclip`, PAPERCLIP_CONFIG: `${directory}/paperclip/config.json`,
    PAPERCLIP_INSTANCE_ID: "playwright-e2e", PAPERCLIP_AGENT_JWT_SECRET: "playwright-e2e-agent-jwt-secret",
    PAPERCLIP_DECISION_SIGNING_SECRET: "playwright-e2e-decision-signing-secret",
    PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "playwright-e2e-tool-action-signing-secret",
    PAPERCLIP_UI_DEV_MIDDLEWARE: "false", PAPERCLIP_OPEN_ON_LISTEN: "false",
    PAPERCLIP_BIND: "loopback", PAPERCLIP_API_URL: "http://127.0.0.1:3199", PORT: "3199",
    PAPERCLIP_DEPLOYMENT_MODE: "local_trusted", PAPERCLIP_DEPLOYMENT_EXPOSURE: "private", HEARTBEAT_SCHEDULER_INTERVAL_MS: "10000",
  };
  const child = spawn("sh", ["-c", "node scripts/ensure-plugin-build-deps.mjs && pnpm --filter @paperclipai/ui build --outDir ../server/ui-dist --emptyOutDir && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts onboard --yes --run"],
    { cwd: "/candidate", env, stdio: "inherit" });
  const [code] = await new Promise(resolve => child.once("close", (...result) => resolve(result)));
  process.exitCode = code ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action, ...command] = process.argv.slice(2);
  if (action === "serve") {
    verifyComposerCandidateRuntime();
    const child = spawn("docker", ["exec", "--interactive", "--env", "NODE_OPTIONS=", "--env", "NODE_PATH=", process.env.COMPOSER_STOP_CONTAINER_ID,
      "/usr/local/bin/node", "--input-type=module", "-e", `await (${serveInsideComposerContainer.toString()})();`], { stdio: "inherit" });
    const [code] = await once(child, "close");
    process.exitCode = code ?? 1;
  } else if (action === "run") {
    assert.ok(command.length > 0, "Missing trusted browser command");
    const runtime = await startComposerCandidateRuntime({ candidate: process.env.COMPOSER_STOP_CANDIDATE_ROOT,
      provider: process.env.PAPERCLIP_STOP_FAKE_CODEX, callLog: process.env.PAPERCLIP_STOP_CODEX_LOG,
      stateDirectory: mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "composer-runtime-")) });
    try {
      if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV,
        `PAPERCLIP_RUNNER_BINARY=${runtime.env.PAPERCLIP_RUNNER_BINARY}\nCOMPOSER_STOP_RUNTIME_RECEIPT=${runtime.env.COMPOSER_STOP_RUNTIME_RECEIPT}\n`);
      const child = spawn(process.execPath, command, { env: { ...process.env, ...runtime.env }, stdio: "inherit" });
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
      const [code] = await once(child, "close"); process.exitCode = code ?? 1;
    }
    finally { await runtime.close(); }
  } else { throw new Error("Expected composer runtime run or serve"); }
}
