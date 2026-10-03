/** A bounded startup receipt for operator logs; never print exception messages or query text. */
export function startupDiagnostic(error: unknown, phase: "configuration" | "serve" | "command"): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^(?:[0-9A-Z]{5}|E[A-Z_]{2,32})$/.test(code)) {
      return `Paperclip declarative startup failed (phase=${phase}, code=${code}); check configuration and runtime credential availability.`;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return `Paperclip declarative startup failed (phase=${phase}, code=unclassified); check configuration and runtime credential availability.`;
}
