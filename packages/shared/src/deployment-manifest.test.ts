import { describe, expect, it } from "vitest";
import { deploymentManifestSchema } from "./deployment-manifest.js";

const company = { fields: { name: "Example" } };
const agent = { company: "example", fields: { name: "Worker", adapterType: "process", adapterConfig: { command: "true" } } };
describe("deployment manifest", () => {
  it("declares operator keys by credential alias only", () => {
    const manifest = { version: 1, owner: "deployment", companies: { example: company } };
    expect(deploymentManifestSchema.parse(manifest).operatorKeys).toEqual({});
    expect(deploymentManifestSchema.parse({ ...manifest, operatorKeys: { ops: { credential: "operator" } } }).operatorKeys)
      .toEqual({ ops: { credential: "operator" } });
    for (const invalid of [{ ops: {} }, { ops: { credential: "operator", token: "secret" } }, { Ops: { credential: "operator" } }]) {
      expect(deploymentManifestSchema.safeParse({ ...manifest, operatorKeys: invalid }).success).toBe(false);
    }
  });
  it("resolves company-owned SSH environments by declaration key without database IDs or key material", () => {
    const ssh = { company: "example", credential: "executor", fields: { name: "Atlas", driver: "ssh",
      config: { host: "atlas", port: 1337, username: "can", remoteWorkspacePath: "/work", knownHosts: "atlas ssh-ed25519 AAAA", strictHostKeyChecking: true } } };
    const manifest = { version: 1, owner: "deployment", companies: { example: company },
      environments: { atlas: ssh }, agents: { worker: { ...agent, environment: "atlas" } } };
    expect(deploymentManifestSchema.parse(manifest).agents.worker.environment).toBe("atlas");
    for (const invalid of [
      { ...manifest, agents: { worker: { ...agent, environment: "missing" } } },
      { ...manifest, environments: { atlas: { ...ssh, company: "missing" } } },
      { ...manifest, environments: { atlas: { ...ssh, fields: { ...ssh.fields, config: { ...ssh.fields.config, privateKey: "PRIVATE" } } } } },
      { ...manifest, environments: { atlas: { ...ssh, fields: { ...ssh.fields, config: { ...ssh.fields.config, strictHostKeyChecking: false } } } } },
      { ...manifest, environments: { atlas: { ...ssh, company: "other" } }, companies: { example: company, other: company } },
    ]) expect(deploymentManifestSchema.safeParse(invalid).success).toBe(false);
  });
  it("declares local capacity and same-company overflow environments", () => {
    const ssh = { company: "example", credential: "executor", fields: { name: "Nomad", driver: "ssh",
      config: { host: "nomad", username: "exec", remoteWorkspacePath: "/work", knownHosts: "nomad ssh-ed25519 AAAA", strictHostKeyChecking: true,
        capacity: { maxConcurrentRuns: 1, admissionCommand: ["probe"] } } } };
    const local = { adopt: "instance-local", company: "example", fields: { driver: "local", config: { capacity: { maxConcurrentRuns: 1 } } } };
    const manifest = { version: 1, owner: "deployment", companies: { example: company },
      environments: { local, nomad: ssh }, agents: { worker: { ...agent, environment: "local", overflowEnvironments: ["nomad"] } } };
    expect(deploymentManifestSchema.parse(manifest).agents.worker.overflowEnvironments).toEqual(["nomad"]);
    for (const invalid of [
      { ...manifest, agents: { worker: { ...agent, overflowEnvironments: ["missing"] } } },
      { ...manifest, environments: { local: { ...local, credential: "executor" }, nomad: ssh } },
      { ...manifest, environments: { local, nomad: { ...ssh, credential: undefined } } },
      { ...manifest, environments: { local, again: local, nomad: ssh } },
      { ...manifest, environments: { local: { ...local, adopt: undefined }, nomad: ssh } },
      { ...manifest, environments: { local: { ...local, adopt: "00000000-0000-4000-8000-000000000000" }, nomad: ssh } },
      { ...manifest, environments: { local, nomad: { ...ssh, adopt: "instance-local" } } },
      { ...manifest, environments: { local: { ...local, fields: { ...local.fields, config: { capacity: { maxConcurrentRuns: 1 }, host: "x" } } }, nomad: ssh } },
    ]) expect(deploymentManifestSchema.safeParse(invalid).success).toBe(false);
  });
  it("keeps omitted fields absent instead of applying native create defaults", () => {
    const parsed = deploymentManifestSchema.parse({ version: 1, owner: "deployment", companies: { example: company }, agents: { worker: agent } });
    expect(parsed.companies.example.fields).toEqual({ name: "Example" });
    expect(parsed.agents.worker.fields).toEqual({ name: "Worker", adapterType: "process", adapterConfig: { command: "true" } });
    expect(() => deploymentManifestSchema.parse({ version: 1, owner: "deployment", companies: { example: company },
      agents: { worker: { ...agent, fields: { name: "Worker", adapterType: "process" } } } })).toThrow();
  });

  it("requires one explicit primary and a valid source for each declared project workspace", () => {
    const manifest = {
      version: 1, owner: "deployment", companies: { example: company },
      projects: { main: { company: "example", fields: { name: "Main" } } },
      projectWorkspaces: { checkout: { project: "main", fields: {
        name: "Checkout", sourceType: "remote_managed", remoteWorkspaceRef: "project-key", isPrimary: true,
      } } },
    };
    expect(deploymentManifestSchema.parse(manifest).projectWorkspaces.checkout.project).toBe("main");
    for (const projectWorkspaces of [
      { checkout: { ...manifest.projectWorkspaces.checkout, project: "missing" } },
      { checkout: { project: "main", fields: { name: "No source", isPrimary: true } } },
      { checkout: { ...manifest.projectWorkspaces.checkout, fields: { cwd: "/checkout", isPrimary: false } } },
      { ...manifest.projectWorkspaces, other: manifest.projectWorkspaces.checkout },
    ]) expect(deploymentManifestSchema.safeParse({ ...manifest, projectWorkspaces }).success).toBe(false);
  });
  it("accepts native execution policy and rejects unmanaged database references", () => {
    const policy = { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize",
      allowIssueOverride: false, workspaceStrategy: { type: "project_primary" } };
    const manifest = { version: 1, owner: "deployment", companies: { example: company },
      projects: { main: { company: "example", fields: { name: "Main", executionWorkspacePolicy: policy } } } };
    expect(deploymentManifestSchema.parse(manifest).projects.main.fields.executionWorkspacePolicy).toEqual(policy);
    for (const invalid of [
      { ...policy, sharedWorkspaceConcurrency: "sometimes" },
      { ...policy, writableRepositories: ["arbitrary"] },
      { ...policy, defaultProjectWorkspaceId: "00000000-0000-4000-8000-000000000001" },
      { ...policy, environmentId: "00000000-0000-4000-8000-000000000001" },
    ]) expect(deploymentManifestSchema.safeParse({ ...manifest,
      projects: { main: { ...manifest.projects.main, fields: { name: "Main", executionWorkspacePolicy: invalid } } },
    }).success).toBe(false);
  });
  it("keeps keys independent of display names", () => {
    const parsed = deploymentManifestSchema.parse({ version: 1, owner: "deployment", companies: { example: company } });
    expect(parsed.companies.example.fields.name).toBe("Example");
  });
  it("rejects unsupported versions, fields and state restoration", () => {
    for (const input of [
      { version: 2, owner: "deployment", companies: {} },
      { version: 1, owner: "deployment", companies: {}, unknown: true },
      { version: 1, owner: "deployment", companies: { example: { fields: { name: "Example", spentMonthlyCents: 0 } } } },
    ]) expect(deploymentManifestSchema.safeParse(input).success).toBe(false);
  });
  it("rejects invalid references and reporting cycles before writes", () => {
    for (const agents of [
      { worker: { ...agent, company: "missing" } },
      { worker: { ...agent, reportsTo: "missing" } },
      { worker: { ...agent, reportsTo: "worker" } },
      { worker: { ...agent, reportsTo: "manager" }, manager: { ...agent, reportsTo: "worker" } },
    ]) expect(deploymentManifestSchema.safeParse({ version: 1, owner: "deployment", companies: { example: company }, agents }).success).toBe(false);
  });
});
