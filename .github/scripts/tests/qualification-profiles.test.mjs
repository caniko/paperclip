import assert from "node:assert/strict";
import { test } from "node:test";
import { profileSelection, verifyProfileResults } from "../qualification-profiles.mjs";
import { sha256 } from "../qualification-roster.mjs";

const file = "server/profile.test.ts";
const source = 'describe.skipIf(!sdk)("real SDK", () => {});';
const policy = {
  all_declared_cases_required: true,
  environments: { sdk: { platform: "linux" } },
  rules: [{ file, source_sha256: sha256(source), name_contains: "real SDK", environment: "sdk", anchor: "describe.skipIf(!sdk)" }],
};
const row = { id: "case-1", project: "server", file, name: "real SDK > renders ($value)", required: true, skipped_in_environment: false };
const select = (rows = [row], p = policy, sources = { [file]: source }, platform = "linux") => profileSelection("sdk", platform, rows, sources, p);

test("profile scope retains every expanded identity, with literal name matching", () => {
  const second = { ...row, id: "case-2" };
  const selected = select([row, second, { ...row, id: "other", name: "unrelated suite" }]);
  assert.deepEqual(selected.requiredCases.map(c => c.id), ["case-1", "case-2"]);
  assert.ok(new RegExp(selected.testNamePattern).test("real SDK renders ($value)"));
  const results = [row, second].map(c => ({ ...c, outcome: "passed", retryCount: 0, repeatCount: 0 }));
  assert.equal(verifyProfileResults(selected, results, []).passed, 2);
});

test("source, platform, policy, missing mapping and skipped prerequisite substitutions fail closed", () => {
  for (const run of [
    () => select([row], policy, { [file]: source + "changed" }),
    () => select([row], policy, { [file]: source }, "darwin"),
    () => select([row], { ...policy, all_declared_cases_required: false }),
    () => select([{ ...row, name: "different suite" }]),
    () => select([{ ...row, skipped_in_environment: true }]),
    () => select([{ ...row, required: false }]),
    () => select([row, row]),
    () => profileSelection("unknown", "linux", [row], { [file]: source }, policy),
  ]) assert.throws(run);
});

test("mandatory missing, duplicate, cross-file, renamed, skipped, failed, error, retry and repeat results reject credit", () => {
  const selected = select();
  const passed = { ...row, outcome: "passed", retryCount: 0, repeatCount: 0 };
  for (const results of [[], [passed, passed], [{ ...passed, file: "other.test.ts" }],
    [{ ...passed, name: "replacement" }], ...["skipped", "failed", "error", "unexecuted"].map(outcome => [{ ...passed, outcome }]),
    [{ ...passed, retryCount: 1 }], [{ ...passed, repeatCount: 1 }]]) {
    assert.throws(() => verifyProfileResults(selected, results, []));
  }
  assert.throws(() => verifyProfileResults(selected, [passed], [{ message: "module collection failed" }]));
});

test("unrelated raw skips are retained but cannot supply mandatory credit or conceal failures", () => {
  const selected = select();
  const passed = { ...row, outcome: "passed", retryCount: 0, repeatCount: 0 };
  const unrelated = { ...passed, id: "other", name: "another profile", outcome: "skipped" };
  assert.equal(verifyProfileResults(selected, [passed, unrelated], []).rawCases, 2);
  assert.throws(() => verifyProfileResults(selected, [unrelated], []));
  assert.throws(() => verifyProfileResults(selected, [passed, { ...unrelated, outcome: "failed" }], []));
});
