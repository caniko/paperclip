import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REQUIRED = ["process", "paperclip_runner"].map(adapter =>
  `${adapter}: queue, composer Stop, subtree pause/cancel, and resume`);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function qualifyComposerStop(raw, provenance) {
  for (const field of ["revision", "headRevision", "runnerSha256", "providerSha256", "junitSha256"]) {
    const pattern = field.endsWith("Sha256") ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
    if (!pattern.test(provenance[field] ?? "")) throw new Error(`Invalid composer Stop provenance: ${field}`);
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
      [title.split(":")[0] + "-timing", "owned-company-status-metadata"].every(name =>
        test.results[0].attachments?.some(attachment => attachment.name === name)));
  if (!valid) throw new Error("Incomplete composer Stop proof: require both cases, retained evidence and zero failures, retries or skips");
  const evidence = tests.flatMap(({ title, test }) =>
    [title.split(":")[0] + "-timing", "owned-company-status-metadata"].map(name => {
      const matches = test.results[0].attachments.filter(attachment => attachment.name === name);
      if (matches.length !== 1) throw new Error("Incomplete composer Stop proof: ambiguous attachment");
      const attachment = matches[0];
      const bytes = attachment.path ? readFileSync(attachment.path) :
        Buffer.from(attachment.body ?? "", "base64");
      if (!bytes.length) throw new Error("Incomplete composer Stop proof: missing attachment bytes");
      return { case: title, name, sha256: sha256(bytes) };
    }));
  return {
    kind: "native-composer-stop-qualification", ...provenance,
    reportSha256: sha256(raw), cases: REQUIRED, evidence, qualified: true,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [reportPath, receiptPath] = process.argv.slice(2);
    const receipt = qualifyComposerStop(readFileSync(reportPath), {
      revision: process.env.COMPOSER_STOP_REVISION,
      headRevision: process.env.COMPOSER_STOP_HEAD_REVISION,
      runnerSha256: sha256(readFileSync(process.env.PAPERCLIP_RUNNER_BINARY)),
      providerSha256: sha256(readFileSync(process.env.PAPERCLIP_STOP_FAKE_CODEX)),
      junitSha256: sha256(readFileSync(process.env.PLAYWRIGHT_JUNIT_OUTPUT_NAME)),
    });
    writeFileSync(receiptPath, JSON.stringify({
      ...receipt, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    }, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
