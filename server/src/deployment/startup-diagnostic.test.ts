import { describe, expect, it } from "vitest";
import { startupDiagnostic } from "./startup-diagnostic.js";

describe("declarative startup diagnostics", () => {
  it("reports a nested SQLSTATE without printing credential, query or filesystem material", () => {
    const secret = "test-secret-should-not-appear";
    const error = new Error(`query: SELECT '${secret}'`, {
      cause: Object.assign(new Error(`password ${secret}`), { code: "42501", detail: secret }),
    });
    const result = startupDiagnostic(error, "serve");
    expect(result).toContain("phase=serve, code=42501");
    expect(result).not.toContain(secret);
  });

  it("does not include arbitrary error codes or messages", () => {
    const result = startupDiagnostic({ code: "PASSWORD=secret", message: "sensitive" }, "configuration");
    expect(result).toContain("code=unclassified");
    expect(result).not.toMatch(/PASSWORD|secret|sensitive/);
  });
});
