import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { PROJECT_ICON_NAMES } from "../../../packages/shared/src/constants.js";
import { createProjectAction } from "../../../packages/paperclip-runner/src/protocol-actions/create-project.js";
import { paperclipSemanticAction } from "../../../packages/paperclip-runner/src/catalog/semantic-action-catalog.js";

// Cross-layer parity belongs to the App, which may inspect both contracts.
// Runner's standalone tests must not import the App's shared implementation.
describe("App-owned Paperclip Runner project icon contract", () => {
  it("advertises only icons accepted by the project API on both tool surfaces", () => {
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
    for (const schema of [createProjectAction.live.descriptor.inputSchema, paperclipSemanticAction("create_project")!.inputSchema]) {
      const validate = ajv.compile(schema);
      const input = { name: "Onboarding", idempotencyKey: "onboarding" };
      expect(schema).toMatchObject({ properties: { icon: { enum: [...PROJECT_ICON_NAMES, null] } } });
      for (const icon of [...PROJECT_ICON_NAMES, null]) expect(validate({ ...input, icon }), String(icon)).toBe(true);
      expect(validate({ ...input, icon: "users" })).toBe(false);
    }
  });
});
