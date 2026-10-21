import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deploymentEnvironment, readCredential, validateDeploymentConfig } from "./runtime.js";

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
  it("refuses public credentials with redacted errors", () => {
    const d = mkdtempSync(join(tmpdir(), "paperclip-credential-")); dirs.push(d);
    const file = join(d, "secret"); writeFileSync(file, "do-not-print", { mode: 0o644 });
    expect(() => readCredential(file)).toThrow("publicly readable");
    try { readCredential(file); } catch (e) { expect(String(e)).not.toContain("do-not-print"); }
  });
  it("rejects unknown config fields instead of silently preserving typos", () => {
    expect(() => validateDeploymentConfig({ server: { porrt: 3100 } })).toThrow("server.porrt");
  });
});
