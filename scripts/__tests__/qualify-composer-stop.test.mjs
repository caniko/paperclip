import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { qualifyComposerStop } from "../qualify-composer-stop.mjs";
import { stageComposerCandidate } from "../composer-candidate-stage.mjs";

const provenance = {
  revision: "a".repeat(40), headRevision: "a".repeat(40),
  runnerSha256: "c".repeat(64), providerSha256: "d".repeat(64),
  junitSha256: "e".repeat(64),
  sourceLockSha256: "f".repeat(64), effectiveLockSha256: "f".repeat(64),
  trustedRevision: "1".repeat(40), harnessSha256: "2".repeat(64), verifierSha256: "3".repeat(64),
  nodeVersion: "24.20.0", pnpmVersion: "9.15.4",
};
function cancellationEvidence() {
  return {
    schema: "paperclip.composer-stop-cancellation.v1", runId: "parent-run",
    companyId: "owned-company", issueId: "parent-issue", status: "cancelled",
    nativeCancellation: {
      schema: "paperclip.native-cancellation.v1", runId: "parent-run",
      companyId: "owned-company", issueId: "parent-issue", scope: "run",
      reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
      intentAuditId: "intent-audit", acknowledgementAuditId: "ack-audit",
    },
    provider: { fixture: "fake-codex-app-server", callsDuringStop: ["turn/interrupt"] },
  };
}
function report() {
  return {
    errors: [], stats: { expected: 2, skipped: 0, unexpected: 0, flaky: 0 },
    suites: [{ suites: [{ specs: ["process", "paperclip_runner"].map(adapter => ({
      title: `${adapter}: queue, composer Stop, subtree pause/cancel, and resume`,
      tests: [{ expectedStatus: "passed", status: "expected", results: [{
        status: "passed", attachments: [
          { name: `${adapter}-timing`, body: Buffer.from('{"clickToRequestMs":1,"requestToStoppedMs":2}').toString("base64") },
          { name: "owned-company-status-metadata", body: Buffer.from("[]").toString("base64") },
          ...(adapter === "paperclip_runner" ? [{ name: "paperclip_runner-cancellation",
            body: Buffer.from(JSON.stringify(cancellationEvidence())).toString("base64") }] : []),
        ],
      }] }],
    })) }] }],
  };
}

test("qualification binds both mandatory cases and the exact report and binaries", () => {
  const raw = Buffer.from(JSON.stringify(report()));
  const receipt = qualifyComposerStop(raw, provenance);
  assert.equal(receipt.qualified, true);
  assert.equal(receipt.reportSha256, createHash("sha256").update(raw).digest("hex"));
  assert.equal(receipt.revision, provenance.revision);
  assert.equal(receipt.headRevision, provenance.headRevision);
  assert.equal(receipt.runnerSha256, provenance.runnerSha256);
  assert.equal(receipt.providerSha256, provenance.providerSha256);
  assert.equal(receipt.junitSha256, provenance.junitSha256);
  assert.equal(receipt.sourceLockSha256, provenance.sourceLockSha256);
  assert.equal(receipt.effectiveLockSha256, provenance.effectiveLockSha256);
  assert.equal(receipt.nodeVersion, provenance.nodeVersion);
  assert.equal(receipt.pnpmVersion, provenance.pnpmVersion);
  assert.equal(receipt.trustedRevision, provenance.trustedRevision);
  assert.equal(receipt.harnessSha256, provenance.harnessSha256);
  assert.equal(receipt.verifierSha256, provenance.verifierSha256);
  assert.equal(receipt.lockfileRegenerated, false);
  assert.equal(receipt.cases.length, 2);
  assert.equal(receipt.evidence.length, 5);
  assert.equal(receipt.evidence[0].sha256, createHash("sha256")
    .update('{"clickToRequestMs":1,"requestToStoppedMs":2}').digest("hex"));
});

test("native proof refuses child, mismatched, nonterminal, unaudited or undispatched cancellation", () => {
  for (const fault of ["missing", "child", "company", "issue", "nonterminal", "pending", "undispatched", "unaudited", "no-interrupt", "wrong-provider", "malformed"]) {
    const value = report();
    const attachments = value.suites[0].suites[0].specs[1].tests[0].results[0].attachments;
    const proof = cancellationEvidence();
    if (fault === "missing") attachments.pop();
    if (fault === "child") proof.nativeCancellation.runId = "child-run";
    if (fault === "company") proof.nativeCancellation.companyId = "other-company";
    if (fault === "issue") proof.nativeCancellation.issueId = "child-issue";
    if (fault === "nonterminal") proof.status = "running";
    if (fault === "pending") proof.nativeCancellation.dispatchState = "pending";
    if (fault === "undispatched") proof.nativeCancellation.dispatched = false;
    if (fault === "unaudited") delete proof.nativeCancellation.acknowledgementAuditId;
    if (fault === "no-interrupt") proof.provider.callsDuringStop = ["turn/start"];
    if (fault === "wrong-provider") proof.provider.fixture = "live-provider";
    if (fault !== "missing") attachments.at(-1).body = Buffer.from(fault === "malformed" ? "not JSON" : JSON.stringify(proof)).toString("base64");
    assert.throws(() => qualifyComposerStop(Buffer.from(JSON.stringify(value)), provenance), /Incomplete composer Stop proof/, fault);
  }
});

test("a regenerated dependency lock is explicitly identified in the receipt", () => {
  const receipt = qualifyComposerStop(Buffer.from(JSON.stringify(report())), {
    ...provenance, effectiveLockSha256: "0".repeat(64),
  });
  assert.equal(receipt.lockfileRegenerated, true);
  assert.equal(receipt.sourceLockSha256, provenance.sourceLockSha256);
  assert.equal(receipt.effectiveLockSha256, "0".repeat(64));
});

test("the proposed caller retains the staged effective lock before candidate runtime", (t) => {
  const workflow = readFileSync(new URL("../../.github/workflows/pr-trusted.yml", import.meta.url), "utf8");
  const lane = workflow.split("  native_composer_stop:")[1].split("\n  e2e:")[0];
  const statement = lane.split("\n").find(line => line.includes("composer-candidate-stage.mjs effective-lock"))?.trim();
  assert.ok(statement, "the host source lock is not the staged effective dependency lock");
  assert.ok(lane.indexOf(statement) < lane.indexOf("      - name: Run mandatory composer Stop acceptance"));
  assert.doesNotMatch(lane, /cp pnpm-lock\.yaml "\$COMPOSER_STOP_EFFECTIVE_LOCKFILE"/);
  const directory = mkdtempSync(join(tmpdir(), "composer-stop-effective-lock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidate = join(directory, "candidate");
  const trusted = join(directory, ".trusted-composer-stop", "scripts");
  mkdirSync(candidate);
  mkdirSync(trusted, { recursive: true });
  for (const name of ["composer-candidate-stage.mjs", "composer-candidate-sandbox.mjs", "grok-public-install-sandbox.mjs"]) {
    copyFileSync(new URL(`../${name}`, import.meta.url), join(trusted, name));
  }
  const sourceLock = "unchanged source lock\n";
  const effectiveLock = "regenerated staged dependency lock\n";
  writeFileSync(join(directory, "pnpm-lock.yaml"), sourceLock);
  writeFileSync(join(candidate, "pnpm-lock.yaml"), effectiveLock);
  const output = join(directory, "composer-stop-effective-lock.yaml");
  const result = spawnSync("bash", ["-c", statement], { cwd: directory, encoding: "utf8", timeout: 10000,
    env: { ...process.env, COMPOSER_STOP_CANDIDATE_ROOT: candidate, RUNNER_TEMP: directory } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), effectiveLock);
  const receipt = qualifyComposerStop(Buffer.from(JSON.stringify(report())), { ...provenance,
    sourceLockSha256: createHash("sha256").update(sourceLock).digest("hex"),
    effectiveLockSha256: createHash("sha256").update(readFileSync(output)).digest("hex") });
  assert.equal(receipt.lockfileRegenerated, true);
  assert.notEqual(receipt.sourceLockSha256, receipt.effectiveLockSha256);
  const descendant = join(candidate, "evidence");
  const alias = join(directory, "candidate-alias");
  mkdirSync(descendant);
  symlinkSync(candidate, alias, "dir");
  for (const destination of [candidate, descendant, alias]) {
    const refused = spawnSync("bash", ["-c", statement], { cwd: directory, encoding: "utf8", timeout: 10000,
      env: { ...process.env, COMPOSER_STOP_CANDIDATE_ROOT: candidate, RUNNER_TEMP: destination } });
    assert.notEqual(refused.status, 0, destination);
    assert.match(refused.stderr, /must be outside the candidate directory/);
    assert.equal(existsSync(join(destination, "composer-stop-effective-lock.yaml")), false);
  }
  rmSync(join(candidate, "pnpm-lock.yaml"));
  for (const fault of ["symlink", "directory", "fifo", "oversized"]) {
    const lock = join(candidate, "pnpm-lock.yaml");
    if (fault === "symlink") symlinkSync(join(directory, "pnpm-lock.yaml"), lock);
    if (fault === "directory") mkdirSync(lock);
    if (fault === "fifo") assert.equal(spawnSync("mkfifo", [lock]).status, 0);
    if (fault === "oversized") { writeFileSync(lock, ""); truncateSync(lock, 16 * 1024 * 1024 + 1); }
    const refused = spawnSync("bash", ["-c", statement], { cwd: directory, encoding: "utf8", timeout: 10000,
      env: { ...process.env, COMPOSER_STOP_CANDIDATE_ROOT: candidate, RUNNER_TEMP: directory } });
    assert.notEqual(refused.status, 0, fault);
    assert.equal(refused.signal, null, `${fault} must refuse rather than hang`);
    assert.equal(readFileSync(output, "utf8"), effectiveLock, `${fault} changed trusted evidence`);
    rmSync(lock, { recursive: true });
  }
});

test("missing, skipped, failed, retried or incomplete native proof is refused", () => {
  for (const fault of ["missing", "skipped", "failed", "retried", "expected-failure", "attachment", "empty-attachment", "duplicate-attachment", "error", "stats", "duplicate"]) {
    const value = report();
    const specs = value.suites[0].suites[0].specs;
    const native = specs[1].tests[0];
    if (fault === "missing") specs.pop();
    if (fault === "skipped") native.results[0].status = "skipped";
    if (fault === "failed") native.results[0].status = "failed";
    if (fault === "retried") native.results.unshift({ status: "failed" });
    if (fault === "expected-failure") native.expectedStatus = "failed";
    if (fault === "attachment") native.results[0].attachments.pop();
    if (fault === "empty-attachment") delete native.results[0].attachments[0].body;
    if (fault === "duplicate-attachment") native.results[0].attachments.push(native.results[0].attachments[0]);
    if (fault === "error") value.errors.push({ message: "server failed" });
    if (fault === "stats") value.stats.skipped = 1;
    if (fault === "duplicate") specs[1].title = specs[0].title;
    assert.throws(() => qualifyComposerStop(Buffer.from(JSON.stringify(value)), provenance), /Incomplete composer Stop proof/, fault);
  }
});

test("file-backed attachments are required and their bytes are bound", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "composer-stop-evidence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "timing.json");
  const value = report();
  const attachment = value.suites[0].suites[0].specs[1].tests[0].results[0].attachments[0];
  delete attachment.body;
  attachment.path = path;
  const raw = Buffer.from(JSON.stringify(value));
  assert.throws(() => qualifyComposerStop(raw, provenance), /ENOENT/);
  writeFileSync(path, "first evidence");
  const first = qualifyComposerStop(raw, provenance).evidence[2].sha256;
  writeFileSync(path, "changed evidence");
  assert.notEqual(qualifyComposerStop(raw, provenance).evidence[2].sha256, first);
});

test("qualification refuses missing source or binary identities", () => {
  for (const field of Object.keys(provenance)) {
    assert.throws(() => qualifyComposerStop(Buffer.from(JSON.stringify(report())), {
      ...provenance, [field]: undefined,
    }), /Invalid composer Stop provenance/, field);
  }
  assert.throws(() => qualifyComposerStop(Buffer.from(JSON.stringify(report())), {
    ...provenance, headRevision: "b".repeat(40),
  }), /checkout is not the declared PR head/);
});

test("the hosted JUnit gate refuses missing, failed, errored and skipped cases", (t) => {
  const workflow = readFileSync(new URL("../../.github/workflows/pr-trusted.yml", import.meta.url), "utf8");
  const step = workflow.split("      - name: Qualify exact-head native composer Stop proof")[1];
  const python = step.match(/<<'PY'\n([\s\S]*?)\n {10}PY/)[1]
    .split("\n").map(line => line.replace(/^ {10}/, "")).join("\n");
  const directory = mkdtempSync(join(tmpdir(), "composer-stop-junit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "report.xml");
  for (const fault of ["none", "missing", "failure", "error", "skipped"]) {
    const cases = ["process", "paperclip_runner"].filter(adapter => fault !== "missing" || adapter === "process")
      .map(adapter => `<testcase name="${adapter}: queue, composer Stop, subtree pause/cancel, and resume">${
        adapter === "paperclip_runner" && !["none", "missing"].includes(fault) ? `<${fault}/>` : ""
      }</testcase>`).join("");
    writeFileSync(reportPath, `<testsuites><testsuite>${cases}</testsuite></testsuites>`);
    const result = spawnSync("python3", ["-c", python, reportPath], { encoding: "utf8" });
    assert.equal(result.status === 0, fault === "none", `${fault}: ${result.stderr}`);
  }
});

test("the mandatory lane executes an immutable harness and verifier outside the candidate source", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/pr-trusted.yml", import.meta.url), "utf8");
  const lane = workflow.split("  native_composer_stop:")[1].split("\n  e2e:")[0];
  const checkout = lane.split("      - name: Checkout immutable Stop harness")[1]?.split("      - name:")[0];
  assert.ok(checkout, "candidate-controlled acceptance files are not a trusted harness");
  assert.match(checkout, /repository: caniko\/paperclip/);
  assert.match(checkout, /ref: [0-9a-f]{40}(?:\s|$)/);
  assert.match(checkout, /path: \.trusted-composer-stop/);
  assert.match(lane, /PAPERCLIP_E2E_SOURCE_ROOT: \$\{\{ github\.workspace \}\}/);
  assert.match(lane, /--config \.trusted-composer-stop\/tests\/e2e\/playwright-composer-stop\.config\.ts/);
  assert.match(lane, /node \.trusted-composer-stop\/scripts\/qualify-composer-stop\.mjs/);
  assert.doesNotMatch(lane, /node scripts\/qualify-composer-stop\.mjs/);
  assert.match(lane, /COMPOSER_STOP_TRUSTED_REVISION/);
  assert.match(lane, /COMPOSER_STOP_HARNESS_SHA256/);
  assert.match(lane, /COMPOSER_STOP_VERIFIER_SHA256/);
  assert.match(lane, /working-directory: \.trusted-composer-stop\n\s+run: pnpm install --filter paperclip --frozen-lockfile --ignore-scripts/);
  assert.match(lane, /working-directory: \.trusted-composer-stop\/packages\/paperclip-runner\n\s+run: \|\n\s+cargo build[^\n]+--bin fake-codex-app-server/);
  assert.match(lane, /node \.trusted-composer-stop\/node_modules\/@playwright\/test\/cli\.js/);
  assert.match(lane, /git ls-files -z -- tests\/e2e scripts\/qualify-composer-stop\.mjs/);
  assert.match(lane, /packages\/paperclip-runner package\.json pnpm-lock\.yaml/);
  assert.match(lane, /pnpm-workspace\.yaml \.npmrc \.cargo patches \| xargs -0 sha256sum/);
  for (const helper of ["composer-candidate-stage", "composer-candidate-sandbox", "composer-provider-bridge", "grok-public-install-sandbox"]) {
    assert.ok(lane.includes(`scripts/${helper}.mjs`), `missing trusted executable closure: ${helper}`);
  }
  assert.equal((lane.match(/sha256sum --check/g) ?? []).length, 2);
  const base = readFileSync(new URL("../../tests/e2e/playwright.config.ts", import.meta.url), "utf8");
  assert.match(base, /cwd: process\.env\.PAPERCLIP_E2E_SOURCE_ROOT \?\?/);
  const config = readFileSync(new URL("../../tests/e2e/playwright-composer-stop.config.ts", import.meta.url), "utf8");
  assert.match(config, /Mandatory native composer Stop requires an absolute candidate source root/);
});

test("candidate staging retains exact committed source and excludes untracked trusted state", (t) => {
  const source = fileURLToPath(new URL("../../", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "composer-stop-staging-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const untracked = mkdtempSync(join(source, ".composer-staging-untracked-"));
  t.after(() => rmSync(untracked, { recursive: true, force: true }));
  writeFileSync(join(untracked, "trusted-provenance.json"), "host-only fixture state");
  const head = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(head.status, 0, head.stderr);
  const revision = head.stdout.trim();
  const candidate = stageComposerCandidate({ source, revision, temporaryDirectory: directory });
  assert.equal(readFileSync(join(candidate, "package.json"), "utf8"),
    spawnSync("git", ["-C", source, "show", `${revision}:package.json`], { encoding: "utf8" }).stdout);
  for (const path of [".git", ".trusted-composer-stop", "node_modules", basename(untracked)]) assert.equal(existsSync(join(candidate, path)), false, path);
  const parentCandidate = stageComposerCandidate({ source, revision, temporaryDirectory: dirname(source) });
  t.after(() => rmSync(dirname(parentCandidate), { recursive: true, force: true }));
  assert.equal(readFileSync(join(parentCandidate, "package.json"), "utf8"), readFileSync(join(candidate, "package.json"), "utf8"));
  assert.throws(() => stageComposerCandidate({ source, revision: "0".repeat(40), temporaryDirectory: directory }), /not the declared PR head/);
  assert.throws(() => stageComposerCandidate({ source, revision, temporaryDirectory: source }), /outside the source workspace/);
  assert.throws(() => stageComposerCandidate({ source, revision, temporaryDirectory: untracked }), /outside the source workspace/);
});

test("candidate dependency and compiler execution cannot rewrite trusted verifier, tools or provenance", { timeout: 300000 }, (t) => {
  const workflow = readFileSync(new URL("../../.github/workflows/pr-trusted.yml", import.meta.url), "utf8");
  const lane = workflow.split("  native_composer_stop:")[1].split("\n  e2e:")[0];
  const install = lane.split("      - name: Install dependencies\n")[1]?.split("      - name:")[0];
  assert.ok(install, "retain a candidate installation boundary that can be exercised");
  const command = install.match(/        run: \|\n([\s\S]*)/)[1]
    .split("\n").map(line => line.replace(/^ {10}/, "")).join("\n");
  const directory = mkdtempSync(join(tmpdir(), "composer-stop-candidate-isolation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = join(directory, "trusted-runtime");
  const trusted = join(directory, ".trusted-composer-stop");
  for (const path of [runtime, join(trusted, "scripts"), join(trusted, "node_modules")]) mkdirSync(path, { recursive: true });
  for (const name of ["composer-candidate-stage.mjs", "composer-candidate-sandbox.mjs", "grok-public-install-sandbox.mjs"]) {
    copyFileSync(new URL(`../${name}`, import.meta.url), join(trusted, "scripts", name));
  }
  const targets = [join(trusted, "scripts", "qualify-composer-stop.mjs"), join(trusted, "node_modules", "browser-tool.mjs"),
    join(runtime, "composer-stop-harness-manifest.sha256"), join(runtime, "trusted-github-env")];
  for (const path of targets) writeFileSync(path, "independently trusted bytes\n");
  const attack = `import { writeFileSync } from "node:fs";
    for (const target of ${JSON.stringify(targets)}) {
      try { writeFileSync(target, "candidate-controlled forged acceptance\\n"); } catch {}
    }
    writeFileSync('.install-executed', 'real pnpm lifecycle ran');`;
  // Exercise the actual workflow command, not a host pnpm shim. Missing Docker,
  // a failed installation or a lifecycle that never executes is not a pass.
  for (const source of [directory, join(directory, ".candidate")]) {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "attack.mjs"), attack);
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "candidate-isolation-fixture", version: "1.0.0", scripts: { postinstall: "node attack.mjs" } }));
    writeFileSync(join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n");
  }
  const result = spawnSync("bash", ["-c", command.replaceAll("${{ github.workspace }}", directory)], {
    cwd: directory, encoding: "utf8", timeout: 150000,
    env: { ...process.env, GITHUB_WORKSPACE: directory, COMPOSER_STOP_CANDIDATE_ROOT: join(directory, ".candidate"),
      RUNNER_TEMP: runtime, GITHUB_ENV: targets[3] },
  });
  assert.equal(result.status, 0, `candidate fixture must actually execute: ${result.stderr}`);
  assert.equal(readFileSync(join(directory, ".candidate", ".install-executed"), "utf8"), "real pnpm lifecycle ran");
  for (const path of targets) assert.equal(readFileSync(path, "utf8"), "independently trusted bytes\n", `candidate changed trusted state: ${path}`);
  const runner = join(directory, ".candidate", "packages", "paperclip-runner", "runner");
  mkdirSync(join(runner, "src"), { recursive: true });
  writeFileSync(join(runner, "Cargo.toml"), '[package]\nname = "paperclip-runnerd"\nversion = "0.1.0"\nedition = "2021"\n');
  writeFileSync(join(runner, "Cargo.lock"), 'version = 4\n[[package]]\nname = "paperclip-runnerd"\nversion = "0.1.0"\n');
  writeFileSync(join(runner, "src", "main.rs"), "fn main() {}\n");
  writeFileSync(join(runner, "build.rs"), `fn main() {
    for path in [${targets.map(path => JSON.stringify(path)).join(",")}] {
      let _ = std::fs::write(path, b"candidate-controlled forged acceptance\\n");
    }
    std::fs::write(".build-executed", "real Cargo build script ran").unwrap();
  }`);
  const build = lane.split("      - name: Build candidate runner\n")[1]?.split("      - name:")[0];
  assert.ok(build, "retain a candidate compilation boundary that can be exercised");
  const buildCommand = build.match(/        run: \|\n([\s\S]*)/)[1]
    .split("\n").map(line => line.replace(/^ {10}/, "")).join("\n");
  const compiled = spawnSync("bash", ["-c", buildCommand], {
    cwd: directory, encoding: "utf8", timeout: 120000,
    env: { ...process.env, COMPOSER_STOP_CANDIDATE_ROOT: join(directory, ".candidate"), GITHUB_ENV: targets[3] },
  });
  assert.equal(compiled.status, 0, `Cargo fixture must actually execute: ${compiled.stderr}`);
  assert.equal(readFileSync(join(runner, ".build-executed"), "utf8"), "real Cargo build script ran");
  for (const path of targets) assert.equal(readFileSync(path, "utf8"), "independently trusted bytes\n", `compiler changed trusted state: ${path}`);
});

test("the proposed caller refuses acceptance before host execution when isolated runtime is absent", (t) => {
  const workflow = readFileSync(new URL("../../.github/workflows/pr-trusted.yml", import.meta.url), "utf8");
  const step = workflow.split("      - name: Run mandatory composer Stop acceptance")[1].split("      - name:")[0];
  const command = step.match(/        run: \|\n([\s\S]*)/)[1]
    .split("\n").map(line => line.replace(/^ {10}/, "")).join("\n");
  const directory = mkdtempSync(join(tmpdir(), "composer-stop-runtime-refusal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync("bash", ["-c", command], { cwd: directory, encoding: "utf8",
    env: { ...process.env, COMPOSER_STOP_CONTAINER_ID: "" }, timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires isolated container runtime and trusted PID integration/);
  assert.doesNotMatch(result.stderr, /No such file or directory/);
});
