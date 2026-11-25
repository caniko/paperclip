import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { formatAgyStreamJsonInput } from "./parse.js";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  prepareAdapterExecutionTargetRuntime,
} = vi.hoisted(() => {
  const restoreWorkspace = vi.fn(async () => {});
  return {
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    runAdapterExecutionTargetProcess: vi.fn(async (_runId: string, _target: unknown, _command: string, args: string[]) => {
      if (args[0] === "models") {
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "gemini-4-neon-high\tGemini 4 Neon (High)\n",
          stderr: "",
          pid: 122,
          startedAt: new Date().toISOString(),
        };
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ event: "init", conversation_id: "agy-probe-1", init: { model: "gemini-4-neon-high" } }),
          JSON.stringify({
            event: "step_update",
            step_update: { conversation_id: "agy-probe-1", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "hello\n" },
          }),
          JSON.stringify({
            event: "result",
            result: { conversation_id: "agy-probe-1", status: "SUCCESS", response: "hello\n" },
          }),
        ].join("\n"),
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    }),
    describeAdapterExecutionTarget: vi.fn(() => "Atlas worker"),
    resolveAdapterExecutionTargetCwd: vi.fn((target, configuredCwd, fallbackCwd) => {
      if (typeof configuredCwd === "string" && configuredCwd.trim().length > 0) return configuredCwd;
      if (target && typeof target === "object" && "remoteCwd" in target && typeof target.remoteCwd === "string") {
        return target.remoteCwd;
      }
      return fallbackCwd;
    }),
    prepareAdapterExecutionTargetRuntime: vi.fn(async () => ({
      target: null,
      workspaceRemoteDir: "/remote/workspace/attempt-probe",
      runtimeRootDir: "/remote/workspace/attempt-probe/.paperclip-runtime/gemini",
      assetDirs: {},
      restoreWorkspace,
    })),
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory,
    ensureAdapterExecutionTargetCommandResolvable,
    maybeRunSandboxInstallCommand,
    runAdapterExecutionTargetProcess,
    describeAdapterExecutionTarget,
    resolveAdapterExecutionTargetCwd,
    prepareAdapterExecutionTargetRuntime,
  };
});

import { testEnvironment } from "./test.js";

describe("gemini remote environment diagnostics", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("runs an Atlas agy hello probe in the realized scratch without controller credentials or caller args", async () => {
    vi.stubEnv("GEMINI_API_KEY", "controller-gemini-key");
    vi.stubEnv("GOOGLE_API_KEY", "controller-google-key");
    const target: AdapterExecutionTarget = {
      kind: "remote", transport: "ssh", environmentId: "atlas", leaseId: "probe", remoteCwd: "/remote/workspace",
      spec: {
        host: "127.0.0.1", port: 2222, username: "worker", remoteCwd: "/remote/workspace",
        remoteWorkspacePath: "/remote/workspace", privateKey: "fixture-key", knownHosts: "fixture-host", strictHostKeyChecking: true,
        atlas: { sshExecutable: "/bin/ssh", scratchDir: "/controller/atlas-scratch", probe: true },
      },
    };
    const ctx = {
      companyId: "company-1",
      adapterType: "gemini_local",
      executionTarget: target,
      config: {
        engine: "cli",
        cliFlavor: "agy",
        command: "/worker/agy",
        model: "gemini-4-neon-high",
        extraArgs: ["--remote-agent"],
        managedAiConnection: true,
        env: {
          PAPERCLIP_API_KEY: "fake-jwt",
          PAPERCLIP_BRIDGE_TOKEN: "fake-bearer",
          PAPERCLIP_ATLAS_BRIDGE_TOKEN_FILE: "/untrusted-file",
          PAPERCLIP_API_URL: "http://controller.invalid",
          GEMINI_API_KEY: "caller-gemini-key",
          GOOGLE_API_KEY: "caller-google-key",
          CLOUD_CODE_URL: "http://caller.invalid",
          CALLER_ONLY: "caller-env-marker",
        },
      },
    };

    const result = await testEnvironment(ctx);
    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "gemini_hello_probe_passed" }));
    expect(ensureAdapterExecutionTargetDirectory).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({ spec: expect.objectContaining({ atlas: expect.objectContaining({ adapterType: "gemini_local", probe: true }) }) }),
      "/remote/workspace",
      expect.objectContaining({ createIfMissing: false }),
    );
    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      workspaceLocalDir: "/controller/atlas-scratch",
      assets: [],
    }));
    expect(maybeRunSandboxInstallCommand).not.toHaveBeenCalled();

    const runtimeCwd = "/remote/workspace/attempt-probe";
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    expect(runAdapterExecutionTargetProcess).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({
        remoteCwd: runtimeCwd,
        spec: expect.objectContaining({ atlas: expect.objectContaining({ adapterType: "gemini_local", probe: true }) }),
      }),
      "/worker/agy",
      ["models"],
      expect.objectContaining({
        cwd: runtimeCwd,
        env: { NO_BROWSER: "1", AGY_ACP_FORCE_FILE_STORAGE: "1", GEMINI_CLI_TRUST_WORKSPACE: "true" },
      }),
    );
    expect(runAdapterExecutionTargetProcess).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        remoteCwd: runtimeCwd,
        spec: expect.objectContaining({ atlas: expect.objectContaining({ adapterType: "gemini_local", probe: true }) }),
      }),
      "/worker/agy",
      [
        "--output-format", "stream-json", "--input-format", "stream-json",
        "--model", "gemini-4-neon", "--effort", "high",
      ],
      expect.objectContaining({
        cwd: runtimeCwd,
        env: { NO_BROWSER: "1", AGY_ACP_FORCE_FILE_STORAGE: "1", GEMINI_CLI_TRUST_WORKSPACE: "true" },
        stdin: formatAgyStreamJsonInput("Respond with hello."),
      }),
    );

    vi.clearAllMocks();
    for (const badConfig of [
      { ...ctx.config, engine: "acp" },
      { ...ctx.config, cliFlavor: "gemini" },
      { ...ctx.config, model: "claude-opus-5-5-max" },
      { ...ctx.config, dangerouslySkipPermissions: true },
    ]) {
      const failed = await testEnvironment({ ...ctx, config: badConfig });
      expect(failed.status).toBe("fail");
      expect(failed.checks).toContainEqual(expect.objectContaining({ code: "gemini_atlas_agy_required", level: "error" }));
      expect(ensureAdapterExecutionTargetDirectory).not.toHaveBeenCalled();
      expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
      expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    }

    // Exact combined ID preflight stops before hello when absent.
    vi.clearAllMocks();
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "gemini-3.8-flash\tGemini 3.8 Flash\n",
      stderr: "",
      pid: 122,
      startedAt: new Date().toISOString(),
    });
    const missingModel = await testEnvironment(ctx);
    expect(missingModel.status).toBe("fail");
    expect(missingModel.checks).toContainEqual(expect.objectContaining({ code: "gemini_model_unavailable", level: "error" }));
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);

    // Partial output without terminal SUCCESS fails without leaking raw worker output.
    vi.clearAllMocks();
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "gemini-4-neon-high\tGemini 4 Neon (High)\n",
      stderr: "",
      pid: 122,
      startedAt: new Date().toISOString(),
    }).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ event: "init", conversation_id: "agy-partial" }),
        JSON.stringify({
          event: "step_update",
          step_update: { conversation_id: "agy-partial", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "hello\n" },
        }),
      ].join("\n"),
      stderr: "secret-stderr-should-not-leak",
      pid: 123,
      startedAt: new Date().toISOString(),
    });
    const incomplete = await testEnvironment(ctx);
    expect(incomplete.status).toBe("fail");
    expect(incomplete.checks).toContainEqual(expect.objectContaining({ code: "gemini_hello_probe_failed", level: "error" }));
    expect(JSON.stringify(incomplete.checks)).not.toContain("secret-stderr-should-not-leak");

    // Failed directory check on Atlas returns immediately with fixed message and no scratch staging.
    vi.clearAllMocks();
    ensureAdapterExecutionTargetDirectory.mockRejectedValueOnce(new Error("raw-worker-stderr-leak"));
    const badCwd = await testEnvironment(ctx);
    expect(badCwd.status).toBe("fail");
    expect(badCwd.checks).toContainEqual(expect.objectContaining({
      code: "gemini_cwd_invalid",
      level: "error",
      message: "Atlas worker directory is invalid or unavailable.",
    }));
    expect(JSON.stringify(badCwd.checks)).not.toContain("raw-worker-stderr-leak");
    expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("skips custom commands for non-Atlas agy diagnostics", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "gemini_local",
      config: {
        engine: "cli",
        cliFlavor: "agy",
        command: "/tmp/custom-helper",
        model: "gemini-4-neon-high",
      },
    });
    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "gemini_hello_probe_skipped_custom_command" }));
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
