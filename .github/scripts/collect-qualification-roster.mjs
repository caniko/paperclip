#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createVitest } from "vitest/node";
import { collectRows, mapEnvironments, sha256, specificationRows } from "./qualification-roster.mjs";
import { importEntries, reconcileImportEntry, supplementalSpecifications } from "./qualification-import-provenance.mjs";

const root = process.cwd();
const destination = path.resolve(process.argv[2]);
mkdirSync(destination, { recursive: true });
const write = (name, data) => writeFileSync(path.join(destination, name), JSON.stringify(data, null, 2) + "\n");
const source = JSON.parse(readFileSync(path.join(destination, "source.json"), "utf8"));
assert.equal(source.initialized, true);
assert.equal(source.tested_source, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
const policy = JSON.parse(readFileSync(".github/qualification/coverage-environments.json", "utf8"));
const options = { root, watch: false, reporters: [], includeTaskLocation: true,
  allowOnly: false, retry: 0, maxWorkers: 1, fileParallelism: false, exclude: ["**/dist/**"] };
// Keep AST and runtime state separate: static placeholder tasks must never
// stand in for a module that failed to collect in the real environment.
// Source: https://github.com/vitest-dev/vitest/blob/v5.0.3/packages/vitest/src/node/core.ts
let ctx = await createVitest(options);
try {
  const specs = await ctx.globTestSpecifications();
  const discoveryRows = specifications => specifications.map(spec => ({ file: path.relative(root, spec.moduleId).split(path.sep).join("/"), project: spec.project.name, pool: spec.pool }));
  write("static-discovery.json", discoveryRows(specs));
  const specifications = specificationRows(specs, root);
  write("specifications.json", specifications);
  assert.ok(specs.length, "No configured test specifications");
  const sources = Object.fromEntries([...new Set(specifications.map(spec => spec.file))]
    .map(file => [file, readFileSync(file, "utf8")]));
  const entries = importEntries(specs, root);
  write("import-entry-sources.json", entries);
  const supplementalStatic = supplementalSpecifications(specs, entries, root);
  write("supplemental-static-specifications.json", specificationRows(supplementalStatic, root));
  for (const entry of entries) for (const source of entry.sources) {
    sources[source.file] = readFileSync(source.file, "utf8");
  }
  // Static declarations supplement runtime collection: a conditional definition
  // can be absent at runtime, and dynamic parameters may be unresolved statically.
  const parsed = await ctx.parseSpecifications(specs, { concurrency: 2 });
  const supplementalParsed = await ctx.parseSpecifications(supplementalStatic, { concurrency: 2 });
  const declarations = collectRows([...parsed, ...supplementalParsed], root);
  write("static-declarations.json", declarations);
  const moduleErrors = modules => modules.flatMap(module =>
    [module, ...module.children.allSuites()].flatMap(suite => suite.errors()));
  const staticErrors = moduleErrors(parsed);
  write("static-errors.json", staticErrors);
  const supplementalStaticErrors = moduleErrors(supplementalParsed);
  write("supplemental-static-errors.json", supplementalStaticErrors);
  await ctx.close();
  ctx = await createVitest(options);
  const runtimeSpecs = await ctx.globTestSpecifications();
  write("runtime-discovery.json", discoveryRows(runtimeSpecs));
  assert.deepEqual(specificationRows(runtimeSpecs, root),
    specifications, "Configured specifications changed between static and runtime collection");
  const { testModules, unhandledErrors } = await ctx.collectTests(runtimeSpecs);
  const rows = collectRows(testModules, root);
  write("runtime-roster.json", rows);
  const supplementalRuntime = supplementalSpecifications(runtimeSpecs, entries, root);
  write("supplemental-runtime-specifications.json", specificationRows(supplementalRuntime, root));
  // A third context keeps supplemental collection from reusing static tasks or
  // changing the configured runtime roster's state and identities.
  await ctx.close();
  ctx = await createVitest(options);
  const sourceSpecs = await ctx.globTestSpecifications();
  assert.deepEqual(specificationRows(sourceSpecs, root), specifications);
  const extraSpecs = supplementalSpecifications(sourceSpecs, entries, root);
  const supplemental = extraSpecs.length ? await ctx.collectTests(extraSpecs)
    : { testModules: [], unhandledErrors: [] };
  write("supplemental-runtime-roster.json", collectRows(supplemental.testModules, root));
  const provenance = entries.map(entry => reconcileImportEntry(entry,
    [...testModules, ...supplemental.testModules], declarations, root));
  write("import-entry-provenance.json", provenance);
  const unresolvedStaticErrors = [...staticErrors];
  const resolvedParserGaps = [];
  for (const entry of provenance.filter(entry => entry.complete)) {
    const index = unresolvedStaticErrors.findIndex(error =>
      error.message === `No test suite found in file ${path.resolve(root, entry.file)}`);
    if (index >= 0) resolvedParserGaps.push({ original_error: unresolvedStaticErrors.splice(index, 1)[0],
      resolution: "source-bound import-only entry point", file: entry.file,
      source_sha256: entry.sha256, required_cases: entry.bindings.length, execution_credit: false });
  }
  write("resolved-parser-gaps.json", resolvedParserGaps);
  const mapped = mapEnvironments(rows, sources, policy);
  const errors = [...unresolvedStaticErrors, ...supplementalStaticErrors, ...unhandledErrors,
    ...supplemental.unhandledErrors, ...moduleErrors(testModules), ...moduleErrors(supplemental.testModules)]
    .map(error => ({ name: error.name, message: error.message, stack: error.stack }));
  const sites = declarations.map(declaration => ({ ...declaration,
    matching_requires_environment_union_review: true,
    runtime_case_ids_at_site: rows.filter(row => row.file === declaration.file && row.project === declaration.project
      && row.location && declaration.location && row.location.line === declaration.location.line
      && row.location.column === declaration.location.column).map(row => row.id) }));
  const missing = specifications.filter(spec => !rows.some(row => row.file === spec.file && row.project === spec.project));
  const roster = { schema: "paperclip.complete-coverage-map.v1", head: source.head, tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    run_id: source.run_id, run_attempt: source.run_attempt, collection_platform: process.platform,
    all_declared_cases_required: true, qualified: false, collection_is_execution_evidence: false,
    scope: { kind: "configured-workspace-vitest", config: "vitest.config.ts", generated_dist_excluded: true },
    coverage_complete: false, environment_union_reconciled: false, environments: policy.environments,
    policy_sha256: sha256(readFileSync(".github/qualification/coverage-environments.json")),
    source_files: Object.fromEntries(Object.entries(sources).map(([file, text]) => [file, sha256(text)])),
    counts: { specifications: specifications.length, runtime_cases: rows.length, static_declarations: declarations.length,
      skipped_in_collection_environment: rows.filter(row => row.skipped_in_environment).length,
      unmapped_cases: mapped.cases.filter(row => !row.environments.length).length },
     cases: mapped.cases, declaration_sites: sites, missing_specifications: missing, collection_errors: errors,
     import_entry_provenance: provenance, resolved_parser_gaps: resolvedParserGaps,
    stale_mapping_rules: mapped.stale_rules, conditional_expansions: mapped.conditional_expansions,
    blockers: ["Every required case still needs source-bound, attempt-1 execution evidence with zero failures, skips and retries.",
      "The union of real OS, SDK, runner and live environment collections must reconcile conditional declarations and parameter expansions.",
      "Unresolved mappings, collection errors, missing specifications and source drift remain blockers.",
       "Authorized live profiles require disposable hosted environments: the pinned Claude prompt lane is pending; Tailscale requires real service credentials and a dedicated broker-provisioned node."] };
  write("coverage-map.json", roster);
  assert.equal(errors.length, 0, "Collection errors remain in the retained coverage map");
  assert.equal(missing.length, 0, "Configured specifications were not collected");
  assert.equal(mapped.stale_rules.length, 0, "Environment mapping source or anchors drifted");
  assert.ok(provenance.every(entry => entry.complete), "Imported declaration provenance remains unresolved");
} finally {
  await ctx.close();
}
