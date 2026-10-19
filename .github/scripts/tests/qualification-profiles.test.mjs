import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("source-declared managed expansions remain mandatory even when their environment variable is absent", () => {
  const p = { ...policy, conditional_expansions: [{ ...policy.rules[0], name_contains: "real SDK > managed" }] };
  assert.throws(() => select([row], p), /expansion/);
  const managed = { ...row, id: "managed-1", name: "real SDK > managed" };
  assert.equal(select([row, managed], p).requiredCases.length, 2);
  assert.throws(() => select([row, { ...managed, skipped_in_environment: true }], p), /prerequisite/);
  assert.throws(() => select([row, managed], { ...p, conditional_expansions: [{ ...p.conditional_expansions[0], source_sha256: "wrong" }] }), /drift/);
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

test("the separately configured Runner package requires its entire collected roster and all three benchmarks", () => {
  const benchmark = "src/live/runnerd-final-output-burst.benchmark.test.ts";
  const rows = [16, 128, 512].map(deltaCount => ({ ...row, file: benchmark, id: `burst-${deltaCount}`,
    name: `measures ${deltaCount} final deltas, repetition 1, without relaxing durable handoff` }));
  rows.push({ ...row, file: "src/live/runnerd-codex-transport.test.ts" });
  const p = { ...policy, environments: { "runner-package": { platform: "linux" } }, rules: [] };
  const selected = profileSelection("runner-package", "linux", rows, {}, p);
  assert.deepEqual(selected.requiredCases, rows);
  assert.equal(selected.allCasesRequired, true);
  assert.equal(selected.testNamePattern, undefined, "A complete package cannot filter test names");
  const passed = rows.map(c => ({ ...c, outcome: "passed", retryCount: 0, repeatCount: 0 }));
  assert.equal(verifyProfileResults(selected, passed, []).passed, 4);
  assert.throws(() => verifyProfileResults(selected, passed.slice(1), []));
  assert.throws(() => verifyProfileResults(selected, [...passed, { ...passed[0], id: "uncollected" }], []));
  for (const cases of [rows.slice(1), rows.map(c => ({ ...c, skipped_in_environment: true })),
    rows.map(c => ({ ...c, required: false })), [...rows, rows[0]]]) {
    assert.throws(() => profileSelection("runner-package", "linux", cases, {}, p));
  }
});

test("default source scope requires every ordinary case and preserves source-mapped environment obligations", () => {
  const p = { ...policy, environments: { ...policy.environments, "default-hosted": { platform: "linux" } } };
  const ordinary = { ...row, id: "ordinary", name: "ordinary default case" };
  const deferred = { ...row, skipped_in_environment: true };
  const selectDefault = (rows, policyOverride = p) => profileSelection("default-hosted", "linux", rows, { [file]: source }, policyOverride);
  const selected = selectDefault([ordinary, deferred]);
  assert.deepEqual(selected.requiredCases.map(c => c.id), [ordinary.id]);
  assert.deepEqual(selected.deferredCases.map(c => [c.id, c.environments]), [[deferred.id, ["sdk"]]]);
  assert.equal(selected.testNamePattern, undefined, "Source execution must retain every raw sibling outcome");
  const passed = { ...ordinary, outcome: "passed", retryCount: 0, repeatCount: 0 };
  const skipped = { ...deferred, outcome: "skipped", retryCount: 0, repeatCount: 0 };
  assert.equal(verifyProfileResults(selected, [passed, skipped], []).passed, 1);
  assert.throws(() => verifyProfileResults(selected, [skipped], []));
  assert.throws(() => verifyProfileResults(selected, [passed], []), /roster/);
  assert.throws(() => selectDefault([ordinary, { ...deferred, name: "unmapped skipped case" }]), /mapping/);
  assert.throws(() => selectDefault([ordinary, deferred], { ...p, rules: [{ ...p.rules[0], source_sha256: "stale" }] }), /drift/);
});

test("the source runner collects and executes the same native Vitest file shard", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paperclip-source-profile-")));
  const directory = path.join(temporary, "evidence");
  try {
    execFileSync(process.execPath, [".github/scripts/run-qualification-profile.mjs", "--diagnostic", "default-hosted", directory,
      "--project", "@paperclipai/server", "--shard=1/2", "server/src/deployment/runtime.test.ts", "server/src/deployment/adapter-config.test.ts"], {
      cwd: root, timeout: 30_000,
      env: { ...process.env, NODE_ENV: "test", PAPERCLIP_HOME: path.join(temporary, "home"), PAPERCLIP_CONFIG: path.join(temporary, "home/config.json") },
    });
    const collection = JSON.parse(readFileSync(path.join(directory, "profile-collection.json"), "utf8"));
    const selection = JSON.parse(readFileSync(path.join(directory, "profile-selection.json"), "utf8"));
    const result = JSON.parse(readFileSync(path.join(directory, "profile-result.json"), "utf8"));
    assert.equal(collection.discovery.length, 2);
    assert.equal(collection.specifications.length, 1);
    assert.ok(selection.requiredCases.length > 0);
    assert.ok(selection.collectedCases.every(row => row.file === collection.specifications[0].file));
    assert.equal(result.rawCases, selection.collectedCases.length);
    assert.equal(result.passed, selection.requiredCases.length);
    assert.equal(result.diagnostic, true);
    assert.equal(result.producerAcceptanceQualified, false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
