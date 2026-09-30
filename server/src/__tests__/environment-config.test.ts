import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  normalizeEnvironmentConfig,
  normalizeEnvironmentConfigForPersistence,
  normalizeEnvironmentConfigForProbe,
  parseEnvironmentDriverConfig,
} from "../services/environment-config.ts";
import type { Db } from "@paperclipai/db";

describe("environment config helpers", () => {
  it.each(["local", "ssh"] as const)("requires explicit, complete in-place ownership for %s", (driver) => {
    const config = driver === "ssh" ? { host: "worker", username: "alice", remoteWorkspacePath: "/data/link/../work " } : {};
    const filesystemOwnership = { authority: "authority-1", principal: "controller-1", roots: ["/data/link/../work ", "/data/shared"] };
    const normalize = (extra: Record<string, unknown>) => normalizeEnvironmentConfig({ driver, config: { ...config, ...extra } });
    expect(normalize({})).not.toHaveProperty("filesystemOwnership");
    expect(normalize({ workspaceRealizationMode: "in_place", filesystemOwnership })).toMatchObject({ filesystemOwnership });
    for (const invalid of [{}, { ...filesystemOwnership, roots: [] }, { ...filesystemOwnership, roots: ["relative"] },
      { ...filesystemOwnership, roots: ["/data/\0"] }, { ...filesystemOwnership, principal: "" }, { ...filesystemOwnership, unknown: true }]) {
      expect(() => normalize({ workspaceRealizationMode: "in_place", filesystemOwnership: invalid })).toThrow();
    }
    expect(() => normalize({ filesystemOwnership })).toThrow("in-place");
    expect(() => normalize({ workspaceRealizationMode: "copy", filesystemOwnership })).toThrow("in-place");
  });
  it.each(["local", "ssh"] as const)("normalizes %s ownership clearing to omission across config entry points", async (driver) => {
    const config = {
      ...(driver === "ssh" ? { host: "worker", username: "alice", remoteWorkspacePath: "/data/link/../work " } : {}),
      workspaceRealizationMode: "copy",
      filesystemOwnership: null,
    };
    const context = { db: {} as Db, companyId: "company-1", driver, config };
    const normalizedConfigs = [
      normalizeEnvironmentConfig({ driver, config }),
      await normalizeEnvironmentConfigForProbe(context),
      await normalizeEnvironmentConfigForPersistence({
        ...context, environmentName: "Worker", secretProvider: "local_encrypted",
      }),
      parseEnvironmentDriverConfig({ driver, config }).config,
    ];
    for (const normalized of normalizedConfigs) {
      expect(normalized).toMatchObject({ workspaceRealizationMode: "copy" });
      expect(normalized).not.toHaveProperty("filesystemOwnership");
    }
  });
  it.each(["local", "ssh"] as const)("preserves an explicit %s in-place policy and rejects invalid modes", (driver) => {
    const config = driver === "ssh"
      ? { host: "worker.example", username: "alice", remoteWorkspacePath: "/srv/link/../data " }
      : {};
    expect(normalizeEnvironmentConfig({ driver, config: { ...config, workspaceRealizationMode: "in_place" } }))
      .toMatchObject({ ...config, workspaceRealizationMode: "in_place" });
    expect(() => normalizeEnvironmentConfig({ driver, config: { ...config, workspaceRealizationMode: "typo" } }))
      .toThrow(HttpError);
  });
  it("normalizes SSH config into its canonical stored shape", () => {
    const config = normalizeEnvironmentConfig({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: "2222",
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
          version: "latest",
        },
        knownHosts: "",
      },
    });

    expect(config).toEqual({
      host: "ssh.example.test",
      port: 2222,
      username: "ssh-user",
      remoteWorkspacePath: "/srv/paperclip/workspace",
      privateKey: null,
      privateKeySecretRef: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
        version: "latest",
      },
      knownHosts: null,
      strictHostKeyChecking: true,
    });
  });

  it("rejects raw SSH private keys in the stored config shape", () => {
    expect(() =>
      normalizeEnvironmentConfig({
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          port: "2222",
          username: "ssh-user",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: "PRIVATE KEY",
        },
      }),
    ).toThrow(HttpError);
  });

  it("rejects SSH config without an absolute remote workspace path", () => {
    expect(() =>
      normalizeEnvironmentConfig({
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          username: "ssh-user",
          remoteWorkspacePath: "workspace",
        },
      }),
    ).toThrow(HttpError);

    expect(() =>
      normalizeEnvironmentConfig({
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          username: "ssh-user",
          remoteWorkspacePath: "workspace",
        },
      }),
    ).toThrow("absolute");
  });

  it("parses a persisted SSH environment into a typed driver config", () => {
    const parsed = parseEnvironmentDriverConfig({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: null,
        knownHosts: null,
        strictHostKeyChecking: false,
      },
    });

    expect(parsed).toEqual({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: null,
        knownHosts: null,
        strictHostKeyChecking: false,
      },
    });
  });

  it("normalizes sandbox config into its canonical stored shape", () => {
    const config = normalizeEnvironmentConfig({
      driver: "sandbox",
      config: {
        provider: "fake",
        image: "  ubuntu:24.04  ",
      },
    });

    expect(config).toEqual({
      provider: "fake",
      image: "ubuntu:24.04",
      reuseLease: false,
    });
  });

  it("loads a strict fake sandbox config that still carries the removed streamAgentSessionOutput key and drops it", () => {
    // Session-output streaming moved from an operator flag to the capability
    // snapshot. The fake sandbox schema is `.strict()`, so an undeclared key
    // would fail validation. A saved config that still carries the removed key
    // must load, and the removed key must not reach the stored config.
    const config = normalizeEnvironmentConfig({
      driver: "sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        streamAgentSessionOutput: true,
      },
    });

    expect(config).toEqual({
      provider: "fake",
      image: "ubuntu:24.04",
      reuseLease: false,
    });
    expect(config).not.toHaveProperty("streamAgentSessionOutput");
  });

  it("loads a plugin sandbox config that still carries the removed streamAgentSessionOutput key and drops it", () => {
    // The plugin sandbox schema uses `.catchall`, so an unknown key passes
    // through. The removed key must still drop, so no consumer reads a stale
    // operator flag.
    const config = normalizeEnvironmentConfig({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        streamAgentSessionOutput: true,
      },
    });

    expect(config).not.toHaveProperty("streamAgentSessionOutput");
    expect(config).toMatchObject({ provider: "fake-plugin", image: "fake:test" });
  });

  it("parses a persisted sandbox environment into a typed driver config", () => {
    const parsed = parseEnvironmentDriverConfig({
      driver: "sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });

    expect(parsed).toEqual({
      driver: "sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });
  });

  it("normalizes schema-driven sandbox config into the generic plugin-backed stored shape", () => {
    const config = normalizeEnvironmentConfig({
      driver: "sandbox",
      config: {
        provider: "secure-plugin",
        template: "  base  ",
        apiKey: "22222222-2222-2222-2222-222222222222",
        timeoutMs: "450000",
      },
    });

    expect(config).toEqual({
      provider: "secure-plugin",
      template: "  base  ",
      apiKey: "22222222-2222-2222-2222-222222222222",
      timeoutMs: 450000,
      reuseLease: false,
    });
  });

  it("normalizes plugin-backed sandbox provider config without server provider changes", () => {
    const config = normalizeEnvironmentConfig({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        image: "  fake:test  ",
        timeoutMs: "120000",
        reuseLease: true,
        customFlag: "kept",
      },
    });

    expect(config).toEqual({
      provider: "fake-plugin",
      image: "  fake:test  ",
      timeoutMs: 120000,
      reuseLease: true,
      customFlag: "kept",
    });
  });

  it("parses a persisted schema-driven sandbox environment into a typed driver config", () => {
    const parsed = parseEnvironmentDriverConfig({
      driver: "sandbox",
      config: {
        provider: "secure-plugin",
        template: "base",
        apiKey: "22222222-2222-2222-2222-222222222222",
        timeoutMs: 300000,
        reuseLease: true,
      },
    });

    expect(parsed).toEqual({
      driver: "sandbox",
      config: {
        provider: "secure-plugin",
        template: "base",
        apiKey: "22222222-2222-2222-2222-222222222222",
        timeoutMs: 300000,
        reuseLease: true,
      },
    });
  });

  it("parses a persisted plugin-backed sandbox environment into a typed driver config", () => {
    const parsed = parseEnvironmentDriverConfig({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 300000,
        reuseLease: true,
      },
    });

    expect(parsed).toEqual({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 300000,
        reuseLease: true,
      },
    });
  });

  it("normalizes plugin environment config into its canonical stored shape", () => {
    const config = normalizeEnvironmentConfig({
      driver: "plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: {
          template: "base",
        },
      },
    });

    expect(config).toEqual({
      pluginKey: "acme.environments",
      driverKey: "fake-plugin",
      driverConfig: {
        template: "base",
      },
    });
  });
});
