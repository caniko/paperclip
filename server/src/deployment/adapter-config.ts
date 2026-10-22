import { z } from "zod";
import { SECRET_PAYLOAD_KEY_RE } from "../redaction.js";

// Execution contracts, deliberately independent of UI form schemas. Keep this
// closed until an adapter's consumed fields and credential projection are audited.
const text = z.string().min(1);
const duration = z.number().finite().nonnegative();
const url = z.string().url().refine((value) => {
  const parsed = new URL(value);
  return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
});
const headers = z.record(z.string(), z.string()).refine((value) =>
  Object.keys(value).every((key) => !/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i.test(key)),
);
// Manifest values land in the world-readable store; credentials must arrive through bindings.
// JSON-valued settings such as PAPERCLIP_OPENCODE_PROVIDERS may only reference them as {env:NAME}.
const envReference = /^(?:[A-Za-z]+ )?\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
const embedsSecret = (value: unknown, key = ""): boolean => typeof value === "string"
  ? SECRET_PAYLOAD_KEY_RE.test(key) && !envReference.test(value)
  : typeof value === "object" && value !== null
    && Object.entries(value).some(([field, nested]) => embedsSecret(nested, Array.isArray(value) ? key : field));
const jsonEmbedsSecret = (value: string) => { try { return embedsSecret(JSON.parse(value)); } catch { return false; } };
const env = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/).refine((key) => !SECRET_PAYLOAD_KEY_RE.test(key)),
  z.string().refine((value) => !jsonEmbedsSecret(value)),
);
const schemas: Record<string, z.ZodType> = {
  process: z.object({
    command: text, args: z.array(z.string()).optional(), cwd: text.optional(),
    env: env.optional(), timeoutSec: duration.optional(), graceSec: duration.optional(),
  }).strict(),
  http: z.object({
    url, method: z.enum(["POST", "PUT", "PATCH"]).optional(), headers: headers.optional(),
    payloadTemplate: z.record(z.string(), z.json()).optional(), timeoutMs: duration.optional(),
  }).strict(),
  opencode_local: z.object({
    command: text.optional(), model: text.optional(), variant: text.optional(), cwd: text.optional(),
    // The adapter otherwise defaults to injecting permission=allow. Declarations
    // must make that choice explicit rather than changing personal policy silently.
    dangerouslySkipPermissions: z.boolean(),
    managedService: z.boolean().optional(),
    args: z.array(z.string()).optional(), extraArgs: z.array(z.string()).optional(),
    env: env.optional(), timeoutSec: duration.optional(), graceSec: duration.optional(),
    instructionsFilePath: text.optional(), promptTemplate: z.string().optional(),
    bootstrapPromptTemplate: z.string().optional(),
  }).strict().refine(config => !config.managedService || (config.dangerouslySkipPermissions === false
    && !config.variant && !config.args?.length && !config.extraArgs?.length
    && Object.keys(config.env ?? {}).every(key => /^PAPERCLIP_[A-Z0-9_]+$/.test(key)))),
  // Claude Code through its CLI. The ACP engine (the adapter's default) and the
  // sandbox, network, Chrome and managed-connection fields stay closed until
  // audited; the adapter otherwise defaults to skipping permissions. Runtime
  // credentials (e.g. CLAUDE_CODE_OAUTH_TOKEN) arrive as env.* bindings.
  claude_local: z.object({
    engine: z.literal("cli"),
    dangerouslySkipPermissions: z.boolean(),
    command: text.optional(), model: text.optional(), effort: text.optional(), cwd: text.optional(),
    args: z.array(z.string()).optional(), extraArgs: z.array(z.string()).optional(),
    env: env.optional(), timeoutSec: duration.optional(), graceSec: duration.optional(),
    maxTurnsPerRun: z.number().int().nonnegative().optional(),
    instructionsFilePath: text.optional(), promptTemplate: z.string().optional(),
    bootstrapPromptTemplate: z.string().optional(),
  }).strict(),
  hermes_gateway: z.object({
    apiBaseUrl: url, paperclipApiUrl: url.optional(),
    waitForJobs: z.boolean().optional(),
    dangerouslyAllowInsecureRemoteHttp: z.boolean().optional(),
    sessionKeyStrategy: z.enum(["issue", "agent", "run", "none"]).optional(),
    timeoutSec: duration.optional(), eventReconnectMs: duration.optional(), pollIntervalMs: duration.optional(),
    headers: headers.optional(), instructions: z.string().optional(),
    payloadTemplate: z.record(z.string(), z.json()).optional(),
  }).strict(),
};

export function validateDeclaredAdapterConfig(
  type: string, config: Record<string, unknown>, credentials: Record<string, string>,
): void {
  const schema = Object.hasOwn(schemas, type) ? schemas[type] : undefined;
  if (!schema) throw new Error("Adapter has no native deployment configuration contract");
  if (!schema.safeParse(config).success) throw new Error("Invalid declared adapter configuration");
  for (const field of Object.keys(credentials)) {
    if (type === "hermes_gateway" && field === "apiKey") continue;
    if (!["process", "opencode_local", "claude_local"].includes(type) || !/^env\.[A-Z_][A-Z0-9_]*$/.test(field)
      || /^(PAPERCLIP_|DATABASE_|BETTER_AUTH_|NODE_OPTIONS$|LD_)/.test(field.slice(4))) {
      throw new Error("Unsupported or reserved adapter credential binding");
    }
    if (Object.hasOwn(config.env as Record<string, unknown> ?? {}, field.slice(4))) {
      throw new Error("Conflicting adapter credential binding");
    }
  }
  if (type === "hermes_gateway" && !Object.hasOwn(credentials, "apiKey")) {
    throw new Error("Hermes gateway requires a runtime apiKey credential binding");
  }
}
