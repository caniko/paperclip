import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, _args: string[], _options?: Record<string, unknown>) => ({
    exitCode: 0,
    signal: null as string | null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "gemini-session-1", model: "gemini-2.5-pro" }),
      JSON.stringify({ type: "message", role: "assistant", content: "hello" }),
      JSON.stringify({
        type: "result",
        status: "success",
        session_id: "gemini-session-1",
        stats: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "ssh://fixture@127.0.0.1:2222/remote/workspace :: gemini"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({
    stdout: "/home/agent",
    stderr: "",
    exitCode: 0,
  })),
  syncDirectoryToSsh: vi.fn(async (_input: { localDir: string; remoteDir: string }) => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async (): Promise<{
    env: Record<string, string>;
    stop: () => Promise<void>;
  } | null> => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    runSshCommand,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";

describe("gemini remote execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.each([
    "protected",
    "protected-skip-permissions",
    "missing",
    "unprotected",
    "setup-failure",
    "staging-failure",
    "probe-failure",
    "probe-auth-required",
    "probe-missing-model",
    "acp-engine",
    "invalid-model",
    "db-skip-permissions",
    "silent-error",
    "finished-reason-error",
    "missing-terminal-result",
    "truncated-tail-no-onUsage",
  ])(
    "fences Atlas agy execution and its unauthenticated model probe (%s)", async (outcome) => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "gemini-atlas-scratch-"));
      cleanupDirs.push(workspace);
      vi.stubEnv("GEMINI_API_KEY", "controller-gemini-key");
      vi.stubEnv("GOOGLE_API_KEY", "controller-google-key");
      vi.stubEnv("PAPERCLIP_API_URL", "http://controller.invalid");
      const hostToken = "fake-controller-jwt";
      const tokenFile = `/tmp/paperclip-atlas-${"a".repeat(32)}/bearer`;
      const stop = vi.fn(async () => {});
      const onUsage = outcome === "truncated-tail-no-onUsage" ? undefined : vi.fn(async () => {});
      const runsExecution = [
        "protected",
        "protected-skip-permissions",
        "silent-error",
        "finished-reason-error",
        "missing-terminal-result",
        "truncated-tail-no-onUsage",
      ].includes(outcome);
      if (runsExecution) startAdapterExecutionTargetPaperclipBridge.mockResolvedValueOnce({
        env: { PAPERCLIP_ATLAS_BRIDGE_TOKEN_FILE: tokenFile, PAPERCLIP_API_URL: "http://127.0.0.1:4310" }, stop,
      });
      if (outcome === "missing") startAdapterExecutionTargetPaperclipBridge.mockResolvedValueOnce(null);
      if (outcome === "unprotected") startAdapterExecutionTargetPaperclipBridge.mockResolvedValueOnce({
        env: { PAPERCLIP_API_KEY: "plaintext-bridge-token" }, stop,
      });
      if (outcome === "setup-failure") startAdapterExecutionTargetPaperclipBridge.mockRejectedValueOnce(new Error("bridge setup failed"));
      if (outcome === "staging-failure") {
        syncDirectoryToSsh.mockRejectedValueOnce(new Error("scratch staging failed"));
      }
      const runsModelsProbe = !["acp-engine", "invalid-model", "db-skip-permissions", "staging-failure"].includes(outcome);
      if (runsModelsProbe) {
        runChildProcess.mockImplementationOnce(async (_runId: string, _command: string, args: string[]) => {
          if (args[0] === "models") {
            if (outcome === "probe-failure") {
              return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "probe failed", pid: 122, startedAt: new Date().toISOString() };
            }
            if (outcome === "probe-auth-required") {
              return {
                exitCode: 1,
                signal: null,
                timedOut: false,
                stdout: "",
                stderr: "Error: Please sign in to view available models. raw-secret-diagnostic",
                pid: 122,
                startedAt: new Date().toISOString(),
              };
            }
            return {
              exitCode: 0, signal: null, timedOut: false,
              stdout: outcome === "probe-missing-model"
                ? "gemini-3.8-flash\tGemini 3.8 Flash\n"
                : "gemini-4-neon-high\tGemini 4 Neon (High)\n",
              stderr: "", pid: 122, startedAt: new Date().toISOString(),
            };
          }
          return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 122, startedAt: new Date().toISOString() };
        });
      }
      if (runsExecution) {
        runChildProcess.mockImplementationOnce(async (_runId, _command, _args, options) => {
          const onLog = options?.onLog as ((stream: "stdout" | "stderr", chunk: string) => Promise<void>) | undefined;
          const stepLine = JSON.stringify({
            event: "step_update",
            step_update: {
              conversation_id: "agy-conv-1", step_index: 1, state: "DONE", step_type: "agent_response",
              text_delta: "hello from agy\n",
              usage: { input_tokens: 10, output_tokens: 4, thinking_tokens: 1, cache_read_tokens: 20, total_tokens: 14 },
            },
          });
          const lines = [
            JSON.stringify({ event: "init", conversation_id: "agy-conv-1", init: { model: "gemini-4-neon-high" } }),
            stepLine,
            ...(outcome === "silent-error"
              ? [JSON.stringify({ event: "result", result: { conversation_id: "agy-conv-1", status: "ERROR", response: "", error: "", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } } })]
              : outcome === "finished-reason-error"
                ? [JSON.stringify({ event: "result", result: { conversation_id: "agy-conv-1", status: "SUCCESS", finished_reason: "error", response: "hello", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } } })]
              : outcome === "missing-terminal-result"
                ? []
                : [JSON.stringify({
                    event: "result",
                    result: {
                      conversation_id: "agy-conv-1", status: "SUCCESS", response: "hello from agy\n",
                      usage: { input_tokens: 15, output_tokens: 6, thinking_tokens: 2, cache_read_tokens: 25, total_tokens: 21 },
                    },
                  })]),
          ];
          for (const line of lines) {
            await onLog?.("stdout", `${line}\n`);
          }
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: outcome === "truncated-tail-no-onUsage" ? "" : lines.join("\n"),
            stderr: "",
            pid: 123,
            startedAt: new Date().toISOString(),
          };
        });
      }

      const remoteCwd = "/remote/atlas";
      const result = execute({
        runId: "atlas-gemini-run",
        agent: { id: "agent-1", companyId: "company-1", name: "Fixture", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: "untrusted-prior-session", sessionParams: null, sessionDisplayId: null, taskKey: null },
        context: { paperclipWorkspace: { cwd: workspace } },
        config: {
          engine: outcome === "acp-engine" ? "acp" : "cli",
          cliFlavor: "agy",
          command: "/worker/agy",
          model: outcome === "invalid-model" ? "claude-opus-5-5-max" : "gemini-4-neon-high",
          ...(outcome === "db-skip-permissions" ? { dangerouslySkipPermissions: true } : {}),
          extraArgs: ["--remote-agent"],
          managedAiConnection: true,
          instructionsFilePath: "/etc/passwd",
          env: {
            PAPERCLIP_ATLAS_BRIDGE_TOKEN_FILE: "/untrusted-file",
            GEMINI_API_KEY: "caller-gemini-key",
            GOOGLE_API_KEY: "caller-google-key",
            CLOUD_CODE_URL: "http://caller.invalid",
            CALLER_ONLY: "caller-env-marker",
          },
        },
        executionTarget: {
          kind: "remote", transport: "ssh", environmentId: "atlas", leaseId: "lease-1", remoteCwd,
          spec: {
            host: "127.0.0.1", port: 2222, username: "worker", remoteCwd,
            remoteWorkspacePath: remoteCwd, privateKey: "fixture-key", knownHosts: "fixture-host", strictHostKeyChecking: true,
            atlas: {
              sshExecutable: "/bin/ssh",
              scratchDir: workspace,
              ...(outcome === "protected-skip-permissions" ? { dangerouslySkipPermissions: true } : {}),
            },
          },
        },
        authToken: hostToken,
        onLog: async () => {},
        onUsage,
      });

      if (outcome === "protected" || outcome === "protected-skip-permissions" || outcome === "truncated-tail-no-onUsage") {
        expect(await result).toMatchObject({
          exitCode: 0,
          billingType: "subscription",
          usageComplete: true,
          usage: { inputTokens: 15, cachedInputTokens: 25, outputTokens: 6 },
          ...(outcome === "truncated-tail-no-onUsage" ? {} : { sessionId: "agy-conv-1", summary: "hello from agy" }),
        });
        if (onUsage) {
          expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
            complete: false,
            usage: { inputTokens: 10, cachedInputTokens: 20, outputTokens: 4 },
          }));
          expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({
            complete: true,
            usage: { inputTokens: 15, cachedInputTokens: 25, outputTokens: 6 },
          }));
        }
      } else if (outcome === "probe-auth-required") {
        const resolved = await result;
        expect(resolved).toMatchObject({
          exitCode: 1,
          errorCode: "gemini_auth_required",
          errorMessage: "Atlas Gemini worker authentication is not ready.",
          usageComplete: false,
        });
        expect(resolved.errorMessage).not.toContain("raw-secret-diagnostic");
      } else if (outcome === "silent-error" || outcome === "finished-reason-error" || outcome === "missing-terminal-result") {
        const resolved = await result;
        expect(resolved).toMatchObject({
          exitCode: 1,
          usageComplete: false,
          usage: { inputTokens: 10, cachedInputTokens: 20, outputTokens: 4 },
        });
        expect(resolved.errorMessage).toBeTruthy();
        if (onUsage) {
          expect(onUsage).not.toHaveBeenCalledWith(expect.objectContaining({ complete: true }));
        }
      } else {
        await expect(result).rejects.toThrow(
          outcome === "acp-engine" || outcome === "invalid-model" || outcome === "db-skip-permissions" ? /cliFlavor=agy/i
            : outcome === "staging-failure" ? "scratch staging failed"
            : outcome === "setup-failure" ? "bridge setup failed"
            : outcome === "probe-failure" ? "Atlas Gemini model probe failed"
            : outcome === "probe-missing-model" ? "unavailable on the Atlas worker: gemini-4-neon-high"
            : "protected callback bridge",
        );
      }

      expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
      expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
      expect(runSshCommand).not.toHaveBeenCalled();
      expect(await readdir(workspace)).toEqual([]);
      if (["acp-engine", "invalid-model", "db-skip-permissions"].includes(outcome)) {
        expect(syncDirectoryToSsh).not.toHaveBeenCalled();
        expect(runChildProcess).not.toHaveBeenCalled();
        expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
        return;
      }
      if (outcome === "staging-failure") {
        expect(runChildProcess).not.toHaveBeenCalled();
        expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
        return;
      }
      const attemptDir = syncDirectoryToSsh.mock.calls[0]![0].remoteDir;
      expect(attemptDir).toMatch(/^\/remote\/atlas\/attempt-/);
      expect(syncDirectoryToSsh.mock.calls.map(([input]) => input.remoteDir)).toEqual([attemptDir]);
      expect(runChildProcess).toHaveBeenNthCalledWith(1, "atlas-gemini-run", "/worker/agy", ["models"],
        expect.objectContaining({
          cwd: attemptDir,
          env: { NO_BROWSER: "1", AGY_ACP_FORCE_FILE_STORAGE: "1", GEMINI_CLI_TRUST_WORKSPACE: "true" },
          remoteExecution: expect.objectContaining({
            remoteCwd: attemptDir,
            atlas: expect.objectContaining({ adapterType: "gemini_local", probe: true }),
          }),
        }));
      if (["probe-failure", "probe-auth-required", "probe-missing-model"].includes(outcome)) {
        expect(runChildProcess).toHaveBeenCalledTimes(1);
        expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
        return;
      }
      expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        hostApiToken: hostToken,
        target: expect.objectContaining({ remoteCwd: attemptDir }),
      }));
      if (runsExecution) {
        const runCall = runChildProcess.mock.calls[1]!;
        expect(runCall[2]).toEqual([
          "--output-format", "stream-json", "--input-format", "stream-json",
          "--model", "gemini-4-neon", "--effort", "high",
          ...(outcome === "protected-skip-permissions" ? ["--dangerously-skip-permissions"] : []),
        ]);
        expect(runCall[3]).toMatchObject({
          cwd: attemptDir,
          env: {
            PAPERCLIP_ATLAS_BRIDGE_TOKEN_FILE: tokenFile,
            NO_BROWSER: "1",
            AGY_ACP_FORCE_FILE_STORAGE: "1",
            GEMINI_CLI_TRUST_WORKSPACE: "true",
          },
          remoteExecution: { remoteCwd: attemptDir, atlas: expect.objectContaining({ adapterType: "gemini_local" }) },
        });
        const stdinLine = JSON.parse((runCall[3] as { stdin: string }).stdin);
        expect(stdinLine).toMatchObject({ event: "user", message: { role: "user", content: expect.any(String) } });
        expect(stdinLine.message.content).toContain("PAPERCLIP_ATLAS_BRIDGE_TOKEN_FILE");
        expect(stdinLine.message.content).toContain("expectedStatuses");
        expect(stdinLine.message.content).toContain("if(!r.ok)");
        expect(stdinLine.message.content).not.toContain("PAPERCLIP_API_KEY");
      } else {
        expect(runChildProcess).toHaveBeenCalledTimes(1);
      }
      const processCalls = JSON.stringify(runChildProcess.mock.calls);
      for (const secret of [
        hostToken, "controller-gemini-key", "controller-google-key",
        "caller-gemini-key", "caller-google-key", "caller.invalid",
        "caller-env-marker", "controller.invalid", "/untrusted-file",
      ]) {
        expect(processCalls).not.toContain(secret);
      }
      expect(stop).toHaveBeenCalledTimes(runsExecution || outcome === "unprotected" ? 1 : 0);
    },
  );

  it("prepares the workspace, syncs Gemini skills, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const alternateWorkspaceDir = path.join(rootDir, "workspace-other");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(alternateWorkspaceDir, { recursive: true });

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Gemini Builder",
        adapterType: "gemini_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "gemini",
        env: {
          GEMINI_API_KEY: "test-key",
          NO_COLOR: "1",
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
        paperclipWorkspaces: [
          {
            workspaceId: "workspace-1",
            cwd: workspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
          },
          {
            workspaceId: "workspace-2",
            cwd: alternateWorkspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "feature/other",
          },
        ],
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(result.sessionParams).toMatchObject({
      sessionId: "gemini-session-1",
      cwd: managedRemoteWorkspace,
      remoteExecution: {
        transport: "ssh",
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteCwd: managedRemoteWorkspace,
      },
    });
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: `${managedRemoteWorkspace}/.paperclip-runtime/gemini/skills`,
      followSymlinks: true,
    }));
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(".gemini/skills"),
      expect.anything(),
    );
    // The headless-auth settings.json write is scoped to managed HOMEs (sandbox
    // transport). SSH targets keep the user's real home, where existing settings
    // stay visible and the adapter must not create files.
    expect(runSshCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(".gemini/settings.json"),
      expect.anything(),
    );
    expect(runSshCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("gemini-api-key"),
      expect.anything(),
    );
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(JSON.parse(call?.[3].env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: managedRemoteWorkspace,
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "main",
      },
      {
        workspaceId: "workspace-2",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "feature/other",
      },
    ]);
    expect(call?.[3].env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:4310");
    expect(call?.[3].env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(call?.[3].env.GEMINI_CLI_TRUST_WORKSPACE).toBe("true");
    expect(call?.[3].env.TERM).toBe("xterm-256color");
    expect(call?.[3].env.COLORTERM).toBe("truecolor");
    expect(call?.[3].env.NO_BROWSER).toBe("1");
    expect(call?.[3].env).not.toHaveProperty("NO_COLOR");
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
  });

  it("pre-selects gemini-api-key auth in the managed HOME for sandbox execution", async () => {
    vi.stubEnv("GEMINI_API_KEY", "host-injected-sandbox-key");
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-sandbox-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const geminiOutput = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "gemini-session-2", model: "gemini-2.5-pro" }),
      JSON.stringify({ type: "message", role: "assistant", content: "hello" }),
      JSON.stringify({
        type: "result",
        status: "success",
        session_id: "gemini-session-2",
        stats: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n");
    // A valid empty tar lets the real workspace restore finish after auth setup.
    const emptyArchive = Buffer.alloc(1024);
    const runnerExecute = vi.fn(async (input: { command: string; args?: string[] }) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: input.command === "gemini" ? geminiOutput
        : input.args?.some((arg) => arg.startsWith("wc -c < ")) ? String(emptyArchive.length)
        : input.args?.some((arg) => arg.startsWith("dd if=")) ? emptyArchive.toString("base64")
        : "",
      stderr: "",
      pid: 321,
      startedAt: new Date().toISOString(),
    }));

    const sandboxResult = await execute({
      runId: "run-sandbox-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Gemini Builder",
        adapterType: "gemini_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        // Pin the CLI lane: sandbox targets with a runner now default to ACP,
        // and this test covers the CLI lane's managed-HOME auth flow.
        engine: "cli",
        command: "gemini",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "kubernetes",
        remoteCwd: "/remote/workspace",
        runner: { execute: runnerExecute },
      },
      onLog: async () => {},
    });
    expect(sandboxResult.billingType).toBe("api");

    const runnerScripts = runnerExecute.mock.calls.map(
      (call) => `${call[0].command} ${(call[0].args ?? []).join(" ")}`,
    );
    const settingsWrite = runnerScripts.find((script) => script.includes(".gemini/settings.json"));
    expect(settingsWrite).toBeDefined();
    expect(settingsWrite).toContain("gemini-api-key");
    // The managed HOME lives under the per-run runtime root, never a real home.
    expect(settingsWrite).toContain(".paperclip-runtime");
  });

  it("resumes saved Gemini sessions for remote SSH execution only when the identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Gemini Builder",
        adapterType: "gemini_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "gemini",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toContain("--resume");
    expect(call?.[2]).toContain("session-123");
  });

  it("restores the remote workspace if skills sync fails after workspace prep", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-remote-sync-fail-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    syncDirectoryToSsh.mockRejectedValueOnce(new Error("sync failed"));

    await expect(execute({
      runId: "run-sync-fail",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Gemini Builder",
        adapterType: "gemini_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "gemini",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    })).rejects.toThrow("sync failed");

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(runChildProcess).not.toHaveBeenCalled();
  });
});
