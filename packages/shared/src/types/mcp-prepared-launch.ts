/** Controller-resolved authority. Never accept this shape from an agent request. */
export interface McpPreparedLaunchSnapshot {
  version: 1;
  companyId: string;
  agentId: string;
  issueId: string | null;
  projectId: string | null;
  runId: string;
  controllerInstanceId: string;
  controllerBootId: string;
  generation: number;
  assignmentDigest: string;
  assignmentRevision: string;
  policyDigest: string;
  policyRevision: string;
  worker: {
    id: string;
    keyId: string;
    publicKey: string;
    gatewayUrl: string;
    executionHostId: string;
  };
  servers: Array<{
    connectionId: string;
    url: string;
    serverHostId: string;
    authorizedCrossHost: boolean;
    credentialRef: string;
  }>;
  /** Exact effective outbound JSON bytes, including credentials; encrypted at rest. */
  launchJson: string;
  /** Complete effective dispatch headers, including worker credentials and the
   * original idempotency key. Private and immutable with the outbound body. */
  launchHeaders: Record<string, string>;
  expiresAt: number;
}

export interface McpLaunchChallenge {
  version: 1;
  launchId: string;
  launchDigest: string;
  companyId: string;
  runId: string;
  controllerInstanceId: string;
  controllerBootId: string;
  generation: number;
  workerId: string;
  keyId: string;
  gatewayUrl: string;
  executionHostId: string;
  nonce: string;
  expiresAt: number;
}

/** Acceptance is inspection-only. A separate controller claim owns dispatch. */
export interface McpLaunchAuthorizationReceipt {
  version: 1;
  launchId: string;
  launchDigest: string;
  workerId: string;
  generation: number;
  authorizedAt: number;
  expiresAt: number;
}
