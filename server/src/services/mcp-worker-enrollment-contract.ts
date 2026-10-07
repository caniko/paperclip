import { z } from "zod";
import type { McpWorkerEnrollmentChallenge, McpWorkerEnrollmentPins } from "@paperclipai/shared";
import { isMcpAdmissionIdentifier, requireMcpCredentialEndpoint } from "@paperclipai/adapter-utils/mcp-admission";
import { McpLaunchBlockedError } from "./mcp-prepared-launch-contract.js";
import { requireMcpWorkerKey } from "./mcp-worker-key.js";

const identifier = z.string().refine(isMcpAdmissionIdentifier);
const pinsSchema = z.object({
  workerId: identifier, keyId: identifier, executionHostId: identifier,
  publicKey: z.string().max(128), gatewayUrl: z.string().max(2048),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export function parseMcpWorkerEnrollmentPins(value: unknown): McpWorkerEnrollmentPins {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Object.keys(pinsSchema.shape).some(key => !Object.hasOwn(value, key)) ||
        Reflect.ownKeys(value).some(key => typeof key !== "string" || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) {
      throw new McpLaunchBlockedError();
    }
    const pins = pinsSchema.parse(value);
    requireMcpCredentialEndpoint(pins.gatewayUrl);
    requireMcpWorkerKey(pins.publicKey);
    return pins;
  } catch { throw new McpLaunchBlockedError(); }
}

/** Ordered protocol array, including all approved pins and both deadlines. */
export function mcpWorkerEnrollmentProofBytes(c: McpWorkerEnrollmentChallenge): Buffer {
  return Buffer.from(JSON.stringify(["paperclip.mcp-worker-enrollment-proof.v1", c.version, c.enrollmentId,
    c.companyId, c.controllerInstanceId, c.workerId, c.keyId, c.publicKey, c.gatewayUrl,
    c.executionHostId, c.nonce, c.challengeExpiresAt, c.expiresAt]), "utf8");
}
