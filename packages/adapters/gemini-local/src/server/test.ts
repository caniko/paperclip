import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { ATLAS_GEMINI_ENV } from "@paperclipai/adapter-utils/remote-execution-env";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  ensureAdapterExecutionTargetDirectory,
  isAdapterExecutionTargetUnavailableError,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { DEFAULT_GEMINI_LOCAL_MODEL, SANDBOX_INSTALL_COMMAND } from "../index.js";
import {
  atlasGeminiRunArgs,
  detectGeminiAuthRequired,
  detectGeminiQuotaExhausted,
  formatAgyStreamJsonInput,
  parseGeminiJsonl,
  splitAgyModelEffort,
} from "./parse.js";
import {
  AtlasGeminiModelUnavailableError,
  AtlasGeminiPreflightAuthError,
  ensureAtlasAgyModelAvailable,
} from "./execute.js";
import { firstNonEmptyLine } from "./utils.js";
import {
  resolveGeminiExecutionEngineForRun,
  testGeminiAcpEnvironment,
} from "./acp.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const declaredTarget = ctx.executionTarget ?? null;
  const atlas = declaredTarget?.kind === "remote" && declaredTarget.transport === "ssh" && declaredTarget.spec.atlas;
  const atlasArgs = atlas
    ? atlasGeminiRunArgs(config, { dangerouslySkipPermissions: atlas.dangerouslySkipPermissions === true })
    : null;
  if (atlas && (config.engine !== "cli" || !atlasArgs || Object.hasOwn(config, "dangerouslySkipPermissions"))) {
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks: [{
        code: "gemini_atlas_agy_required",
        level: "error",
        message: "Atlas Gemini requires engine=cli with cliFlavor=agy and a pinned gemini-* model",
      }],
      testedAt: new Date().toISOString(),
    };
  }
  const engineSelection = await resolveGeminiExecutionEngineForRun({
    config,
    executionTarget: ctx.executionTarget,
  });
  if (engineSelection.unavailableReason) {
    return {
      adapterType: "gemini_local",
      status: "fail",
      checks: [{
        code: "adapter_engine_unavailable",
        level: "error",
        message: engineSelection.unavailableReason,
      }],
      testedAt: new Date().toISOString(),
    };
  }
  if (engineSelection.engine === "acp") {
    return testGeminiAcpEnvironment(ctx);
  }

  const checks: AdapterEnvironmentCheck[] = [];
  const isAgy = Boolean(atlas) || asString(config.cliFlavor, "").trim().toLowerCase() === "agy";
  const command = asString(config.command, isAgy ? "agy" : "gemini");
  const target: AdapterExecutionTarget | null = atlas
    ? { ...declaredTarget, spec: { ...declaredTarget.spec, atlas: { ...atlas, adapterType: "gemini_local", probe: true } } }
    : declaredTarget;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, atlas ? "" : asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `gemini-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "gemini_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: !atlas,
    });
    checks.push({
      code: "gemini_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "gemini_cwd_invalid",
      ...(isAdapterExecutionTargetUnavailableError(err) ? { retryable: true } : {}),
      level: "error",
      message: atlas
        ? "Atlas worker directory is invalid or unavailable."
        : err instanceof Error
          ? err.message
          : "Invalid working directory",
      detail: cwd,
    });
    if (atlas) {
      return {
        adapterType: ctx.adapterType,
        status: summarizeStatus(checks),
        checks,
        testedAt: new Date().toISOString(),
      };
    }
  }

  const envConfig = atlas ? {} : parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!atlas && targetIsRemote && typeof env.GEMINI_CLI_TRUST_WORKSPACE !== "string") {
    env.GEMINI_CLI_TRUST_WORKSPACE = "true";
  }

  let restoreWorkspace: (() => Promise<void>) | null = null;
  try {
    let runtimeTarget: AdapterExecutionTarget | null = target;
    let runtimeCwd = cwd;
    if (atlas) {
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target,
        adapterKey: "gemini",
        workspaceLocalDir: atlas.scratchDir,
        workspaceRestoreRetryDelaysMs: [],
        assets: [],
      });
      restoreWorkspace = async () => {
        await preparedExecutionTargetRuntime.restoreWorkspace().catch(() => {});
      };
      if (!preparedExecutionTargetRuntime.workspaceRemoteDir) {
        throw new Error("Atlas Gemini requires a realized scratch directory");
      }
      runtimeCwd = preparedExecutionTargetRuntime.workspaceRemoteDir;
      runtimeTarget = overrideAdapterExecutionTargetRemoteCwd(target, runtimeCwd) ?? null;
    }

    const runtimeEnv = atlas ? ATLAS_GEMINI_ENV : ensurePathInEnv({ ...process.env, ...env });
    const installCheck = atlas ? null : await maybeRunSandboxInstallCommand({
      runId,
      target,
      adapterKey: "gemini",
      installCommand: SANDBOX_INSTALL_COMMAND,
      detectCommand: command,
      env,
    });
    if (installCheck) checks.push(installCheck);
    try {
      await ensureAdapterExecutionTargetCommandResolvable(command, runtimeTarget, runtimeCwd, runtimeEnv);
      checks.push({
        code: "gemini_command_resolvable",
        level: "info",
        message: `Command is executable: ${command}`,
      });
    } catch (err) {
      checks.push({
        code: "gemini_command_unresolvable",
        ...(isAdapterExecutionTargetUnavailableError(err) ? { retryable: true } : {}),
        level: "error",
        message: atlas
          ? "Atlas worker command is not executable."
          : err instanceof Error
            ? err.message
            : "Command is not executable",
        detail: command,
      });
    }

    if (atlas) {
      checks.push({
        code: "gemini_atlas_worker_auth",
        level: "info",
        message: "Atlas worker uses host-managed subscription proxy authentication.",
      });
    } else {
      const configGeminiApiKey = env.GEMINI_API_KEY;
      const hostGeminiApiKey = targetIsRemote ? undefined : process.env.GEMINI_API_KEY;
      const configGoogleApiKey = env.GOOGLE_API_KEY;
      const hostGoogleApiKey = targetIsRemote ? undefined : process.env.GOOGLE_API_KEY;
      const hasGca = env.GOOGLE_GENAI_USE_GCA === "true" || (!targetIsRemote && process.env.GOOGLE_GENAI_USE_GCA === "true");
      if (
        isNonEmpty(configGeminiApiKey) ||
        isNonEmpty(hostGeminiApiKey) ||
        isNonEmpty(configGoogleApiKey) ||
        isNonEmpty(hostGoogleApiKey) ||
        hasGca
      ) {
        const source = hasGca
          ? "Google account login (GCA)"
          : isNonEmpty(configGeminiApiKey) || isNonEmpty(configGoogleApiKey)
            ? "adapter config env"
            : "server environment";
        checks.push({
          code: "gemini_api_key_present",
          level: "info",
          message: "Gemini API credentials are set for CLI authentication.",
          detail: `Detected in ${source}.`,
        });
      } else {
        checks.push({
          code: "gemini_api_key_missing",
          level: "info",
          message: "No explicit API key detected. Gemini CLI may still authenticate via `gemini auth login` (OAuth).",
          hint: "If the hello probe fails with an auth error, set GEMINI_API_KEY or GOOGLE_API_KEY in adapter env, or run `gemini auth login`.",
        });
      }
    }

    const canRunProbe =
      checks.every((check) => check.code !== "gemini_cwd_invalid" && check.code !== "gemini_command_unresolvable");
    let atlasModelPreflightPassed = !atlas;
    if (atlas && canRunProbe && runtimeTarget?.kind === "remote" && runtimeTarget.transport === "ssh") {
      const configuredModel = asString(config.model, "").trim();
      const preflightTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 20));
      try {
        await ensureAtlasAgyModelAvailable({
          runId,
          executionTarget: runtimeTarget,
          command,
          model: configuredModel,
          cwd: runtimeCwd,
          timeoutSec: preflightTimeoutSec,
          graceSec: 5,
        });
        checks.push({
          code: "gemini_model_configured",
          level: "info",
          message: `Configured model: ${configuredModel}`,
        });
        atlasModelPreflightPassed = true;
      } catch (err) {
        if (err instanceof AtlasGeminiPreflightAuthError) {
          checks.push({
            code: "gemini_hello_probe_auth_required",
            level: "warn",
            message: err.message,
          });
        } else if (err instanceof AtlasGeminiModelUnavailableError) {
          checks.push({
            code: "gemini_model_unavailable",
            level: "error",
            message: `Configured Gemini model is not advertised by the Atlas worker: ${err.model}`,
          });
        } else {
          checks.push({
            code: "gemini_hello_probe_failed",
            level: "error",
            message: "Atlas Gemini model preflight failed.",
          });
        }
      }
    }

    if (canRunProbe && atlasModelPreflightPassed) {
      const expectedCommand = isAgy ? "agy" : "gemini";
      if (!atlas && !commandLooksLike(command, expectedCommand)) {
        checks.push({
          code: "gemini_hello_probe_skipped_custom_command",
          level: "info",
          message: `Skipped hello probe because command is not \`${expectedCommand}\`.`,
          detail: command,
          hint: `Use the \`${expectedCommand}\` CLI command to run the automatic installation and auth probe.`,
        });
      } else {
        const model = asString(config.model, DEFAULT_GEMINI_LOCAL_MODEL).trim();
        const approvalMode = asString(config.approvalMode, asBoolean(config.yolo, true) ? "yolo" : "default");
        const sandbox = atlas ? false : asBoolean(config.sandbox, false);
        const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 60));
        const extraArgs = atlas ? [] : (() => {
          const fromExtraArgs = asStringArray(config.extraArgs);
          if (fromExtraArgs.length > 0) return fromExtraArgs;
          return asStringArray(config.args);
        })();

        let args: string[];
        let stdin: string | undefined;
        if (atlasArgs) {
          args = atlasArgs;
          stdin = formatAgyStreamJsonInput("Respond with hello.");
        } else if (isAgy) {
          args = ["--output-format", "stream-json", "--input-format", "stream-json"];
          if (model && model !== DEFAULT_GEMINI_LOCAL_MODEL) {
            const resolved = splitAgyModelEffort(model);
            args.push("--model", resolved.model);
            if (resolved.effort) args.push("--effort", resolved.effort);
          }
          if (asBoolean(config.dangerouslySkipPermissions, true)) args.push("--dangerously-skip-permissions");
          if (sandbox) args.push("--sandbox");
          if (extraArgs.length > 0) args.push(...extraArgs);
          stdin = formatAgyStreamJsonInput("Respond with hello.");
        } else {
          args = ["--output-format", "stream-json", "--prompt", "Respond with hello."];
          if (model && model !== DEFAULT_GEMINI_LOCAL_MODEL) args.push("--model", model);
          if (approvalMode !== "default") args.push("--approval-mode", approvalMode);
          if (sandbox) {
            args.push("--sandbox");
          } else {
            args.push("--sandbox=none");
          }
          if (extraArgs.length > 0) args.push(...extraArgs);
        }

        const probe = await runAdapterExecutionTargetProcess(
          runId,
          runtimeTarget,
          command,
          args,
          {
            cwd: runtimeCwd,
            env: atlas ? ATLAS_GEMINI_ENV : env,
            ...(stdin !== undefined ? { stdin } : {}),
            timeoutSec: helloProbeTimeoutSec,
            graceSec: 5,
            onLog: async () => { },
          },
        );
        const parsed = parseGeminiJsonl(probe.stdout);
        const detail = atlas ? null : summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
        const authMeta = detectGeminiAuthRequired({
          parsed: parsed.resultEvent,
          stdout: probe.stdout,
          stderr: probe.stderr,
        });
        const quotaMeta = detectGeminiQuotaExhausted({
          parsed: parsed.resultEvent,
          stdout: probe.stdout,
          stderr: probe.stderr,
        });

        if (quotaMeta.exhausted) {
          checks.push({
            code: "gemini_hello_probe_quota_exhausted",
            level: "warn",
            message: atlas
              ? "Atlas Gemini worker account is currently over quota."
              : probe.timedOut
                ? "Gemini CLI is retrying after quota exhaustion."
                : "Gemini CLI authentication is configured, but the current account or API key is over quota.",
            ...(detail ? { detail } : {}),
            ...(atlas ? {} : { hint: "The configured Gemini account or API key is over quota. Check ai.google.dev usage/billing, then retry the probe." }),
          });
        } else if (probe.timedOut) {
          checks.push({
            code: "gemini_hello_probe_timed_out",
            level: "warn",
            message: atlas ? "Atlas Gemini hello probe timed out." : "Gemini hello probe timed out.",
            ...(atlas ? {} : { hint: "Retry the probe. If this persists, verify Gemini can run `Respond with hello.` from this directory manually." }),
          });
        } else if ((probe.exitCode ?? 1) === 0 && !parsed.errorMessage && (!isAgy || parsed.terminalStatus === "success")) {
          const summary = parsed.summary.trim();
          const hasHello = /\bhello\b/i.test(summary);
          checks.push({
            code: hasHello ? "gemini_hello_probe_passed" : "gemini_hello_probe_unexpected_output",
            level: hasHello ? "info" : "warn",
            message: hasHello
              ? "Gemini hello probe succeeded."
              : "Gemini probe ran but did not return `hello` as expected.",
            ...(!atlas && summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
            ...(hasHello || atlas
              ? {}
              : {
                hint: "Try `gemini --output-format json \"Respond with hello.\"` manually to inspect full output.",
              }),
          });
        } else if (authMeta.requiresAuth) {
          checks.push({
            code: "gemini_hello_probe_auth_required",
            level: "warn",
            message: atlas
              ? "Atlas Gemini worker authentication is not ready."
              : "Gemini CLI is installed, but authentication is not ready.",
            ...(detail ? { detail } : {}),
            ...(atlas ? {} : { hint: "Run `gemini auth` or configure GEMINI_API_KEY / GOOGLE_API_KEY in adapter env/shell, then retry the probe." }),
          });
        } else {
          checks.push({
            code: "gemini_hello_probe_failed",
            level: "error",
            message: atlas ? "Atlas Gemini hello probe failed." : "Gemini hello probe failed.",
            ...(detail ? { detail } : {}),
            ...(atlas ? {} : { hint: "Run `gemini --output-format json \"Respond with hello.\"` manually in this working directory to debug." }),
          });
        }
      }
    }
  } finally {
    await restoreWorkspace?.();
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
