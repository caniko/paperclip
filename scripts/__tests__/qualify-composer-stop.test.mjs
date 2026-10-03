import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualifyComposerStop } from "../qualify-composer-stop.mjs";

const provenance = {
  revision: "a".repeat(40), headRevision: "a".repeat(40),
  runnerSha256: "c".repeat(64), providerSha256: "d".repeat(64),
  junitSha256: "e".repeat(64),
  sourceLockSha256: "f".repeat(64), effectiveLockSha256: "f".repeat(64),
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
