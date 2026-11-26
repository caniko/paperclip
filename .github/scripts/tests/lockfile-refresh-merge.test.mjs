import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOCKFILES, REPORT_LOCK_FILES } from "../lockfile-trust.mjs";

const workflow = readFileSync(new URL("../../workflows/refresh-lockfile.yml", import.meta.url), "utf8");
const stepNames = [...workflow.matchAll(/^      - name: (.+)$/gm)].map((match) => match[1]);
const step = (name) => {
  const body = workflow.split(`      - name: ${name}\n`)[1]?.split("      - name:")[0];
  assert.ok(body, `the refresh workflow must have a "${name}" step`);
  return body;
};
const condition = (name) => step(name).match(/^        if: (.+)$/m)?.[1].trim();

test("the bot key is only reachable from the master-only lockfile-refresh environment", () => {
  assert.match(workflow, /^    environment: lockfile-refresh$/m);
  const keyUses = workflow.match(/secrets\.LOCKFILE_BOT_PRIVATE_KEY/g) ?? [];
  assert.equal(keyUses.length, 1, "only the token step may read the bot key");
  assert.match(step("Create lockfile bot token"), /private-key: \$\{\{ secrets\.LOCKFILE_BOT_PRIVATE_KEY \}\}/);
});

test("the bot token is minted only after resolution and the release-age gate", () => {
  const order = (name) => {
    const index = stepNames.indexOf(name);
    assert.notEqual(index, -1, `missing step "${name}"`);
    return index;
  };
  assert.ok(order("Refresh pnpm lockfile") < order("Check release age of added package versions"));
  assert.ok(order("Check release age of added package versions") < order("Create or update pull request"));
  assert.ok(order("Create or update pull request") < order("Create lockfile bot token"));
  assert.ok(order("Check release age of added package versions") < order("Create lockfile bot token"));
  assert.ok(order("Create lockfile bot token") < order("Merge lockfile PR"));
});

test("only a changed canonical refresh reaches the age gate, and the bot merges only when the gate passes", () => {
  assert.match(workflow, /^\s+if: needs\.refresh\.outputs\.canonical_master == 'true' && needs\.refresh\.outputs\.changed == 'true'$/m);
  assert.equal(condition("Hold lockfile PR for review"), "steps.release-age.outputs.eligible == 'false'");
  assert.equal(condition("Create lockfile bot token"), "steps.release-age.outputs.eligible == 'true'");
  assert.equal(condition("Merge lockfile PR"), "steps.release-age.outputs.eligible == 'true'");
});

test("a held refresh keeps its versions through the next master run's artifact", () => {
  assert.ok(stepNames.indexOf("Reuse versions from a held refresh") < stepNames.indexOf("Refresh pnpm lockfile"));
  const fetch = step("Fetch previously held locks");
  assert.match(fetch, /gh run list --workflow refresh-lockfile\.yml --branch master --status success/);
  assert.match(fetch, /gh run download "\$run_id" --name held-pnpm-lock/);
  assert.match(step("Download held lock input"), /artifact-ids: \$\{\{ needs\.held_input\.outputs\.artifact_id \}\}/);
  const reuse = step("Reuse versions from a held refresh");
  assert.match(reuse, /if \[ ! -f "\$held\/source-locks\.sha256" \]; then[\s\S]*?exit 0/, "an older held artifact must not be reused");
  assert.doesNotMatch(fetch + reuse, /chore\/refresh-lockfile/, "the PR branch is writable by others and must not seed resolution");

  for (const name of ["Stage held lockfile", "Save held lockfile for the next refresh"]) {
    assert.equal(condition(name), "steps.release-age.outputs.eligible == 'false'");
  }
  const stage = step("Stage held lockfile");
  assert.match(stage, /cp "\$lock" "\$held\/\$lock"/);
  assert.match(stage, /\(cd "\$RUNNER_TEMP\/base-locks" && sha256sum "\$\{locks\[@\]\}"\) > "\$held\/source-locks\.sha256"/);
  const save = step("Save held lockfile for the next refresh");
  assert.match(save, /name: held-pnpm-lock/);
  assert.match(save, /path: \$\{\{ runner\.temp \}\}\/held-upload\//);
});

test("the bot merges only the commit this job pushed", () => {
  assert.match(step("Create or update pull request"), /echo "head_sha=\$\(git rev-parse HEAD\)" >> "\$GITHUB_OUTPUT"/);
  const merge = step("Merge lockfile PR");
  assert.match(merge, /HEAD_SHA: \$\{\{ steps\.upsert-pr\.outputs\.head_sha \}\}/);
  assert.match(merge, /GH_TOKEN: \$\{\{ steps\.bot-token\.outputs\.token \}\}/);
  assert.match(merge, /gh pr merge "\$PR_URL" .*--match-head-commit "\$HEAD_SHA"/);
});

test("a refresh that renews only the reporting-lock proof still opens a pull request", () => {
  const prepare = step("Commit refreshed locks locally");
  const files = prepare.match(/^          (read -ra files .+)$/m)?.[1];
  const check = prepare.match(/^          if (git diff --quiet HEAD -- [^;]+); then$/m)?.[1];
  assert.ok(check, "the preparation step must check for changes with git diff --quiet");
  assert.ok(files, "the preparation step must populate the managed file list");
  const added = prepare.match(/^          git add -- (.+)$/m)?.[1];
  assert.equal(check.replace("git diff --quiet HEAD -- ", ""), added, "the change check must cover every file in the initial refresh commit");

  const root = mkdtempSync(path.join(tmpdir(), "refresh-proof-only-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root });
    execFileSync("mkdir", ["-p", path.join(root, "tests/runner-e2e")]);
    const files = { "pnpm-lock.yaml": "lock\n", "tests/runner-e2e/report-lock.json": "{}\n", "tests/runner-e2e/report-lock.patch": "old\n" };
    for (const [file, contents] of Object.entries(files)) writeFileSync(path.join(root, file), contents);
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    const unchanged = () => spawnSync("bash", ["-c", `${files}\n${check}`], {
      cwd: root, env: { ...process.env, LOCKFILES: LOCKFILES.join(" "), REPORT_PROOF: REPORT_LOCK_FILES.join(" ") },
    }).status === 0;
    assert.equal(unchanged(), true);
    writeFileSync(path.join(root, "tests/runner-e2e/report-lock.json"), '{"outputSha256":"new"}\n');
    writeFileSync(path.join(root, "tests/runner-e2e/report-lock.patch"), "");
    assert.equal(unchanged(), false, "a proof-only change must not exit as unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the workflow owns the same lockfiles that the trust policy guards", () => {
  const env = workflow.match(/^  LOCKFILES: (.+)$/m)?.[1];
  assert.ok(env, "both jobs must share LOCKFILES");
  assert.deepEqual(env.trim().split(/\s+/), LOCKFILES);
  assert.match(step("Refresh sandbox provider lockfiles"),
    /pnpm --dir scripts\/typecheck-sandbox-providers install --resolution-only --ignore-scripts --no-frozen-lockfile/);
  assert.match(step("Refresh sandbox provider lockfiles"),
    /pnpm --dir packages\/plugins\/sandbox-providers\/daytona install --ignore-workspace --resolution-only --ignore-scripts --no-frozen-lockfile/);
  assert.ok(stepNames.indexOf("Refresh sandbox provider lockfiles") < stepNames.indexOf("Fail on unexpected file changes"));
  assert.match(step("Check release age of added package versions"), /read -ra locks <<< "\$LOCKFILES"[\s\S]*?pairs\+=\(--base "\$base\/\$lock" --head "\$lock"\)/);
});

// Run a workflow step's script with bash, as GitHub would.
const runStep = (name, cwd, env) => {
  const lines = step(name).split("\n");
  const start = lines.findIndex((line) => line === "        run: |") + 1;
  const script = lines.slice(start).map((line) => line.slice(10)).join("\n");
  return spawnSync("bash", ["-e", "-c", script], { cwd, encoding: "utf8", env: {
    ...process.env, LOCKFILES: LOCKFILES.join(" "), REPORT_PROOF: REPORT_LOCK_FILES.join(" "), ...env,
  } });
};

test("unexpected-change check admits every managed lockfile and nothing else", () => {
  const root = mkdtempSync(path.join(tmpdir(), "refresh-unexpected-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root });
    for (const file of [...LOCKFILES, "notes.md"]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), "old\n");
    }
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    for (const file of LOCKFILES) writeFileSync(path.join(root, file), "new\n");
    const allowed = runStep("Fail on unexpected file changes", root, {});
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    writeFileSync(path.join(root, "notes.md"), "new\n");
    const blocked = runStep("Fail on unexpected file changes", root, {});
    assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout, /notes\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a held refresh round-trips every managed lockfile", () => {
  const root = mkdtempSync(path.join(tmpdir(), "refresh-held-"));
  const temp = mkdtempSync(path.join(tmpdir(), "refresh-held-temp-"));
  try {
    for (const file of LOCKFILES) {
      for (const dir of [root, path.join(temp, "base-locks")]) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), `master ${file}\n`);
      }
      writeFileSync(path.join(root, file), `held ${file}\n`);
    }
    const staged = runStep("Stage held lockfile", root, { RUNNER_TEMP: temp });
    assert.equal(staged.status, 0, staged.stderr);
    const held = path.join(temp, "held-lock");
    execFileSync("mv", [path.join(temp, "held-upload"), held]);
    for (const file of LOCKFILES) assert.equal(readFileSync(path.join(held, file), "utf8"), `held ${file}\n`);

    // The next run checks the hashes against master's lockfiles, then copies the held ones in.
    for (const file of LOCKFILES) writeFileSync(path.join(root, file), `master ${file}\n`);
    const reuse = () => runStep("Reuse versions from a held refresh", root, { RUNNER_TEMP: temp });
    const accepted = reuse();
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    for (const file of LOCKFILES) assert.equal(readFileSync(path.join(root, file), "utf8"), `held ${file}\n`);
    for (const file of LOCKFILES) writeFileSync(path.join(root, file), `master ${file}\n`);
    writeFileSync(path.join(root, LOCKFILES[1]), "changed on master\n");
    const refused = reuse();
    assert.equal(refused.status, 0, refused.stdout + refused.stderr);
    assert.equal(readFileSync(path.join(root, LOCKFILES[0]), "utf8"), `master ${LOCKFILES[0]}\n`);
    assert.equal(readFileSync(path.join(root, LOCKFILES[1]), "utf8"), "changed on master\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

// The SDK public source proof pins the lock too. The bot merges without CI, so
// a refresh that left those pins stale turned master red (#20615).
test("the refresh commit resyncs and checks the SDK public source pins before pushing", () => {
  const prepare = step("Commit refreshed locks locally");
  const order = [
    'git commit -m "chore(lockfile): refresh pnpm lockfiles"',
    'node tests/runner-e2e/source-sdk-public-inputs.mjs "$(git rev-parse HEAD)" --write',
    'git add -- "$SDK_PROOF"',
    "git commit --amend --no-edit",
    'node tests/runner-e2e/source-sdk-public-inputs.mjs "$(git rev-parse HEAD)" --check',
    "echo 'changed=true' >> \"$GITHUB_OUTPUT\"",
  ].map((line) => prepare.indexOf(line));
  assert.ok(order.every((index) => index !== -1), `missing resync command: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "resync must follow the lock commit and precede the handoff");
  const publish = step("Commit artifact for publication");
  assert.match(publish, /--check\n\s+echo "head_sha=\$\(git rev-parse HEAD\)"/);
  const upsert = step("Create or update pull request");
  assert.ok(upsert.includes("REFRESH_HEAD: ${{ steps.commit-artifact.outputs.head_sha }}"));
  assert.match(upsert, /git checkout -B "\$BRANCH" "\$REFRESH_HEAD"\n\s+git push --force origin "\$BRANCH"/);
  assert.ok(workflow.indexOf(prepare) < workflow.indexOf(upsert), "resync must precede both publication paths");
});
