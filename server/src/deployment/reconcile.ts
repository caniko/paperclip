import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import {
  type Db, deploymentResources, companies, projects, agents, routines,
  routineTriggers, agentApiKeys, boardApiKeys, companySecrets, companySecretVersions, companyMemberships,
  pluginManagedResources, builtInManagedResources,
  instanceSettings, projectWorkspaces, environments, budgetPolicies,
} from "@paperclipai/db";
import { LOCAL_ENVIRONMENT_ADOPT, deploymentManifestSchema, type DeploymentManifest, type Environment } from "@paperclipai/shared";
import type { createAgentLifecycleInTransaction } from "../services/agent-lifecycle.js";
import { publishAccountingActivities } from "../services/accounting-transaction.js";
import type { ActivityPublication } from "../types/activity-publication.js";
import { stableJson } from "../services/managed-resource-drift.js";
import { logActivity } from "../services/activity-log.js";
import { validateDeclaredAdapterConfig } from "./adapter-config.js";
import { validateCron } from "../services/cron.js";
import { bootstrapOperator } from "./bootstrap.js";
import { readCredential, type DeploymentDescriptor } from "./runtime.js";
import type { Config } from "../config.js";
import { verifyLocalEncryptedMaterials } from "../secrets/local-encrypted-provider.js";
import { mergeProjectWorkspaceRuntimeConfig } from "../services/project-workspace-runtime-config.js";

const tables = { company: companies, project: projects, workspace: projectWorkspaces, environment: environments, agent: agents, routine: routines, schedule: routineTriggers, secret: companySecrets, taskBridge: agentApiKeys, operatorKey: boardApiKeys };
type Kind = keyof typeof tables;
type Binding = typeof deploymentResources.$inferSelect;
type Fields = Record<string, unknown>;
type Spec = { kind: Kind; key: string; id: string; companyId: string | null; adopt?: string; enabled: boolean; fields: () => Fields; create: (fields: Fields) => Promise<string>; update: (fields: Fields) => Promise<unknown> };
export type DeploymentDifference = { kind: string; key: string; action: "create" | "adopt" | "update" | "disable"; fields: string[] };

/** The manifest owns only the fallback list inside application-managed runtime configuration. */
function withFallbacks({ fallbackEnvironmentIds, ...fields }: Fields, runtimeConfig: unknown = {}): Fields {
  if (fallbackEnvironmentIds === undefined) return fields;
  const current = runtimeConfig && typeof runtimeConfig === "object" ? runtimeConfig as Fields : {};
  return { ...fields, runtimeConfig: { ...current, fallbackEnvironmentIds } };
}

/** Values never appear in plans, including adapter URLs, paths and credentials. */
export function changedFields(before: Fields, after: Fields): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter((k) => stableJson(before[k]) !== stableJson(after[k]));
}

async function validateAdapters(manifest: DeploymentManifest, credentials: Record<string, string>) {
  for (const e of Object.values(manifest.environments)) {
    const { normalizeEnvironmentConfig } = await import("../services/environment-config.js");
    normalizeEnvironmentConfig({ driver: e.fields.driver, config: e.fields.config });
    if (e.credential && !credentials[e.credential]) throw new Error("Missing declared execution credential");
  }
  for (const a of Object.values(manifest.agents)) {
    validateDeclaredAdapterConfig(a.fields.adapterType, a.fields.adapterConfig, a.credentials);
    for (const credential of Object.values(a.credentials)) {
      if (!credentials[credential]) throw new Error("Missing declared worker credential");
    }
  }
  for (const r of Object.values(manifest.routines)) {
    if (validateCron(r.schedule.cronExpression)) throw new Error("Invalid declared routine schedule");
    try { new Intl.DateTimeFormat("en", { timeZone: r.schedule.timezone }); }
    catch { throw new Error("Invalid declared routine timezone"); }
  }
}

export async function reconcileDeployment(db: Db, raw: unknown, options: {
  apply: boolean; descriptor: DeploymentDescriptor; config: Config; singleOwner: boolean;
}) {
  let stage = "manifest";
  try {
  const parsed = deploymentManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid deployment manifest or references");
  const m = parsed.data;
  stage = "credentials";
  const credentials = Object.fromEntries(Object.entries(options.descriptor.credentialFiles).map(([key, file]) => [key, readCredential(file)]));
  await validateAdapters(m, credentials);
  for (const b of Object.values(m.taskBridges)) {
    if (!credentials[b.credential] || credentials[b.credential].trim().length < 32) throw new Error("Task bridge requires a runtime token of at least 32 characters");
  }
  for (const k of Object.values(m.operatorKeys)) {
    if (!credentials[k.credential] || credentials[k.credential].trim().length < 32) throw new Error("Operator key requires a runtime token of at least 32 characters");
  }
  if (Object.keys(m.operatorKeys).length && !options.descriptor.bootstrap) throw new Error("Declared operator keys require an operator bootstrap identity");
  stage = "database-preflight";
  const bridgeTokens = Object.values(m.taskBridges).map((b) => credentials[b.credential].trimEnd());
  if (new Set(bridgeTokens).size !== bridgeTokens.length) throw new Error("Task bridge tokens must be unique; use a new runtime token");
  const keyTokens = [...bridgeTokens, ...Object.values(m.operatorKeys).map((k) => credentials[k.credential].trimEnd())];
  if (new Set(keyTokens).size !== keyTokens.length) throw new Error("Operator key tokens must be unique; use a new runtime token");
   const publications: ActivityPublication[] = [];
   const afterCommit: Array<() => Promise<void>> = [];
   const lifecycleAgents = new Set<string>();
   const budgetCompanies = new Set<string>();
   // Keep execution-service imports out of read-only commands, and outside the
   // transaction's advisory lock when apply does need them.
   const services = options.apply ? await import("./mutation-services.js") : undefined;
   const result = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    if (!options.apply) await tx.execute(sql`set transaction read only`);
    await tx.execute(sql`select pg_advisory_xact_lock(1735289201)`);
    if (options.apply) await tx.execute(sql`select set_config('paperclip.deployment_apply', 'on', true)`);
    const [identity] = await tx.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "deployment"));
    if (identity && identity.general.instance !== options.descriptor.instance) throw new Error("Database belongs to another deployment instance");
    if (options.singleOwner && identity?.general.owner && identity.general.owner !== m.owner) {
      throw new Error("Deployment owner changed; an explicit ownership handoff is required");
    }
    stage = "encryption-check";
    // Validate historical and unmanaged local secrets too: the instance key is
    // shared, and a no-op declaration must not mask a broken restore/rotation.
    const encrypted = await tx.select({ material: companySecretVersions.material }).from(companySecretVersions)
      .innerJoin(companySecrets, eq(companySecretVersions.secretId, companySecrets.id))
      .where(eq(companySecrets.provider, "local_encrypted"));
    const keyFile = options.descriptor.serverCredentials.encryption ?? options.config.secretsMasterKeyFilePath;
    if (encrypted.length || options.descriptor.serverCredentials.encryption || existsSync(keyFile)) {
      verifyLocalEncryptedMaterials(readCredential(keyFile), encrypted.map((v) => v.material));
    }
    stage = "operator-preflight";
    const ledger = await tx.select().from(deploymentResources);
    if (options.singleOwner && ledger.some((binding) => binding.owner !== m.owner)) {
      throw new Error("Deployment owner changed; an explicit ownership handoff is required");
    }
    const owned = ledger.filter((b) => b.owner === m.owner);
    if (options.apply && (Object.keys(m.projectWorkspaces).length || owned.some((b) => b.kind === "workspace"))) {
      await tx.execute(sql`lock table project_workspaces in share row exclusive mode`);
    }
    const bindings = new Map(owned.map((b) => [`${b.kind}/${b.key}`, b]));
    const ids = new Map<string, string>();
    const getId = (kind: Kind, key: string, adopt?: string) => {
      const identity = `${kind}/${key}`;
      const id = ids.get(identity) ?? bindings.get(identity)?.resourceId ?? adopt ?? randomUUID();
      ids.set(identity, id); return id;
    };
    for (const [key, c] of Object.entries(m.companies)) getId("company", key, c.adopt);
    for (const [key, p] of Object.entries(m.projects)) getId("project", key, p.adopt);
    for (const [key, w] of Object.entries(m.projectWorkspaces)) getId("workspace", key, w.adopt);
    // The explicit sentinel adopts the singleton local environment once it exists.
    const [localEnvironment] = Object.values(m.environments).some((e) => e.adopt === LOCAL_ENVIRONMENT_ADOPT)
      ? await tx.select({ id: environments.id }).from(environments).where(eq(environments.driver, "local")).limit(1)
      : [];
    const environmentAdopt = (e: DeploymentManifest["environments"][string]) =>
      e.adopt === LOCAL_ENVIRONMENT_ADOPT ? localEnvironment?.id : e.adopt;
    for (const [key, e] of Object.entries(m.environments)) getId("environment", key, environmentAdopt(e));
    for (const [key, a] of Object.entries(m.agents)) getId("agent", key, a.adopt);
    const actorId = await bootstrapOperator(tx, options.config, options.descriptor.bootstrap, false);
    if (Object.keys(m.routines).length && !actorId && !options.descriptor.bootstrap) throw new Error("Declared routines require an operator bootstrap identity");
     stage = "resource-preflight";
     const actor = { userId: actorId };
     // Mutator closures run only in the apply branch guarded by services below.
     const companySvc = services?.companyService(tx, {}, { db, afterCommit, publications }), projectSvc = services?.projectService(tx), agentSvc = services?.agentService(tx), routineSvc = services?.routineService(tx), secrets = services?.secretService(tx);
    const agentLifecycle = services?.createAgentLifecycleInTransaction(tx, publications);
    const specs: Spec[] = [];
    const add = (spec: Omit<Spec, "id">) => specs.push({ ...spec, id: getId(spec.kind, spec.key, spec.adopt) });
    for (const [key, c] of Object.entries(m.companies).sort()) {
      add({ kind: "company", key, adopt: c.adopt, companyId: null, enabled: true, fields: () => c.fields,
        create: async (f) => {
          const { budgetMonthlyCents, ...rest } = { ...c.fields, ...f };
          const created = await companySvc!.create({ ...rest, id: getId("company", key), defaultResponsibleUserId: actor.userId }, { provisionBundledAgents: false });
          if (budgetMonthlyCents) await companySvc!.update(created.id, { budgetMonthlyCents });
          return created.id;
        },
        update: (f) => companySvc!.update(getId("company", key), f) });
    }
    for (const [key, p] of Object.entries(m.projects).sort()) {
      const companyId = getId("company", p.company);
      add({ kind: "project", key, adopt: p.adopt, companyId, enabled: true, fields: () => ({ ...p.fields, companyId }),
        create: async () => (await projectSvc!.create(companyId, { ...p.fields, id: getId("project", key) })).id,
        update: (f) => projectSvc!.update(getId("project", key), f) });
    }
    for (const [key, e] of Object.entries(m.environments).sort()) {
      const { collectEnvironmentSecretRefs, normalizeEnvironmentConfig } = await import("../services/environment-config.js");
      const companyId = getId("company", e.company), svc = services?.environmentService(tx);
      if (e.fields.driver === "local") {
        const config = e.fields.config;
        const fields = () => ({ config: normalizeEnvironmentConfig({ driver: "local", config }) });
        add({ kind: "environment", key, adopt: environmentAdopt(e), companyId, enabled: true, fields,
          create: async (f) => {
            const { id } = await svc!.ensureLocalEnvironment(companyId);
            if (!await svc!.update(id, f)) throw new Error("Managed environment is missing; explicit recovery is required");
            return id;
          },
          update: async (f) => {
            if (!await svc!.update(getId("environment", key), f)) throw new Error("Managed environment is missing; explicit recovery is required");
          } });
        continue;
      }
      const secretKey = `environment-${key}.privateKey`;
      const value = credentials[e.credential!], digest = createHash("sha256").update(value).digest("hex");
      add({ kind: "secret", key: secretKey, companyId, enabled: true, fields: () => ({ digest }),
        create: async () => (await secrets!.create(companyId, { name: `deployment.${m.owner}.${secretKey}`, provider: "local_encrypted", value })).id,
        update: () => secrets!.rotate(getId("secret", secretKey), { value }) });
      const ssh = e.fields;
      const fields = () => ({ ...ssh, status: "active" as const, envVars: {}, config: normalizeEnvironmentConfig({ driver: "ssh", config: {
        ...ssh.config, privateKeySecretRef: { type: "secret_ref", secretId: getId("secret", secretKey), version: "latest" },
      } }) });
      const syncRefs = async (environment: Environment) => {
        await secrets!.replaceSecretRefsForInstanceTarget({ targetType: "environment", targetId: environment.id },
          await collectEnvironmentSecretRefs({ db: tx, environment }));
        return environment.id;
      };
      add({ kind: "environment", key, adopt: e.adopt, companyId, enabled: true, fields,
        create: async () => syncRefs(await svc!.create(fields())),
        update: async () => {
          const updated = await svc!.update(getId("environment", key), fields());
          if (!updated) throw new Error("Managed environment is missing; explicit recovery is required");
          await syncRefs(updated);
        } });
    }
    const workspaceEntries = Object.entries(m.projectWorkspaces).sort(([a, x], [b, y]) =>
      Number(y.fields.isPrimary) - Number(x.fields.isPrimary) || a.localeCompare(b));
    for (const [key, w] of workspaceEntries) {
      const companyId = getId("company", m.projects[w.project].company);
      const projectId = getId("project", w.project);
      const { runtimeConfig, ...nativeFields } = w.fields;
      const fields = {
        ...nativeFields,
        sourceType: nativeFields.sourceType ?? (nativeFields.repoUrl ? "git_repo" : "local_path"),
        ...(runtimeConfig !== undefined ? { metadata: mergeProjectWorkspaceRuntimeConfig(nativeFields.metadata ?? null, runtimeConfig) } : {}),
        companyId, projectId,
      };
      add({ kind: "workspace", key, adopt: w.adopt, companyId, enabled: true, fields: () => fields,
        create: async () => {
          const created = await projectSvc!.createWorkspace(projectId, fields);
          if (!created) throw new Error("Declared workspace could not be created");
          return created.id;
        },
        update: async () => {
          if (!await projectSvc!.updateWorkspace(projectId, getId("workspace", key), fields)) throw new Error("Declared workspace could not be updated");
        } });
    }
    const agentKeys: string[] = [];
    const visit = (key: string) => { if (agentKeys.includes(key)) return; const parent = m.agents[key].reportsTo; if (parent) visit(parent); agentKeys.push(key); };
    Object.keys(m.agents).sort().forEach(visit);
    for (const key of agentKeys) {
      const a = m.agents[key], companyId = getId("company", a.company);
      for (const [field, credential] of Object.entries(a.credentials).sort()) {
        const secretKey = `${key}.${field}`;
        const value = credentials[credential];
        const digest = createHash("sha256").update(value).digest("hex");
        add({ kind: "secret", key: secretKey, companyId, enabled: true, fields: () => ({ digest }),
          create: async () => (await secrets!.create(companyId, { name: `deployment.${m.owner}.${secretKey}`, provider: "local_encrypted", value })).id,
          update: () => secrets!.rotate(getId("secret", secretKey), { value }) });
      }
      const fields = () => {
        const adapterConfig = { ...a.fields.adapterConfig };
        for (const field of Object.keys(a.credentials)) {
          const ref = { type: "secret_ref", secretId: getId("secret", `${key}.${field}`), version: "latest" };
          if (field.startsWith("env.")) adapterConfig.env = { ...(adapterConfig.env as Fields ?? {}), [field.slice(4)]: ref };
          else adapterConfig[field] = ref;
        }
        return { ...a.fields, adapterConfig, reportsTo: a.reportsTo ? getId("agent", a.reportsTo) : null, companyId,
          ...(a.environment !== undefined ? { defaultEnvironmentId: a.environment ? getId("environment", a.environment) : null } : {}),
          ...(a.overflowEnvironments !== undefined ? { fallbackEnvironmentIds: a.overflowEnvironments.map((k) => getId("environment", k)) } : {}) };
      };
      add({ kind: "agent", key, adopt: a.adopt, companyId, enabled: a.enabled, fields,
        create: async (f) => {
          const { budgetMonthlyCents, ...rest } = { ...a.fields, ...withFallbacks(f) };
          const created = await agentLifecycle!.requestHire(companyId, { ...rest, id: getId("agent", key), status: a.enabled ? "idle" : "paused", ...(a.enabled ? {} : { pauseReason: "deployment" }) }, { runnerResolved: true, responsibleUserId: actor.userId, createdByUserId: actor.userId });
          if (budgetMonthlyCents) await agentLifecycle!.updateConfiguration(created.id, { budgetMonthlyCents });
          return created.id;
        },
        update: async (f) => {
          const { companyId: _companyId, ...configuration } = f;
          const [current] = configuration.fallbackEnvironmentIds === undefined ? []
            : await tx.select({ runtimeConfig: agents.runtimeConfig }).from(agents).where(eq(agents.id, getId("agent", key)));
          return agentLifecycle!.updateConfiguration(getId("agent", key), withFallbacks(configuration, current?.runtimeConfig));
        } });
    }
    for (const [key, r] of Object.entries(m.routines).sort()) {
      const companyId = getId("company", r.company);
      const { adopt: scheduleAdopt, ...schedule } = r.schedule;
      const fields = () => ({ ...r.fields, projectId: getId("project", r.project), assigneeAgentId: getId("agent", r.agent), companyId });
      add({ kind: "routine", key, adopt: r.adopt, companyId, enabled: r.enabled, fields,
        create: async () => (await routineSvc!.create(companyId, { ...r.fields, projectId: getId("project", r.project), assigneeAgentId: getId("agent", r.agent), status: r.enabled ? "active" : "paused", variables: [] }, actor)).id,
        update: (f) => routineSvc!.update(getId("routine", key), f, actor) });
      add({ kind: "schedule", key, adopt: scheduleAdopt, companyId, enabled: true, fields: () => ({ ...schedule, routineId: getId("routine", key) }),
        create: async () => (await routineSvc!.createTrigger(getId("routine", key), { ...schedule, enabled: true }, actor)).trigger.id,
        update: (f) => routineSvc!.updateTrigger(getId("schedule", key), { ...schedule, ...(f.enabled === true ? { enabled: true } : {}) }, actor) });
    }
    for (const [key, b] of Object.entries(m.taskBridges).sort()) {
      const companyId = getId("company", m.agents[b.agent].company);
      const token = credentials[b.credential].trimEnd();
      const scope = { kind: "task_bridge" as const, projectId: getId("project", b.project), allowedAssigneeAgentIds: b.allowedAssignees.map((a) => getId("agent", a)).sort() };
      add({ kind: "taskBridge", key, companyId, enabled: true,
        fields: () => ({ agentId: getId("agent", b.agent), scopeConfig: scope, keyHash: createHash("sha256").update(token).digest("hex") }),
        create: async () => (await agentSvc!.createApiKey(getId("agent", b.agent), `deployment.${m.owner}.${key}`, scope, { responsibleUserId: actor.userId, token })).id,
        update: async () => { throw new Error("Task bridge rotation requires a new declaration key and removal of the old key"); } });
    }
    for (const [key, k] of Object.entries(m.operatorKeys).sort()) {
      const token = credentials[k.credential].trimEnd();
      add({ kind: "operatorKey", key, companyId: null, enabled: true,
        fields: () => ({ keyHash: createHash("sha256").update(token).digest("hex") }),
        create: async () => (await services!.boardAuthService(tx).createNamedBoardApiKey({ userId: actor.userId!, name: `deployment.${m.owner}.${key}`, expiresAt: null, token })).id,
        update: async () => { throw new Error("Operator key rotation requires a new declaration key and removal of the old key"); } });
    }
    const differences: DeploymentDifference[] = [];
    if (!identity) differences.push({ kind: "instance", key: options.descriptor.instance, action: "create", fields: ["instance"] });
    else if (options.singleOwner && !identity.general.owner) {
      differences.push({ kind: "instance", key: options.descriptor.instance, action: "update", fields: ["owner"] });
    }
    const actions = new Map<Spec, DeploymentDifference>();
    const claimed = new Set<string>();
    for (const spec of specs) {
      const resource = `${spec.kind}/${spec.id}`;
      if (claimed.has(resource)) throw new Error("Duplicate resource ownership in deployment manifest");
      claimed.add(resource);
      const binding = bindings.get(`${spec.kind}/${spec.key}`);
      if (spec.adopt && binding && spec.adopt !== binding.resourceId) throw new Error("Adoption cannot change a managed identity");
      if (binding && binding.companyId !== spec.companyId) throw new Error("Moving managed resources between companies is unsupported");
      if (binding && !binding.enabled && ["taskBridge", "operatorKey", "secret"].includes(spec.kind)) throw new Error("Removed credentials require a new declaration key");
      if (ledger.some((b) => b.kind === spec.kind && b.resourceId === spec.id && (b.owner !== m.owner || b.key !== spec.key))) throw new Error("Resource ownership conflict");
      const table = tables[spec.kind];
      const existing = await tx.select({ id: table.id }).from(table).where(eq(table.id, spec.id));
      if ((binding || spec.adopt) && !existing.length) throw new Error("Managed or adopted resource is missing; explicit recovery is required");
      if (spec.kind === "environment" && binding) {
        const before = binding.fields.config as Fields, after = spec.fields().config as Fields;
        if (["host", "port", "username", "remoteWorkspacePath", "workspaceRealizationMode", "filesystemOwnership"]
          .some(field => stableJson(before[field]) !== stableJson(after[field]))) {
          throw new Error("Environment placement changes require an explicit ownership handoff");
        }
      }
      if (spec.kind === "workspace") {
        const projectId = spec.fields().projectId as string;
        const siblings = await tx.select().from(projectWorkspaces).where(eq(projectWorkspaces.projectId, projectId));
        if (existing.length) {
          const [workspace] = await tx.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, spec.id));
          if (workspace.projectId !== projectId || workspace.companyId !== spec.companyId) throw new Error("Workspace belongs to a different project or company");
        } else if (siblings.some((workspace) =>
          (spec.fields().name && workspace.name === String(spec.fields().name).trim()) ||
          (spec.fields().remoteWorkspaceRef && workspace.remoteWorkspaceRef === spec.fields().remoteWorkspaceRef
            && workspace.remoteProvider === (spec.fields().remoteProvider ?? null)))) {
          throw new Error("Existing workspace requires explicit adoption");
        }
        if (spec.fields().isPrimary && siblings.some((workspace) => workspace.isPrimary && workspace.id !== spec.id
          && !specs.some((other) => other.kind === "workspace" && other.id === workspace.id && other.fields().projectId === projectId))) {
          throw new Error("Existing primary workspace requires explicit adoption before changing primary selection");
        }
      }
      if (!binding && !spec.adopt && existing.length) throw new Error("Existing unmanaged resource requires explicit adoption");
      if (spec.adopt) {
        for (const registry of [pluginManagedResources, builtInManagedResources]) {
          const owners = await tx.select({ id: registry.id }).from(registry).where(eq(registry.resourceId, spec.id));
          if (owners.length) throw new Error("Adoption conflicts with an existing managed resource owner");
        }
      }
      if (!binding && !spec.adopt && ["company", "project", "agent", "routine", "environment"].includes(spec.kind)
        && !(spec.kind === "environment" && spec.fields().name === undefined)) {
        const fields = spec.fields();
        const label = spec.kind === "routine" ? "title" : "name";
        const matches = await tx.execute(sql`select id from ${table} where ${sql.identifier(label)} = ${fields[label] as string}
          ${spec.companyId && spec.kind !== "environment" ? sql`and company_id = ${spec.companyId}` : sql``} limit 1`);
        if (matches.length) throw new Error("Existing resource with this name requires explicit adoption");
      }
      if (spec.kind === "taskBridge" && !binding) {
        const matches = await tx.select({ id: agentApiKeys.id }).from(agentApiKeys).where(eq(agentApiKeys.keyHash, spec.fields().keyHash as string));
        if (matches.length) throw new Error("Task bridge tokens must be unique; use a new runtime token");
      }
      if (spec.kind === "operatorKey" && !binding) {
        const matches = await tx.select({ id: boardApiKeys.id }).from(boardApiKeys).where(eq(boardApiKeys.keyHash, spec.fields().keyHash as string));
        if (matches.length) throw new Error("Operator key tokens must be unique; use a new runtime token");
      }
      if (spec.adopt && spec.companyId && spec.kind !== "environment") {
        const rows = await tx.execute(sql`select company_id from ${table} where id = ${spec.id}`);
        if (rows[0]?.company_id !== spec.companyId) throw new Error("Adopted resource belongs to a different company");
      }
      if (spec.kind === "schedule") {
        const routineId = spec.fields().routineId as string;
        if (existing.length) {
          const [trigger] = await tx.select({ routineId: routineTriggers.routineId, kind: routineTriggers.kind })
            .from(routineTriggers).where(eq(routineTriggers.id, spec.id));
          if (!trigger || trigger.routineId !== routineId || trigger.kind !== "schedule") {
            throw new Error("Adopted schedule must belong to the declared routine");
          }
        }
        if (!binding) {
          const active = await tx.select({ id: routineTriggers.id }).from(routineTriggers).where(and(
            eq(routineTriggers.routineId, routineId), eq(routineTriggers.kind, "schedule"),
            eq(routineTriggers.enabled, true), eq(routineTriggers.archived, false),
          ));
          if (active.some((trigger) => trigger.id !== (spec.adopt ?? ""))) {
            throw new Error("Existing active schedule requires explicit adoption before declaring this routine");
          }
        }
      }
      const changed = changedFields(binding?.fields ?? {}, spec.fields());
      if (binding && (spec.kind === "taskBridge" || spec.kind === "operatorKey") && changed.length) throw new Error("Task bridge rotation requires a new declaration key and removal of the old key");
      if (!binding || changed.length || binding.enabled !== spec.enabled) {
        const action: DeploymentDifference = { kind: spec.kind, key: spec.key, action: !binding ? (spec.adopt ? "adopt" : "create") : "update", fields: changed };
        actions.set(spec, action); differences.push(action);
      }
    }
    const removed = owned.filter((b) => b.enabled && !specs.some((s) => s.kind === b.kind && s.key === b.key));
    if (removed.some((b) => b.kind === "environment")) throw new Error("Environment removal requires an explicit ownership handoff; retain the declaration to preserve execution references");
    if (removed.some((b) => b.kind === "workspace")) throw new Error("Workspace removal requires an explicit ownership handoff; retain the declaration to preserve execution references");
    for (const b of removed) differences.push({ kind: b.kind, key: b.key, action: "disable", fields: [] });
    if (options.descriptor.bootstrap && !actorId) differences.unshift({ kind: "operator", key: "bootstrap", action: "create", fields: [] });
    if (services) {
      stage = "operator-apply";
      if (!identity) await tx.insert(instanceSettings).values({ singletonKey: "deployment", general: {
        instance: options.descriptor.instance, ...(options.singleOwner ? { owner: m.owner } : {}),
      } });
      else if (options.singleOwner && !identity.general.owner) {
        await tx.update(instanceSettings).set({ general: { ...identity.general, owner: m.owner } })
          .where(eq(instanceSettings.id, identity.id));
      }
      actor.userId = await bootstrapOperator(tx, options.config, options.descriptor.bootstrap, true);
      stage = "resource-apply";
      for (const spec of specs) {
        if (!actions.has(spec)) continue;
        const fields = spec.fields();
        const binding = bindings.get(`${spec.kind}/${spec.key}`);
        if (!binding && !spec.adopt) {
          spec.id = await spec.create(fields); ids.set(`${spec.kind}/${spec.key}`, spec.id);
        } else {
          const updateFields = { ...fields };
          // Native budget setters reconcile pause state even for an unchanged
          // limit. An enablement or unrelated edit must not reapply that limit.
          // Keep the full declaration in the ledger so ownership is preserved.
          if (binding && (spec.kind === "agent" || spec.kind === "company")
            && !actions.get(spec)!.fields.includes("budgetMonthlyCents")) {
            delete updateFields.budgetMonthlyCents;
          }
          if (binding && !binding.enabled && spec.kind === "schedule") updateFields.enabled = true;
          await spec.update(updateFields);
        }
        if (spec.kind === "agent") lifecycleAgents.add(spec.id);
        if ((spec.kind === "agent" || spec.kind === "company") && "budgetMonthlyCents" in fields &&
            actions.get(spec)!.fields.includes("budgetMonthlyCents")) {
          budgetCompanies.add(spec.companyId ?? spec.id);
          await tx.update(budgetPolicies).set({ hardStopEnabled: true, isActive: Number(fields.budgetMonthlyCents) > 0, enforcementVersion: sql`${budgetPolicies.enforcementVersion} + 1` })
            .where(and(eq(budgetPolicies.scopeType, spec.kind), eq(budgetPolicies.scopeId, spec.id),
              eq(budgetPolicies.metric, "billed_cents"), eq(budgetPolicies.windowKind, "calendar_month_utc")));
        }
        if (!spec.enabled) await disableResource(tx, spec.kind, spec.id, agentLifecycle!);
        const next = { owner: m.owner, kind: spec.kind, key: spec.key, resourceId: spec.id, companyId: spec.companyId, fields: spec.fields(), enabled: spec.enabled };
        await tx.insert(deploymentResources).values(next).onConflictDoUpdate({ target: [deploymentResources.owner, deploymentResources.kind, deploymentResources.key], set: next });
        const companyId = spec.companyId ?? spec.id;
        if (spec.kind === "company" && actor.userId && !binding) {
          await tx.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actor.userId, status: "active", membershipRole: "owner" }).onConflictDoNothing();
        }
        if (spec.kind !== "operatorKey") await logActivity(tx, { companyId, actorType: "system", actorId: `deployment:${m.owner}`, action: "deployment.reconciled", entityType: spec.kind, entityId: spec.id, details: { key: spec.key, fields: actions.get(spec)!.fields } }, publications);
      }
      for (const binding of removed) {
        if (binding.kind === "agent") lifecycleAgents.add(binding.resourceId);
        await disableResource(tx, binding.kind as Kind, binding.resourceId, agentLifecycle!);
        await tx.update(deploymentResources).set({ enabled: false }).where(and(eq(deploymentResources.owner, m.owner), eq(deploymentResources.kind, binding.kind), eq(deploymentResources.key, binding.key)));
        if (binding.kind !== "operatorKey") await logActivity(tx, { companyId: binding.companyId ?? binding.resourceId, actorType: "system", actorId: `deployment:${m.owner}`, action: "deployment.disabled", entityType: binding.kind, entityId: binding.resourceId, details: { key: binding.key } }, publications);
      }
    }
    return {
      version: 1, owner: m.owner, differences,
      bindings: Object.fromEntries(specs.filter((s) => options.apply || bindings.has(`${s.kind}/${s.key}`)).map((s) => [`${s.kind}/${s.key}`, s.id])),
    };
   });
   for (const id of lifecycleAgents) services!.scheduleAgentLifecycle(db, id);
   for (const publication of publications) publishAccountingActivities(publication.companyId, [publication]);
   for (const effect of afterCommit) await effect();
   for (const companyId of budgetCompanies) {
     await services!.deliverBudgetEnforcement(db, {}, companyId);
   }
   return result;
  } catch (error) {
    // This receipt is consumed by the deployment entry point. Never copy the
    // exception's message, SQL query, credential path, or manifest fields.
    if (error instanceof Error && Object.isExtensible(error)) {
      Object.defineProperty(error, "deploymentStage", { value: stage, configurable: true });
      throw error;
    }
    throw Object.assign(new Error("Declarative reconciliation failed", { cause: error }), { deploymentStage: stage });
  }
}

async function disableResource(db: Db, kind: Kind, id: string, lifecycle: ReturnType<typeof createAgentLifecycleInTransaction>) {
  if (kind === "agent") {
    const [agent] = await db.select().from(agents).where(eq(agents.id, id));
    if (agent && !["pending_approval", "terminated", "rejected"].includes(agent.lifecycleState)) {
      await lifecycle.pauseAgent(id, "deployment");
    }
  } else if (kind === "routine") {
    await db.update(routines).set({ status: "paused" }).where(eq(routines.id, id));
  } else if (kind === "company") {
    await db.update(companies).set({ status: "paused" }).where(and(eq(companies.id, id), eq(companies.status, "active")));
  } else if (kind === "taskBridge") {
    await db.update(agentApiKeys).set({ revokedAt: new Date() }).where(eq(agentApiKeys.id, id));
  } else if (kind === "operatorKey") {
    await db.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, id));
  } else if (kind === "schedule") {
    await db.update(routineTriggers).set({ enabled: false }).where(eq(routineTriggers.id, id));
  } else if (kind === "secret") {
    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, id));
  }
}
