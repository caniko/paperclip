import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8");
const jobs = [...workflow.matchAll(/^  ([a-z_][a-z_0-9]*):\n([\s\S]*?)(?=^  [a-z_][a-z_0-9]*:\n|$(?![\s\S]))/gm)];
const installers = jobs.filter(([, , body]) => /\bpnpm install [^\r\n]*--frozen-lockfile\b/.test(body));
const cachedInstallers = installers.filter(([, job]) => job !== "native_composer_stop");

test("generated Nix concurrency isolates forks but coalesces the same source branch", () => {
  const nix = readFileSync(new URL("../../workflows/nix-builds.yaml", import.meta.url), "utf8");
  const group = nix.match(/^  group: (.+)$/m)?.[1];
  assert.ok(group);
  assert.match(nix, /^  cancel-in-progress: true$/m);
  const key = (repository, ref, pullRequest = false) => group.replace(/\$\{\{ (.*?) \}\}/g, (_, expression) => {
    const context = {
      "github.workflow": "Nix installable builds",
      "github.repository": repository,
      "github.ref_name": pullRequest ? "4/merge" : ref,
      "github.event.pull_request.head.repo.full_name": pullRequest ? repository : "",
      "github.event.pull_request.head.ref": pullRequest ? ref : "",
    };
    const operands = expression.split(" || ");
    for (const operand of operands) assert.ok(Object.hasOwn(context, operand), operand);
    return operands.map((operand) => context[operand]).find(Boolean);
  });
  assert.notEqual(key("alice/paperclip", "fix", true), key("bob/paperclip", "fix", true));
  assert.notEqual(key("alice/paperclip", "fix", true), key("alice/paperclip", "other", true));
  assert.equal(key("alice/paperclip", "fix", true), key("alice/paperclip", "fix"));
});

test("PR workflows restore dependency stores without creating branch copies", () => {
  assert.equal(installers.length, 8);
  assert.equal(cachedInstallers.length, 7);
  assert.doesNotMatch(workflow, /^ +cache: pnpm$/m);
  assert.doesNotMatch(workflow, /uses: actions\/cache(?:@|\/save@)/);
  for (const [, job, body] of jobs) {
    for (const step of body.split("      - name:").filter((step) => step.includes("uses: actions/setup-node@"))) {
      assert.match(step, /package-manager-cache: false/, job);
    }
  }
  const policy = jobs.find(([, name]) => name === "policy")[2];
  assert.doesNotMatch(policy, /uses: actions\/cache|cache: pnpm/);
});

test("native composer: immutable frozen tools and candidate installation do not share a host cache", () => {
  const native = installers.find(([, job]) => job === "native_composer_stop");
  assert.ok(native, "the filtered immutable-harness install is an installer too");
  const body = native[2];
  const harness = body.split("      - name: Install immutable browser harness dependencies")[1]?.split("      - name:")[0];
  assert.ok(harness);
  assert.match(harness, /working-directory: \.trusted-composer-stop/);
  assert.match(harness, /run: pnpm install --filter paperclip --frozen-lockfile --ignore-scripts/);
  assert.doesNotMatch(body, /uses: actions\/cache|cache: pnpm/);
  const candidate = body.split("      - name: Install dependencies")[1]?.split("      - name:")[0];
  assert.ok(candidate);
  assert.match(candidate, /node \.trusted-composer-stop\/scripts\/composer-candidate-stage\.mjs install "\$COMPOSER_STOP_CANDIDATE_ROOT"/);
  assert.doesNotMatch(candidate, /\bpnpm install\b/);
});

for (const [, job, body] of cachedInstallers) {
  test(`${job}: reuse master keys before installing with an inline stale-lockfile fallback`, () => {
    const locate = body.indexOf("      - name: Locate pnpm store");
    const restore = body.indexOf("      - name: Restore pnpm store (read only)");
    const install = body.indexOf("      - name: Install dependencies");
    assert.ok(locate >= 0 && locate < restore && restore < install);
    const cache = body.slice(restore, install);
    assert.match(body.slice(locate, restore), /pnpm store path --silent/);
    assert.match(body.slice(locate, restore), /node -p 'process.arch'/);
    assert.match(cache, /uses: actions\/cache\/restore@[a-f0-9]{40}/);
    assert.ok(cache.includes("key: node-cache-${{ runner.os }}-${{ steps.pnpm_store.outputs.arch }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}"));
    assert.ok(cache.includes("restore-keys: node-cache-${{ runner.os }}-${{ steps.pnpm_store.outputs.arch }}-pnpm-"));
    // Lanes must not wait on the policy job for a regenerated lockfile; each
    // install resolves a stale one inline and then re-validates frozen.
    const installStep = body.slice(install).split("      - name:")[1] ?? body.slice(install);
    assert.match(installStep, /if ! pnpm install --frozen-lockfile; then/);
    assert.match(installStep, /pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile/);
    assert.doesNotMatch(installStep, /needs\.policy/);
  });
}
