import { z } from "zod";

/** Signature only: callers cannot supply controller, host or enrollment pins. */
export const mcpWorkerEnrollmentProofSchema = z.object({
  signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
}).strict();
export type McpWorkerEnrollmentProof = z.infer<typeof mcpWorkerEnrollmentProofSchema>;
