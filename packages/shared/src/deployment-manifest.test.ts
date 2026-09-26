import { describe, expect, it } from "vitest";
import { deploymentManifestSchema } from "./deployment-manifest.js";

const company = { fields: { name: "Example" } };
const agent = { company: "example", fields: { name: "Worker", adapterType: "process" } };
describe("deployment manifest", () => {
  it("keeps keys independent of display names", () => {
    const parsed = deploymentManifestSchema.parse({ version: 1, owner: "deployment", companies: { example: company } });
    expect(parsed.companies.example.fields.name).toBe("Example");
  });
  it("rejects unsupported versions, fields and state restoration", () => {
    for (const input of [
      { version: 2, owner: "deployment", companies: {} },
      { version: 1, owner: "deployment", companies: {}, unknown: true },
      { version: 1, owner: "deployment", companies: { example: { fields: { name: "Example", spentMonthlyCents: 0 } } } },
    ]) expect(deploymentManifestSchema.safeParse(input).success).toBe(false);
  });
  it("rejects invalid references and reporting cycles before writes", () => {
    for (const agents of [
      { worker: { ...agent, company: "missing" } },
      { worker: { ...agent, reportsTo: "missing" } },
      { worker: { ...agent, reportsTo: "worker" } },
      { worker: { ...agent, reportsTo: "manager" }, manager: { ...agent, reportsTo: "worker" } },
    ]) expect(deploymentManifestSchema.safeParse({ version: 1, owner: "deployment", companies: { example: company }, agents }).success).toBe(false);
  });
});
