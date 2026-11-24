#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./qualification-roster.mjs";
import { inventory } from "./qualification-sdk-inventory.mjs";

const args = process.argv.slice(2);
const diagnostic = args[0] === "--diagnostic";
assert.equal(args.length, diagnostic ? 4 : 3, "Pass profile, fresh external SDK directory and evidence directory");
const [profile, destination, output] = args.slice(diagnostic ? 1 : 0);
assert.equal(profile, "sentry-sdk");
assert.equal(process.platform, "linux");
if (!diagnostic) {
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1");
}
const root = process.cwd();
const sdk = path.resolve(destination);
const evidence = path.resolve(output);
assert.ok(!sdk.startsWith(root + path.sep) && sdk !== root, "SDK install must be outside the source checkout");
assert.ok(!existsSync(sdk), "SDK directory already exists; preserve original install evidence");
const declared = path.join(root, ".github/qualification/sdks", profile);
const manifest = JSON.parse(readFileSync(path.join(declared, "package.json")));
const lock = JSON.parse(readFileSync(path.join(declared, "package-lock.json")));
const serverPeers = JSON.parse(readFileSync(path.join(root, "server/package.json"))).peerDependencies;
assert.ok(serverPeers["@sentry/node"]);
const expected = { "@sentry/node": serverPeers["@sentry/node"] };
assert.deepEqual(manifest.dependencies, expected, "SDK versions must exactly match the declared server peers");
assert.equal(lock.lockfileVersion, 3);
assert.deepEqual(lock.packages[""].dependencies, expected);
for (const [name, entry] of Object.entries(lock.packages)) {
  if (!name) continue;
  assert.ok(!entry.link && /^https:\/\/registry\.npmjs\.org\//.test(entry.resolved), "SDK lock must use integrity-bound registry packages");
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
}
mkdirSync(sdk);
cpSync(path.join(declared, "package.json"), path.join(sdk, "package.json"));
cpSync(path.join(declared, "package-lock.json"), path.join(sdk, "package-lock.json"));
const installArgs = ["ci", "--prefix", sdk, "--ignore-scripts", "--no-audit", "--no-fund"];
// npm ci verifies the committed complete lock and refuses to repair its resolution.
// https://docs.npmjs.com/cli/v11/commands/npm-ci
execFileSync("npm", installArgs, { stdio: "inherit", timeout: 120_000 });
assert.equal(sha256(readFileSync(path.join(sdk, "package-lock.json"))), sha256(readFileSync(path.join(declared, "package-lock.json"))));
const names = Object.keys(expected);
const links = [];
// Validate all destinations before linking any package into the disposable checkout.
for (const name of names) {
  const link = path.join(root, "server/node_modules", name);
  assert.ok(!existsSync(link), `Preserve an existing SDK entry: ${name}`);
  assert.throws(() => lstatSync(link), { code: "ENOENT" });
}
for (const name of names) {
  const target = path.join(sdk, "node_modules", name);
  const installed = JSON.parse(readFileSync(path.join(target, "package.json")));
  assert.equal(installed.name, name);
  assert.equal(installed.version, expected[name]);
  const link = path.join(root, "server/node_modules", name);
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(target, link, "dir");
  const require = createRequire(path.join(root, "server/package.json"));
  assert.ok(realpathSync(require.resolve(name)).startsWith(realpathSync(target) + path.sep), "Test resolver bypassed the declared SDK");
  links.push({ name, link, target, version: installed.version, packageSha256: sha256(readFileSync(path.join(target, "package.json"))) });
}
const files = inventory(path.join(sdk, "node_modules"), sdk);
const receipt = { schema: "paperclip.qualification-sdk.v1", profile, diagnostic, producerAcceptanceQualified: false,
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  helperSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  manifestSha256: sha256(readFileSync(path.join(declared, "package.json"))),
  sdkLockSha256: sha256(readFileSync(path.join(declared, "package-lock.json"))),
  workspaceLockSha256: sha256(readFileSync(path.join(root, "pnpm-lock.yaml"))),
  installArgs, lifecycleScriptsExecuted: false, links, borrowedPackages: [], installedFileSha256: files };
mkdirSync(evidence, { recursive: true });
writeFileSync(path.join(evidence, "sdk.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
for (const name of ["package.json", "package-lock.json"]) cpSync(path.join(declared, name), path.join(evidence, `sdk-${name}`), { errorOnExist: true, force: false });
console.log(JSON.stringify({ profile, sdkLockSha256: receipt.sdkLockSha256, installedFiles: Object.keys(files).length,
  lifecycleScriptsExecuted: false, producerAcceptanceQualified: false }));
