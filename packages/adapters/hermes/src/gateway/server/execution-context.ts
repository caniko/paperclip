import { createHash } from "node:crypto";
import path from "node:path";
import type { AdapterExecutionContext, WorkspaceOwnershipIntent } from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";

interface TerminalExecutionContext {
  version: 1;
  backend: "local" | "ssh";
  cwd: string;
  lifetime?: "wait_for_jobs";
  ownership?: WorkspaceOwnershipIntent;
  ssh?: { host: string; port: number; user: string };
}

export interface WorkspaceBinding {
  context: TerminalExecutionContext;
  fingerprint: string;
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "hermes_gateway_execution_context_invalid" });
}

export function resolveWorkspaceBinding(ctx: Pick<AdapterExecutionContext, "executionTarget" | "config" | "context" | "executionTransport" | "workspaceOwnership">, endpoint: string): WorkspaceBinding | null {
  const target = ctx.executionTarget;
  const realization = target?.workspaceRealization;
  const required = !!ctx.workspaceOwnership || ctx.config.bindWorkspace === true || ctx.config.waitForJobs === true || target?.kind === "remote" || realization?.mode === "in_place";
  const template = parseObject(ctx.config.payloadTemplate);
  if (!required) {
    if ("execution_context" in template) invalid("Use bindWorkspace and a selected execution target instead of payloadTemplate.execution_context.");
    if (ctx.executionTransport?.remoteExecution) invalid("Hermes requires a core-resolved executionTarget for remote work.");
    return null;
  }
  if (!target) invalid("Workspace binding requires a core-resolved executionTarget.");
  if (target.kind === "remote" && realization?.mode !== "in_place") {
    invalid("Hermes gateway SSH workspace binding requires in_place realization.");
  }
  for (const key of ["execution_context", "session_id", "previous_response_id", "conversation_history", "hosted_room_dispatch"]) {
    if (key in template) invalid(`Bound Hermes runs cannot override ${key} in payloadTemplate.`);
  }

  let context: TerminalExecutionContext;
  if (target.kind === "local") {
    const workspace = parseObject(ctx.context.paperclipWorkspace);
    const cwd = realization?.authoritativeRoot ?? workspace.cwd;
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0")) {
      invalid("Workspace binding requires an absolute selected local directory.");
    }
    context = { version: 1, backend: "local", cwd };
  } else {
    if (target.transport !== "ssh") invalid("Hermes gateway supports configured local and SSH workers only.");
    const { remoteCwd: cwd, spec } = target;
    if (!path.posix.isAbsolute(cwd) || cwd.includes("\0")) invalid("Workspace binding requires an absolute SSH directory.");
    if (!spec.host || !spec.username || !Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) {
      invalid("Workspace binding requires an explicit SSH host, port and user.");
    }
    if (realization && realization.authoritativeRoot !== cwd) invalid("The in-place root must match the selected SSH directory.");
    context = { version: 1, backend: "ssh", cwd, ssh: { host: spec.host, port: spec.port, user: spec.username } };
  }
  if (realization?.mode === "in_place" || ctx.config.waitForJobs === true) context.lifetime = "wait_for_jobs";
  // Leases and credentials can rotate without moving the conversation. The
  // endpoint includes /p/<profile>, so a different worker gets a different scope.
  const fingerprint = createHash("sha256").update(JSON.stringify([
    endpoint, target.environmentId ?? null, context,
    ctx.workspaceOwnership ? { authority: ctx.workspaceOwnership.authority, principal: ctx.workspaceOwnership.principal, roots: ctx.workspaceOwnership.roots } : null,
  ])).digest("hex");
  if (ctx.workspaceOwnership) {
    context.lifetime = "wait_for_jobs";
    context.ownership = ctx.workspaceOwnership;
  }
  return { context, fingerprint };
}

export function bindSessionKey(key: string | null, binding: WorkspaceBinding | null): string | null {
  if (!key || !binding) return key;
  return `${key}:target:${binding.fingerprint}`;
}

export function requireWorkspaceCapability(value: unknown, binding: WorkspaceBinding): void {
  const capability = parseObject(parseObject(parseObject(value).features).runs_execution_context);
  const ownership = parseObject(capability.filesystem_ownership);
  if (capability.version !== 1 || capability.mode !== "precondition"
    || !Array.isArray(capability.backends) || !capability.backends.includes(binding.context.backend)
    || (binding.context.lifetime && (capability.stop_admission !== true
       || !Array.isArray(capability.lifetimes) || !capability.lifetimes.includes(binding.context.lifetime)))
    || (binding.context.ownership && (ownership.version !== 1 || ownership.early_intent !== true
      || ownership.target_authority !== true || ownership.controller_release !== true))) {
    throw Object.assign(new Error("Hermes gateway does not support the required execution-context precondition. Upgrade the worker before binding a workspace."), {
      code: "hermes_gateway_execution_context_unsupported",
    });
  }
}
