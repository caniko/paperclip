import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("lock policy consumes large diffs and accepts only unchanged approved CI imports", t => {
  const workflow = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8");
  const step = workflow.split("      - name: Block manual lockfile edits")[1].split("      - name:")[0];
  const script = step.split("        run: |\n")[1].replace(/^ {10}/gm, "")
    .replaceAll("${{ github.event.pull_request.base.sha }}", "base").replaceAll("${{ github.event.pull_request.head.sha }}", "head");
  const directory = mkdtempSync(join(tmpdir(), "pr-lock-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "git"), `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "diff" && args[1] === "--name-only") console.log((process.env.LOCK_CHANGED === "true" ? "pnpm-lock.yaml\\n" : "") + Array.from({length:50000},(_,i)=>"changed/"+i).join("\\n"));
else if (args[0] === "fetch") { writeFileSync(process.env.FETCH_STATE, args.slice(-2).join(" ")); process.exit(process.env.FETCH_FAILED === "true" || (process.env.REFRESH_FETCH_FAILED === "true" && args.at(-1) !== "master") || (process.env.FORK_FETCH_FAILED === "true" && args.at(-2) === "https://github.com/caniko/paperclip.git") ? 1 : 0); }
else if (args[0] === "merge-base") console.log("a".repeat(40));
else if (args[0] === "rev-parse") { if (process.env.RESOLVE_FAILED === "true") process.exit(1); const fetched = args[1].startsWith("head:") ? "" : readFileSync(process.env.FETCH_STATE, "utf8"); console.log(args[1].startsWith("head:") ? (process.env.MANUAL_LOCK === "true" ? "c" : "b").repeat(40) : ((process.env.REFRESH_LOCK === "true" && fetched.endsWith(" master")) || (process.env.FORK_REFRESH === "true" && !fetched.startsWith("https://github.com/caniko/paperclip.git ")) ? "d" : "b").repeat(40)); }
else process.exit(2);
`, { mode: 0o700 });
  const scenarios = [
    { changed: false, succeeds: true },
    { succeeds: true },
    { manual: true },
    { fetchFailed: true },
    { resolveFailed: true },
    { refresh: true, succeeds: true },
    { refresh: true, manual: true },
    { refresh: true, refreshFetchFailed: true },
    { fork: true, succeeds: true },
    { fork: true, manual: true },
    { fork: true, forkFetchFailed: true },
    { fork: true, repository: "untrusted/paperclip" },
  ];
  for (const scenario of scenarios) {
    const { changed = true, manual = false, fetchFailed = false, resolveFailed = false,
      refresh = false, refreshFetchFailed = false, fork = false, forkFetchFailed = false,
      repository = "caniko/paperclip", succeeds = false } = scenario;
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FETCH_STATE: join(directory, "fetched-ref"), LOCK_CHANGED: String(changed), MANUAL_LOCK: String(manual), FETCH_FAILED: String(fetchFailed), RESOLVE_FAILED: String(resolveFailed), REFRESH_LOCK: String(refresh), REFRESH_FETCH_FAILED: String(refreshFetchFailed), FORK_REFRESH: String(fork), FORK_FETCH_FAILED: String(forkFetchFailed), GITHUB_REPOSITORY: repository } });
    assert.equal(result.status === 0, succeeds, `${JSON.stringify(scenario)}: ${result.stdout} ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /Broken pipe/);
    if (manual) assert.match(result.stdout, /Do not commit pnpm-lock.yaml/);
  }
});

test("feature-branch lock refresh publishes non-force without opening or merging another PR", t => {
  const workflow = readFileSync(new URL("../../workflows/refresh-lockfile.yml", import.meta.url), "utf8");
  const step = workflow.split("      - name: Create or update pull request")[1].split("      - name:")[0];
  const script = step.split("        run: |\n")[1].replace(/^ {10}/gm, "");
  const directory = mkdtempSync(join(tmpdir(), "pr-lock-refresh-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "git.log");
  writeFileSync(join(directory, "git"), `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.GIT_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "diff") process.exit(1);
if (args.includes("--force")) process.exit(22);
`, { mode: 0o700 });
  writeFileSync(join(directory, "gh"), `#!${process.execPath}\nprocess.exit(23);\n`, { mode: 0o700 });
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { encoding: "utf8", timeout: 10000,
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GIT_LOG: log,
      GITHUB_OUTPUT: join(directory, "output"), SOURCE_REF: "refs/heads/feature", REPO_OWNER: "caniko" } });
  assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
  const commands = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(commands.filter(args => args[0] === "push"), [["push", "origin", "chore/refresh-lockfile"]]);
  assert.equal(readFileSync(join(directory, "output"), "utf8"), "pr_url=\n");
});

test("prepared lock policy has an independent exact-head attempt-1 hosted gate before caller promotion", () => {
  const workflow = readFileSync(new URL("../../workflows/qualification-lock-policy.yml", import.meta.url), "utf8");
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /qualification-evidence\.py initialize "\$EVIDENCE"/);
  assert.match(workflow, /node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination="\$EVIDENCE\/policy\.xml"/);
  for (const name of ["pr-lockfile-policy", "pr-dependency-cache", "pr-runner-rust-cache"]) {
    assert.ok(workflow.includes(`.github/scripts/tests/${name}.test.mjs`), name);
  }
  assert.match(workflow, /qualification-evidence\.py seal "\$EVIDENCE" '\$\{\{ job\.status \}\}' --strict-reports/);
  assert.match(workflow, /qualification-evidence\.py artifacts prepared-lock-policy- 1 /);
  assert.equal(workflow.match(/retention-days: 32/g)?.length, 2);
  assert.match(workflow, /sha256sum "\$\(command -v node\)"/);
  assert.doesNotMatch(workflow, /continue-on-error|workflow_dispatch|workflow_call|\bneeds:|cancel-in-progress: true/);
});
