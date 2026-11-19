import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { agents } from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { atlasExecutionPolicy, readCredential, type AtlasAdmission } from "../../deployment/runtime.js";
import { forbidden } from "../../errors.js";
import type { environmentService } from "../environments.js";

type Agent = Pick<typeof agents.$inferSelect, "id" | "companyId" | "adapterType" | "adapterConfig" | "runtimeConfig" | "defaultEnvironmentId">;

export function atlasAdmissionForAgent(agent: Agent, companyId: string): AtlasAdmission | null {
  const policy = atlasExecutionPolicy();
  if (!policy) return null;
  const admission = policy.admissions.find((row) => row.companyId === companyId && row.agentId === agent.id);
  if (!admission || agent.companyId !== companyId || agent.adapterType !== admission.adapterType ||
      agent.defaultEnvironmentId !== admission.environmentId || Object.keys(agent.runtimeConfig ?? {}).some((key) => key !== "heartbeat") ||
      agent.adapterConfig?.engine !== "cli" || agent.adapterConfig.command !== admission.command ||
      Object.keys(agent.adapterConfig).some((key) => !["engine", "command", "model", "timeoutSec", "dangerouslySkipPermissions"].includes(key))) {
    throw forbidden("No qualified Atlas agent execution binding");
  }
  return admission;
}

function atlasKnownHosts(binding: AtlasAdmission) {
  return `${binding.port === 22 ? binding.host : `[${binding.host}]:${binding.port}`} ${binding.hostKey}`;
}

export function assertAtlasEnvironment(binding: AtlasAdmission, environment: Environment | null): asserts environment is Environment {
  const knownHosts = atlasKnownHosts(binding);
  const config = environment?.config;
  if (!environment || environment.id !== binding.environmentId || environment.driver !== "ssh" || environment.status !== "active" ||
      Object.keys(environment.envVars ?? {}).length > 0 || !config || config.host !== binding.host || config.port !== binding.port ||
      config.username !== binding.username || config.remoteWorkspacePath !== binding.remoteWorkspacePath ||
      config.knownHosts !== knownHosts || config.strictHostKeyChecking !== true || config.privateKeyCredential !== binding.privateKeyCredential ||
      (config.workspaceRealizationMode !== undefined && config.workspaceRealizationMode !== "copy") ||
      Object.entries(config).some(([key, value]) => ![
        "host", "port", "username", "remoteWorkspacePath", "knownHosts", "strictHostKeyChecking", "privateKeyCredential", "workspaceRealizationMode", "capacity",
      ].includes(key) && value != null)) {
    throw forbidden("Atlas SSH environment is unavailable or differs from the controller pin");
  }
}

type EnvironmentService = Pick<ReturnType<typeof environmentService>, "getById" | "acquireLease" | "releaseLease">;

export async function acquireAtlasExecution(input: {
  environments: EnvironmentService;
  binding: AtlasAdmission;
  runId: string | null;
  issueId: string | null;
  assertOwned?: () => Promise<void>;
}) {
  const { environments, binding } = input;
  const environment = await environments.getById(binding.environmentId);
  assertAtlasEnvironment(binding, environment);
  // Unlike the ordinary SSH driver's acquire, this only reserves a DB slot. It
  // doesn't resolve credentials or prepare the directory on the worker.
  const lease = await environments.acquireLease({
    companyId: binding.companyId, environmentId: binding.environmentId,
    issueId: input.issueId, heartbeatRunId: input.runId, assertCompanyBinding: true,
    leasePolicy: "ephemeral", provider: "ssh", maxConcurrentRuns: 1,
    metadata: { agentId: binding.agentId, driver: "ssh", remoteCwd: binding.remoteWorkspacePath },
  });
  try {
    await input.assertOwned?.();
    const acquired = await environments.getById(lease.environmentId ?? "");
    assertAtlasEnvironment(binding, acquired);
    if (lease.companyId !== binding.companyId || lease.provider !== "ssh" || lease.status !== "active" ||
        lease.metadata?.driver !== "ssh" || lease.metadata.agentId !== binding.agentId ||
        lease.metadata.remoteCwd !== binding.remoteWorkspacePath || lease.heartbeatRunId !== input.runId) {
      throw forbidden("Acquired Atlas lease differs from the admitted execution binding");
    }
    return { environment: acquired, lease };
  } catch (error) {
    await environments.releaseLease(lease.id, "failed");
    throw error;
  }
}

export async function prepareAtlasScratch(binding: AtlasAdmission) {
  const policy = atlasExecutionPolicy()!;
  const home = await fs.realpath(policy.home);
  const root = path.join(home, "atlas-quarantine");
  await fs.mkdir(root, { mode: 0o700 }).catch((err) => { if (err.code !== "EEXIST") throw err; });
  const dir = await fs.lstat(root);
  if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0 || await fs.realpath(root) !== root) {
    throw forbidden("Atlas scratch quarantine must be private and controller owned");
  }
  const credential = readCredential(policy.credentialFiles[binding.privateKeyCredential]!);
  const scratchDir = await fs.mkdtemp(path.join(root, "run-"));
  return {
    kind: "remote", transport: "ssh", environmentId: binding.environmentId, leaseId: null, remoteCwd: binding.remoteWorkspacePath,
    spec: {
      host: binding.host, port: binding.port, username: binding.username, remoteCwd: binding.remoteWorkspacePath,
      remoteWorkspacePath: binding.remoteWorkspacePath, workspaceRealizationMode: "copy", strictHostKeyChecking: true,
      knownHosts: atlasKnownHosts(binding), privateKey: credential,
      atlas: { sshExecutable: binding.sshExecutable, scratchDir },
    },
  } as const satisfies AdapterExecutionTarget;
}

export function assertAtlasDispatch(binding: AtlasAdmission, target: AdapterExecutionTarget | null | undefined, config: Record<string, unknown>, cwd: string) {
  if (target?.kind !== "remote" || target.transport !== "ssh" || target.environmentId !== binding.environmentId || !target.leaseId ||
    target.remoteCwd !== binding.remoteWorkspacePath || target.spec.remoteCwd !== target.remoteCwd ||
    target.spec.host !== binding.host || target.spec.port !== binding.port || target.spec.username !== binding.username ||
    target.spec.knownHosts !== atlasKnownHosts(binding) || !target.spec.strictHostKeyChecking || !target.spec.privateKey ||
    target.spec.workspaceRealizationMode !== "copy" || target.spec.remoteWorkspacePath !== binding.remoteWorkspacePath ||
    target.spec.atlas?.sshExecutable !== binding.sshExecutable || target.spec.atlas.scratchDir !== cwd || target.spec.atlas.probe ||
    config.command !== binding.command || config.engine !== "cli" ||
    Object.keys(config).some((key) => !["command", "engine", "model", "timeoutSec", "dangerouslySkipPermissions", "env"].includes(key)) ||
    Object.keys((config.env as Record<string, unknown> | undefined) ?? {}).length > 0) {
    throw forbidden("Final Atlas dispatch differs from the qualified binding");
  }
}
