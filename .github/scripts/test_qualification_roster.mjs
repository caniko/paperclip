import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createVitest } from "vitest/node";
import { collectRows, mapEnvironments, sha256, specificationRows } from "./qualification-roster.mjs";

const module = tasks => ({ task: { filepath: "/checkout/fixture.test.ts", projectName: "fixture", mode: "run", tasks } });
const task = (id, mode = "run") => ({ id, type: "test", name: "same display title", mode, location: { line: 10, column: 3 } });
const policy = { all_declared_cases_required: true, rules: [], environments: { "default-hosted": {} } };

test("concurrent discovery order cannot hide a missing, changed or duplicate file/project/pool identity", () => {
  const spec = (file, project, pool = "forks") => ({ moduleId: `/checkout/${file}`, project: { name: project }, pool });
  const first = spec("a.test.ts", "first");
  const second = spec("b.test.ts", "second");
  const expected = specificationRows([first, second], "/checkout");
  assert.deepEqual(specificationRows([second, first], "/checkout"), expected);
  for (const changed of [[first], [first, spec("c.test.ts", "second")],
    [first, spec("b.test.ts", "other")], [first, spec("b.test.ts", "second", "typescript")]]) {
    assert.throws(() => assert.deepEqual(specificationRows(changed, "/checkout"), expected));
  }
  assert.throws(() => specificationRows([first, first], "/checkout"), /Duplicate configured specification/);
  assert.throws(() => specificationRows([{ ...first, pool: undefined }], "/checkout"), /identity is incomplete/);
  assert.throws(() => specificationRows([first], "/other-checkout"), /inside the checkout/);
});

test("keeps distinct parameter identities, inherited skips and todo cases required and unexecuted", () => {
  const rows = collectRows([module([task("a"), task("b"), { type: "suite", name: "unavailable", mode: "skip", tasks: [task("c")] }, task("d", "todo")])], "/checkout");
  assert.equal(rows.length, 4);
  assert.equal(rows.filter(row => row.skipped_in_environment).length, 2);
  assert.ok(rows.every(row => row.required && row.status === "unexecuted" && row.evidence.length === 0));
  const mapped = mapEnvironments(rows, { "fixture.test.ts": "fixture source" }, policy);
  assert.deepEqual(mapped.cases.filter(row => row.skipped_in_environment).map(row => row.environment_mapping), ["unresolved", "unresolved"]);
});

test("rejects duplicate task emission and outside-checkout sources", () => {
  assert.throws(() => collectRows([module([task("a"), task("a")])], "/checkout"), /Duplicate framework task/);
  assert.throws(() => collectRows([module([task("a")])], "/other-checkout"), /inside the checkout/);
});

test("source and anchor drift block a rule instead of silently falling back to the default environment", () => {
  const source = "skip when missing real SDK";
  const rule = { file: "fixture.test.ts", source_sha256: sha256(source), anchor: "real SDK", name_contains: "same display title", environment: "sdk" };
  const configured = { ...policy, environments: { ...policy.environments, sdk: {} }, rules: [rule] };
  const rows = collectRows([module([task("a", "skip")])], "/checkout");
  const valid = mapEnvironments(rows, { "fixture.test.ts": source }, configured);
  assert.deepEqual(valid.cases[0].environments, ["sdk"]);
  for (const altered of [source + " changed", source.replace("real SDK", "mock")]) {
    const mapped = mapEnvironments(rows, { "fixture.test.ts": altered }, configured);
    assert.equal(mapped.stale_rules.length, 1);
    assert.deepEqual(mapped.cases[0].environments, []);
    assert.equal(mapped.cases[0].environment_mapping, "source-drift");
  }
  assert.throws(() => mapEnvironments(rows, { "fixture.test.ts": source }, { ...configured, all_declared_cases_required: false }), /cannot waive/);
});

test("retains absent parameter expansions as required obligations", () => {
  const source = "actual managed fixture adds a parameter";
  const expansion = { file: "fixture.test.ts", source_sha256: sha256(source), anchor: "managed fixture", name_contains: "managed parameter", environment: "runner" };
  const configured = { ...policy, environments: { ...policy.environments, runner: {} }, conditional_expansions: [expansion] };
  const mapped = mapEnvironments([], { "fixture.test.ts": source }, configured);
  assert.equal(mapped.conditional_expansions.length, 1);
  assert.equal(mapped.conditional_expansions[0].required, true);
  assert.equal(mapped.conditional_expansions[0].source_valid, true);
  assert.equal(mapped.conditional_expansions[0].status, "unexecuted");
  assert.deepEqual(mapped.conditional_expansions[0].observed_case_ids, []);
  assert.equal(mapEnvironments([], { "fixture.test.ts": source + " changed" }, configured).stale_rules.length, 1);
});

test("real Vitest collection preserves skipped cases and static-only declarations without executing assertions", { timeout: 60_000 }, async () => {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const root = mkdtempSync(path.join(os.tmpdir(), "qualification-roster-"));
  let ctx;
  try {
    symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "junction");
    writeFileSync(path.join(root, "fixture.test.mjs"), `import { beforeAll, describe, it } from "vitest";
      beforeAll(() => { throw new Error("collection must not execute hooks"); });
      it.each([1, 2])("same display title", () => { throw new Error("collection must not execute assertions"); });
      describe.skip("unavailable SDK", () => { it("required case", () => {}); });
      it.todo("required todo");
      if (process.pid < 0) { it("conditional declaration", () => {}); }`);
    const configFile = path.join(root, "vitest.config.mjs");
    writeFileSync(configFile, `export default { test: { name: "roster-contract", root: ${JSON.stringify(root)}, include: ["fixture.test.mjs"] } };`);
    const options = { root, config: configFile, watch: false, reporters: [], includeTaskLocation: true, allowOnly: false, maxWorkers: 1 };
    ctx = await createVitest(options);
    const parsed = await ctx.parseSpecifications(await ctx.globTestSpecifications(), { concurrency: 1 });
    const declarations = collectRows(parsed, root);
    assert.ok(declarations.some(row => row.name === "conditional declaration"));
    assert.ok(parsed.every(module => module.errors().length === 0));
    await ctx.close();
    ctx = await createVitest(options);
    const { testModules, unhandledErrors } = await ctx.collectTests(await ctx.globTestSpecifications());
    const rows = collectRows(testModules, root);
    assert.deepEqual(unhandledErrors, []);
    assert.ok(testModules.every(module => module.errors().length === 0));
    assert.equal(rows.length, 4);
    assert.equal(rows.filter(row => row.name === "same display title").length, 2);
    assert.equal(new Set(rows.map(row => row.id)).size, 4);
    assert.equal(rows.filter(row => row.skipped_in_environment).length, 2);
    assert.ok(!rows.some(row => row.name === "conditional declaration"));
    assert.ok(rows.every(row => row.required && row.status === "unexecuted" && row.location?.line > 0));
    if (process.env.EVIDENCE) {
      const directory = path.join(process.env.EVIDENCE, "roster-contract");
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "framework-collection.json"), JSON.stringify({ declarations, rows }, null, 2) + "\n");
    }
  } finally {
    await ctx?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
