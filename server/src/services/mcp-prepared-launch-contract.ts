import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { isMcpAdmissionIdentifier, MCP_ADMISSION_LIMITS, requireMcpCredentialEndpoint, requireMcpRunBinding } from "@paperclipai/adapter-utils/mcp-admission";
import type { McpLaunchChallenge, McpPreparedLaunchSnapshot } from "@paperclipai/shared";
import { requireMcpWorkerKey, verifyMcpWorkerSignature } from "./mcp-worker-key.js";

export class McpLaunchBlockedError extends Error {
  readonly code = "runtime_mcp_admission_blocked";
  constructor() { super("Managed MCP launch authorization is blocked. Request fresh controller authorization for the enrolled worker."); }
}

const identifier = z.string().refine(isMcpAdmissionIdentifier);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const endpoint = z.string().refine(value => {
  try { requireMcpCredentialEndpoint(value); return true; } catch { return false; }
});
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const MCP_LAUNCH_ENVELOPE_MAX_BYTES = 2_097_152;
const snapshotSchema = z.object({
  version: z.literal(1), companyId: z.string().guid(), agentId: z.string().guid(),
  issueId: z.string().guid().nullable(), projectId: z.string().guid().nullable(), runId: z.string().guid(),
  controllerInstanceId: identifier, controllerBootId: z.string().guid(), generation: z.number().int().min(1).max(2_147_483_647),
  assignmentDigest: digest, assignmentRevision: identifier, policyDigest: digest, policyRevision: identifier,
  worker: z.object({ id: identifier, keyId: identifier, publicKey: z.string().max(128),
    gatewayUrl: endpoint, executionHostId: identifier }).strict(),
  servers: z.array(z.object({ connectionId: identifier, url: endpoint, serverHostId: identifier,
    authorizedCrossHost: z.boolean(), credentialRef: z.string().min(1).max(256) }).strict()).min(1).max(MCP_ADMISSION_LIMITS.serversPerRun),
  launchJson: z.string().min(2).max(1_048_576),
  launchHeaders: z.record(z.string().min(1).max(128), z.string().max(8192)), expiresAt: timestamp,
}).strict();
const envelopeSchema = z.object({ schema: z.literal("paperclip.mcp-prepared-launch.v1"),
  id: z.string().guid(), salt: digest, snapshot: snapshotSchema }).strict();

export function parseMcpLaunchSnapshot(value: unknown): McpPreparedLaunchSnapshot {
  try {
    const snapshot = snapshotSchema.parse(value);
    requireMcpWorkerKey(snapshot.worker.publicKey);
    if (new Set(snapshot.servers.map(server => server.connectionId)).size !== snapshot.servers.length ||
        Buffer.byteLength(snapshot.launchJson, "utf8") > 1_048_576 ||
        Buffer.from(snapshot.launchJson, "utf8").toString("utf8") !== snapshot.launchJson) throw new McpLaunchBlockedError();
    for (const server of snapshot.servers) requireMcpRunBinding({ runId: snapshot.runId,
      executionHostId: snapshot.worker.executionHostId, serverHostId: server.serverHostId,
      gatewayUrl: snapshot.worker.gatewayUrl, authorizedCrossHost: server.authorizedCrossHost },
    { runId: snapshot.runId, executionHostId: snapshot.worker.executionHostId, gatewayUrl: snapshot.worker.gatewayUrl });
    const headers = Object.entries(snapshot.launchHeaders);
    if (headers.length > 32 || new Set(headers.map(([key]) => key.toLowerCase())).size !== headers.length ||
        Buffer.byteLength(JSON.stringify(snapshot.launchHeaders), "utf8") > 32_768) throw new McpLaunchBlockedError();
    for (const [key, value] of headers) { validateHeaderName(key); validateHeaderValue(key, value); }
    // Header ordering has no HTTP meaning; canonicalize for stable comparison.
    snapshot.launchHeaders = Object.fromEntries(headers.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const body = JSON.parse(snapshot.launchJson);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new McpLaunchBlockedError();
    const pending: Array<[unknown, number]> = [[body, 0]];
    while (pending.length) {
      const [entry, depth] = pending.pop()!;
      if (depth > 32) throw new McpLaunchBlockedError();
      if (entry && typeof entry === "object") for (const nested of Object.values(entry)) pending.push([nested, depth + 1]);
    }
    return snapshot;
  } catch { throw new McpLaunchBlockedError(); }
}

type Envelope = z.infer<typeof envelopeSchema>;
function envelopeDigest(envelope: Envelope) {
  // A private per-launch salt prevents public digests becoming a credential oracle.
  return createHmac("sha256", Buffer.from(envelope.salt, "hex"))
    .update(JSON.stringify([envelope.schema, envelope.id, envelope.snapshot])).digest("hex");
}

export function prepareMcpLaunchEnvelope(value: unknown) {
  const snapshot = parseMcpLaunchSnapshot(value);
  const envelope: Envelope = { schema: "paperclip.mcp-prepared-launch.v1", id: randomUUID(), salt: randomBytes(32).toString("hex"), snapshot };
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MCP_LAUNCH_ENVELOPE_MAX_BYTES) throw new McpLaunchBlockedError();
  return { id: envelope.id, digest: envelopeDigest(envelope), envelope };
}

export function readMcpLaunchEnvelope(value: unknown, id: string, expectedDigest: string) {
  try {
    const envelope = envelopeSchema.parse(value);
    envelope.snapshot = parseMcpLaunchSnapshot(envelope.snapshot);
    if (envelope.id !== id || envelopeDigest(envelope) !== expectedDigest) throw new McpLaunchBlockedError();
    return envelope;
  } catch { throw new McpLaunchBlockedError(); }
}

/** Protocol-defined ordered JSON array; no locale-dependent key sorting. */
export function mcpLaunchProofBytes(c: McpLaunchChallenge): Buffer {
  return Buffer.from(JSON.stringify(["paperclip.mcp-launch-proof.v1", c.version, c.launchId, c.launchDigest,
    c.companyId, c.runId, c.controllerInstanceId, c.controllerBootId, c.generation,
    c.workerId, c.keyId, c.gatewayUrl, c.executionHostId, c.nonce, c.expiresAt]), "utf8");
}

export function verifyMcpLaunchProof(challenge: McpLaunchChallenge, signature: string, publicKey: string): boolean {
  return verifyMcpWorkerSignature(mcpLaunchProofBytes(challenge), signature, publicKey);
}
