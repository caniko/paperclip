import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("SDK provisioning rejects a foreign runner or retry before creating any installation", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "qualification-sdk-guard-"));
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

test("SDK cleanup preserves every link if one entry changes ownership", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "qualification-sdk-ownership-"));
  const checkout = path.join(directory, "checkout");
  const profile = "otel-sdk";
  const manifestPath = path.join(".github/qualification/sdks", profile, "package.json");
  mkdirSync(path.dirname(path.join(checkout, manifestPath)), { recursive: true });
  cpSync(path.join(root, manifestPath), path.join(checkout, manifestPath));
  const manifest = JSON.parse(readFileSync(path.join(root, manifestPath)));
  const names = [...Object.keys(manifest.dependencies), "@opentelemetry/api", "@opentelemetry/sdk-trace-base"];
  const sdk = path.join(directory, "sdk");
  const links = names.map(name => {
    const link = path.join(checkout, "server/node_modules", name);
    const target = path.join(sdk, "node_modules", name);
    mkdirSync(path.dirname(link), { recursive: true });
    const owner = name === names.at(-1) ? path.join(directory, "foreign-owner") : target;
    symlinkSync(owner, link, "dir");
    return { name, link, target };
  });
  const evidence = path.join(directory, "evidence");
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, "sdk.json"), JSON.stringify({ profile, installArgs: ["ci", "--prefix", sdk], links, borrowedPackages: [] }));
  const before = links.map(row => readlinkSync(row.link));
  const result = spawnSync(process.execPath, [path.join(root, ".github/scripts/cleanup-qualification-sdk.mjs"), evidence], {
    cwd: checkout, encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(links.map(row => readlinkSync(row.link)), before);
  assert.equal(existsSync(path.join(evidence, "sdk-cleanup.json")), false);
});
