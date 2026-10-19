import assert from "node:assert/strict";
import { mapEnvironments, sha256 } from "./qualification-roster.mjs";

const identity = row => JSON.stringify([row.project, row.file, row.id]);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function profileSelection(profile, platform, rows, sources, policy) {
  assert.equal(policy.all_declared_cases_required, true, "Profiles cannot waive declared cases");
  assert.equal(policy.environments[profile]?.platform, platform, "An actual matching operating system is required");
  const allCasesRequired = profile === "runner-package";
  const sourceScope = profile === "default-hosted";
  const rules = sourceScope ? policy.rules.filter(rule => Object.hasOwn(sources, rule.file))
    : [...policy.rules, ...(policy.supplemental_rules ?? [])].filter(rule => rule.environment === profile);
  assert.ok(rules.length || allCasesRequired || sourceScope, "Profile has no source-backed mapping rules");
  for (const rule of rules) {
    assert.equal(sha256(sources[rule.file]), rule.source_sha256, `Profile source drift: ${rule.file}`);
    assert.ok(sources[rule.file].includes(rule.anchor), "Profile prerequisite anchor is missing");
    assert.ok(rows.some(row => row.file === rule.file && row.name.includes(rule.name_contains)), "Required mapping collected no cases");
  }
  const mapped = sourceScope ? mapEnvironments(rows, sources, { ...policy, rules, conditional_expansions: [] }).cases : undefined;
  if (mapped) assert.ok(mapped.every(row => row.environments.length), "Skipped source case has no environment mapping");
  const requiredCases = mapped ? mapped.filter(row => row.environments.includes(profile)) : allCasesRequired ? rows
    : rows.filter(row => rules.some(rule => rule.file === row.file && row.name.includes(rule.name_contains)));
  assert.ok(requiredCases.length, "Profile collection is empty");
  if (allCasesRequired) {
    const benchmarks = rows.filter(row => row.file === "src/live/runnerd-final-output-burst.benchmark.test.ts");
    assert.deepEqual(benchmarks.map(row => row.name).sort(), [16, 128, 512].map(count =>
      `measures ${count} final deltas, repetition 1, without relaxing durable handoff`).sort(),
    "All three original final-output-burst benchmarks must be collected exactly once");
  }
  for (const expansion of (policy.conditional_expansions ?? []).filter(rule => rule.environment === profile)) {
    assert.equal(sha256(sources[expansion.file]), expansion.source_sha256, `Profile expansion source drift: ${expansion.file}`);
    assert.ok(sources[expansion.file].includes(expansion.anchor), "Required expansion anchor is missing");
    assert.ok(requiredCases.some(row => row.file === expansion.file && row.name.includes(expansion.name_contains)),
      `Required profile expansion was not collected: ${expansion.name_contains}`);
  }
  assert.equal(new Set(requiredCases.map(identity)).size, requiredCases.length, "Duplicate profile case");
  assert.equal(new Set(requiredCases.map(row => row.id)).size, requiredCases.length, "Ambiguous framework identity");
  for (const row of requiredCases) {
    assert.equal(row.required, true, "Every expanded profile case is mandatory");
    assert.equal(row.skipped_in_environment, false, `Profile prerequisite not met: ${row.name}`);
  }
  return { profile, platform, rules, requiredCases, allCasesRequired,
    ...(mapped ? { collectedCases: mapped, deferredCases: mapped.filter(row => !row.environments.includes(profile)) } : {}),
    testNamePattern: allCasesRequired || sourceScope ? undefined : rules.map(rule => escape(rule.name_contains)).join("|") };
}

export function verifyProfileResults(selection, results, errors) {
  assert.equal(errors.length, 0, "Profile has collection, hook or unhandled errors");
  assert.equal(new Set(results.map(identity)).size, results.length, "Duplicate/replayed execution identity");
  assert.ok(results.every(row => !["failed", "error"].includes(row.outcome)), "Raw execution contains a failure");
  assert.ok(results.every(row => row.retryCount === 0 && row.repeatCount === 0), "Retried/repeated execution cannot qualify");
  if (selection.collectedCases) assert.deepEqual(results.map(identity).sort(), selection.collectedCases.map(identity).sort(),
    "Source execution roster changed after collection");
  if (selection.allCasesRequired) assert.deepEqual(results.map(identity).sort(), selection.requiredCases.map(identity).sort(),
    "Complete-package execution must match every collected identity without additions or omissions");
  const actual = new Map(results.map(row => [identity(row), row]));
  for (const required of selection.requiredCases) {
    const row = actual.get(identity(required));
    assert.ok(row, `Required case was not executed: ${required.name}`);
    assert.equal(row.name, required.name, "Case title changed after collection");
    assert.equal(row.outcome, "passed", `Required profile case did not pass: ${required.name}`);
  }
  return { requiredCases: selection.requiredCases.length, passed: selection.requiredCases.length,
    failures: 0, errors: 0, skips: 0, retries: 0, repeats: 0, rawCases: results.length,
    scopedExecutionVerified: true, producerAcceptanceQualified: false };
}
