import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  atlasBridgeTokenDelivery,
  buildSshEnvLabFixtureConfig,
  buildSshSpawnTarget,
  createSshCommandManagedRuntimeRunner,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  syncDirectoryToSsh,
  type SshEnvLabFixtureState,
} from "./ssh.js";
import { ATLAS_CALLBACK_BRIDGE_ROUTES, authorizeSandboxCallbackBridgeRequestWithRoutes, createSandboxCallbackBridgeAsset, sandboxCallbackBridgeDirectories, startSandboxCallbackBridgeServer } from "./sandbox-callback-bridge.js";
import { startAdapterExecutionTargetPaperclipBridge } from "./execution-target.js";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";

const execFileAsync = promisify(execFile);

async function atlasFixtureSpec(root: string) {
  const fakeSsh = path.join(root, "ssh");
  const argvLog = path.join(root, "argv");
  await writeFile(fakeSsh, `#!/bin/sh\nexport PATH=${JSON.stringify(process.env.PATH || "/bin:/usr/bin")}\nprintf '%s\\n' "$@" >> '${argvLog}'\nfor arg do :; done\nexec /bin/sh -c "$arg"\n`, { mode: 0o700 });
  return { host: "127.0.0.1", port: 2222, username: "worker", remoteCwd: root, remoteWorkspacePath: root,
    privateKey: "fixture-key", knownHosts: "fixture-host", strictHostKeyChecking: true,
    atlas: { sshExecutable: fakeSsh, scratchDir: root } };
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-c", 'command -v "$1"', "paperclip-ssh-auth-test", command], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

describe("SSH authentication selection", () => {
  it("keeps Atlas bridge runtime control out of the queue allowlist", () => {
    for (const workspace of ["/api/execution-workspaces/x", "/api/projects/p/workspaces/x"]) {
      for (const alias of ["runtime-services", "runtime-commands"]) {
        for (const action of ["start", "restart"]) {
          const request = { method: "POST", path: `${workspace}/${alias}/${action}` };
          expect(authorizeSandboxCallbackBridgeRequestWithRoutes(request, ATLAS_CALLBACK_BRIDGE_ROUTES)).not.toBeNull();
        }
      }
    }
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes({ method: "GET", path: "/api/execution-workspaces/x" }, ATLAS_CALLBACK_BRIDGE_ROUTES)).toBeNull();
  });

  it.each(["models", "hello", "run"] as const)("sets only the fixed OpenCode launch flag for Atlas %s", async (invocation) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pc-atlas-opencode-"));
    try {
      const spec = await atlasFixtureSpec(root);
      const probe = invocation !== "run";
      const worker = path.join(root, "opencode");
      await writeFile(worker, "#!/bin/sh\nexec env\n", { mode: 0o700 });
      const bridge = atlasBridgeTokenDelivery(spec, "fixture-bridge-bearer");
      if (!probe) await bridge.deliver();
      try {
        const launch = await buildSshSpawnTarget({
          spec: { ...spec, atlas: { ...spec.atlas, adapterType: "opencode_local", ...(probe ? { probe: true } : {}) } },
          command: worker,
          args: invocation === "models" ? ["models"] : ["run", "--standalone", "--format", "json", "--model", "openai/gpt-4.1", "--variant", "high"],
          env: {
            OPENCODE_DISABLE_PROJECT_CONFIG: "0", CALLER_ONLY: "arbitrary", OPENAI_API_KEY: "fixture-host-provider",
            PAPERCLIP_API_KEY: "fixture-jwt", PAPERCLIP_BRIDGE_TOKEN: "fixture-bridge-bearer",
            PAPERCLIP_API_URL: "http://callback.invalid", PAPERCLIP_ATLAS_BRIDGE_TOKEN_FILE: bridge.file,
          },
        });
        try {
          const { stdout } = await execFileAsync(launch.command, launch.args, { env: {} });
          expect(stdout.split("\n").filter((line) => /^(OPENCODE_|PAPERCLIP_|OPENAI_|CALLER_ONLY=)/.test(line)).sort()).toEqual(
            probe ? ["OPENCODE_DISABLE_PROJECT_CONFIG=1"] : [
              "OPENCODE_DISABLE_PROJECT_CONFIG=1", "PAPERCLIP_API_KEY=fixture-bridge-bearer", "PAPERCLIP_API_URL=http://callback.invalid",
            ],
          );
          const remoteCommand = launch.args.at(-1)!;
          for (const forbidden of ["fixture-jwt", "fixture-bridge-bearer", "fixture-host-provider", "CALLER_ONLY", ...(probe ? [bridge.file, "callback.invalid"] : [])]) {
            expect(remoteCommand).not.toContain(forbidden);
          }
        } finally {
          await launch.cleanup();
        }
      } finally {
        if (!probe) await bridge.cleanup();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delivers the Atlas bearer out of band for bridge and adapter launches and cleans it up", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pc-atlas-auth-"));
    const argvLog = path.join(root, "argv");
    const spec = await atlasFixtureSpec(root);
    const runBearer = "host-run-marker";
    const bridgeBearer = "private-bridge-marker";
    const delivery = atlasBridgeTokenDelivery(spec, bridgeBearer);
    const asset = await createSandboxCallbackBridgeAsset();
    let bridge: Awaited<ReturnType<typeof startSandboxCallbackBridgeServer>> | undefined;
    try {
      await delivery.deliver();
      expect((await stat(delivery.file)).mode & 0o777).toBe(0o600);
      const bridgeInput = {
        runner: createSshCommandManagedRuntimeRunner({ spec }), remoteCwd: root,
        assetRemoteDir: path.join(root, "server"), queueDir: path.join(root, "queue"),
        nodeCommand: process.execPath, bridgeToken: bridgeBearer, protectedBridgeTokenFile: delivery.file, bridgeAsset: asset,
      };
      bridge = await startSandboxCallbackBridgeServer(bridgeInput);
      const bridgeArgv = await readFile(argvLog, "utf8");
      expect(bridgeArgv).toContain("nohup");
      expect(bridgeArgv).not.toContain(bridgeBearer);
      expect(await readFile(bridge.directories.logFile, "utf8")).not.toContain(bridgeBearer);
      const launch = await buildSshSpawnTarget({ spec, command: "sh", args: ["-c", 'test -n "$PAPERCLIP_API_KEY"'],
        env: { PAPERCLIP_ATLAS_BRIDGE_TOKEN_FILE: delivery.file, PAPERCLIP_API_KEY: runBearer, ANTHROPIC_API_KEY: "controller-env-marker" } });
      try {
        expect(launch.command).toBe(spec.atlas.sshExecutable);
        expect(launch.args).toEqual(expect.arrayContaining(["-F", "/dev/null", "IdentityAgent=none", "ClearAllForwardings=yes", "ControlPath=none"]));
        const invocation = await execFileAsync(launch.command, launch.args, { env: {} });
        expect(invocation.stdout + invocation.stderr).toBe("");
        await delivery.cleanup();
        await expect(execFileAsync(launch.command, launch.args, { env: {} })).rejects.toThrow();
      } finally { await launch.cleanup(); }
      const logged = await readFile(argvLog, "utf8");
      for (const marker of [runBearer, bridgeBearer, "controller-env-marker"]) expect(logged).not.toContain(marker);
      await bridge.stop();
      bridge = undefined;
      await expect(startSandboxCallbackBridgeServer(bridgeInput)).rejects.toThrow("Could not start the protected Atlas callback bridge");
    } finally {
      await bridge?.stop();
      await delivery.cleanup();
      await asset.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards only canonical Atlas queue paths and does not follow redirects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pc-atlas-queue-"));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { location: "/elsewhere" } }));
    let bridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
    try {
      const spec = await atlasFixtureSpec(root);
      bridge = await startAdapterExecutionTargetPaperclipBridge({ runId: "fixture-run", adapterKey: "claude", runtimeRootDir: root,
        target: { kind: "remote", transport: "ssh", remoteCwd: root, spec }, hostApiUrl: "http://fixture.invalid", hostApiToken: "fixture-token" });
      expect(bridge).not.toBeNull();
      const { requestsDir, responsesDir } = sandboxCallbackBridgeDirectories(path.join(root, "paperclip-bridge", "queue"));
      const deny = ["/api/issues/.", "/api/issues/%2e%2e", "/api/issues/a%2fb", "/api/issues/a%5cb", "/api/issues//x",
        "http://fixture.invalid/api/issues/x", "//fixture.invalid/api/issues/x"];
      const paths = [...deny, "/api/issues/fixture"];
      await Promise.all(paths.map(async (candidate, i) => {
        const id = `fixture-${i}`;
        const file = path.join(requestsDir, `${id}.json`);
        await writeFile(`${file}.tmp`, JSON.stringify({ id, method: "GET", path: candidate, query: "view=fixture", headers: {}, body: "" }));
        await rename(`${file}.tmp`, file);
      }));
      await vi.waitFor(async () => {
        const statuses = await Promise.all(paths.map(async (_, i) =>
          JSON.parse(await readFile(path.join(responsesDir, `fixture-${i}.json`), "utf8")).status));
        expect(statuses).toEqual([...deny.map(() => 403), 302]);
      }, { timeout: 8_000, interval: 50 });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(new URL("http://fixture.invalid/api/issues/fixture?view=fixture"), expect.objectContaining({ redirect: "manual" }));
    } finally {
      await bridge?.stop();
      fetch.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("allocates private Atlas directories per attempt without reusing prior results", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pc-atlas-scratch-"));
    try {
      const scratch = path.join(root, "local");
      await mkdir(scratch, { mode: 0o700 });
      const spec = await atlasFixtureSpec(root);
      spec.atlas.scratchDir = scratch;
      const input = { spec, runId: "same-run", adapterKey: "claude", workspaceLocalDir: scratch };
      const first = (await prepareRemoteManagedRuntime(input)).workspaceRemoteDir;
      const result = path.join(first, "result");
      await writeFile(result, "keep");
      const second = (await prepareRemoteManagedRuntime(input)).workspaceRemoteDir;
      expect(second).not.toBe(first);
      for (const attempt of [first, second]) {
        expect(path.dirname(attempt)).toBe(root);
        expect((await stat(attempt)).mode & 0o777).toBe(0o700);
      }
      await expect(syncDirectoryToSsh({ spec, localDir: scratch, remoteDir: first, createFresh: true })).rejects.toThrow();
      expect(await readFile(result, "utf8")).toBe("keep");
    } finally { await rm(root, { recursive: true, force: true }); }
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
