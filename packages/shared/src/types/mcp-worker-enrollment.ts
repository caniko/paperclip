export interface McpWorkerEnrollmentPins {
  workerId: string;
  keyId: string;
  publicKey: string;
  gatewayUrl: string;
  executionHostId: string;
  expiresAt: number;
}

/** Operator inspection only. No bootstrap verifier, nonce or private credentials. */
export interface McpWorkerEnrollment extends McpWorkerEnrollmentPins {
  id: string;
  companyId: string;
  controllerInstanceId: string;
  revision: string;
  state: "pending" | "enrolled" | "revoked";
  createdAt: number;
  enrolledAt: number | null;
  revokedAt: number | null;
}

/** Every field is covered by the worker's domain-separated Ed25519 proof. */
export interface McpWorkerEnrollmentChallenge extends McpWorkerEnrollmentPins {
  version: 1;
  enrollmentId: string;
  companyId: string;
  controllerInstanceId: string;
  nonce: string;
  challengeExpiresAt: number;
}

export interface McpWorkerEnrollmentPreparation {
  enrollment: McpWorkerEnrollment;
  challenge: McpWorkerEnrollmentChallenge;
  /** Purpose-specific bootstrap credential, returned once to the operator. */
  bearerToken: string;
}
