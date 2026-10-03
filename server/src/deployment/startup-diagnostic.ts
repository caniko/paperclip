/** A bounded startup receipt for operator logs; never print exception messages or query text. */
export function startupDiagnostic(error: unknown, phase: "configuration" | "serve" | "command"): string {
  let current: unknown = error;
  let stage = "";
  let code = "unclassified";
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const detail = current as { code?: unknown; cause?: unknown; deploymentStage?: unknown };
    if (typeof detail.deploymentStage === "string" && /^(?:manifest|credentials|database-preflight|encryption-check|operator-preflight|resource-preflight|operator-apply|resource-apply)$/.test(detail.deploymentStage)) {
      stage = detail.deploymentStage;
    }
    if (typeof detail.code === "string" && /^(?:[0-9A-Z]{5}|EACCES|ENOENT|EPERM|EADDRINUSE|ECONNREFUSED|ETIMEDOUT)$/.test(detail.code)) {
      code = detail.code;
      break;
    }
    current = detail.cause;
  }
  return `Paperclip declarative startup failed (phase=${phase}${stage ? `, step=${stage}` : ""}, code=${code}); check configuration and runtime credential availability.`;
}
