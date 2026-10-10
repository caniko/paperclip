#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./qualification-roster.mjs";

const args = process.argv.slice(2);
const diagnostic = args[0] === "--diagnostic";
assert.equal(args.length, diagnostic ? 4 : 3, "Pass profile, fresh external SDK directory and evidence directory");
const [profile, destination, output] = args.slice(diagnostic ? 1 : 0);
assert.ok(["otel-sdk", "sentry-sdk"].includes(profile));
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
const expected = Object.fromEntries(Object.entries(serverPeers).filter(([name]) => profile === "sentry-sdk"
  ? name === "@sentry/node" : name.startsWith("@opentelemetry/")));
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
const names = [...Object.keys(expected), ...(profile === "otel-sdk" ? ["@opentelemetry/api", "@opentelemetry/sdk-trace-base"] : [])];
const links = [];
const borrowedPackages = [];
const serverRequire = createRequire(path.join(root, "server/package.json"));
// Validate all destinations before linking any package into the disposable checkout.
for (const name of names) {
  const link = path.join(root, "server/node_modules", name);
  if (name === "@opentelemetry/api" && existsSync(link)) {
    // The API is already a workspace dependency. Borrow only byte-identical
    // files from the separately locked SDK version.
    const actual = realpathSync(link);
    const target = path.join(sdk, "node_modules", name);
    assert.equal(sha256(readFileSync(path.join(actual, "package.json"))), sha256(readFileSync(path.join(target, "package.json"))));
    const sdkRequire = createRequire(path.join(sdk, "package.json"));
    assert.equal(sha256(readFileSync(serverRequire.resolve(name))), sha256(readFileSync(sdkRequire.resolve(name))));
    const borrowedFiles = inventory(actual);
    assert.deepEqual(borrowedFiles, inventory(target), "Existing API files differ from the locked SDK");
    borrowedPackages.push({ name, link, target: readlinkSync(link), resolvedPackage: actual,
      packageSha256: sha256(readFileSync(path.join(actual, "package.json"))), fileSha256: borrowedFiles });
    continue;
  }
  assert.ok(!existsSync(link), `Preserve an existing SDK entry: ${name}`);
  assert.throws(() => lstatSync(link), { code: "ENOENT" });
}
for (const name of names) {
  if (borrowedPackages.some(row => row.name === name)) continue;
  const target = path.join(sdk, "node_modules", name);
  const installed = JSON.parse(readFileSync(path.join(target, "package.json")));
  assert.equal(installed.name, name);
  assert.equal(installed.version, expected[name] ?? lock.packages[`node_modules/${name}`].version);
  const link = path.join(root, "server/node_modules", name);
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(target, link, "dir");
  const require = createRequire(path.join(root, "server/package.json"));
  assert.ok(realpathSync(require.resolve(name)).startsWith(realpathSync(target) + path.sep), "Test resolver bypassed the declared SDK");
  links.push({ name, link, target, version: installed.version, packageSha256: sha256(readFileSync(path.join(target, "package.json"))) });
}
function inventory(directory, base = directory, files = {}) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inventory(file, base, files);
    else if (entry.isFile()) files[path.relative(base, file).split(path.sep).join("/")] = sha256(readFileSync(file));
  }
  return files;
}
const files = inventory(path.join(sdk, "node_modules"), sdk);
const receipt = { schema: "paperclip.qualification-sdk.v1", profile, diagnostic, producerAcceptanceQualified: false,
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  helperSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  manifestSha256: sha256(readFileSync(path.join(declared, "package.json"))),
  sdkLockSha256: sha256(readFileSync(path.join(declared, "package-lock.json"))),
  workspaceLockSha256: sha256(readFileSync(path.join(root, "pnpm-lock.yaml"))),
  installArgs, lifecycleScriptsExecuted: false, links, borrowedPackages, installedFileSha256: files };
mkdirSync(evidence, { recursive: true });
writeFileSync(path.join(evidence, "sdk.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
for (const name of ["package.json", "package-lock.json"]) cpSync(path.join(declared, name), path.join(evidence, `sdk-${name}`), { errorOnExist: true, force: false });
console.log(JSON.stringify({ profile, sdkLockSha256: receipt.sdkLockSha256, installedFiles: Object.keys(files).length,
  lifecycleScriptsExecuted: false, producerAcceptanceQualified: false }));
