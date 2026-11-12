import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
else if (args[0] === "fetch") { writeFileSync(process.env.FETCH_STATE, args.slice(-2).join(" ")); process.exit(process.env.FETCH_FAILED === "true" || (process.env.REFRESH_FETCH_FAILED === "true" && args.at(-1) !== "master") || (process.env.FORK_FETCH_FAILED === "true" && args.at(-2) === "https://github.com/caniko/paperclip.git") || (process.env.UPSTREAM_REFRESH_MISSING === "true" && args.at(-2) === "https://github.com/paperclipai/paperclip.git" && args.at(-1) !== "master") ? 1 : 0); }
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
    { fork: true, upstreamRefreshMissing: true, succeeds: true },
    { refresh: true, upstreamRefreshMissing: true, manual: true },
    { fork: true, repository: "untrusted/paperclip" },
    { manual: true, repository: "paperclipai/paperclip" },
  ];
  for (const scenario of scenarios) {
    const { changed = true, manual = false, fetchFailed = false, resolveFailed = false,
      refresh = false, refreshFetchFailed = false, fork = false, forkFetchFailed = false, upstreamRefreshMissing = false,
      repository = "caniko/paperclip", succeeds = false } = scenario;
    // In the fork, a change no CI-owned import matches defers to CI's own resolution step.
    const deferred = changed && !resolveFailed && !succeeds && repository === "caniko/paperclip";
    const githubEnv = join(directory, "github-env");
    writeFileSync(githubEnv, "");
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FETCH_STATE: join(directory, "fetched-ref"), LOCK_CHANGED: String(changed), MANUAL_LOCK: String(manual), FETCH_FAILED: String(fetchFailed), RESOLVE_FAILED: String(resolveFailed), REFRESH_LOCK: String(refresh), REFRESH_FETCH_FAILED: String(refreshFetchFailed), FORK_REFRESH: String(fork), FORK_FETCH_FAILED: String(forkFetchFailed), UPSTREAM_REFRESH_MISSING: String(upstreamRefreshMissing), GITHUB_REPOSITORY: repository, GITHUB_ENV: githubEnv } });
    assert.equal(result.status === 0, succeeds || deferred, `${JSON.stringify(scenario)}: ${result.stdout} ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /Broken pipe/);
    assert.equal(readFileSync(githubEnv, "utf8").includes("PAPERCLIP_LOCK_FROM_CI_RESOLUTION=true"), deferred);
    if (manual && !succeeds && !deferred) assert.match(result.stdout, /Do not commit pnpm-lock.yaml/);
  }
});

test("fork lock changes pass only as CI's own importer-only resolution", t => {
  const workflow = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8");
  const step = workflow.split("      - name: Require the committed lock to equal CI's own resolution")[1].split("      - name:")[0];
  assert.match(step, /if: env\.PAPERCLIP_LOCK_FROM_CI_RESOLUTION == 'true'/);
  const script = step.split("        run: |\n")[1].replace(/^ {10}/gm, "")
    .replaceAll("${{ github.event.pull_request.base.sha }}", "base").replaceAll("${{ github.event.pull_request.head.sha }}", "head");
  const directory = mkdtempSync(join(tmpdir(), "pr-lock-resolution-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const lock = (importers, packages) => `lockfileVersion: '9.0'\n\nimporters:\n${importers}\npackages:\n${packages}\n`;
  const base = lock("  a: {}", "  ws@8.22.0: {}");
  const importerOnly = lock("  a:\n    dependencies:\n      ws:\n        specifier: ^8.22.0\n        version: 8.22.0", "  ws@8.22.0: {}");
  const addedPackage = lock("  a:\n    dependencies:\n      ws:\n        specifier: ^9.0.0\n        version: 9.0.0", "  ws@8.22.0: {}\n  ws@9.0.0: {}");
  // git serves the merge-base and head locks; checkout restores the merge-ref lock.
  writeFileSync(join(bin, "git"), `#!${process.execPath}
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "merge-base") console.log("m".repeat(40));
else if (args[0] === "cat-file") process.exit(args[2].endsWith(":pnpm-lock.yaml") ? 0 : 1);
else if (args[0] === "show" && args[1] === "${"m".repeat(40)}:pnpm-lock.yaml") process.stdout.write(process.env.BASE_LOCK);
else if (args[0] === "show" && args[1] === "head:pnpm-lock.yaml") process.stdout.write(process.env.HEAD_LOCK);
else if (args[0] === "worktree" && args[1] === "add") require("node:fs").mkdirSync(args[3], { recursive: true });
else if (args[0] === "worktree" && args[1] === "remove") require("node:fs").rmSync(args[3], { recursive: true, force: true });
else process.exit(2);
`, { mode: 0o700 });
  // pnpm writes the resolution it would produce, or fails.
  writeFileSync(join(bin, "pnpm"), `#!${process.execPath}
const { writeFileSync } = require("node:fs");
if (process.env.PNPM_FAILS === "true") process.exit(1);
writeFileSync("pnpm-lock.yaml", process.env.RESOLVED_LOCK);
`, { mode: 0o700 });
  const scenarios = [
    { name: "importer-only CI resolution", head: importerOnly, resolved: importerOnly, succeeds: true },
    // A carriage return or a link: reference is not what pnpm resolves from the manifests.
    { name: "hidden carriage return", head: importerOnly.replace("importers:", "importers:\r"), resolved: importerOnly },
    { name: "link reference", head: importerOnly.replace("version: 8.22.0", "version: link:./evil"), resolved: importerOnly },
    { name: "missing version", head: importerOnly.replace("version: 8.22.0", "version: 99.0.0"), resolved: importerOnly },
    { name: "added package", head: addedPackage, resolved: addedPackage },
    { name: "resolution failure", head: importerOnly, resolved: importerOnly, pnpmFails: true },
  ];
  for (const { name, head, resolved, succeeds = false, pnpmFails = false } of scenarios) {
    const cwd = mkdtempSync(join(directory, "checkout-"));
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "merge-ref lock");
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { cwd, encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BASE_LOCK: base, HEAD_LOCK: head, RESOLVED_LOCK: resolved,
        PNPM_FAILS: String(pnpmFails), RUNNER_TEMP: join(cwd, "runner-temp") } });
    assert.equal(result.status === 0, succeeds, `${name}: ${result.stdout} ${result.stderr}`);
    // The resolution happens in its own checkout; the PR checkout is never touched.
    assert.equal(readFileSync(join(cwd, "pnpm-lock.yaml"), "utf8"), "merge-ref lock", `${name}: checkout untouched`);
    assert.equal(existsSync(join(cwd, "runner-temp", "lock-resolution")), false, `${name}: resolution checkout removed`);
  }
});

test("CI's lock resolution uses real pnpm and ignores PR-controlled pnpm hooks", t => {
  // The policy job runs these tests after pnpm setup. Other jobs that run this file,
  // such as the trusted harness identity job, have no pnpm.
  if (spawnSync("pnpm", ["--version"]).status !== 0) {
    t.skip("pnpm is not installed");
    return;
  }
  const workflow = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8");
  const step = workflow.split("      - name: Require the committed lock to equal CI's own resolution")[1].split("      - name:")[0];
  const template = step.split("        run: |\n")[1].replace(/^ {10}/gm, "");
  const repo = mkdtempSync(join(tmpdir(), "pr-lock-real-pnpm-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "pr-lock-runner-temp-"));
  t.after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(runnerTemp, { recursive: true, force: true }); });
  // A disposable fixture repository, isolated from the host's git configuration and signing.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    npm_config_store_dir: join(repo, ".store"), XDG_CACHE_HOME: join(repo, ".cache"), RUNNER_TEMP: runnerTemp };
  const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, env, encoding: "utf8" }).trim();
  const write = (path, content) => { mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), content); };
  const resolve = (...flags) => execFileSync("pnpm", ["install", "--resolution-only", "--ignore-scripts", ...flags, "--no-frozen-lockfile"],
    { cwd: repo, env, stdio: "ignore" });
  const commit = message => { git("add", "-A"); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main");
  write(".gitignore", ".store\n.cache\n");
  write("package.json", '{"name":"fixture","private":true}\n');
  write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write("packages/a/package.json", '{"name":"a","version":"1.0.0"}\n');
  write("packages/b/package.json", '{"name":"b","version":"1.0.0"}\n');
  resolve();
  const base = commit("base");
  const dependent = '{"name":"a","version":"1.0.0","dependencies":{"b":"workspace:*"}}\n';
  // Like CI, run in a checkout of the merge of the target branch into the PR head.
  const run = (head, target = base) => {
    git("checkout", "-q", "--detach", head);
    git("merge", "-q", "--no-edit", target);
    const script = template.replaceAll("${{ github.event.pull_request.base.sha }}", target).replaceAll("${{ github.event.pull_request.head.sha }}", head);
    return spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { cwd: repo, env, encoding: "utf8", timeout: 60000 });
  };

  // A workspace dependency adds only importer entries, exactly as CI resolves them.
  write("packages/a/package.json", dependent);
  resolve();
  const legitimate = commit("importer-only dependency");
  const accepted = run(legitimate);
  assert.equal(accepted.status, 0, `${accepted.stdout} ${accepted.stderr}`);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(git("worktree", "list").split("\n").length, 1);

  // A base branch that moved its own dependencies after the merge base does not refuse it.
  git("checkout", "-q", base);
  write("packages/c/package.json", '{"name":"c","version":"1.0.0"}\n');
  write("packages/b/package.json", '{"name":"b","version":"1.0.0","dependencies":{"c":"workspace:*"}}\n');
  resolve();
  const movedBase = commit("base branch adds its own dependency");
  const behindBase = run(legitimate, movedBase);
  assert.equal(behindBase.status, 0, `${behindBase.stdout} ${behindBase.stderr}`);

  // The PR's .npmrc cannot move the lockfile or switch pnpm versions for CI's resolution,
  // and the PR checkout keeps its own configuration.
  git("checkout", "-q", legitimate);
  write(".npmrc", "lockfile-dir=nested\nmanage-package-manager-versions=true\n");
  const configured = commit("PR-controlled pnpm configuration");
  const isolated = run(configured);
  assert.equal(isolated.status, 0, `${isolated.stdout} ${isolated.stderr}`);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(readFileSync(join(repo, ".npmrc"), "utf8"), "lockfile-dir=nested\nmanage-package-manager-versions=true\n");

  // A PR-controlled hook writes an importer-only link into the committed lock and hides
  // its own checksum, so only ignoring the hook keeps CI's resolution independent.
  git("checkout", "-q", base);
  write("packages/a/package.json", dependent);
  write(".pnpmfile.cjs", `module.exports = { hooks: { afterAllResolved(lockfile) {
  const a = lockfile.importers["packages/a"];
  a.dependencies = { ...a.dependencies, evil: "link:../../evil" };
  a.specifiers = { ...a.specifiers, evil: "link:../../evil" };
  delete lockfile.pnpmfileChecksum;
  return lockfile;
} } };
`);
  resolve();
  assert.match(readFileSync(join(repo, "pnpm-lock.yaml"), "utf8"), /evil:/);
  const hooked = commit("hook-shaped lock");
  const refused = run(hooked);
  assert.equal(refused.status, 1, `${refused.stdout} ${refused.stderr}`);
  assert.match(refused.stdout, /differs from CI's resolution/);

  // A PR that widens the workspace commits the lock its own configuration produces;
  // CI resolves with the merge base's workspace configuration and refuses it.
  git("checkout", "-q", base);
  write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n  - "extra/*"\n');
  write("extra/x/package.json", '{"name":"x","version":"1.0.0"}\n');
  write("packages/a/package.json", '{"name":"a","version":"1.0.0","dependencies":{"x":"workspace:*"}}\n');
  resolve();
  const widened = commit("PR-controlled workspace configuration");
  const workspaceRefused = run(widened);
  assert.notEqual(workspaceRefused.status, 0, `${workspaceRefused.stdout} ${workspaceRefused.stderr}`);
  assert.equal(git("worktree", "list").split("\n").length, 1);
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
  assert.match(workflow, /node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=\.\/scripts\/qualification-node-junit-reporter\.mjs --test-reporter-destination="\$EVIDENCE\/policy\.xml"/);
  assert.ok(workflow.includes("'.github/scripts/tests/*.test.mjs'"), "Prepare every policy test, including dependency-backed profiles");
  const dependencies = workflow.indexOf("uses: ./.github/actions/setup-ci-dependencies");
  const tests = workflow.indexOf("      - name: Execute prepared policy and cache contracts once");
  assert.ok(dependencies >= 0 && dependencies < tests);
  assert.match(workflow, /version: 9\.15\.4\n\s+run_install: false/);
  assert.match(workflow, /qualification-evidence\.py seal "\$EVIDENCE" '\$\{\{ job\.status \}\}' --strict-reports/);
  assert.match(workflow, /qualification-evidence\.py artifacts prepared-lock-policy- 1 /);
  assert.equal(workflow.match(/retention-days: 32/g)?.length, 2);
  assert.match(workflow, /sha256sum "\$\(command -v node\)"/);
  assert.doesNotMatch(workflow, /continue-on-error|workflow_dispatch|workflow_call|\bneeds:|cancel-in-progress: true/);
});
