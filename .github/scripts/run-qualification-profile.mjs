#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createVitest } from "vitest/node";
import QualificationJUnitReporter from "../../scripts/qualification-junit-reporter.mjs";
import { collectRows, sha256, specificationRows } from "./qualification-roster.mjs";
import { profileSelection, verifyProfileResults } from "./qualification-profiles.mjs";
import { resolveCargoBinary, resolveCargoTargetDirectory } from "../../packages/paperclip-runner/scripts/cargo-artifacts.mjs";
import { bindQualificationRunner } from "./qualification-runner.mjs";

const args = process.argv.slice(2);
const diagnostic = args[0] === "--diagnostic";
assert.equal(args.length, diagnostic ? 3 : 2, "Pass a profile and new evidence directory, optionally preceded by --diagnostic");
const [profile, directory] = args.slice(diagnostic ? 1 : 0);
const root = process.cwd();
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
const rules = policy.rules.filter(rule => rule.environment === profile);
assert.ok(rules.length, "Unknown or unmapped profile");
const files = [...new Set(rules.map(rule => rule.file))];
const sources = Object.fromEntries(files.map(file => [file, readFileSync(file, "utf8")]));
const serverRequire = createRequire(path.join(root, "server/package.json"));
if (profile === "otel-absent") {
  const peers = Object.keys(serverRequire("./package.json").peerDependencies).filter(name => name.startsWith("@opentelemetry/"));
  // The API can already be a transitive workspace dependency. The SDK peers
  // and trace provider must be absent for these unchanged failure-mode tests.
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
  policySha256: sha256(policyRaw), sourceFiles: Object.fromEntries(files.map(file => [file, sha256(sources[file])])) };
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
  assert.equal(nativeTools.helperSha256, sha256(readFileSync(".github/scripts/prepare-source-native-tools.mjs")));
  assert.equal(nativeTools.nativeRuntimeHelperSha256, sha256(readFileSync("packages/db/src/embedded-postgres-native.ts")));
  assert.equal(nativeTools.dependencyLockSha256, sha256(readFileSync("pnpm-lock.yaml")));
  assert.deepEqual(Object.keys(nativeTools.tools).sort(), ["pg_dump", "postgres", "psql", "zsh"]);
  for (const tool of Object.values(nativeTools.tools)) assert.equal(sha256(readFileSync(tool.binary)), tool.sha256);
  return { ...binding, rustcVersion, cargoVersion, nativeToolsReceiptSha256: sha256(nativeToolsRaw),
    bindingHelperSha256: sha256(readFileSync(".github/scripts/qualification-runner.mjs")),
    resolutionHelperSha256: sha256(readFileSync(path.join(packageRoot, "src/live/runner-binary.ts"))),
    transportSha256: sha256(readFileSync(path.join(packageRoot, "src/live/runnerd-codex-transport.ts"))) };
}
if (profile === "runnerd") metadata.runnerd = runnerBinding();
write("profile-source.json", metadata);
const options = { root, watch: false, includeTaskLocation: true, allowOnly: false, retry: 0,
  maxWorkers: 1, fileParallelism: false, exclude: ["**/dist/**"] };
let ctx;
let selection;
try {
  // Runtime collection preserves all parameters and inactive sibling declarations.
  // https://vitest.dev/api/advanced/vitest#collecttests
  ctx = await createVitest({ ...options, reporters: [] });
  const specs = await ctx.globTestSpecifications(files);
  const specifications = specificationRows(specs, root);
  assert.deepEqual([...new Set(specifications.map(spec => spec.file))].sort(), files.slice().sort());
  const collection = await ctx.collectTests(specs);
  const moduleErrors = modules => modules.flatMap(module => [module, ...module.children.allSuites()].flatMap(suite => suite.errors()));
  const collectionErrors = [...collection.unhandledErrors, ...moduleErrors(collection.testModules)];
  const rows = collectRows(collection.testModules, root);
  write("profile-collection.json", { specifications, cases: rows, errors: collectionErrors });
  assert.equal(collectionErrors.length, 0, "Profile collection contains errors");
  selection = profileSelection(profile, process.platform, rows, sources, policy);
  write("profile-selection.json", selection);
  await ctx.close();
  // Retain every raw sibling outcome, including filtered skips. A separately
  // verified projection creates strict XML for the source-mapped profile scope.
  const rawReporter = new QualificationJUnitReporter();
  rawReporter.options.outputFile = path.join(evidence, "raw-results.junit");
  ctx = await createVitest({ ...options, testNamePattern: selection.testNamePattern,
    reporters: ["default", rawReporter] });
  const executionSpecs = await ctx.globTestSpecifications(files);
  assert.deepEqual(specificationRows(executionSpecs, root), specifications);
  // https://vitest.dev/api/advanced/vitest#start — run once, no retries or timeout overrides.
  const executed = await ctx.start(files);
  const executedRows = collectRows(executed.testModules, root);
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
  for (const file of files) assert.equal(sha256(readFileSync(file)), metadata.sourceFiles[file], "Fixture changed during execution");
  if (profile === "runnerd") assert.deepEqual(runnerBinding(), metadata.runnerd, "Runner prerequisites changed during execution");
  const result = verifyProfileResults(selection, results, errors);
  write("profile-result.json", { ...metadata, ...result });
} catch (error) {
  write("profile-failure.json", { ...metadata, message: error.message, stack: error.stack });
  throw error;
} finally {
  await ctx?.close();
}
