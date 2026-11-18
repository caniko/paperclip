import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  atlasBridgeTokenDelivery,
  loadAtlasBridgeToken,
  buildSshEnvLabFixtureConfig,
  buildSshSpawnTarget,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
} from "./ssh.js";

const execFileAsync = promisify(execFile);

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-c", 'command -v "$1"', "paperclip-ssh-auth-test", command], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

describe("SSH authentication selection", () => {
  it("delivers the Atlas bearer out of band for bridge and adapter launches and cleans it up", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pc-atlas-auth-"));
    const fakeSsh = path.join(root, "ssh");
    const argvLog = path.join(root, "argv");
    await writeFile(fakeSsh, `#!/bin/sh\nexport PATH=${JSON.stringify(process.env.PATH || "/bin:/usr/bin")}\nprintf '%s\\n' "$@" >> '${argvLog}'\nfor arg do :; done\nexec /bin/sh -c "$arg"\n`, { mode: 0o700 });
    const spec = { host: "127.0.0.1", port: 2222, username: "worker", remoteCwd: root, remoteWorkspacePath: root,
      privateKey: "fixture-key", knownHosts: "fixture-host", strictHostKeyChecking: true,
      atlas: { sshExecutable: fakeSsh, scratchDir: root } };
    const runBearer = "host-run-marker";
    const bridgeBearer = "private-bridge-marker";
    const delivery = atlasBridgeTokenDelivery(spec, bridgeBearer);
    try {
      await delivery.deliver();
      expect((await stat(delivery.file)).mode & 0o777).toBe(0o600);
      const bridgeLoad = loadAtlasBridgeToken(delivery.file, "PAPERCLIP_BRIDGE_TOKEN");
      const bridge = await execFileAsync(fakeSsh, [`${bridgeLoad} && test -n "$PAPERCLIP_BRIDGE_TOKEN"`]);
      expect(bridge.stdout + bridge.stderr).toBe("");
      const launch = await buildSshSpawnTarget({ spec, command: "sh", args: ["-c", 'test -n "$PAPERCLIP_API_KEY"'],
        env: { PAPERCLIP_ATLAS_BRIDGE_TOKEN_FILE: delivery.file, PAPERCLIP_API_KEY: runBearer, ANTHROPIC_API_KEY: "controller-env-marker" } });
      try {
        expect(launch.command).toBe(fakeSsh);
        expect(launch.args).toEqual(expect.arrayContaining(["-F", "/dev/null", "IdentityAgent=none", "ClearAllForwardings=yes", "ControlPath=none"]));
        const invocation = await execFileAsync(launch.command, launch.args, { env: {} });
        expect(invocation.stdout + invocation.stderr).toBe("");
        await delivery.cleanup();
        await expect(execFileAsync(launch.command, launch.args, { env: {} })).rejects.toThrow();
      } finally { await launch.cleanup(); }
      const logged = await readFile(argvLog, "utf8");
      for (const marker of [runBearer, bridgeBearer, "controller-env-marker"]) expect(logged).not.toContain(marker);
    } finally {
      await delivery.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("does not authenticate with an agent key when the supplied key is rejected", async (context) => {
    const support = await getSshEnvLabSupport();
    if (!support.supported) context.skip(support.reason ?? "SSH fixture unavailable");
    if (process.getuid?.() === 0) context.skip("The SSH fixture disables root login, so it cannot authenticate as root");
    for (const command of ["ssh-agent", "ssh-add"]) {
      if (!(await commandAvailable(command))) context.skip(`Missing required command: ${command}`);
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "pc-auth-"));
    const socket = path.join(root, "agent.sock");
    const agent = spawn("ssh-agent", ["-D", "-a", socket], { stdio: "ignore" });
    const agentExit = new Promise<void>((resolve) => {
      agent.once("close", () => resolve());
      agent.once("error", () => resolve());
    });
    let fixture: SshEnvLabFixtureState | undefined;
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        ready = await stat(socket).then((entry) => entry.isSocket(), () => false);
        if (ready) break;
        await delay(20);
      }
      expect(ready).toBe(true);
      fixture = await startSshEnvLabFixture({ statePath: path.join(root, "server", "state.json") });
      const config = await buildSshEnvLabFixtureConfig(fixture);
      const env = { ...process.env, SSH_AUTH_SOCK: socket };
      await execFileAsync("ssh-add", [fixture.clientPrivateKeyPath], { env, timeout: 5_000 });
      const execute = async (privateKey: string | null) => {
        const target = await buildSshSpawnTarget({
          spec: { ...config, privateKey, remoteCwd: fixture!.workspaceDir },
          command: "printf",
          args: ["authenticated"],
          env: {},
        });
        try {
          return await execFileAsync(target.command, ["-F", "/dev/null", ...target.args], { env, timeout: 5_000 });
        } finally {
          await target.cleanup();
        }
      };
      expect((await execute(null)).stdout).toBe("authenticated");
      expect((await execute(config.privateKey)).stdout).toBe("authenticated");
      await expect(execute("invalid-fixture-key")).rejects.toMatchObject({
        code: 255,
        stderr: expect.stringContaining("Permission denied"),
      });
    } finally {
      agent.kill("SIGTERM");
      const killTimer = setTimeout(() => agent.kill("SIGKILL"), 2_000);
      try {
        await agentExit;
      } finally {
        clearTimeout(killTimer);
      }
      if (fixture) await stopSshEnvLabFixture(fixture);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.for([true, false])("preserves ambient agent selection only without a supplied key (explicit: %s)", async (explicit, context) => {
    if (!(await commandAvailable("ssh"))) context.skip("Missing required command: ssh");
    const target = await buildSshSpawnTarget({
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: "/srv/workspace",
        remoteWorkspacePath: "/srv/workspace",
        privateKey: explicit ? "fixture-key" : null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      command: "true",
      args: [],
      env: {},
    });
    const keyIndex = target.args.indexOf("-i");
    const keyPath = keyIndex < 0 ? null : target.args[keyIndex + 1];
    let root: string | undefined;
    try {
      root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-auth-"));
      const config = path.join(root, "config");
      await writeFile(config, "Host *\n  IdentityAgent /ambient/agent.sock\n  IdentitiesOnly no\n");
      const { stdout } = await execFileAsync(target.command, ["-G", "-F", config, ...target.args], { timeout: 5_000 });
      expect(stdout).toMatch(explicit ? /^identityagent none$/m : /^identityagent \/ambient\/agent.sock$/m);
      expect(stdout).toMatch(explicit ? /^identitiesonly yes$/m : /^identitiesonly no$/m);
      if (explicit) {
        expect(keyPath).toBeTruthy();
        expect(await readFile(keyPath!, "utf8")).toBe("fixture-key\n");
        expect((await stat(keyPath!)).mode & 0o777).toBe(0o600);
      } else {
        expect(keyPath).toBeNull();
      }
    } finally {
      await target.cleanup();
      if (root) await rm(root, { recursive: true, force: true });
    }
    if (keyPath) await expect(stat(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
