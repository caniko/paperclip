import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { bindMcpServersToRun, MCP_ADMISSION_LIMITS, McpAdmissionError } from "@paperclipai/adapter-utils/mcp-admission";

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
  let raw: unknown;
  if (input.policy !== undefined) {
    if (Buffer.byteLength(input.policy, "utf8") > MCP_ADMISSION_LIMITS.policyBytes) throw new McpAdmissionError("invalid_policy");
    try { raw = JSON.parse(input.policy); } catch { throw new McpAdmissionError("invalid_policy"); }
  }
  return bindMcpServersToRun({ servers: input.servers, runId: input.runId,
    executionHostId: input.executionTarget?.environmentId, policy: raw });
}
