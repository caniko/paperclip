import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCKFILES, REPORT_LOCK_FILES } from "../lockfile-trust.mjs";

const policySource = fileURLToPath(new URL("../lockfile-trust.mjs", import.meta.url));
const workflowPath = ".github/workflows/refresh-lockfile.yml";
const policyScript = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8")
  .split("      - name: Block untrusted lockfile edits")[1].split("      - name:")[0]
  .split("        run: |\n")[1].replace(/^ {10}/gm, "");

test("lock policy consumes large diffs and accepts only unchanged upstream master imports", t => {
  const directory = mkdtempSync(join(tmpdir(), "pr-lock-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const oldBotPolicy = join(directory, "old-bot-policy.mjs");
  writeFileSync(oldBotPolicy, `import { appendFileSync } from "node:fs";
appendFileSync(process.env.GITHUB_OUTPUT, "writer=refresh-bot\\n");`);
  writeFileSync(join(directory, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(directory, "git"), `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "show") process.stdout.write(readFileSync(process.env.POLICY_SOURCE));
else if (args[0] === "diff" && args.includes("--name-only")) {
  const locks = (process.env.LOCK_CHANGED === "true" ? "pnpm-lock.yaml\\n" : "") + process.env.EXTRA_LOCK;
  console.log(locks + (args.includes("--") ? "" : Array.from({length:10000},(_,i)=>"changed/"+i).join("\\n")));
}
else if (args[0] === "diff" && args[1] === "--quiet") {
  const imported = process.env.IMPORT_FROM;
  const fetched = readFileSync(process.env.FETCH_STATE, "utf8").trim().split("\\n").at(-1);
  process.exit(imported === fetched ? 0 : 1);
}
else if (args[0] === "fetch") {
  appendFileSync(process.env.FETCH_STATE, args.slice(-2).join(" ") + "\\n");
  process.exit(process.env.FETCH_FAILED === "true" ? 1 : 0);
}
else if (args[0] === "merge-base") console.log("a".repeat(40));
else if (args[0] === "cat-file" && args[1] === "-e" && args[2] === "head:pnpm-lock.yaml") process.exit(0);
else if (args[0] === "rev-parse") {
  if (args.at(-1) !== "FETCH_HEAD") process.exit(1);
  console.log("b".repeat(40));
}
else process.exit(2);
`, { mode: 0o700 });
  const scenarios = [
    { changed: false, succeeds: true },
    { succeeds: true },
    { imported: "" },
    { fetchFailed: true },
    { imported: "https://github.com/paperclipai/paperclip.git refs/heads/chore/refresh-lockfile", extra: REPORT_LOCK_FILES[0] },
    { imported: "https://github.com/caniko/paperclip.git refs/heads/chore/refresh-lockfile", extra: REPORT_LOCK_FILES[1] },
    { repository: "untrusted/paperclip" },
    { repository: "paperclipai/paperclip" },
    { imported: "", extra: LOCKFILES[1] },
    { imported: "", extra: REPORT_LOCK_FILES[1] },
    { author: "dependabot[bot]", extra: "tests/runner-e2e/report-lock.patch" },
    { ref: "chore/refresh-lockfile" },
    { ref: "chore/refresh-lockfile", author: "github-actions[bot]", policy: oldBotPolicy },
  ];
  for (const scenario of scenarios) {
    const { changed = true, imported = "https://github.com/paperclipai/paperclip.git master", fetchFailed = false,
      repository = "caniko/paperclip", succeeds = false, extra = "", author = "contributor", ref = "feature", policy = policySource } = scenario;
    // In the fork, a change no CI-owned import matches defers to CI's own resolution step.
    const deferred = changed && !extra && !succeeds && repository === "caniko/paperclip" && ref === "feature";
    const githubEnv = join(directory, "github-env");
    const githubOutput = join(directory, "github-output");
    const fetchState = join(directory, "fetched-ref");
    writeFileSync(githubEnv, "");
    writeFileSync(githubOutput, "");
    writeFileSync(fetchState, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", policyScript], { cwd: directory, encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FETCH_STATE: fetchState,
        LOCK_CHANGED: String(changed), EXTRA_LOCK: extra ? `${extra}\n` : "", IMPORT_FROM: imported,
         FETCH_FAILED: String(fetchFailed), POLICY_SOURCE: policy,
        BASE_SHA: "base", HEAD_SHA: "head", PR_AUTHOR: author, HEAD_REPO: repository, HEAD_REF: ref, PR_NUMBER: "1",
        GITHUB_SHA: "merge", RUNNER_TEMP: directory, GITHUB_REPOSITORY: repository, GITHUB_ENV: githubEnv, GITHUB_OUTPUT: githubOutput } });
    assert.equal(result.status === 0, succeeds || deferred, `${JSON.stringify(scenario)}: ${result.stdout} ${result.stderr}`);
    assert.doesNotMatch(readFileSync(fetchState, "utf8"), /refs\/heads\/chore\/refresh-lockfile/);
    assert.doesNotMatch(result.stderr, /Broken pipe/);
    assert.equal(readFileSync(githubEnv, "utf8").includes("PAPERCLIP_LOCK_FROM_CI_RESOLUTION=true"), deferred);
    assert.equal(readFileSync(githubOutput, "utf8"), succeeds || deferred ? "writer=none\n" : "");
    if (policy === oldBotPolicy) assert.match(result.stdout, /Only upstream may publish lockfile bot PRs/);
    if (!imported && !succeeds && !deferred) assert.match(result.stdout, /Do not commit pnpm-lock.yaml/);
  }
});

test("the fork accepts only an authenticated ancestor's exact prepared lock artifact", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pr-prepared-lock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  const bin = join(directory, "bin");
  const runnerTemp = join(directory, "runner");
  for (const path of [repo, bin, runnerTemp]) mkdirSync(path);
  const config = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...args) => execFileSync("git", args, { cwd: repo, env: config, encoding: "utf8" }).trim();
  const write = (root, file, bytes) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), bytes);
  };
  const commit = message => {
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const lockPaths = [...LOCKFILES, ...REPORT_LOCK_FILES, "tests/runner-e2e/source-sdk-public-inputs.json"];
  const fork = "caniko/paperclip";
  git("init", "-q", "-b", "master");
  git("config", "diff.renames", "true");
  write(repo, workflowPath, readFileSync(new URL("../../workflows/refresh-lockfile.yml", import.meta.url)));
  write(repo, ".github/scripts/lockfile-trust.mjs", readFileSync(policySource));
  for (const file of lockPaths) write(repo, file, `base ${file}\n`);
  const base = commit("trusted base");
  const upstream = join(directory, "upstream.git");
  git("clone", "-q", "--bare", repo, upstream);
  git("config", `url.${upstream}.insteadOf`, "https://github.com/paperclipai/paperclip.git");
  git("config", `url.${repo}.insteadOf`, "https://github.com/caniko/paperclip.git");

  const prepare = (name, setup = () => {}) => {
    git("checkout", "-q", "--detach", base);
    write(repo, "feature.txt", name);
    setup();
    const source = commit(name);
    for (const file of lockPaths) write(repo, file, `resolved ${file}\n`);
    return { source, head: commit(`${name} locks`) };
  };
  const valid = prepare("valid");
  const unrelated = prepare("unrelated");
  const doctored = prepare("changed workflow", () => write(repo, workflowPath, "# changed\n"));
  const tainted = prepare("edited input", () => write(repo, LOCKFILES[1], "not CI-owned\n"));
  const changedHelper = prepare("changed helper", () => write(repo, "tests/runner-e2e/prepare-report-lock.mjs", "// changed\n"));
  const changedConfig = prepare("changed config", () => write(repo, ".npmrc", "lockfile-dir=nested\n"));
  git("checkout", "-q", "--detach", base);
  write(repo, workflowPath, "# fork base workflow differs from upstream\n");
  write(repo, LOCKFILES[1], "fork base lock differs from upstream\n");
  const forkBase = commit("fork base advanced independently");
  git("checkout", "-q", "--detach", valid.head);
  git("rm", "-q", "--", LOCKFILES[1]);
  const withDeletion = commit("head omits provider lock");
  git("checkout", "-q", "--detach", base);
  git("mv", LOCKFILES[0], "other.yaml");
  const withRename = commit("head renames root lock");
  const artifact = join(directory, "artifact");
  for (const file of lockPaths) write(artifact, file, `resolved ${file}\n`);
  const gitLog = join(directory, "git.log");
  writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$1" = fetch ]; then
  printf '%s\\n' "$*" >> "$GIT_LOG"
  [ "$FETCH_FAILS" = false ] || exit 1
fi
exec "$REAL_GIT" "$@"
`, { mode: 0o700 });
  writeFileSync(join(bin, "gh"), `#!/bin/sh
set -eu
case "$1 $2" in
  "api repos/$GITHUB_REPOSITORY/actions/workflows/refresh-lockfile.yml/runs?event=workflow_dispatch&status=success&per_page=100")
    printf 'api\\n' >> "$GH_LOG"
    cat "$RUNS"
    [ "$API_FAILS" = false ];;
  "run download")
    printf 'download\\n' >> "$GH_LOG"
    # If policy leaves the loop's stdin connected, consume the remaining run rows.
    cat > /dev/null
    [ "$3" = 47 ] && [ "$4" = --repo ] && [ "$5" = "$GITHUB_REPOSITORY" ] &&
      [ "$6" = --name ] && [ "$7" = "prepared-lock-$ARTIFACT_SOURCE-47-2" ] && [ "$8" = --dir ] || exit 1
    case "$9" in "$RUNNER_TEMP"/*) ;; *) exit 1;; esac
    [ -z "$(ls -A "$9")" ] && [ "$DOWNLOAD_FAILS" = false ]
    cp -R "$ARTIFACT/." "$9/";;
  *) exit 99;;
esac
`, { mode: 0o700 });
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const run = { id: 47, run_attempt: 2, head_sha: valid.source, event: "workflow_dispatch",
    conclusion: "success", head_repository: { full_name: fork }, path: workflowPath };
  const cases = [
    { name: "valid prepared locks", pass: true },
    { name: "valid when only upstream vouches for the workflow and inputs", target: forkBase, pass: true },
    { name: "valid against trusted base when upstream is unavailable", fetchFails: true, pass: true },
    { name: "clobbered refresh branch does not matter", branch: unrelated.head, pass: true },
    { name: "matching mutable refresh branch is not proof", branch: valid.head, rows: [] },
    { name: "skip a missing artifact without losing the next API row", rows: [{ ...run, id: 46 }, run], pass: true },
    ...["push", "pull_request"].map(event => ({ name: `reject event ${event}`, rows: [{ ...run, event }] })),
    ...["failure", "cancelled"].map(conclusion => ({ name: `reject conclusion ${conclusion}`, rows: [{ ...run, conclusion }] })),
    { name: "wrong head repository", rows: [{ ...run, head_repository: { full_name: "other/paperclip" } }] },
    { name: "wrong workflow", rows: [{ ...run, path: ".github/workflows/other.yml" }] },
    { name: "source is not an ancestor", rows: [{ ...run, head_sha: unrelated.source }], source: unrelated.source },
    { name: "source workflow was changed", ...doctored, rows: [{ ...run, head_sha: doctored.source }] },
    { name: "source lock was hand-edited", ...tainted, rows: [{ ...run, head_sha: tainted.source }] },
    { name: "source helper was changed", ...changedHelper, rows: [{ ...run, head_sha: changedHelper.source }] },
    { name: "source pnpm config was changed", ...changedConfig, rows: [{ ...run, head_sha: changedConfig.source }] },
    { name: "download error", downloadFails: true },
    { name: "one byte differs in the root lock", mismatch: LOCKFILES[0] },
    { name: "one byte differs in the report patch", mismatch: REPORT_LOCK_FILES[1] },
    { name: "missing proof file", missing: lockPaths[5] },
    { name: "a file absent at head is rejected even with a complete artifact", head: withDeletion },
    { name: "a file absent from both the head and the artifact is rejected", head: withDeletion, missing: LOCKFILES[1] },
    { name: "a symlink to matching bytes is not a regular artifact file", link: LOCKFILES[1] },
    { name: "a renamed-away root lock is rejected", head: withRename },
    { name: "API error with valid-looking stdout", apiFails: true },
    { name: "canonical repository does not consult artifacts", repository: "paperclipai/paperclip" },
    { name: "reserved refresh head cannot use artifacts", ref: "chore/refresh-lockfile" },
    { name: "fork bot cannot use the reserved refresh head", ref: "chore/refresh-lockfile", author: "github-actions[bot]" },
    { name: "Dependabot cannot use artifacts", author: "dependabot[bot]" },
  ];
  for (const { name, pass = false, branch, rows = [run], source = valid.source, head = valid.head, target = base,
    downloadFails = false, apiFails = false, fetchFails = false,
    mismatch, missing, link, repository = fork, ref = "feature", author = "contributor" } of cases) {
    await t.test(name, () => {
      if (branch) {
        git("update-ref", "refs/heads/chore/refresh-lockfile", branch);
        git("update-ref", "refs/remotes/origin/chore/refresh-lockfile", branch);
      }
      const githubEnv = join(directory, "github-env");
      const githubOutput = join(directory, "github-output");
      const runs = join(directory, "runs.json");
      const ghLog = join(directory, "gh.log");
      for (const file of [githubEnv, githubOutput, gitLog, ghLog]) writeFileSync(file, "");
      writeFileSync(runs, JSON.stringify({ workflow_runs: rows }));
      if (mismatch) write(artifact, mismatch, `Resolved ${mismatch}\n`);
      if (missing) rmSync(join(artifact, missing));
      if (link) {
        write(artifact, "matching-bytes", `resolved ${link}\n`);
        rmSync(join(artifact, link));
        symlinkSync(join(artifact, "matching-bytes"), join(artifact, link));
      }
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", policyScript], { cwd: repo, encoding: "utf8", timeout: 10000,
        env: { ...config, PATH: `${bin}:${config.PATH}`, REAL_GIT: realGit, GIT_LOG: gitLog, GH_LOG: ghLog, RUNS: runs,
          ARTIFACT: artifact, ARTIFACT_SOURCE: source, DOWNLOAD_FAILS: String(downloadFails), API_FAILS: String(apiFails),
          FETCH_FAILS: String(fetchFails), BASE_SHA: target, HEAD_SHA: head, PR_AUTHOR: author, HEAD_REPO: repository, HEAD_REF: ref, PR_NUMBER: "1",
          GITHUB_SHA: head, RUNNER_TEMP: runnerTemp, GITHUB_REPOSITORY: repository, GITHUB_ENV: githubEnv, GITHUB_OUTPUT: githubOutput } });
      if (link) rmSync(join(artifact, link));
      for (const file of [mismatch, missing, link].filter(Boolean)) write(artifact, file, `resolved ${file}\n`);
      assert.equal(result.status, pass ? 0 : 1, `${result.stdout}\n${result.stderr}`);
      assert.equal(readFileSync(githubOutput, "utf8"), pass ? "writer=none\n" : "");
      assert.equal(readFileSync(githubEnv, "utf8"), "", "proof must not defer to CI resolution");
      assert.doesNotMatch(readFileSync(gitLog, "utf8"), /refs\/heads\/chore\/refresh-lockfile/);
      const ghCalls = readFileSync(ghLog, "utf8");
      if (pass) assert.match(ghCalls, /download/);
      if (repository !== fork || ref !== "feature" || author !== "contributor") assert.equal(ghCalls, "");
    });
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
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], { cwd, encoding: "utf8", timeout: 10000,
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
  // Like this repository, the fixture root declares pnpm overrides; CI's resolution must keep them.
  write("package.json", '{"name":"fixture","private":true,"pnpm":{"overrides":{"left-pad":"1.3.0"}}}\n');
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
    return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], { cwd: repo, env, encoding: "utf8", timeout: 60000 });
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
