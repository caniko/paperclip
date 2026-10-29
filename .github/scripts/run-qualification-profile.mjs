#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createVitest, parseCLI } from "vitest/node";
import QualificationJUnitReporter from "../../scripts/qualification-junit-reporter.mjs";
import { collectRows, sha256, specificationRows } from "./qualification-roster.mjs";
import { profileSelection, verifyProfileResults } from "./qualification-profiles.mjs";
import { resolveCargoBinary, resolveCargoTargetDirectory } from "../../packages/paperclip-runner/scripts/cargo-artifacts.mjs";
import { bindQualificationRunner, bindRemoteContinuity } from "./qualification-runner.mjs";
import { bindMockTailscale, verifyMockTailscaleExercise } from "./qualification-tailscale-mock.mjs";

const args = process.argv.slice(2);
const diagnostic = args[0] === "--diagnostic";
const [profile, directory, ...sourceArgs] = args.slice(diagnostic ? 1 : 0);
assert.ok(profile && directory, "Pass a profile and new evidence directory, optionally preceded by --diagnostic");
const sourceScope = profile === "default-hosted";
assert.ok(sourceScope || sourceArgs.length === 0, "Only source lanes accept the stable runner's Vitest filters");
const cli = sourceScope ? parseCLI(["vitest", ...sourceArgs]) : { filter: [], options: {} };
assert.ok(!cli.options.testNamePattern && !cli.options.config && !cli.options.root,
  "Source qualification preserves the configured roster without name or configuration overrides");
const root = process.cwd();
const completePackage = profile === "runner-package";
const testRoot = completePackage ? path.join(root, "packages/paperclip-runner") : root;
const evidence = path.resolve(directory);
const write = (name, data) => writeFileSync(path.join(evidence, name), JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
if (diagnostic) mkdirSync(evidence, { recursive: true });
else {
  const source = JSON.parse(readFileSync(path.join(evidence, "source.json"), "utf8"));
  assert.equal(source.initialized, true);
  assert.equal(source.tested_source, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  assert.equal(source.run_attempt, 1);
  assert.equal(source.runner_environment, "github-hosted");
}
const policyRaw = readFileSync(".github/qualification/coverage-environments.json");
const policy = JSON.parse(policyRaw);
const rules = [...policy.rules, ...(policy.supplemental_rules ?? [])].filter(rule => rule.environment === profile);
assert.ok(rules.length || completePackage || sourceScope, "Unknown or unmapped profile");
let files = [...new Set(rules.map(rule => rule.file))];
let sources;
const serverRequire = createRequire(path.join(root, "server/package.json"));
if (profile === "otel-absent") {
  const manifest = serverRequire("./package.json");
  assert.equal(manifest.dependencies["@opentelemetry/resources"], manifest.peerDependencies["@opentelemetry/resources"]);
  const peers = Object.keys(manifest.peerDependencies).filter(name => name.startsWith("@opentelemetry/") && name !== "@opentelemetry/resources");
  // API and resource utilities are workspace dependencies. Optional providers,
  // instrumentation and exporters must still be absent for these unchanged tests.
  for (const name of [...peers, "@opentelemetry/sdk-trace-base"]) {
    assert.throws(() => serverRequire.resolve(name), { code: "MODULE_NOT_FOUND" }, `Absence profile resolved ${name}`);
  }
}
const metadata = { schema: "paperclip.required-profile-execution.v1", profile, platform: process.platform, arch: process.arch,
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
  diagnostic, hostedAcceptance: false, producerAcceptanceQualified: false,
  nodeVersion: process.version, nodeExecutable: process.execPath, nodeSha256: sha256(readFileSync(process.execPath)),
  vitestVersion: createRequire(path.join(root, "package.json"))("vitest/package.json").version,
  policySha256: sha256(policyRaw) };
if (completePackage) {
  assert.equal(process.env.PAPERCLIP_FINAL_BURST_BENCHMARK, "1");
  assert.equal(process.env.PAPERCLIP_FINAL_BURST_REPETITIONS, "1");
  assert.ok(!process.env.PAPERCLIP_FINAL_BURST_BINARY, "The benchmark must use the source-built runner");
  metadata.scope = { kind: "configured-package-vitest", root: "packages/paperclip-runner",
    config: "packages/paperclip-runner/vitest.config.ts", configSha256: sha256(readFileSync(path.join(testRoot, "vitest.config.ts"))),
    benchmarkEnabled: true, benchmarkRepetitions: 1 };
}
if (["otel-sdk", "sentry-sdk"].includes(profile)) {
  const sdkRaw = readFileSync(path.join(evidence, "sdk.json"));
  const sdk = JSON.parse(sdkRaw);
  assert.equal(sdk.profile, profile);
  assert.equal(sdk.head, metadata.head);
  assert.equal(sdk.helperSha256, sha256(readFileSync(".github/scripts/prepare-qualification-sdk.mjs")));
  assert.equal(sdk.sdkLockSha256, sha256(readFileSync(`.github/qualification/sdks/${profile}/package-lock.json`)));
  assert.equal(sdk.lifecycleScriptsExecuted, false);
  metadata.sdkReceiptSha256 = sha256(sdkRaw);
}
if (profile === "linux-containment") {
  assert.equal(process.env.PAPERCLIP_TEST_BWRAP, "/usr/bin/bwrap");
  assert.equal(process.env.PAPERCLIP_TEST_SANDBOX_BUILD, "1");
  metadata.containment = { binary: "/usr/bin/bwrap", binarySha256: sha256(readFileSync("/usr/bin/bwrap")),
    version: execFileSync("/usr/bin/bwrap", ["--version"], { encoding: "utf8" }).trim(),
    preparationHelperSha256: sha256(readFileSync(".github/scripts/prepare-candidate-sandbox.sh")) };
}
function runnerBinding() {
  const packageRoot = path.join(root, "packages/paperclip-runner");
  const binary = resolveCargoBinary({ binary: "paperclip-runnerd", targetDirectory: resolveCargoTargetDirectory({ packageRoot }) });
  const binding = bindQualificationRunner(packageRoot, binary);
  const version = command => execFileSync(command, ["--version", "--verbose"], { cwd: packageRoot, encoding: "utf8" }).trim();
  const rustcVersion = version("rustc"), cargoVersion = version("cargo");
  const channel = readFileSync(path.join(packageRoot, "rust-toolchain.toml"), "utf8").match(/^channel = "([0-9.]+)"$/m)?.[1];
  assert.ok(channel, "The runner requires its declared immutable Rust toolchain");
  assert.ok(rustcVersion.startsWith(`rustc ${channel} `) && cargoVersion.startsWith(`cargo ${channel} `),
    "The actual compiler and Cargo must match the declared runner toolchain");
  const nativeToolsRaw = readFileSync(path.join(evidence, "native-tools.json"));
  const nativeTools = JSON.parse(nativeToolsRaw);
  assert.equal(nativeTools.schema, "paperclip.source-native-tools.v1");
  assert.equal(nativeTools.head, metadata.head);
  assert.equal(nativeTools.tree, metadata.tree);
  assert.equal(nativeTools.verificationOnly, diagnostic);
  assert.equal(nativeTools.helperSha256, sha256(readFileSync(path.join(root, ".github/scripts/prepare-source-native-tools.mjs"))));
  assert.equal(nativeTools.nativeRuntimeHelperSha256, sha256(readFileSync(path.join(root, "packages/db/src/embedded-postgres-native.ts"))));
  assert.equal(nativeTools.dependencyLockSha256, sha256(readFileSync(path.join(root, "pnpm-lock.yaml"))));
  assert.deepEqual(Object.keys(nativeTools.tools).sort(), ["pg_dump", "postgres", "psql", "zsh"]);
  for (const tool of Object.values(nativeTools.tools)) assert.equal(sha256(readFileSync(tool.binary)), tool.sha256);
  return { ...binding, rustcVersion, cargoVersion, nativeToolsReceiptSha256: sha256(nativeToolsRaw),
    bindingHelperSha256: sha256(readFileSync(path.join(root, ".github/scripts/qualification-runner.mjs"))),
    resolutionHelperSha256: sha256(readFileSync(path.join(packageRoot, "src/live/runner-binary.ts"))),
    transportSha256: sha256(readFileSync(path.join(packageRoot, "src/live/runnerd-codex-transport.ts"))) };
}
if (["runnerd", "warm-transition", "runner-package"].includes(profile)) metadata.runnerd = runnerBinding();
if (profile === "runnerd") metadata.remoteContinuity = bindRemoteContinuity(root, evidence);
if (profile === "tailscale-mock") metadata.tailscaleMock = bindMockTailscale(root);
const options = { ...cli.options, root: testRoot, ...(completePackage ? { config: path.join(testRoot, "vitest.config.ts") } : {}),
  watch: false, includeTaskLocation: true, allowOnly: false, retry: 0,
  maxWorkers: 1, fileParallelism: false, exclude: [...(cli.options.exclude ?? []), "**/dist/**"] };
let ctx;
let selection;
try {
  // Package tests historically run from this directory; config.root alone does
  // not set the cwd inherited by their real subprocesses and filesystem probes.
  process.chdir(testRoot);
  // Runtime collection preserves all parameters and inactive sibling declarations.
  // https://vitest.dev/api/advanced/vitest#collecttests
  ctx = await createVitest({ ...options, reporters: [] });
  const filters = sourceScope ? cli.filter : files;
  const specs = await ctx.globTestSpecifications(filters);
  const discovery = specificationRows(specs, testRoot);
  // Use Vitest's own configured sequencer, just as its collection/execution pools do.
  const selectedSpecs = ctx.config.shard ? await new ctx.config.sequence.sequencer(ctx).shard(specs) : specs;
  const specifications = specificationRows(selectedSpecs, testRoot);
  if (completePackage || sourceScope) files = [...new Set(specifications.map(spec => spec.file))];
  assert.ok(specifications.length, "The configured test roster must not be empty");
  assert.deepEqual([...new Set(specifications.map(spec => spec.file))].sort(), files.slice().sort());
  sources = Object.fromEntries(files.map(file => [file, readFileSync(path.join(testRoot, file), "utf8")]));
  metadata.sourceFiles = Object.fromEntries(files.map(file => [file, sha256(sources[file])]));
  write("profile-source.json", metadata);
  const collection = await ctx.collectTests(specs);
  const moduleErrors = modules => modules.flatMap(module => [module, ...module.children.allSuites()].flatMap(suite => suite.errors()));
  const collectionErrors = [...collection.unhandledErrors, ...moduleErrors(collection.testModules)];
  const rows = collectRows(collection.testModules, testRoot);
  write("profile-collection.json", { discovery, specifications, sourceArgs, cases: rows, errors: collectionErrors });
  assert.equal(collectionErrors.length, 0, "Profile collection contains errors");
  for (const spec of specifications) assert.ok(rows.some(row => row.file === spec.file && row.project === spec.project),
    `Configured specification collected no cases: ${spec.file}`);
  selection = profileSelection(profile, process.platform, rows, sources, policy);
  write("profile-selection.json", selection);
  await ctx.close();
  // Retain every raw sibling outcome, including filtered skips. A separately
  // verified projection creates strict XML for the source-mapped profile scope.
  const rawReporter = new QualificationJUnitReporter();
  rawReporter.options.outputFile = path.join(evidence, "raw-results.junit");
  ctx = await createVitest({ ...options, testNamePattern: selection.testNamePattern,
    // The runnerd profile streams each case as it finishes so a hang names its scenario.
    reporters: [profile === "runnerd" ? "verbose" : "default", rawReporter] });
  const executionSpecs = await ctx.globTestSpecifications(filters);
  assert.deepEqual(specificationRows(executionSpecs, testRoot), discovery);
  // https://vitest.dev/api/advanced/vitest#start — run once, no retries or timeout overrides.
  const executed = await ctx.start(filters);
  const executedRows = collectRows(executed.testModules, testRoot);
  const tasks = executed.testModules.flatMap(module => [...module.children.allTests()].map(test => test.task));
  const byId = new Map(tasks.map(task => [task.id, task]));
  assert.equal(byId.size, tasks.length, "Execution emitted duplicate framework identities");
  const results = executedRows.map(row => {
    const task = byId.get(row.id);
    return { ...row, outcome: task.result?.state === "pass" ? "passed" : task.result?.state === "fail" ? "failed"
      : ["skip", "todo"].includes(task.mode) ? "skipped" : "unexecuted",
    retryCount: task.result?.retryCount ?? 0, repeatCount: task.result?.repeatCount ?? 0 };
  });
  const errors = [...executed.unhandledErrors, ...moduleErrors(executed.testModules)];
  write("profile-raw-results.json", { cases: results, errors });
  for (const file of files) assert.equal(sha256(readFileSync(path.join(testRoot, file))), metadata.sourceFiles[file], "Fixture changed during execution");
  if (completePackage) assert.equal(sha256(readFileSync(path.join(testRoot, "vitest.config.ts"))), metadata.scope.configSha256,
    "The package configuration changed during execution");
  if (["runnerd", "warm-transition", "runner-package"].includes(profile)) assert.deepEqual(runnerBinding(), metadata.runnerd, "Runner prerequisites changed during execution");
  if (profile === "runnerd") assert.deepEqual(bindRemoteContinuity(root, evidence), metadata.remoteContinuity, "Remote continuity prerequisites changed during execution");
  if (profile === "tailscale-mock") {
    assert.deepEqual(bindMockTailscale(root), metadata.tailscaleMock, "Mock broker prerequisites changed during execution");
    const mockReceipt = readFileSync(path.join(evidence, "tailscale-mock.json"));
    verifyMockTailscaleExercise(JSON.parse(mockReceipt), metadata.tailscaleMock);
    metadata.mockExerciseReceiptSha256 = sha256(mockReceipt);
  }
  const result = verifyProfileResults(selection, results, errors);
  write("profile-result.json", { ...metadata, ...result });
} catch (error) {
  write("profile-failure.json", { ...metadata, message: error.message, stack: error.stack });
  throw error;
} finally {
  await ctx?.close();
  process.chdir(root);
}
