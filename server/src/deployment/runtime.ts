import { readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { paperclipConfigSchema, deploymentManifestSchema } from "@paperclipai/shared";
import { readDeploymentCredential as readCredential } from "./credentials.js";
export { readDeploymentCredential as readCredential } from "./credentials.js";

export const runtimeFile = z.string().refine((p) => isAbsolute(p) && normalize(p) === p
  && p !== "/" && !p.startsWith("/nix/store/"), "Expected an absolute runtime file outside the Nix store");
const credentialName = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
const executablePath = z.string().regex(/^\/(?:[a-zA-Z0-9_+.-]+\/)*[a-zA-Z0-9_+.-]+$/)
  .refine((p) => normalize(p) === p && !p.split("/").some((part) => part === "." || part === ".."));
const atlasAdmissionFields = {
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  environmentId: z.string().uuid(),
  workspaceClass: z.literal("copy-scratch"),
  command: executablePath,
  sshExecutable: executablePath,
  host: z.enum(["127.0.0.1", "::1"]),
  port: z.number().int().min(1).max(65535),
  username: z.string().regex(/^[a-z_][a-z0-9_-]{0,63}$/).refine((user) => user !== "root"),
  hostKey: z.string().regex(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/),
  privateKeyCredential: credentialName,
  remoteWorkspacePath: executablePath,
};
const atlasAdmissionSchema = z.discriminatedUnion("adapterType", [
  z.object({ ...atlasAdmissionFields, adapterType: z.literal("claude_local") }).strict(),
  z.object({
    ...atlasAdmissionFields,
    adapterType: z.literal("opencode_local"),
    standalone: z.literal(true),
    // Slashes inside model IDs are valid; # separates the two pins in the CLI model reference.
    model: z.string().regex(/^(?!-)(?:[^/\s\p{C}#]+\/)+[^/\s\p{C}#]+$/u),
    variant: z.string().regex(/^(?!-)[^\s\p{C}#]+$/u),
  }).strict(),
]);
export type AtlasAdmission = Readonly<z.infer<typeof atlasAdmissionSchema>>;
const atlasExecutionPolicySchema = z.object({ admissions: z.array(atlasAdmissionSchema) }).strict()
  .refine(({ admissions }) => new Set(admissions.map(({ agentId }) => agentId)).size === admissions.length);

export const deploymentDescriptorSchema = z.object({
  version: z.literal(1),
  home: runtimeFile,
  instance: z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/),
  executionProfile: z.enum(["trusted-local", "remote-only", "atlas-ssh"]).optional(),
  atlasExecutionPolicy: atlasExecutionPolicySchema.optional(),
  configFile: z.string(),
  apiUrl: z.string().url().optional(),
  manifestFile: z.string().optional(),
  credentialFiles: z.record(credentialName, runtimeFile).default({}),
  serverCredentials: z.object({
    auth: runtimeFile.optional(),
    oidc: runtimeFile.optional(),
    database: runtimeFile.optional(),
    migration: runtimeFile.optional(),
    encryption: runtimeFile.optional(),
  }).strict().default({}),
  embedded: z.object({
    user: z.string().regex(/^[a-z_][a-z0-9_-]{0,62}$/),
    database: z.string().regex(/^[a-z_][a-z0-9_-]{0,62}$/),
    passwordFile: runtimeFile,
  }).strict().optional(),
  bootstrap: z.object({ email: z.string().email(), name: z.string().min(1), passwordFile: runtimeFile }).strict().optional(),
}).strict().refine((d) => d.executionProfile === "atlas-ssh"
  ? d.atlasExecutionPolicy !== undefined && d.atlasExecutionPolicy.admissions.every(
    ({ privateKeyCredential }) => Object.hasOwn(d.credentialFiles, privateKeyCredential))
  : d.atlasExecutionPolicy === undefined);
export type DeploymentDescriptor = z.infer<typeof deploymentDescriptorSchema>;

let atlasDeployment: { readonly admissions: readonly AtlasAdmission[]; readonly home: string; readonly credentialFiles: Readonly<Record<string, string>> } | null = null;
export function atlasExecutionPolicy() {
  return atlasDeployment;
}

export class UnqualifiedRemoteExecutionError extends Error {
  constructor() {
    super("Paperclip remote-only execution is not yet qualified; refusing startup before adapter/plugin loading or database mutation.");
  }
}

let serverCredentials: Partial<Record<"auth" | "oidc" | "database" | "migration", string>> = {};
export function deploymentServerCredential(name: keyof typeof serverCredentials) {
  return process.env.PAPERCLIP_DECLARATIVE === "true" ? serverCredentials[name] : undefined;
}

export function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("Deployment JSON could not be read or parsed"); }
}

function rejectUnknown(value: unknown, schema: z.ZodType, path: string[] = []): void {
  let current = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault || current instanceof z.ZodPrefault) {
    current = current.unwrap() as z.ZodType;
  }
  if (!(current instanceof z.ZodObject) || !value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childSchema = current.shape[key];
    if (!childSchema) throw new Error(`Unsupported deployment config field: ${[...path, key].join(".")}`);
    rejectUnknown(child, childSchema, [...path, key]);
  }
}

export function validateDeploymentConfig(raw: unknown) {
  rejectUnknown(raw, paperclipConfigSchema);
  const parsed = paperclipConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid deployment application configuration");
  return parsed.data;
}

export function loadDeploymentDescriptor(file: string): DeploymentDescriptor {
  const parsed = deploymentDescriptorSchema.safeParse(readJson(file));
  if (!parsed.success) throw new Error("Invalid deployment descriptor");
  const descriptor = parsed.data;
  if (descriptor.executionProfile === "remote-only") throw new UnqualifiedRemoteExecutionError();
  const config = validateDeploymentConfig(readJson(descriptor.configFile));
  if (descriptor.executionProfile === "atlas-ssh" && config.server.deploymentMode !== "authenticated") {
    throw new Error("Atlas SSH requires authenticated Board access");
  }
  if (config.database.connectionString) throw new Error("Database connections must use runtime credential files");
  if (descriptor.manifestFile && !deploymentManifestSchema.safeParse(readJson(descriptor.manifestFile)).success) {
    throw new Error("Invalid deployment manifest");
  }
  if (!descriptor.serverCredentials.auth) {
    throw new Error("Deployment requires a signing credential for authentication and scoped agent tokens");
  }
  if (config.database.mode === "postgres" && !descriptor.serverCredentials.database) {
    throw new Error("External PostgreSQL requires a database credential file");
  }
  if (config.database.mode === "embedded-postgres" && !descriptor.embedded) {
    throw new Error("Embedded deployment requires a database identity and password file");
  }
  return descriptor;
}

export function embeddedDeploymentIdentity() {
  const file = process.env.PAPERCLIP_DEPLOYMENT_FILE;
  const embedded = file ? loadDeploymentDescriptor(file).embedded : undefined;
  const user = embedded?.user ?? "paperclip";
  const database = embedded?.database ?? "paperclip";
  const password = embedded ? readCredential(embedded.passwordFile).trimEnd() : "paperclip";
  if (embedded && password.length < 16) throw new Error("Embedded database password requires at least 16 characters");
  return { user, database, password,
    url: (port: number, db = database) => `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(db)}` };
}

export function deploymentEnvironment(d: DeploymentDescriptor, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "LD_LIBRARY_PATH", "SSL_CERT_FILE", "NIX_SSL_CERT_FILE"]) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  Object.assign(env, {
    NODE_ENV: "production", PAPERCLIP_HOME: d.home, PAPERCLIP_INSTANCE_ID: d.instance,
    PAPERCLIP_CONFIG: d.configFile, PAPERCLIP_DECLARATIVE: "true",
    PAPERCLIP_MIGRATION_PROMPT: "never", PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
  });
  if (d.apiUrl) env.PAPERCLIP_API_URL = d.apiUrl;
  serverCredentials = {};
  for (const name of ["auth", "oidc", "database", "migration"] as const) {
    const file = d.serverCredentials[name];
    if (file) serverCredentials[name] = readCredential(file).trimEnd();
  }
  if (serverCredentials.auth && serverCredentials.auth.length < 32) throw new Error("Authentication signing secret must contain at least 32 characters");
  if (d.serverCredentials.encryption) {
    readCredential(d.serverCredentials.encryption);
    env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = d.serverCredentials.encryption;
  }
  atlasDeployment = d.executionProfile === "atlas-ssh" ? Object.freeze({
    home: d.home,
    admissions: Object.freeze(d.atlasExecutionPolicy!.admissions.map((binding) => Object.freeze({ ...binding }))),
    credentialFiles: Object.freeze({ ...d.credentialFiles }),
  }) : null;
  return env;
}

/** Reads a declared instance credential file at use time; the value is never stored in the database. */
export function deploymentExecutionCredential(name: string): string {
  const file = process.env.PAPERCLIP_DEPLOYMENT_FILE;
  if (process.env.PAPERCLIP_DECLARATIVE !== "true" || !file) {
    throw new Error("Declared execution credentials are available only to a declarative deployment");
  }
  const raw = readJson(file) as { credentialFiles?: unknown };
  const credentialFiles = deploymentDescriptorSchema.shape.credentialFiles.parse(raw.credentialFiles ?? {});
  const path = credentialFiles[name];
  if (!path) throw new Error("Missing declared execution credential");
  return readCredential(path);
}
