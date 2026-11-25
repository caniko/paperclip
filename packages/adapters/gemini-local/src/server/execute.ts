import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import { ATLAS_GEMINI_ENV, atlasSshEnv } from "@paperclipai/adapter-utils/remote-execution-env";
import { createUsageCheckpointLog } from "@paperclipai/adapter-utils/usage-checkpoint";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  managedRemoteHomeEnvironment,
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetLocalWorkspace,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  readAdapterExecutionTarget,
  readAdapterExecutionTargetHomeDir,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  joinPromptSections,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolveLegacyPaperclipDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  parseObject,
  renderTemplate,
  hydrateFreshSessionHandoff,
  selectPaperclipPromptSections,
  selectInitialCommunicationGuidance,
  isPaperclipRecoveryWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_GEMINI_LOCAL_MODEL, SANDBOX_INSTALL_COMMAND } from "../index.js";
import {
  atlasGeminiRunArgs,
  describeGeminiFailure,
  detectGeminiAuthRequired,
  formatAgyStreamJsonInput,
  isGeminiTransientNetworkError,
  isGeminiTurnLimitResult,
  isGeminiSessionUnrecoverableError,
  parseAgyModelsOutput,
  parseGeminiJsonl, createGeminiJsonlParser,
  splitAgyModelEffort,
} from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";
import {
  createGeminiAcpExecutor,
  resolveGeminiExecutionEngineForRun,
} from "./acp.js";
import { resolveGeminiSkillsHome } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const executeGeminiAcp = createGeminiAcpExecutor();

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveGeminiBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "GEMINI_API_KEY") || hasNonEmptyEnvValue(env, "GOOGLE_API_KEY")
    ? "api"
    : "subscription";
}

function buildGeminiHeadlessEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env };
  const term = env.TERM?.trim().toLowerCase();
  if (!term || term === "dumb" || term === "vt100") {
    next.TERM = "xterm-256color";
  }
  if (!next.COLORTERM?.trim()) {
    next.COLORTERM = "truecolor";
  }
  next.NO_BROWSER = "1";
  delete next.NO_COLOR;
  return next;
}

function buildGeminiRuntimeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...buildGeminiHeadlessEnv(env) })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

const REMOTE_AGY_MODELS_PROBE_DEFAULT_TIMEOUT_SEC = 20;

export class AtlasGeminiPreflightAuthError extends Error {
  constructor() {
    super("Atlas Gemini worker authentication is not ready.");
    this.name = "AtlasGeminiPreflightAuthError";
  }
}

export class AtlasGeminiModelUnavailableError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`Configured Gemini model is unavailable on the Atlas worker: ${model}`);
    this.name = "AtlasGeminiModelUnavailableError";
    this.model = model;
  }
}

export async function ensureAtlasAgyModelAvailable(input: {
  runId: string;
  executionTarget: Extract<AdapterExecutionTarget, { kind: "remote"; transport: "ssh" }>;
  command: string;
  model: string;
  cwd: string;
  timeoutSec: number;
  graceSec: number;
}) {
  const atlas = input.executionTarget.spec.atlas;
  if (!atlas) throw new Error("Atlas Gemini model probe requires an Atlas SSH target");
  const probeTimeoutSec = input.timeoutSec > 0
    ? Math.min(input.timeoutSec, REMOTE_AGY_MODELS_PROBE_DEFAULT_TIMEOUT_SEC)
    : REMOTE_AGY_MODELS_PROBE_DEFAULT_TIMEOUT_SEC;
  const probe = await runAdapterExecutionTargetProcess(
    input.runId,
    {
      ...input.executionTarget,
      spec: {
        ...input.executionTarget.spec,
        atlas: { ...atlas, adapterType: "gemini_local", probe: true },
      },
    },
    input.command,
    ["models"],
    {
      cwd: input.cwd,
      env: ATLAS_GEMINI_ENV,
      timeoutSec: probeTimeoutSec,
      graceSec: input.graceSec,
      onLog: async () => {},
    },
  );
  if (probe.timedOut) {
    throw new Error("Atlas Gemini model probe timed out");
  }
  if ((probe.exitCode ?? 1) !== 0) {
    const parsedProbe = parseGeminiJsonl(probe.stdout);
    const authMeta = detectGeminiAuthRequired({
      parsed: parsedProbe.resultEvent,
      stdout: probe.stdout,
      stderr: probe.stderr,
    });
    if (authMeta.requiresAuth) {
      throw new AtlasGeminiPreflightAuthError();
    }
    throw new Error("Atlas Gemini model probe failed");
  }
  const models = parseAgyModelsOutput(probe.stdout);
  if (models.length === 0) {
    throw new Error("Atlas Gemini model probe returned no models");
  }
  if (!models.some((entry) => entry.id === input.model)) {
    throw new AtlasGeminiModelUnavailableError(input.model);
  }
}

function renderPaperclipEnvNote(env: Record<string, string>, isAtlas = false): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_") && (!isAtlas || key !== "PAPERCLIP_API_KEY"))
    .sort();
  if (paperclipKeys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "",
    "",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>, isAtlas = false): string {
  if (isAtlas) {
    if (!hasNonEmptyEnvValue(env, "PAPERCLIP_API_URL") || !hasNonEmptyEnvValue(env, "PAPERCLIP_ATLAS_BRIDGE_TOKEN_FILE")) {
      return "";
    }
    return [
      "Paperclip API access note:",
      "Read the bridge bearer directly from $PAPERCLIP_ATLAS_BRIDGE_TOKEN_FILE inside a file-aware HTTP client (such as node fetch); never expand the bearer into shell arguments or environment variables.",
      "GET example:",
      `  node -e 'const fs=require("node:fs");const t=fs.readFileSync(process.env.PAPERCLIP_ATLAS_BRIDGE_TOKEN_FILE,"utf8").trim();fetch(process.env.PAPERCLIP_API_URL+"/api/agents/me",{headers:{Authorization:"Bearer "+t,"X-Paperclip-Run-Id":process.env.PAPERCLIP_RUN_ID}}).then(async r=>{const body=await r.text();if(!r.ok){console.error(body);process.exit(1);}console.log(body);})'`,
      "POST/PATCH example:",
      `  node -e 'const fs=require("node:fs");const t=fs.readFileSync(process.env.PAPERCLIP_ATLAS_BRIDGE_TOKEN_FILE,"utf8").trim();fetch(process.env.PAPERCLIP_API_URL+"/api/issues/"+process.env.PAPERCLIP_TASK_ID+"/checkout",{method:"POST",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json","X-Paperclip-Run-Id":process.env.PAPERCLIP_RUN_ID},body:JSON.stringify({agentId:process.env.PAPERCLIP_AGENT_ID,expectedStatuses:["todo","backlog","blocked"]})}).then(async r=>{const body=await r.text();if(!r.ok){console.error(body);process.exit(1);}console.log(body);})'`,
      "When PAPERCLIP_TASK_ID is not set, substitute a real issue id from the current context; never send a placeholder like {id} in the URL.",
      "",
      "",
    ].join("\n");
  }
  if (!hasNonEmptyEnvValue(env, "PAPERCLIP_API_URL") || !hasNonEmptyEnvValue(env, "PAPERCLIP_API_KEY")) {
    return "";
  }
  return [
    "Paperclip API access note:",
    "Use run_shell_command with curl to make Paperclip API requests.",
    "GET example:",
    `  run_shell_command({ command: "curl -s -H \\"Authorization: Bearer $PAPERCLIP_API_KEY\\" \\"$PAPERCLIP_API_URL/api/agents/me\\"" })`,
    "POST/PATCH example:",
    `  run_shell_command({ command: "curl -s -X POST -H \\"Authorization: Bearer $PAPERCLIP_API_KEY\\" -H 'Content-Type: application/json' -H \\"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\\" -d '{...}' \\"$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/checkout\\"" })`,
    "When PAPERCLIP_TASK_ID is not set, substitute a real issue id from the current context; never send a placeholder like {id} in the URL.",
    "",
    "",
  ].join("\n");
}

/**
 * Inject Paperclip skills directly into the effective Gemini skills home.
 * This avoids needing GEMINI_CLI_HOME overrides, so the CLI naturally finds
 * both its auth credentials and the injected skills under the child HOME.
 */
async function ensureGeminiSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
  skillsHome = resolveGeminiSkillsHome({}),
): Promise<void> {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;

  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Failed to prepare Gemini skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Gemini skill "${skillName}" from ${skillsHome}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Linked"} Gemini skill: ${entry.key}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to link Gemini skill "${entry.key}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function buildGeminiSkillsDir(
  config: Record<string, unknown>,
): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-skills-"));
  const target = path.join(tmp, "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(resolveLegacyPaperclipDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return target;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const declaredTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const atlas = declaredTarget?.kind === "remote" && declaredTarget.transport === "ssh" && declaredTarget.spec.atlas;
  const atlasArgs = atlas
    ? atlasGeminiRunArgs(config, { dangerouslySkipPermissions: atlas.dangerouslySkipPermissions === true })
    : null;
  if (atlas && (config.engine !== "cli" || !atlasArgs || atlas.probe || Object.hasOwn(config, "dangerouslySkipPermissions"))) {
    throw new Error("Atlas Gemini requires engine=cli with cliFlavor=agy and a pinned gemini-* model");
  }
  const engineSelection = await resolveGeminiExecutionEngineForRun(ctx);
  if (engineSelection.unavailableReason) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_engine_unavailable",
      errorMessage: engineSelection.unavailableReason,
      resultJson: {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      },
    };
  }
  if (engineSelection.engine === "acp") {
    return executeGeminiAcp(ctx);
  }

  const executionTarget: AdapterExecutionTarget | null = atlas
    ? { ...declaredTarget, spec: { ...declaredTarget.spec, atlas: { ...atlas, adapterType: "gemini_local" } } }
    : declaredTarget;
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  const isAgy = Boolean(atlas) || asString(config.cliFlavor, "").trim().toLowerCase() === "agy";

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, isAgy ? "agy" : "gemini");
  const model = asString(config.model, DEFAULT_GEMINI_LOCAL_MODEL).trim();
  const sandbox = atlas ? false : asBoolean(config.sandbox, false);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
      (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
    )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = (atlas && atlas.scratchDir) || effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  if (atlas) await ensureAbsoluteDirectory(cwd, { createIfMissing: false });
  else await ensureAdapterExecutionTargetLocalWorkspace(executionTarget, cwd);
  const geminiSkillEntries = atlas ? [] : await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredGeminiSkillNames = atlas ? [] : resolveLegacyPaperclipDesiredSkillNames(config, geminiSkillEntries);
  if (!executionTargetIsRemote) {
    await ensureGeminiSkillsInjected(
      onLog,
      geminiSkillEntries.filter((entry) => !isPaperclipSkillSourceMissing(entry)),
      desiredGeminiSkillNames,
      resolveGeminiSkillsHome(config),
    );
  }

  const envConfig = atlas ? {} : parseObject(config.env);
  const rawEnv: Record<string, string> = {
    ...buildPaperclipEnv(agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  rawEnv.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) rawEnv.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) rawEnv.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) rawEnv.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) rawEnv.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) rawEnv.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) rawEnv.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) rawEnv.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (!atlas) {
    refreshPaperclipWorkspaceEnvForExecution({
      env: rawEnv,
      envConfig,
      workspaceCwd: effectiveWorkspaceCwd,
      workspaceSource,
      workspaceId,
      workspaceRepoUrl,
      workspaceRepoRef,
      workspaceHints,
      agentHome,
      executionTargetIsRemote,
      executionCwd: effectiveExecutionCwd,
    });
    if (executionTargetIsRemote && typeof rawEnv.GEMINI_CLI_TRUST_WORKSPACE !== "string") {
      rawEnv.GEMINI_CLI_TRUST_WORKSPACE = "true";
    }
    if (authToken) {
      rawEnv.PAPERCLIP_API_KEY = authToken;
    }
  }
  const env: Record<string, string> = atlas
    ? {
        ...Object.fromEntries(
          Object.entries(atlasSshEnv(rawEnv)).filter(
            ([key]) => !key.startsWith("PAPERCLIP_API_") && !key.startsWith("PAPERCLIP_BRIDGE_"),
          ),
        ),
        ...ATLAS_GEMINI_ENV,
      }
    : rawEnv;
  const runtimeEnv = atlas ? {} : buildGeminiRuntimeEnv(env);
  const billingType = atlas ? "subscription" : resolveGeminiBillingType(runtimeEnv);
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 0),
  );
  const graceSec = asNumber(config.graceSec, 20);
  await ensureAdapterExecutionTargetRuntimeCommandInstalled({
    runId,
    target: executionTarget,
    installCommand: atlas ? undefined : ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog,
  });
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
    installCommand: atlas ? undefined : SANDBOX_INSTALL_COMMAND,
    timeoutSec,
  });
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const extraArgs = atlas ? [] : (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let remoteSkillsDir: string | null = null;
  let localSkillsDir: string | null = null;
  let remoteRuntimeRootDir: string | null = null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  let runtimeExecutionTarget: AdapterExecutionTarget | null = executionTarget;

  try {
    if (executionTargetIsRemote) {
      try {
        if (!atlas) {
          localSkillsDir = await buildGeminiSkillsDir(config);
        }
        await onLog(
          "stdout",
          `[paperclip] Syncing workspace and Gemini runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
          privateRuntime: !atlas && Boolean(config.managedAiConnection),
          runId,
          target: executionTarget,
          adapterKey: "gemini",
          timeoutSec,
          workspaceLocalDir: cwd,
          installCommand: atlas ? undefined : SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          onProgress: (line) => onLog("stdout", line),
          onRuntimeProgress: ctx.onRuntimeProgress,
          assets: localSkillsDir
            ? [{
                key: "skills",
                localDir: localSkillsDir,
                followSymlinks: true,
              }]
            : [],
        });
        restoreRemoteWorkspace = () =>
          preparedExecutionTargetRuntime.restoreWorkspace((line) => onLog("stdout", line));
        if (atlas && !preparedExecutionTargetRuntime.workspaceRemoteDir) {
          throw new Error("Atlas Gemini requires a realized scratch directory");
        }
        effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
        runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd) ?? null;
        remoteRuntimeRootDir = preparedExecutionTargetRuntime.runtimeRootDir;
        if (atlas) {
          env.PAPERCLIP_WORKSPACE_CWD = effectiveExecutionCwd;
          await ensureAtlasAgyModelAvailable({
            runId,
            executionTarget: runtimeExecutionTarget as Extract<AdapterExecutionTarget, { kind: "remote"; transport: "ssh" }>,
            command,
            model,
            cwd: effectiveExecutionCwd,
            timeoutSec,
            graceSec,
          });
        } else {
          refreshPaperclipWorkspaceEnvForExecution({
            env,
            envConfig,
            workspaceCwd: effectiveWorkspaceCwd,
            workspaceSource,
            workspaceId,
            workspaceRepoUrl,
            workspaceRepoRef,
            workspaceHints,
            agentHome,
            executionTargetIsRemote,
            executionCwd: effectiveExecutionCwd,
          });
          if (executionTarget?.kind === "remote" && executionTarget.transport === "ssh" && executionTarget.spec.useHostAuth === false && config.managedAiConnection && remoteRuntimeRootDir) Object.assign(env, managedRemoteHomeEnvironment(remoteRuntimeRootDir));
          const managedHome = adapterExecutionTargetUsesManagedHome(executionTarget, Boolean(config.managedAiConnection));
          const managedRemoteHomeDir =
            managedHome && preparedExecutionTargetRuntime.runtimeRootDir
              ? preparedExecutionTargetRuntime.runtimeRootDir
              : null;
          if (managedRemoteHomeDir) {
            env.HOME = managedRemoteHomeDir;
          }
          const remoteHomeDir =
            managedRemoteHomeDir ??
            (await readAdapterExecutionTargetHomeDir(runId, executionTarget, {
              cwd,
              env,
              timeoutSec,
              graceSec,
              onLog,
            }));
          if (remoteHomeDir && preparedExecutionTargetRuntime.assetDirs.skills) {
            remoteSkillsDir = path.posix.join(remoteHomeDir, ".gemini", "skills");
            await runAdapterExecutionTargetShellCommand(
              runId,
              executionTarget,
              `mkdir -p ${JSON.stringify(path.posix.dirname(remoteSkillsDir))} && rm -rf ${JSON.stringify(remoteSkillsDir)} && cp -a ${JSON.stringify(preparedExecutionTargetRuntime.assetDirs.skills)} ${JSON.stringify(remoteSkillsDir)}`,
              { cwd, env, timeoutSec, graceSec, onLog },
            );
          }
          // Gemini CLI refuses headless runs without an auth selection persisted in
          // $HOME/.gemini/settings.json ("Invalid auth method selected."); env vars
          // alone (GEMINI_DEFAULT_AUTH_TYPE) do not satisfy it. With a managed HOME
          // the runtime root replaces the image home, so any settings baked into the
          // image are invisible -- pre-select the api-key auth whenever an API key
          // is provided. Both settings schema generations are written (legacy
          // selectedAuthType + current security.auth.selectedType). An existing
          // settings.json (user-shipped via workspace) is left untouched.
          // Only the managed HOME (the per-run runtime root) is touched: on
          // non-managed remote targets remoteHomeDir is the user's real home, where
          // creating files is out of scope and existing settings remain visible.
          // Key presence check spans the run env AND the host process env: in the
          // managed sandbox path the key never enters the adapter's run env -- it
          // reaches the agent pod via the provider's per-run secret (envKeys
          // passthrough from the host env), so the host env is the signal here.
          const hasGeminiApiKey = Boolean(
            env.GEMINI_API_KEY || env.GOOGLE_API_KEY ||
            process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
          );
          if (managedRemoteHomeDir && hasGeminiApiKey) {
            const remoteSettingsPath = path.posix.join(managedRemoteHomeDir, ".gemini", "settings.json");
            const authSettingsJson = JSON.stringify({
              selectedAuthType: "gemini-api-key",
              security: { auth: { selectedType: "gemini-api-key" } },
            });
            await runAdapterExecutionTargetShellCommand(
              runId,
              executionTarget,
              `mkdir -p ${JSON.stringify(path.posix.dirname(remoteSettingsPath))} && { [ -f ${JSON.stringify(remoteSettingsPath)} ] || printf '%s' ${JSON.stringify(authSettingsJson)} > ${JSON.stringify(remoteSettingsPath)}; }`,
              { cwd, env, timeoutSec, graceSec, onLog },
            );
          }
        }
      } catch (error) {
        await Promise.allSettled([
          restoreRemoteWorkspace?.(),
          localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
        ]);
        restoreRemoteWorkspace = null;
        if (error instanceof AtlasGeminiPreflightAuthError) {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            usageComplete: false,
            usageBasis: "per_run",
            provider: "google",
            biller: "google",
            model,
            billingType,
            errorCode: "gemini_auth_required",
            errorMessage: error.message,
          };
        }
        throw error;
      }
    }
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "gemini",
        timeoutSec,
        hostApiToken: atlas ? authToken : env.PAPERCLIP_API_KEY,
        onLog,
      });
    }
    if (atlas && (!paperclipBridge?.env.PAPERCLIP_ATLAS_BRIDGE_TOKEN_FILE || "PAPERCLIP_API_KEY" in paperclipBridge.env)) {
      throw new Error("Atlas requires a protected callback bridge");
    }
    if (paperclipBridge) {
      Object.assign(env, paperclipBridge.env);
    }

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = atlas ? "" : asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
      adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const sessionId = canResumeSession ? runtimeSessionId : null;
    if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] Gemini session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
      );
    } else if (runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] Gemini session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
      );
    }

    const instructionsFilePath = atlas ? "" : asString(config.instructionsFilePath, "").trim();
    const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
    let instructionsPrefix = "";
    if (instructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
        instructionsPrefix =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${instructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsDir}.\n\n`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
        );
      }
    }
    const commandNotes = (() => {
      const notes: string[] = isAgy
        ? ["Prompt is passed to agy via --input-format stream-json on stdin for non-interactive execution."]
        : ["Prompt is passed to Gemini via --prompt for non-interactive execution.", "Added --approval-mode yolo for unattended execution."];
      if (isAgy && (atlas ? atlas.dangerouslySkipPermissions === true : asBoolean(config.dangerouslySkipPermissions, true))) {
        notes.push("Added --dangerously-skip-permissions for unattended execution.");
      }
      notes.push("Set headless terminal/browser env so Gemini fails fast instead of opening interactive auth or color prompts.");
      if (executionTargetIsRemote) {
        notes.push("Set GEMINI_CLI_TRUST_WORKSPACE=true for remote headless execution.");
      }
      if (!instructionsFilePath) return notes;
      if (instructionsPrefix.length > 0) {
        notes.push(
          `Loaded agent instructions from ${instructionsFilePath}`,
          `Prepended instructions + path directive to prompt (relative references from ${instructionsDir}).`,
        );
        return notes;
      }
      notes.push(
        `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      );
      return notes;
    })();

    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const buildPrompt = (resumedSession: boolean) => {
      const renderedBootstrapPrompt =
        !resumedSession && bootstrapPromptTemplate.trim().length > 0
          ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
          : "";
      const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
        resumedSession,
        includeCommunicationGuidance: false,
      });
      const shouldUseResumeDeltaPrompt = resumedSession && wakePrompt.length > 0;
      const renderedPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
        ? ""
        : renderTemplate(promptTemplate, templateData);
      const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
      const paperclipEnvNote = renderPaperclipEnvNote(env, Boolean(atlas));
      const apiAccessNote = renderApiAccessNote(env, Boolean(atlas));
      const basePrompt = joinPromptSections([
        instructionsPrefix,
        renderedBootstrapPrompt,
        wakePrompt,
        taskContextNote,
        sessionHandoffNote,
        paperclipEnvNote,
        apiAccessNote,
        renderedPrompt,
      ]);
      return {
        basePrompt,
        promptMetrics: {
          promptChars: basePrompt.length,
          instructionsChars: instructionsPrefix.length,
          bootstrapPromptChars: renderedBootstrapPrompt.length,
          wakePromptChars: wakePrompt.length,
          taskContextChars: taskContextNote.length,
          sessionHandoffChars: sessionHandoffNote.length,
          runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length,
          heartbeatPromptChars: renderedPrompt.length,
        },
      };
    };

    const buildArgs = (resumeSessionId: string | null, prompt: string) => {
      if (atlasArgs) return atlasArgs;
      if (isAgy) {
        const args = ["--output-format", "stream-json", "--input-format", "stream-json"];
        if (resumeSessionId) args.push("--conversation", resumeSessionId);
        if (model && model !== DEFAULT_GEMINI_LOCAL_MODEL) {
          const resolved = splitAgyModelEffort(model);
          args.push("--model", resolved.model);
          if (resolved.effort) args.push("--effort", resolved.effort);
        }
        if (asBoolean(config.dangerouslySkipPermissions, true)) {
          args.push("--dangerously-skip-permissions");
        }
        if (sandbox) args.push("--sandbox");
        if (extraArgs.length > 0) args.push(...extraArgs);
        return args;
      }
      const args = ["--output-format", "stream-json"];
      if (resumeSessionId) args.push("--resume", resumeSessionId);
      if (model && model !== DEFAULT_GEMINI_LOCAL_MODEL) args.push("--model", model);
      args.push("--approval-mode", "yolo");
      if (sandbox) {
        args.push("--sandbox");
      } else {
        args.push("--sandbox=none");
      }
      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("--prompt", prompt);
      return args;
    };

    const runAttempt = async (resumeSessionId: string | null) => {
      await hydrateFreshSessionHandoff(ctx, { resumedSession: Boolean(resumeSessionId) });
      const { basePrompt, promptMetrics } = buildPrompt(Boolean(resumeSessionId));
      const prompt = joinPromptSections([
        selectInitialCommunicationGuidance(context, { resumedSession: Boolean(resumeSessionId) }),
        basePrompt,
      ]);
      const args = buildArgs(resumeSessionId, prompt);
      const stdin = isAgy ? formatAgyStreamJsonInput(prompt) : undefined;
      const invocationEnv = atlas ? { ...env, ...ATLAS_GEMINI_ENV } : buildGeminiHeadlessEnv(env);
      const invocationRuntimeEnv = atlas ? invocationEnv : buildGeminiRuntimeEnv(env);
      const loggedEnv = buildInvocationEnvForLogs(invocationEnv, {
        runtimeEnv: invocationRuntimeEnv,
        includeRuntimeKeys: ["HOME"],
        resolvedCommand,
      });
      if (onMeta) {
        await onMeta({
          adapterType: "gemini_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: isAgy
            ? [...args, `<stdin prompt ${prompt.length} chars>`]
            : args.map((value, index) => (
                index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value
              )),
          env: loggedEnv,
          prompt,
          promptMetrics: { ...promptMetrics, promptChars: prompt.length },
          context,
        });
      }

      const consumeAccounting = createGeminiJsonlParser();
      let hasAccounting = false;
      const accountingLog = createUsageCheckpointLog(onLog, ctx.onUsage ?? (async () => {}), stdout => {
        hasAccounting = true;
        const parsed = consumeAccounting(stdout);
        return {
          usage: parsed.usage,
          costUsd: parsed.costUsd,
          usageBasis: "per_run",
          provider: "google",
          biller: "google",
          billingType,
          model,
          complete: isAgy ? parsed.terminalStatus === "success" : parsed.resultEvent !== null,
        };
      });
      const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
        onProcessStopped: providerStop.beginInvocation(),
        cwd: atlas ? effectiveExecutionCwd : cwd,
        env: invocationEnv,
        ...(stdin !== undefined ? { stdin } : {}),
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog: accountingLog,
        runLogTail: paperclipBridge?.runLogTail,
        settleRunDisposition: paperclipBridge?.settleRunDisposition,
      });
      await accountingLog.flush();
      const parsed = parseGeminiJsonl(proc.stdout);
      if (hasAccounting) {
        // Display output is capped by the process transport. Retain bounded
        // incremental accounting and terminal status across the full stream.
        const retained = consumeAccounting("");
        parsed.usage = retained.usage;
        parsed.costUsd = retained.costUsd;
        if (retained.terminalStatus !== null) {
          parsed.terminalStatus = retained.terminalStatus;
        }
        if (retained.resultEvent !== null && parsed.resultEvent === null) {
          parsed.resultEvent = retained.resultEvent;
        }
        if (retained.errorMessage && !parsed.errorMessage) {
          parsed.errorMessage = retained.errorMessage;
        }
      }
      return {
        proc,
        parsed,
      };
    };

    const toResult = (
      attempt: {
        proc: {
          exitCode: number | null;
          signal: string | null;
          timedOut: boolean;
          stdout: string;
          stderr: string;
          errorCode?: string | null;
        };
        parsed: ReturnType<typeof parseGeminiJsonl>;
      },
      clearSessionOnMissingSession = false,
      isRetry = false,
    ): AdapterExecutionResult => {
      const authMeta = detectGeminiAuthRequired({
        parsed: attempt.parsed.resultEvent,
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      });
      const networkUnavailable = isGeminiTransientNetworkError(attempt.proc.stdout, attempt.proc.stderr);

      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          usageComplete: isAgy ? attempt.parsed.terminalStatus === "success" : attempt.parsed.resultEvent !== null,
            usage: attempt.parsed.usage,
            usageBasis: "per_run",
            provider: "google",
            biller: "google",
            model,
            billingType,
            costUsd: attempt.parsed.costUsd,
          errorMessage: `Timed out after ${timeoutSec}s`,
          errorCode: authMeta.requiresAuth
            ? "gemini_auth_required"
            : networkUnavailable
              ? "gemini_network_unavailable"
              : null,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const structuredFailure = attempt.parsed.resultEvent
        ? describeGeminiFailure(attempt.parsed.resultEvent)
        : null;
      const rawExitCode = attempt.proc.exitCode;
      const agyMissingSuccess = isAgy && attempt.parsed.terminalStatus !== "success";
      const synthesizedExitCode = (agyMissingSuccess || (isAgy && parsedError)) && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
      const fallbackErrorMessage =
        parsedError ||
        structuredFailure ||
        (agyMissingSuccess ? "agy exited without a terminal SUCCESS result" : "") ||
        stderrLine ||
        `Gemini exited with code ${synthesizedExitCode ?? -1}`;
      const failed = (synthesizedExitCode ?? 0) !== 0;
      const clearSessionForTurnLimit = isGeminiTurnLimitResult(
        attempt.parsed.resultEvent,
        synthesizedExitCode,
      );

      // On retry, don't fall back to old session ID — the old session was stale
      const canFallbackToRuntimeSession = !isRetry;
      const resolvedSessionId = attempt.parsed.sessionId
        ?? (canFallbackToRuntimeSession ? (runtimeSessionId ?? runtime.sessionId ?? null) : null);
      const resolvedSessionParams = resolvedSessionId
        ? ({
          sessionId: resolvedSessionId,
          cwd: effectiveExecutionCwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          ...(executionTargetIsRemote
            ? {
                remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
              }
            : {}),
        } as Record<string, unknown>)
        : null;
      const resultJson: Record<string, unknown> = {
        ...(attempt.parsed.resultEvent ?? {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
        }),
        ...(failed && clearSessionForTurnLimit ? { stopReason: "max_turns_exhausted" } : {}),
      };

      return {
        exitCode: synthesizedExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        usageComplete: isAgy ? attempt.parsed.terminalStatus === "success" : attempt.parsed.resultEvent !== null,
        usageBasis: "per_run",
        errorMessage: failed ? fallbackErrorMessage : null,
        // Forward the transport-level error code from the run-disposition seam
        // first. A lost duplex control channel surfaces the typed
        // `duplex_channel_lost` code before any provider classification.
        errorCode: attempt.proc.errorCode
          ? attempt.proc.errorCode
          : failed && authMeta.requiresAuth
          ? "gemini_auth_required"
          : failed && clearSessionForTurnLimit
          ? "max_turns_exhausted"
          : failed && networkUnavailable
          ? "gemini_network_unavailable"
          : null,
        usage: attempt.parsed.usage,
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: "google",
        biller: "google",
        model,
        billingType,
        costUsd: attempt.parsed.costUsd,
        resultJson,
        summary: attempt.parsed.summary,
        question: attempt.parsed.question,
        clearSession: clearSessionForTurnLimit || Boolean(clearSessionOnMissingSession && !resolvedSessionId),
      };
    };

    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isGeminiSessionUnrecoverableError(initial.proc.stdout, initial.proc.stderr)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Gemini resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true, true);
    }

    return toResult(initial);
  } finally {
    try {
      await providerStop.collectBeforeRestore();
    } finally {
      await Promise.all([
        paperclipBridge?.stop(),
        restoreRemoteWorkspace?.(),
        localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
      ]);
    }
  }
}
