import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync } from "node:fs";
import { deploymentDescriptorSchema, deploymentEnvironment, readCredential, validateDeploymentConfig } from "./runtime.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
describe("declarative startup credentials", () => {
  it("reads multiline credentials literally without executing or exposing them", () => {
    const d = mkdtempSync(join(tmpdir(), "paperclip-credential-")); dirs.push(d);
    const file = join(d, "secret");
    const value = "$(touch /never-execute)\nsecond='quoted'\n";
    writeFileSync(file, value, { mode: 0o600 });
    expect(readCredential(file)).toBe(value);
    const env = deploymentEnvironment({ version: 1, home: d, instance: "one", configFile: "/config.json", credentialFiles: {}, serverCredentials: { auth: file } }, {
      PATH: "/bin", DATABASE_URL: "bad", HOST: "0.0.0.0", PAPERCLIP_CONFIG: "/wrong", BETTER_AUTH_SECRET: "bad", UNRELATED_KEY: "bad",
      XDG_CONFIG_HOME: "/home/operator/.config", XDG_DATA_HOME: "/home/operator/.local/share",
      XDG_STATE_HOME: "/home/operator/.local/state", XDG_CACHE_HOME: "/home/operator/.cache", XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(value.trimEnd());
    expect(env.PAPERCLIP_CONFIG).toBe("/config.json");
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.HOST).toBeUndefined();
    expect(env.UNRELATED_KEY).toBeUndefined();
    expect(env).toMatchObject({ XDG_CONFIG_HOME: "/home/operator/.config", XDG_DATA_HOME: "/home/operator/.local/share",
      XDG_STATE_HOME: "/home/operator/.local/state", XDG_CACHE_HOME: "/home/operator/.cache", XDG_RUNTIME_DIR: "/run/user/1000" });
  });
  it("pins the agent API URL from the descriptor and ignores the ambient one", () => {
    const d = mkdtempSync(join(tmpdir(), "paperclip-credential-")); dirs.push(d);
    const file = join(d, "secret"); writeFileSync(file, "x".repeat(32), { mode: 0o600 });
    const base = { version: 1 as const, home: d, instance: "one", configFile: "/config.json", credentialFiles: {}, serverCredentials: { auth: file } };
    expect(deploymentEnvironment({ ...base, apiUrl: "http://127.0.0.1:3117" }, { PAPERCLIP_API_URL: "https://elsewhere.example" }).PAPERCLIP_API_URL).toBe("http://127.0.0.1:3117");
    expect(deploymentEnvironment(base, { PAPERCLIP_API_URL: "https://elsewhere.example" }).PAPERCLIP_API_URL).toBeUndefined();
  });
  it("refuses public credentials with redacted errors", () => {
    const d = mkdtempSync(join(tmpdir(), "paperclip-credential-")); dirs.push(d);
    const file = join(d, "secret"); writeFileSync(file, "do-not-print", { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(() => readCredential(file)).toThrow("publicly readable");
    try { readCredential(file); } catch (e) { expect(String(e)).not.toContain("do-not-print"); }
  });
  it("rejects unknown config fields instead of silently preserving typos", () => {
    expect(() => validateDeploymentConfig({ server: { porrt: 3100 } })).toThrow("server.porrt");
  });
  it("requires an explicit, strict Atlas admission policy, including for a closed Board", () => {
    const descriptor = { version: 1, home: "/var/lib/paperclip", instance: "one", configFile: "/config.json", executionProfile: "atlas-ssh" };
    for (const policy of [undefined, {}, { admissions: null }, { admissions: [{}] }, { admissions: [], fallback: "local" }]) {
      expect(deploymentDescriptorSchema.safeParse({ ...descriptor, atlasExecutionPolicy: policy }).success).toBe(false);
    }
    expect(deploymentDescriptorSchema.safeParse({ ...descriptor, atlasExecutionPolicy: { admissions: [] } }).success).toBe(true);
    expect(deploymentDescriptorSchema.safeParse({ ...descriptor, executionProfile: "trusted-local" }).success).toBe(true);
    expect(deploymentDescriptorSchema.safeParse({ ...descriptor, executionProfile: "remote-only" }).success).toBe(true);
  });

  it("admits only explicit, strictly pinned Atlas OpenCode bindings", () => {
    const descriptor = { version: 1, home: "/var/lib/paperclip", instance: "one", configFile: "/config.json",
      executionProfile: "atlas-ssh", credentialFiles: { worker: "/run/paperclip/key" } };
    const binding = {
      companyId: "01c386b4-02a5-4071-9e07-bea5d4f2824d", agentId: "978d03ab-e5da-44f8-9b88-2f614bf5f047",
      environmentId: "91b06dd5-36df-45f8-94aa-d63c03436aeb", workspaceClass: "copy-scratch",
      command: "/worker/opencode", sshExecutable: "/bin/ssh", remoteWorkspacePath: "/worker/scratch",
      host: "::1", port: 2222, username: "worker", privateKeyCredential: "worker",
      hostKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"A".repeat(43)}`,
      adapterType: "opencode_local", standalone: true, model: "openrouter/provider/model:fast", variant: "high",
    };
    const accepts = (...admissions: unknown[]) =>
      deploymentDescriptorSchema.safeParse({ ...descriptor, atlasExecutionPolicy: { admissions } }).success;
    expect(accepts(binding)).toBe(true);
    for (const change of [
      { standalone: undefined }, { standalone: false }, { model: undefined }, { model: "bare" }, { model: "/model" },
      { model: "provider/" }, { model: "provider/model\n" }, { model: "provider/model#low" }, { variant: undefined },
      { variant: "" }, { variant: "high medium" }, { variant: "high\u007f" }, { managedService: true }, { extraArgs: [] },
      { env: {} }, { adapterType: "claude_local" }, { privateKeyCredential: "unbound" }, { host: "192.0.2.1" },
      { command: "/worker/../opencode" }, { username: "root" }, { hostKey: `${binding.hostKey} comment` },
    ]) expect(accepts({ ...binding, ...change }), JSON.stringify(change)).toBe(false);
    expect(accepts(binding, binding)).toBe(false);
  });
});
