import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { packageInventory } from "../qualification-sdk-inventory.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function sharedPackageFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "qualification-sdk-layout-"));
  const actual = path.join(directory, "pnpm/resources/node_modules/@fixture/resources");
  const core = path.join(directory, "pnpm/core/node_modules/@fixture/core");
  const expected = path.join(directory, "npm/node_modules/@fixture/resources");
  const nestedCore = path.join(expected, "node_modules/@fixture/core");
  for (const [name, locations, dependencies] of [
    ["@fixture/resources", [actual, expected], { "@fixture/core": "1.0.0" }],
    ["@fixture/core", [core, nestedCore], { "@fixture/resources": "1.0.0" }],
  ]) {
    for (const location of locations) {
      mkdirSync(location, { recursive: true });
      writeFileSync(path.join(location, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies }));
      writeFileSync(path.join(location, "index.js"), "module.exports = {};\n");
      writeFileSync(path.join(location, "LICENSE"), "identical non-entrypoint bytes\n");
    }
  }
  symlinkSync(core, path.join(path.dirname(actual), "core"), "dir");
  symlinkSync(actual, path.join(path.dirname(core), "resources"), "dir");
  return { directory, actual, expected, core };
}

test("shared SDK inventories include cyclic resolved dependencies independently of npm nesting or pnpm links", () => {
  const fixture = sharedPackageFixture();
  try {
    const inventory = packageInventory(fixture.actual);
    assert.deepEqual(inventory, packageInventory(fixture.expected));
    assert.deepEqual(Object.keys(inventory.packages).sort(), ["@fixture/core@1.0.0", "@fixture/resources@1.0.0"]);
    assert.ok(inventory.packages["@fixture/core@1.0.0"].fileSha256.LICENSE);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

for (const mutation of [
  "changed dependency bytes",
  "missing dependency file",
  "extra dependency file",
  "missing dependency",
  "undeclared nested package",
]) {
  test(`shared SDK inventories reject ${mutation}`, () => {
    const fixture = sharedPackageFixture();
    try {
      if (mutation === "changed dependency bytes") writeFileSync(path.join(fixture.core, "LICENSE"), "changed\n");
      if (mutation === "missing dependency file") rmSync(path.join(fixture.core, "LICENSE"));
      if (mutation === "extra dependency file")
        writeFileSync(path.join(fixture.core, "extra.js"), "module.exports = 1;\n");
      if (mutation === "missing dependency") rmSync(path.join(path.dirname(fixture.actual), "core"));
      if (mutation === "undeclared nested package") {
        const foreign = path.join(fixture.actual, "node_modules/foreign");
        mkdirSync(foreign, { recursive: true });
        writeFileSync(path.join(foreign, "index.js"), "module.exports = 1;\n");
      }
      assert.throws(() => assert.deepEqual(packageInventory(fixture.actual), packageInventory(fixture.expected)));
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
}

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

test("SDK cleanup preserves borrowed API and resource utilities and rejects changed borrowed ownership", () => {
  for (const changedOwner of [false, true]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "qualification-sdk-borrowed-"));
    const checkout = path.join(directory, "checkout");
    const manifestPath = ".github/qualification/sdks/otel-sdk/package.json";
    mkdirSync(path.dirname(path.join(checkout, manifestPath)), { recursive: true });
    cpSync(path.join(root, manifestPath), path.join(checkout, manifestPath));
    const manifest = JSON.parse(readFileSync(path.join(root, manifestPath)));
    const names = [...Object.keys(manifest.dependencies), "@opentelemetry/api", "@opentelemetry/sdk-trace-base"];
    const sdk = path.join(directory, "sdk");
    const links = [], borrowedPackages = [];
    for (const name of names) {
      const link = path.join(checkout, "server/node_modules", name);
      const borrowed = ["@opentelemetry/api", "@opentelemetry/resources"].includes(name);
      const target = path.join(borrowed ? path.join(directory, "workspace-dependencies") : path.join(sdk, "node_modules"), name);
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(changedOwner && name === "@opentelemetry/resources" ? path.join(directory, "foreign-owner") : target, link, "dir");
      (borrowed ? borrowedPackages : links).push({ name, link, target });
    }
    const evidence = path.join(directory, "evidence");
    mkdirSync(evidence);
    writeFileSync(path.join(evidence, "sdk.json"), JSON.stringify({ profile: "otel-sdk", installArgs: ["ci", "--prefix", sdk], links, borrowedPackages }));
    const before = [...links, ...borrowedPackages].map(row => readlinkSync(row.link));
    const result = spawnSync(process.execPath, [path.join(root, ".github/scripts/cleanup-qualification-sdk.mjs"), evidence], {
      cwd: checkout, encoding: "utf8",
    });
    assert.equal(result.status, changedOwner ? 1 : 0, result.stdout + result.stderr);
    if (changedOwner) {
      assert.deepEqual([...links, ...borrowedPackages].map(row => readlinkSync(row.link)), before);
      assert.equal(existsSync(path.join(evidence, "sdk-cleanup.json")), false);
      continue;
    }
    for (const row of links) assert.throws(() => lstatSync(row.link), { code: "ENOENT" });
    for (const row of borrowedPackages) assert.equal(readlinkSync(row.link), row.target);
    const cleanup = JSON.parse(readFileSync(path.join(evidence, "sdk-cleanup.json")));
    assert.deepEqual(cleanup.borrowedPackagesPreserved, borrowedPackages);
    assert.equal(cleanup.producerAcceptanceQualified, false);
  }
});
