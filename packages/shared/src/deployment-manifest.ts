import { z } from "zod";
import { createCompanySchema } from "./validators/company.js";
import { createAgentSchema } from "./validators/agent.js";
import { createProjectSchema, createProjectWorkspaceSchema } from "./validators/project.js";
import { createRoutineSchema, createRoutineTriggerSchema } from "./validators/routine.js";
import { environmentCapacitySchema, filesystemOwnershipSchema } from "./validators/environment.js";

function undefaulted<T extends z.ZodObject>(schema: T) {
  return z.object(Object.fromEntries(Object.entries(schema.shape).map(([name, field]) =>
    [name, field instanceof z.ZodDefault ? field.removeDefault() : field])) as T["shape"]);
}

const key = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
/** Explicitly adopts the instance's singleton local environment. */
export const LOCAL_ENVIRONMENT_ADOPT = "instance-local";
const identity = z.object({ adopt: z.string().uuid().optional() });
const company = identity.extend({
  fields: undefaulted(createCompanySchema.pick({ name: true, description: true, budgetMonthlyCents: true })).strict(),
}).strict();
const project = identity.extend({
  company: key,
  fields: undefaulted(createProjectSchema.pick({ name: true, description: true, executionWorkspacePolicy: true })).strict(),
}).strict();
const agent = identity.extend({
  company: key,
  environment: key.nullable().optional(),
  /** Ordered environment keys tried when the agent's default lacks capacity. */
  overflowEnvironments: z.array(key).max(8).optional(),
  enabled: z.boolean().default(true),
  reportsTo: key.nullable().default(null),
  fields: undefaulted(createAgentSchema.pick({
    name: true, role: true, title: true, capabilities: true,
    adapterType: true, adapterConfig: true, budgetMonthlyCents: true, permissions: true,
  })).strict(),
  credentials: z.record(z.string().regex(/^(env\.[A-Z_][A-Z0-9_]*|[a-zA-Z][a-zA-Z0-9]*)$/), key).default({}),
}).strict();
const routine = identity.extend({
  company: key,
  project: key,
  agent: key,
  enabled: z.boolean().default(true),
  fields: undefaulted(createRoutineSchema.pick({
    title: true, description: true, priority: true, concurrencyPolicy: true,
    catchUpPolicy: true,
  })).strict(),
  schedule: createRoutineTriggerSchema.options[0].omit({ enabled: true }).extend({
    adopt: z.string().uuid().optional(),
  }).strict(),
}).strict();

export const deploymentManifestSchema = z.object({
  version: z.literal(1),
  owner: key,
  companies: z.record(key, company),
  projects: z.record(key, project).default({}),
  environments: z.record(key, z.object({
    // The singleton local environment has no UUID before the first apply; adopt it by name.
    adopt: z.union([z.string().uuid(), z.literal(LOCAL_ENVIRONMENT_ADOPT)]).optional(),
    company: key,
    // SSH declarations name their private key; local declarations take none.
    credential: key.optional(),
    fields: z.discriminatedUnion("driver", [
      z.object({
        name: z.string().trim().min(1),
        description: z.string().nullable().optional(),
        driver: z.literal("ssh"),
        config: z.object({
          host: z.string().trim().min(1), port: z.number().int().min(1).max(65535).default(22),
          username: z.string().trim().min(1),
          remoteWorkspacePath: z.string().refine(p => p.startsWith("/") && !p.includes("\0")),
          knownHosts: z.string().trim().min(1), strictHostKeyChecking: z.literal(true),
          workspaceRealizationMode: z.enum(["copy", "in_place"]).optional(),
          filesystemOwnership: filesystemOwnershipSchema.optional(),
          capacity: environmentCapacitySchema.optional(),
        }).strict().refine(c => !c.filesystemOwnership || c.workspaceRealizationMode === "in_place"),
      }).strict(),
      // Binds the instance's managed local environment and owns only its capacity.
      z.object({
        driver: z.literal("local"),
        config: z.object({ capacity: environmentCapacitySchema }).strict(),
      }).strict(),
    ]),
  }).strict().refine((e) => (e.fields.driver === "ssh") === (e.credential !== undefined),
    { message: "SSH environments require a credential; local environments take none", path: ["credential"] })
    .refine((e) => (e.fields.driver === "local") === (e.adopt === LOCAL_ENVIRONMENT_ADOPT),
      { message: `Local environments require adopt: "${LOCAL_ENVIRONMENT_ADOPT}"; other drivers cannot use it`, path: ["adopt"] })).default({}),
  projectWorkspaces: z.record(key, identity.extend({
    project: key,
    fields: createProjectWorkspaceSchema.strict(),
  }).strict()).default({}),
  agents: z.record(key, agent).default({}),
  routines: z.record(key, routine).default({}),
  taskBridges: z.record(key, z.object({
    agent: key, project: key, credential: key,
    allowedAssignees: z.array(key).min(1).max(50),
  }).strict()).default({}),
}).strict().superRefine((m, ctx) => {
  const issue = (path: string[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const primaries = new Map<string, number>();
  for (const [name, workspace] of Object.entries(m.projectWorkspaces)) {
    if (!m.projects[workspace.project]) issue(["projectWorkspaces", name, "project"], "Unknown project key");
    primaries.set(workspace.project, (primaries.get(workspace.project) ?? 0) + Number(workspace.fields.isPrimary));
  }
  for (const [project, count] of primaries) {
    if (count !== 1) issue(["projectWorkspaces"], `Project ${project} requires exactly one declared primary workspace`);
  }
  for (const [name, project] of Object.entries(m.projects)) {
    for (const field of ["defaultProjectWorkspaceId", "environmentId"] as const) {
      if (project.fields.executionWorkspacePolicy?.[field] != null) {
        issue(["projects", name, "fields", "executionWorkspacePolicy", field], "Deployment policies cannot reference unmanaged database IDs; use the project primary workspace");
      }
    }
  }
  for (const kind of ["projects", "environments", "agents", "routines"] as const) {
    for (const [name, resource] of Object.entries(m[kind])) {
      if (!m.companies[resource.company]) issue([kind, name, "company"], "Unknown company key");
    }
  }
  if (Object.values(m.environments).filter((e) => e.fields.driver === "local").length > 1) {
    issue(["environments"], "The instance has one local environment; declare it at most once");
  }
  for (const [name, a] of Object.entries(m.agents)) {
    if (a.environment && m.environments[a.environment]?.company !== a.company) {
      issue(["agents", name, "environment"], "Environment must be declared in the same company");
    }
    for (const overflow of a.overflowEnvironments ?? []) {
      if (m.environments[overflow]?.company !== a.company) {
        issue(["agents", name, "overflowEnvironments"], "Overflow environments must be declared in the same company");
      }
    }
    const seen = new Set([name]);
    let manager = a.reportsTo;
    while (manager) {
      if (seen.has(manager)) { issue(["agents", name, "reportsTo"], "Reporting cycle"); break; }
      seen.add(manager);
      const parent = m.agents[manager];
      if (!parent || parent.company !== a.company) {
        issue(["agents", name, "reportsTo"], "Manager must be a declared agent in the same company"); break;
      }
      manager = parent.reportsTo;
    }
  }
  for (const [name, r] of Object.entries(m.routines)) {
    if (m.projects[r.project]?.company !== r.company) issue(["routines", name, "project"], "Project must belong to the same company");
    if (m.agents[r.agent]?.company !== r.company) issue(["routines", name, "agent"], "Agent must belong to the same company");
  }
  for (const [name, bridge] of Object.entries(m.taskBridges)) {
    const company = m.agents[bridge.agent]?.company;
    if (!company || m.projects[bridge.project]?.company !== company
      || bridge.allowedAssignees.some((a) => m.agents[a]?.company !== company)) {
      issue(["taskBridges", name], "Bridge references must resolve within one declared company");
    }
  }
});

export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;
