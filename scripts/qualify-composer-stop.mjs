import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REQUIRED = ["process", "paperclip_runner"].map(adapter =>
  `${adapter}: queue, composer Stop, subtree pause/cancel, and resume`);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const requiredAttachments = title => {
  const adapter = title.split(":")[0];
  return [`${adapter}-timing`, "owned-company-status-metadata",
    ...(adapter === "paperclip_runner" ? ["paperclip_runner-cancellation"] : [])];
};

function verifyCancellationEvidence(bytes) {
  let proof;
  try { proof = JSON.parse(bytes); } catch {
    throw new Error("Incomplete composer Stop proof: invalid cancellation JSON");
  }
  const receipt = proof?.nativeCancellation;
  const provider = proof?.provider;
  const bound = ["runId", "companyId", "issueId"].every(field =>
    typeof proof?.[field] === "string" && proof[field].length > 0 && receipt?.[field] === proof[field]);
  if (proof?.schema !== "paperclip.composer-stop-cancellation.v1" || proof.status !== "cancelled" || !bound ||
      receipt?.schema !== "paperclip.native-cancellation.v1" || receipt.scope !== "run" ||
      receipt.reasonCode !== "cancellation_run_only" || receipt.dispatchState !== "acknowledged" || receipt.dispatched !== true ||
      !["intentAuditId", "acknowledgementAuditId"].every(field => typeof receipt[field] === "string" && receipt[field].length > 0) ||
      provider?.fixture !== "fake-codex-app-server" || !Array.isArray(provider.callsDuringStop) ||
      !provider.callsDuringStop.includes("turn/interrupt") ||
      !provider.callsDuringStop.every(method => ["turn/start", "turn/interrupt"].includes(method)))
    throw new Error("Incomplete composer Stop proof: require bound audited parent cancellation and fixture interrupt");
}

export function qualifyComposerStop(raw, provenance) {
  for (const field of ["revision", "headRevision", "trustedRevision", "harnessSha256", "verifierSha256", "runnerSha256", "providerSha256", "junitSha256", "sourceLockSha256", "effectiveLockSha256"]) {
    const pattern = field.endsWith("Sha256") ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
    if (!pattern.test(provenance[field] ?? "")) throw new Error(`Invalid composer Stop provenance: ${field}`);
  }
  for (const field of ["nodeVersion", "pnpmVersion"]) {
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(provenance[field] ?? ""))
      throw new Error(`Invalid composer Stop provenance: ${field}`);
  }
  if (provenance.revision !== provenance.headRevision) {
    throw new Error("Invalid composer Stop provenance: checkout is not the declared PR head");
  }
  const report = JSON.parse(raw);
  const specs = [];
  const collect = suites => {
    for (const suite of suites ?? []) {
      specs.push(...suite.specs ?? []);
      collect(suite.suites);
    }
  };
  collect(report.suites);
  const tests = specs.flatMap(spec => (spec.tests ?? []).map(test => ({ title: spec.title, test })));
  const valid = report.errors?.length === 0 && report.stats?.expected === REQUIRED.length &&
    ["skipped", "unexpected", "flaky"].every(field => report.stats[field] === 0) &&
    tests.length === REQUIRED.length && REQUIRED.every(title => tests.filter(entry => entry.title === title).length === 1) &&
    tests.every(({ title, test }) => test.expectedStatus === "passed" && test.status === "expected" &&
      test.results?.length === 1 && test.results[0].status === "passed" && !test.results[0].error &&
      (!test.results[0].errors || test.results[0].errors.length === 0) &&
      requiredAttachments(title).every(name =>
        test.results[0].attachments?.some(attachment => attachment.name === name)));
  if (!valid) throw new Error("Incomplete composer Stop proof: require both cases, retained evidence and zero failures, retries or skips");
  const evidence = tests.flatMap(({ title, test }) =>
    requiredAttachments(title).map(name => {
      const matches = test.results[0].attachments.filter(attachment => attachment.name === name);
      if (matches.length !== 1) throw new Error("Incomplete composer Stop proof: ambiguous attachment");
      const attachment = matches[0];
      const bytes = attachment.path ? readFileSync(attachment.path) :
        Buffer.from(attachment.body ?? "", "base64");
      if (!bytes.length) throw new Error("Incomplete composer Stop proof: missing attachment bytes");
      if (name === "paperclip_runner-cancellation") verifyCancellationEvidence(bytes);
      return { case: title, name, sha256: sha256(bytes) };
    }));
  return {
    kind: "native-composer-stop-qualification", ...provenance,
    reportSha256: sha256(raw), cases: REQUIRED, evidence, qualified: true,
    lockfileRegenerated: provenance.sourceLockSha256 !== provenance.effectiveLockSha256,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [reportPath, receiptPath] = process.argv.slice(2);
    const receipt = qualifyComposerStop(readFileSync(reportPath), {
      revision: process.env.COMPOSER_STOP_REVISION,
      headRevision: process.env.COMPOSER_STOP_HEAD_REVISION,
      trustedRevision: process.env.COMPOSER_STOP_TRUSTED_REVISION,
      harnessSha256: process.env.COMPOSER_STOP_HARNESS_SHA256,
      verifierSha256: process.env.COMPOSER_STOP_VERIFIER_SHA256,
      runnerSha256: sha256(readFileSync(process.env.PAPERCLIP_RUNNER_BINARY)),
      providerSha256: sha256(readFileSync(process.env.PAPERCLIP_STOP_FAKE_CODEX)),
      junitSha256: sha256(readFileSync(process.env.PLAYWRIGHT_JUNIT_OUTPUT_NAME)),
      sourceLockSha256: sha256(readFileSync(process.env.COMPOSER_STOP_SOURCE_LOCKFILE)),
      effectiveLockSha256: sha256(readFileSync(process.env.COMPOSER_STOP_EFFECTIVE_LOCKFILE)),
      nodeVersion: process.versions.node,
      pnpmVersion: process.env.COMPOSER_STOP_PNPM_VERSION,
    });
    writeFileSync(receiptPath, JSON.stringify({
      ...receipt, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    }, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
