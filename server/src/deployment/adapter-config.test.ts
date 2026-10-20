import { describe, expect, it } from "vitest";
import { validateDeclaredAdapterConfig } from "./adapter-config.js";

describe("native declaration adapter contracts", () => {
  it("accepts structured process arguments and environment credential bindings", () => {
    expect(() => validateDeclaredAdapterConfig("process", {
      command: "/run/current-system/sw/bin/worker", args: ["--once"], env: { MODE: "test" },
    }, { "env.WORKER_TOKEN": "worker" })).not.toThrow();
  });

  it("accepts OpenCode's native configuration without replacing personal permissions", () => {
    expect(() => validateDeclaredAdapterConfig("opencode_local", {
      command: "opencode", model: "openai/gpt-5.4", cwd: "/workspace",
      dangerouslySkipPermissions: false, timeoutSec: 900, graceSec: 20,
      extraArgs: [], env: {
        MODE: "test",
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
          gateway: { options: { baseURL: "https://gateway.example.test/v1", apiKey: "{env:OPENAI_API_KEY}" } },
        }),
      },
    }, { "env.OPENAI_API_KEY": "provider" })).not.toThrow();
  });

  it("requires an explicit OpenCode permission choice", () => {
    expect(() => validateDeclaredAdapterConfig("opencode_local", {}, {})).toThrow();
  });

  it("declares managed OpenCode without overriding the personal backend", () => {
    expect(() => validateDeclaredAdapterConfig("opencode_local", {
      managedService: true, dangerouslySkipPermissions: false, model: "openai/gpt-6.1-sol", cwd: "/workspace",
    }, {})).not.toThrow();
    for (const overrides of [{ dangerouslySkipPermissions: true }, { env: { HOME: "/other" } }, { extraArgs: ["--standalone"] }]) {
      expect(() => validateDeclaredAdapterConfig("opencode_local", {
        managedService: true, dangerouslySkipPermissions: false, ...overrides,
      }, {})).toThrow();
    }
  });

  it("accepts structured HTTP and Hermes payloads without using form field types", () => {
    expect(() => validateDeclaredAdapterConfig("http", {
      url: "https://worker.example.test/invoke", headers: { Accept: "application/json" },
      payloadTemplate: { task: { labels: ["test"] } }, timeoutMs: 1000,
    }, {})).not.toThrow();
    expect(() => validateDeclaredAdapterConfig("hermes_gateway", {
      apiBaseUrl: "https://worker.example.test", headers: { "X-Worker": "test" },
      payloadTemplate: { instructions: "Follow the task" }, pollIntervalMs: 500,
    }, { apiKey: "gateway" })).not.toThrow();
  });

  it("accepts the remote Stop and recovery fixture's explicit job lifetime", () => {
    for (const waitForJobs of [true, false]) {
      expect(() => validateDeclaredAdapterConfig("hermes_gateway", {
        apiBaseUrl: "http://worker:8642", paperclipApiUrl: "http://controller:3115",
        dangerouslyAllowInsecureRemoteHttp: true, waitForJobs,
      }, { apiKey: "gateway" })).not.toThrow();
    }
  });

  it.each([
    ["process", { command: "worker", args: "--once" }, {}],
    ["process", { command: "worker", timeoutSec: -1 }, {}],
    ["http", { url: "file:///etc/passwd" }, {}],
    ["http", { url: "https://worker.test", timeoutSec: 10 }, {}],
    ["hermes_gateway", { apiBaseUrl: "https://worker.test", apiKey: "inline-secret" }, {}],
    ["hermes_gateway", { apiBaseUrl: "https://worker.test" }, {}],
    ["hermes_gateway", { apiBaseUrl: "https://worker.test" }, { instructions: "secret" }],
    ["hermes_gateway", { apiBaseUrl: "https://worker.test", waitForJobs: "true" }, { apiKey: "gateway" }],
    ["hermes_gateway", { apiBaseUrl: "https://worker.test", waitForJobs: 1 }, { apiKey: "gateway" }],
    ["process", { command: "worker", env: { WORKER_TOKEN: "inline" } }, { "env.WORKER_TOKEN": "worker" }],
    ["process", { command: "worker" }, { "env.NODE_OPTIONS": "worker" }],
    ["process", { command: "worker" }, { "env.PAPERCLIP_API_KEY": "worker" }],
    ["opencode_local", { dangerouslySkipPermissions: "false" }, {}],
    ["opencode_local", { timeoutSec: -1 }, {}],
    ["opencode_local", { extraArgs: "--auto" }, {}],
    ["opencode_local", { apiBaseUrl: "https://worker.test" }, {}],
    ["opencode_local", { dangerouslySkipPermissions: false }, { apiKey: "provider" }],
    ["opencode_local", { dangerouslySkipPermissions: false }, { "env.NODE_OPTIONS": "provider" }],
    ["opencode_local", { dangerouslySkipPermissions: false }, { "env.PAPERCLIP_API_KEY": "provider" }],
    ["opencode_local", { dangerouslySkipPermissions: false, env: { OPENAI_API_KEY: "inline" } }, { "env.OPENAI_API_KEY": "provider" }],
    ["opencode_local", { dangerouslySkipPermissions: false, env: { OPENAI_API_KEY: "inline" } }, {}],
    ["process", { command: "worker", env: { GITHUB_TOKEN: "inline" } }, {}],
    ["opencode_local", { dangerouslySkipPermissions: false, env: {
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({ gateway: { options: { apiKey: "sk-inline" } } }),
    } }, {}],
    ["opencode_local", { dangerouslySkipPermissions: false, env: {
      PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({ gateway: { options: { headers: { Authorization: "Bearer sk-inline" } } } }),
    } }, {}],
    ["invented_remote", {}, {}],
  ] as const)("rejects unsupported, malformed, inline-secret or conflicting %s configuration", (type, config, credentials) => {
    expect(() => validateDeclaredAdapterConfig(type, config, credentials)).toThrow();
  });
});
