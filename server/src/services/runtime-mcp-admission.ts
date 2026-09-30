import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { normalizeBaseUrl } from "@paperclipai/hermes-paperclip-adapter/gateway/server";
import { z } from "zod";

const identifier = z.string().regex(/^[\x21-\x7e]{1,128}$/);
const admissionSchema = z.object({
  version: z.literal(1),
  servers: z.record(identifier, z.object({
    url: z.string().min(1).max(2048),
    gatewayUrl: z.string().min(1).max(2048),
    serverHostId: identifier,
    executionHostIds: z.array(identifier).min(1).max(64),
  }).strict()),
}).strict();

function blocked(): never {
  throw Object.assign(new Error("Runtime MCP admission requires an exact operator-approved endpoint and execution host in PAPERCLIP_RUNTIME_MCP_ADMISSION."), {
    code: "hermes_gateway_managed_mcp_blocked",
  });
}

/** Bind only controller-resolved servers, using instance-operator policy rather
 * than agent configuration or payload templates. The worker separately verifies
 * its matching endpoint/host policy before receiving any run credentials. */
export function bindRuntimeMcpServersToRun(input: {
  servers: AdapterRuntimeMcpServer[];
  runId: string;
  executionTarget?: AdapterExecutionTarget | null;
  policy?: string;
}): AdapterRuntimeMcpServer[] {
  if (!input.servers.length) return [];
  const executionHostId = input.executionTarget?.environmentId;
  if (!executionHostId || !identifier.safeParse(executionHostId).success || !identifier.safeParse(input.runId).success) blocked();
  let raw: unknown;
  try { raw = JSON.parse(input.policy ?? ""); } catch { blocked(); }
  const policy = admissionSchema.safeParse(raw);
  if (!policy.success || input.servers.length > 8) blocked();
  return input.servers.map((server) => {
    const admitted = policy.data.servers[server.connectionId];
    if (!admitted || admitted.url !== server.url || !admitted.executionHostIds.includes(executionHostId)) blocked();
    let gateway: URL;
    try { gateway = new URL(admitted.gatewayUrl); } catch { blocked(); }
    if (gateway.username || gateway.password || gateway.search || gateway.hash
      || (gateway.protocol !== "https:" && !(gateway.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(gateway.hostname)))) blocked();
    const recipient = normalizeBaseUrl(gateway.toString());
    if (!recipient) blocked();
    return { ...server, name: server.connectionId, runBinding: {
      runId: input.runId, executionHostId, serverHostId: admitted.serverHostId,
      gatewayUrl: recipient.toString(),
      authorizedCrossHost: admitted.serverHostId !== executionHostId,
    } };
  });
}
