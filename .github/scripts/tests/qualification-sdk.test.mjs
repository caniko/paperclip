import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inventory } from "../qualification-sdk-inventory.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("SDK provisioning rejects a foreign runner or retry before creating any installation", t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "qualification-sdk-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [runner, attempt] of [["self-hosted", "1"], ["github-hosted", "2"]]) {
    const sdk = path.join(directory, `sdk-${runner}-${attempt}`);
    const result = spawnSync(process.execPath, [path.join(root, ".github/scripts/prepare-qualification-sdk.mjs"),
      "sentry-sdk", sdk, path.join(directory, "evidence")], {
      cwd: root, env: { ...process.env, RUNNER_ENVIRONMENT: runner, GITHUB_RUN_ATTEMPT: attempt }, encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(existsSync(sdk), false);
  }
});

test("Sentry SDK cleanup removes only the prepared link and preserves installed SDK bytes", t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "qualification-sdk-ownership-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, "checkout");
  const profile = "sentry-sdk";
  const manifestPath = path.join(".github/qualification/sdks", profile, "package.json");
  mkdirSync(path.dirname(path.join(checkout, manifestPath)), { recursive: true });
  cpSync(path.join(root, manifestPath), path.join(checkout, manifestPath));
  const sdk = path.join(directory, "sdk");
  const name = "@sentry/node";
  const link = path.join(checkout, "server/node_modules", name);
  const target = path.join(sdk, "node_modules", name);
  mkdirSync(path.dirname(link), { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "package.json"), JSON.stringify({ name }));
  const evidence = path.join(directory, "evidence");
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, "sdk.json"), JSON.stringify({
    profile, installArgs: ["ci", "--prefix", sdk], links: [{ name, link, target }], borrowedPackages: [],
  }));
  const run = () => spawnSync(process.execPath, [path.join(root, ".github/scripts/cleanup-qualification-sdk.mjs"), evidence], {
    cwd: checkout, encoding: "utf8",
  });
  const foreign = path.join(directory, "foreign-owner");
  symlinkSync(foreign, link, "dir");
  const blocked = run();
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.equal(readlinkSync(link), foreign);
  assert.equal(existsSync(path.join(evidence, "sdk-cleanup.json")), false);
  rmSync(link);
  symlinkSync(target, link, "dir");
  const before = inventory(sdk);
  assert.ok(before["node_modules/@sentry/node/package.json"]);
  const cleaned = run();
  assert.equal(cleaned.status, 0, cleaned.stdout + cleaned.stderr);
  assert.throws(() => lstatSync(link), { code: "ENOENT" });
  assert.deepEqual(inventory(sdk), before);
  assert.deepEqual(JSON.parse(readFileSync(path.join(evidence, "sdk-cleanup.json"))).ownedLinksRemoved, [link]);
});

test("profile retention requires one artifact per hosted matrix entry", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/qualification-environments.yml"), "utf8");
  const profiles = [...workflow.matchAll(/^          - profile: ([\w-]+)$/gm)].map(([, profile]) => profile);
  assert.equal(new Set(profiles).size, profiles.length);
  assert.equal(Number(workflow.match(/artifacts required-profile- (\d+) profile-retention\.json/)[1]), profiles.length);
});
