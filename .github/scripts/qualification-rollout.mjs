import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { verifyProfileResults } from "./qualification-profiles.mjs";

const externalEnvironments = new Set(["cloud", "live-daytona", "live-daytona-duplex", "live-tailscale", "hermes-hosted-64gib"]);
const identity = row => JSON.stringify([row.project, row.file, row.id]);
const sourceFields = ["repository", "pull_request", "head", "base", "tree", "harness_sha256", "policy_sha256", "exception_policy_sha256"];

// The observer must verify provider identities, hashes and retention before
// supplying these observations. This decision grants neither execution credit
// to an exception nor production activation authority to a coverage report.
export function rolloutCoverageDecision(roster, executions, policy, expectedSource, blockerEvidence) {
  assert.equal(policy.schema, "paperclip.rollout-exceptions.v1");
  assert.equal(policy.repository, expectedSource.repository);
  assert.equal(policy.pull_request, expectedSource.pull_request);
  assert.equal(policy.execution_credit, false);
  assert.ok(policy.authorization);
  assert.equal(blockerEvidence.provider_verified, true, "Original blocker custody was not verified");
  assert.equal(blockerEvidence.execution_credit, false);
  for (const [field, value] of Object.entries(policy.original_inventory)) {
    assert.equal(blockerEvidence[field], value, `Original blocker ${field} drifted`);
  }
  const waived = new Map();
  for (const exception of policy.exceptions) {
    assert.ok(externalEnvironments.has(exception.environment), "Unapproved rollout exception");
    assert.ok(!waived.has(exception.environment) && exception.reason?.trim(), "Duplicate or unexplained exception");
    assert.ok(Number.isSafeInteger(exception.max_cases) && exception.max_cases >= 0, "Unbounded exception case scope");
    waived.set(exception.environment, exception);
  }
  for (const field of sourceFields) {
    assert.ok(expectedSource[field], `Missing expected ${field}`);
    assert.equal(roster[field], expectedSource[field], `Coverage ${field} drifted`);
  }
  for (const field of ["collection_errors", "missing_specifications", "stale_mapping_rules"]) {
    assert.equal(roster[field].length, 0, `Unresolved ${field}`);
  }
  assert.ok(roster.declaration_sites.length && roster.declaration_sites.every(site => site.runtime_case_ids_at_site.length),
    "Static declarations still need environment-union disposition");
  assert.ok(roster.cases.length, "Empty required roster");
  assert.equal(roster.all_declared_cases_required, true);
  for (const expansion of roster.conditional_expansions ?? []) {
    assert.ok(expansion.source_valid && roster.cases.some(row => row.file === expansion.file
      && row.source_sha256 === expansion.source_sha256 && row.name.includes(expansion.name_contains)),
    "A source-declared conditional expansion is absent from the environment union");
  }
  const cases = new Map(roster.cases.map(row => [identity(row), row]));
  assert.equal(cases.size, roster.cases.length, "Duplicate required case");
  const passed = new Map();
  for (const execution of executions) {
    for (const field of sourceFields) {
      assert.equal(execution[field], expectedSource[field], `Execution ${field} drifted`);
    }
    assert.equal(execution.evidence_verified, true, "Provider evidence was not verified");
    assert.equal(execution.runner_environment, "github-hosted");
    assert.equal(execution.run_attempt, 1);
    assert.equal(execution.outcome, "passed", "Raw execution contains a failure or skip");
    assert.equal(execution.retryCount, 0);
    assert.equal(execution.repeatCount, 0);
    const key = identity(execution), row = cases.get(key);
    assert.ok(row, "Execution is outside this coverage scope");
    assert.equal(execution.name, row.name, "Execution title drifted");
    assert.equal(execution.source_sha256, row.source_sha256, "Execution source drifted");
    assert.ok(row.environments.includes(execution.environment), "Execution environment does not cover this case");
    const scopes = passed.get(key) ?? new Set();
    assert.ok(execution.producer_scope, "Execution producer scope is missing");
    const scope = JSON.stringify([execution.environment, execution.producer_scope]);
    assert.ok(!scopes.has(scope), "Duplicate execution within an original producer scope");
    scopes.add(scope);
    passed.set(key, scopes);
  }
  const exceptions = [];
  for (const [key, row] of cases) {
    assert.ok(row.environments.length && !["source-drift", "unresolved"].includes(row.environment_mapping),
      "Case environment is unresolved or source-drifted");
    if (passed.has(key)) continue;
    assert.equal(row.environment_mapping, "source-backed", "Exceptions require source-backed mappings");
    assert.ok(row.environments.every(environment => waived.has(environment)), `Missing execution: ${row.file}: ${row.name}`);
    assert.ok(blockerEvidence.cases.some(original => original.file === row.file && original.project === row.project
      && original.name === row.name && original.source_sha256 === row.source_sha256
      && row.environments.every(environment => original.environments.includes(environment))),
    "Exception case is outside the original source-bound blocker inventory");
    exceptions.push({ ...row, reasons: row.environments.map(environment => waived.get(environment).reason), execution_credit: false });
  }
  for (const [environment, exception] of waived) assert.ok(
    exceptions.filter(row => row.environments.includes(environment)).length <= exception.max_cases,
    `Exception scope expanded: ${environment}`);
  return { rollout_coverage_accepted: true, complete_original_coverage: exceptions.length === 0,
    producer_acceptance_qualified: false, ...expectedSource, executed_cases: passed.size, exceptions,
    policy_exceptions: policy.exceptions, original_blocker_inventory: policy.original_inventory };
}

// Called only after qualification-evidence.py has observed the live provider,
// downloaded original archives, and verified every source/receipt/member hash.
export function qualifyRolloutObservation(observation) {
  const { expected_source: expected, source_files: sourceFiles, coverage_policy: coveragePolicy } = observation;
  const roster = structuredClone(observation.roster);
  for (const [file, digest] of Object.entries(roster.source_files)) assert.equal(sourceFiles[file], digest, `Coverage source changed: ${file}`);
  const executions = [];
  const cases = new Map(roster.cases.map(row => [identity(row), row]));
  const proof = (row, result, environment, scope) => ({ ...row, ...expected, environment, outcome: result.outcome,
    retryCount: result.retryCount, repeatCount: result.repeatCount, run_attempt: 1,
    runner_environment: "github-hosted", evidence_verified: true, producer_scope: scope });
  assert.deepEqual(observation.profiles.map(profile => profile.profile).sort(), observation.required_profiles.slice().sort());
  assert.equal(new Set(observation.required_profiles).size, observation.required_profiles.length);
  for (const { profile, source, selection, results, strict_results: strictResults } of observation.profiles) {
    assert.equal(source.diagnostic, false);
    for (const field of ["head", "tree"]) assert.equal(source[field], expected[field], `Profile ${field} differs`);
    assert.equal(source.policySha256, expected.policy_sha256);
    assert.equal(source.profile, profile);
    assert.equal(selection.profile, profile);
    assert.equal(source.platform, selection.platform);
    assert.equal(source.platform, coveragePolicy.environments[profile].platform);
    for (const [file, digest] of Object.entries(source.sourceFiles)) {
      const full = profile === "runner-package" ? `packages/paperclip-runner/${file}` : file;
      assert.equal(sourceFiles[full], digest, `Profile source changed: ${full}`);
    }
    verifyProfileResults(selection, results.cases, results.errors);
    const reportKey = row => JSON.stringify([row.file, row.id, row.name]);
    assert.deepEqual(strictResults.map(reportKey).sort(), selection.requiredCases.map(reportKey).sort(),
      "Strict profile XML differs from its raw, independently checked execution scope");
    if (profile === "runner-package") {
      assert.equal(selection.allCasesRequired, true);
      assert.equal(selection.testNamePattern, undefined);
      assert.equal(source.scope.kind, "configured-package-vitest");
      assert.equal(source.scope.benchmarkEnabled, true);
      assert.equal(source.scope.benchmarkRepetitions, 1);
      assert.deepEqual(selection.requiredCases.filter(row => row.file === "src/live/runnerd-final-output-burst.benchmark.test.ts")
        .map(row => row.name).sort(), [16, 128, 512].map(count => `measures ${count} final deltas, repetition 1, without relaxing durable handoff`).sort());
    }
    const actual = new Map(results.cases.map(row => [identity(row), row]));
    for (const required of selection.requiredCases) {
      const full = profile === "runner-package" ? `packages/paperclip-runner/${required.file}` : required.file;
      const collected = { ...required, file: full, source_sha256: source.sourceFiles[required.file] };
      let row = cases.get(identity(collected));
      if (row) {
        assert.equal(row.name, collected.name, "Profile identity/title differs from the workspace roster");
        assert.equal(row.source_sha256, collected.source_sha256);
      }
      if (!row || !row.environments.includes(profile)) {
        const supplemental = (coveragePolicy.supplemental_rules ?? []).some(rule => rule.file === full
          && rule.environment === profile && rule.source_sha256 === collected.source_sha256 && collected.name.includes(rule.name_contains));
        const expansion = (coveragePolicy.conditional_expansions ?? []).some(rule => rule.file === full
          && rule.environment === profile && rule.source_sha256 === collected.source_sha256 && collected.name.includes(rule.name_contains));
        assert.ok(profile === "runner-package" || supplemental || expansion, "Profile introduced an unmapped case");
        // A mocked provider is a separate obligation and can never cover the
        // same source case's real live-provider requirement.
        row = { ...collected, ...(supplemental ? { project: `${profile}:${collected.project}` } : {}),
          environments: [profile], environment_mapping: "source-backed", required: true };
        assert.ok(!cases.has(identity(row)), "Supplemental scope duplicates an existing identity");
        cases.set(identity(row), row);
        roster.cases.push(row);
      }
      executions.push(proof(row, actual.get(identity(required)), profile, `profile/${profile}/profile.xml`));
    }
  }
  const find = result => roster.cases.filter(row => row.file === result.file && row.id === result.id && row.name === result.name);
  for (const result of observation.source_results) {
    for (const field of sourceFields) assert.equal(result[field], expected[field], `Source execution ${field} differs`);
    assert.equal(result.outcome, "passed");
    let matches = find(result);
    if (!matches.length) matches = find({ ...result, file: `packages/paperclip-runner/${result.file}` });
    assert.equal(matches.length, 1, `Raw source execution is unknown or ambiguous: ${result.file}: ${result.name}`);
    const row = matches[0];
    // Profile prerequisites are independently executed, even when a default
    // lane happens to pass that test under its own environment.
    if (row.environments.includes("default-hosted")) executions.push(proof(row, result, "default-hosted", result.producer_scope));
  }
  for (const result of observation.claude_results) {
    for (const field of sourceFields) assert.equal(result[field], expected[field]);
    const matches = find(result);
    assert.equal(matches.length, 1, "Live Claude execution is unknown or ambiguous");
    executions.push(proof(matches[0], result, "live-claude-code", result.producer_scope));
  }
  const decision = rolloutCoverageDecision(roster, executions, observation.exception_policy, expected, observation.blocker_evidence);
  return { ...decision, original_workspace_cases: observation.roster.cases.length,
    required_profile_cases: observation.profiles.reduce((count, profile) => count + profile.selection.requiredCases.length, 0),
    source_passes_observed: observation.source_results.length, required_profiles: observation.required_profiles,
    supplemental_cases: roster.cases.length - observation.roster.cases.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, "Pass the provider-verified observation JSON");
  console.log(JSON.stringify(qualifyRolloutObservation(JSON.parse(readFileSync(process.argv[2], "utf8"))), null, 2));
}
