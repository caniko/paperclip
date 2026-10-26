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

  it("accepts Claude Code's CLI engine with an explicit permission choice", () => {
    expect(() => validateDeclaredAdapterConfig("claude_local", {
      engine: "cli", command: "claude", model: "claude-opus-5-5", cwd: "/workspace",
      dangerouslySkipPermissions: false, extraArgs: ["--allowedTools", "mcp__open-pencil"],
      timeoutSec: 900, graceSec: 20, maxTurnsPerRun: 40,
    }, {})).not.toThrow();
    expect(() => validateDeclaredAdapterConfig("claude_local", {
      engine: "cli", dangerouslySkipPermissions: false,
    }, { "env.CLAUDE_CODE_OAUTH_TOKEN": "claude-oauth" })).not.toThrow();
  });

  it("accepts Codex's CLI engine with an explicit approvals-and-sandbox choice", () => {
    expect(() => validateDeclaredAdapterConfig("codex_local", {
      engine: "cli", command: "codex", model: "gpt-6.1-sol", modelReasoningEffort: "high",
      dangerouslyBypassApprovalsAndSandbox: false, timeoutSec: 900, graceSec: 20,
    }, {})).not.toThrow();
  });

  it("accepts T3 Code threads with provider and model together", () => {
    expect(() => validateDeclaredAdapterConfig("t3code_local", {
      command: "t3", provider: "claudeAgent", model: "claude-opus-5-5", timeoutSec: 900, graceSec: 20,
    }, {})).not.toThrow();
    expect(() => validateDeclaredAdapterConfig("t3code_local", { command: "t3" }, {})).not.toThrow();
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
    ["claude_local", { command: "claude", dangerouslySkipPermissions: false }, {}],
    ["claude_local", { engine: "acp", dangerouslySkipPermissions: false }, {}],
    ["claude_local", { engine: "auto", dangerouslySkipPermissions: false }, {}],
    ["claude_local", { engine: "cli" }, {}],
    ["claude_local", { engine: "cli", dangerouslySkipPermissions: false, chrome: true }, {}],
    ["claude_local", { engine: "cli", dangerouslySkipPermissions: false, filesystemScope: "workspace" }, {}],
    ["claude_local", { engine: "cli", dangerouslySkipPermissions: false, maxTurnsPerRun: 1.5 }, {}],
    ["claude_local", { engine: "cli", dangerouslySkipPermissions: false, env: { ANTHROPIC_API_KEY: "inline" } }, {}],
    ["claude_local", { engine: "cli", dangerouslySkipPermissions: false }, { apiKey: "provider" }],
    ["claude_local", { engine: "cli", dangerouslySkipPermissions: false }, { "env.PAPERCLIP_API_KEY": "provider" }],
    ["claude_local", { engine: "cli", dangerouslySkipPermissions: false, env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } }, { "env.CLAUDE_CODE_OAUTH_TOKEN": "claude-oauth" }],
    ["codex_local", { dangerouslyBypassApprovalsAndSandbox: false }, {}],
    ["codex_local", { engine: "acp", dangerouslyBypassApprovalsAndSandbox: false }, {}],
    ["codex_local", { engine: "cli" }, {}],
    ["codex_local", { engine: "cli", dangerouslyBypassApprovalsAndSandbox: false, networkScope: "open" }, {}],
    ["codex_local", { engine: "cli", dangerouslyBypassApprovalsAndSandbox: false, env: { OPENAI_API_KEY: "inline" } }, {}],
    ["codex_local", { engine: "cli", dangerouslyBypassApprovalsAndSandbox: false }, { "env.OPENAI_API_KEY": "provider" }],
    ["t3code_local", { provider: "claudeAgent" }, {}],
    ["t3code_local", { model: "claude-opus-5-5" }, {}],
    ["t3code_local", { command: "t3", worktree: "main" }, {}],
    ["t3code_local", { command: "t3" }, { "env.ANTHROPIC_API_KEY": "provider" }],
    ["invented_remote", {}, {}],
  ] as const)("rejects unsupported, malformed, inline-secret or conflicting %s configuration", (type, config, credentials) => {
    expect(() => validateDeclaredAdapterConfig(type, config, credentials)).toThrow();
  });
});
