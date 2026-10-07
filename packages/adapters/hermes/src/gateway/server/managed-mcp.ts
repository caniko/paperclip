import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { isMcpAdmissionIdentifier, MCP_ADMISSION_LIMITS, requireMcpRunBinding, type McpRunBinding } from "@paperclipai/adapter-utils/mcp-admission";
import { normalizeBaseUrl } from "./base-url.js";

export interface ManagedMcpManifest {
  version: 1;
  run_id: string;
  execution_host_id: string;
  servers: Array<{ name: string; connection_id: string; url: string; token: string; server_host_id: string; authorized_cross_host: boolean }>;
}

function blocked(message: string): never {
  throw Object.assign(new Error(message), { code: "hermes_gateway_managed_mcp_blocked" });
}

export function resolveManagedMcp(ctx: AdapterExecutionContext, gatewayUrl: string): ManagedMcpManifest | null {
  const template = parseObject(ctx.config.payloadTemplate);
  if ("runtime_mcp" in template) blocked("Managed MCP requires core-resolved run admission; remove payloadTemplate.runtime_mcp.");
  const servers = ctx.runtimeMcp?.getServers() ?? [];
  if (!servers.length) return null;
  for (const key of ["session_id", "previous_response_id", "conversation_history", "hosted_room_dispatch"]) {
    if (key in template) blocked("Managed MCP requires a fresh run-isolated conversation; remove conversation overrides.");
  }
  const executionHostId = ctx.executionTarget?.environmentId;
  if (!executionHostId || servers.length > MCP_ADMISSION_LIMITS.serversPerRun) blocked("Managed MCP requires an explicit execution host and at most eight admitted servers.");
  const ids = new Set<string>();
  return {
    version: 1, run_id: ctx.runId, execution_host_id: executionHostId,
    servers: servers.map((server) => {
      let binding: McpRunBinding;
      try {
        binding = requireMcpRunBinding(server.runBinding, { runId: ctx.runId, executionHostId, gatewayUrl,
          normalizeRecipient: (url) => normalizeBaseUrl(url)?.toString() ?? null });
      } catch {
        blocked("A managed MCP server lacks authorization for this run and execution host. Qualify the host connector and resolve its grants before dispatch.");
      }
      if (ids.has(server.connectionId) || !isMcpAdmissionIdentifier(server.connectionId) || !server.token || !server.url) {
        blocked("Managed MCP admission contains an invalid or duplicate server.");
      }
      ids.add(server.connectionId);
      return { name: server.connectionId, connection_id: server.connectionId, url: server.url, token: server.token,
        server_host_id: binding.serverHostId, authorized_cross_host: binding.authorizedCrossHost === true };
    }),
  };
}

export function requireManagedMcpCapability(payload: unknown, manifest: ManagedMcpManifest): void {
  const capability = parseObject(parseObject(payload).features).runs_managed_mcp;
  const value = parseObject(capability);
  if (value.version !== 1 || value.enabled !== true || value.mode !== "run_isolated" ||
      !isMcpAdmissionIdentifier(value.host_id) || value.host_id !== manifest.execution_host_id ||
      manifest.servers.some((s) => s.server_host_id !== manifest.execution_host_id && s.authorized_cross_host !== true)) {
    blocked("Hermes has no qualified run-isolated MCP capability on the admitted execution host. Configure its operator-owned managed MCP endpoint and host policy before dispatch.");
  }
}
