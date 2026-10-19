import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { qualifyRolloutObservation, rolloutCoverageDecision } from "../qualification-rollout.mjs";

const policy = JSON.parse(readFileSync(new URL("../../qualification/rollout-exceptions.json", import.meta.url)));
const source = { repository: "caniko/paperclip", pull_request: 5, head: "candidate", base: "base", tree: "candidate-tree",
  harness_sha256: "harness", policy_sha256: "policy", exception_policy_sha256: "exceptions" };
const row = { id: "native-1", file: "server/native.test.ts", project: "server", name: "restarts the native runner",
  source_sha256: "native-source", environments: ["runnerd"], environment_mapping: "source-backed" };
const external = { ...row, id: "cloud-1", file: "server/cloud.test.ts", name: "requires Cloud", environments: ["cloud"] };
const roster = { ...source, cases: [row, external], collection_errors: [], missing_specifications: [], stale_mapping_rules: [],
  all_declared_cases_required: true,
  declaration_sites: [{ runtime_case_ids_at_site: [row.id] }, { runtime_case_ids_at_site: [external.id] }] };
const proof = { ...row, ...source, environment: "runnerd", outcome: "passed", retryCount: 0, repeatCount: 0,
  run_attempt: 1, runner_environment: "github-hosted", evidence_verified: true, producer_scope: "original-job/report" };
const blocker = { ...policy.original_inventory, provider_verified: true, cases: [external] };

test("rollout coverage requires actual execution and preserves exact external exceptions without full-coverage credit", () => {
  const decision = rolloutCoverageDecision(roster, [proof], policy, source, blocker);
  assert.equal(decision.rollout_coverage_accepted, true);
  assert.equal(decision.complete_original_coverage, false);
  assert.equal(decision.producer_acceptance_qualified, false);
  assert.equal(decision.exceptions.length, 1);
  assert.equal(decision.exceptions[0].id, external.id);
  assert.equal(decision.executed_cases, 1);
});

test("exceptions cannot hide missing execution, source drift, errors, retries or an unverified provider receipt", () => {
  for (const changes of [{ head: "old" }, { base: "old" }, { tree: "old" }, { harness_sha256: "old" },
    { policy_sha256: "old" }, { exception_policy_sha256: "old" }, { name: "renamed" },
    { source_sha256: "changed" }, { environment: "tailscale-mock" }, { outcome: "failed" },
    { outcome: "skipped" }, { retryCount: 1 }, { repeatCount: 1 }, { run_attempt: 2 },
    { runner_environment: "self-hosted" }, { evidence_verified: false }]) {
    assert.throws(() => rolloutCoverageDecision(roster, [{ ...proof, ...changes }], policy, source, blocker));
  }
  assert.throws(() => rolloutCoverageDecision(roster, [], policy, source, blocker));
  assert.throws(() => rolloutCoverageDecision(roster, [proof, { ...proof, id: "unknown", outcome: "failed" }], policy, source, blocker));
  assert.throws(() => rolloutCoverageDecision(roster, [proof, proof], policy, source, blocker));
  for (const changes of [{ collection_errors: ["collection failed"] }, { stale_mapping_rules: ["drift"] },
    { missing_specifications: ["missing"] }, { declaration_sites: [{ runtime_case_ids_at_site: [] }] }]) {
    assert.throws(() => rolloutCoverageDecision({ ...roster, ...changes }, [proof], policy, source, blocker));
  }
});

test("only the operator's enumerated environments can receive rollout exceptions", () => {
  for (const changed of [
    { ...policy, execution_credit: true }, { ...policy, pull_request: 6 },
    { ...policy, exceptions: [...policy.exceptions, { environment: "runnerd", reason: "unavailable" }] },
    { ...policy, exceptions: [...policy.exceptions, policy.exceptions[0]] },
  ]) assert.throws(() => rolloutCoverageDecision(roster, [proof], changed, source, blocker));
  assert.throws(() => rolloutCoverageDecision({ ...roster, cases: [row, { ...external, environment_mapping: "source-drift" }] },
    [proof], policy, source, blocker));
  for (const changes of [{ provider_verified: false }, { archive_sha256: "changed" }, { cases: [] }]) {
    assert.throws(() => rolloutCoverageDecision(roster, [proof], policy, source, { ...blocker, ...changes }));
  }
  assert.throws(() => rolloutCoverageDecision(roster, [proof], policy, source,
    { ...blocker, cases: [{ ...external, source_sha256: "changed" }] }));
});

test("provider observations reconcile source, complete Runner, conditional and mocked-provider scopes without live credit", () => {
  const defaultCase = { ...row, id: "default", environments: ["default-hosted"] };
  const liveCase = { ...external, id: "live", environments: ["live-tailscale"] };
  const claudeCase = { ...row, id: "claude", file: "claude.test.ts", environments: ["live-claude-code"] };
  const expansion = { ...row, id: "managed", name: "managed expansion", environments: ["warm-transition"] };
  const benchmark = "src/live/runnerd-final-output-burst.benchmark.test.ts";
  const packageCases = [16, 128, 512].map(count => ({ id: `benchmark-${count}`, project: "", file: benchmark,
    name: `measures ${count} final deltas, repetition 1, without relaxing durable handoff` }));
  const profile = (name, rows) => ({ profile: name,
    source: { ...source, diagnostic: false, policySha256: source.policy_sha256, profile: name, platform: "linux",
      sourceFiles: Object.fromEntries(rows.map(row => [row.file, "native-source"])),
      scope: { kind: "configured-package-vitest", benchmarkEnabled: true, benchmarkRepetitions: 1 } },
    selection: { profile: name, platform: "linux", requiredCases: rows, allCasesRequired: name === "runner-package" },
    results: { cases: rows.map(row => ({ ...row, outcome: "passed", retryCount: 0, repeatCount: 0 })), errors: [] },
    strict_results: rows.map(row => ({ ...row, outcome: "passed", retryCount: 0, repeatCount: 0 })) });
  const profiles = [profile("runner-package", packageCases), profile("tailscale-mock", [liveCase]), profile("warm-transition", [expansion])];
  const rule = (environment, name_contains) => ({ file: row.file, source_sha256: "native-source", environment, name_contains });
  const observation = { expected_source: source,
    roster: { ...roster, cases: [defaultCase, liveCase, claudeCase], source_files: {},
      conditional_expansions: [{ ...rule("warm-transition", "managed expansion"), source_valid: true }] },
    coverage_policy: { environments: Object.fromEntries(profiles.map(({ profile }) => [profile, { platform: "linux" }])),
      supplemental_rules: [{ ...rule("tailscale-mock", liveCase.name), file: liveCase.file }],
      conditional_expansions: [rule("warm-transition", "managed expansion")] },
    source_files: { [row.file]: "native-source", [liveCase.file]: "native-source", [`packages/paperclip-runner/${benchmark}`]: "native-source" },
    profiles, required_profiles: profiles.map(row => row.profile), exception_policy: policy,
    blocker_evidence: { ...blocker, cases: [liveCase] },
    source_results: [{ ...proof, ...defaultCase, producer_scope: "source/tests/profile.xml" }],
    claude_results: [{ ...proof, ...claudeCase, producer_scope: "live-claude/profile.xml" }] };
  const decision = qualifyRolloutObservation(observation);
  assert.equal(decision.rollout_coverage_accepted, true);
  assert.equal(decision.producer_acceptance_qualified, false);
  assert.equal(decision.exceptions.length, 1);
  assert.deepEqual(decision.exceptions[0].environments, ["live-tailscale"]);
  assert.equal(decision.supplemental_cases, 5);
  for (const mutate of [
    value => { value.profiles.pop(); },
    value => { value.profiles[0].selection.testNamePattern = "benchmark"; },
    value => { value.profiles[0].source.diagnostic = true; },
    value => { value.profiles[0].source.sourceFiles[benchmark] = "changed"; },
    value => { value.profiles[0].strict_results.pop(); },
    value => { value.profiles[0].results.cases[0].retryCount = 1; },
    value => { value.profiles[0].selection.requiredCases.pop(); value.profiles[0].results.cases.pop(); value.profiles[0].strict_results.pop(); },
    value => { value.coverage_policy.supplemental_rules = []; },
    value => { value.coverage_policy.conditional_expansions = []; },
    value => { value.source_results[0].head = "other"; },
    value => { value.source_results.push({ ...value.source_results[0] }); },
    value => { value.claude_results = []; },
  ]) {
    const changed = structuredClone(observation);
    mutate(changed);
    assert.throws(() => qualifyRolloutObservation(changed));
  }
});
