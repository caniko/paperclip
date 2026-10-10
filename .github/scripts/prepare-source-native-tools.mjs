#!/usr/bin/env node
// Provision only the disposable hosted source lane; local mode verifies tools.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const verifyOnly = args[0] === "--verify-only";
assert.equal(args.length, verifyOnly ? 2 : 1, "Pass an evidence directory, optionally preceded by --verify-only");
assert.equal(process.platform, "linux", "The source tool profile requires actual Linux");
if (!verifyOnly) {
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "Provision only a disposable hosted runner");
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1", "Provision only attempt 1");
  assert.ok(process.env.GITHUB_ENV, "Hosted environment export is required");
}

const root = process.cwd();
const evidence = path.resolve(args.at(-1));
mkdirSync(evidence, { recursive: true });
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const dbRequire = createRequire(path.join(root, "packages/db/package.json"));
const embeddedEntry = dbRequire.resolve("embedded-postgres");
const { default: getBinaries } = await import(pathToFileURL(path.join(path.dirname(embeddedEntry), "binary.js")).href);
const { postgres } = await getBinaries();
const { prepareEmbeddedPostgresNativeRuntime } = await import(pathToFileURL(path.join(root, "packages/db/src/embedded-postgres-native.ts")).href);
await prepareEmbeddedPostgresNativeRuntime();

function version(binary, expectedProgram) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5_000, maxBuffer: 65_536 });
  if (result.status !== 0) return null;
  const match = result.stdout.trim().match(new RegExp(`^${expectedProgram} \\(PostgreSQL\\) (\\d+)\\.`));
  // Keep argv[0]: Ubuntu's pg_wrapper selects pg_dump/psql by its invoked name.
  return match ? { binary: path.resolve(binary), resolvedBinary: realpathSync(binary),
    major: Number(match[1]), version: result.stdout.trim() } : null;
}

const server = version(postgres, "postgres");
assert.ok(server, "Cannot establish the actual embedded PostgreSQL version");
assert.equal(server.major, 18, "Review provisioning when the declared embedded server major changes");
console.log(`Embedded server prerequisite: ${server.version}`);
const operations = [];
let aptUpdated = false;
function provision(argv) {
  assert.equal(verifyOnly, false, "Local verification never installs packages");
  operations.push({ command: "sudo", argv });
  execFileSync("sudo", argv, { stdio: "inherit", timeout: 300_000 });
}
function install(packageName) {
  for (const argv of [...(aptUpdated ? [] : [["apt-get", "update"]]), ["apt-get", "install", "-y", packageName]]) {
    provision(argv);
  }
  aptUpdated = true;
}

function resolveCommand(command) {
  const result = spawnSync("sh", ["-c", 'command -v "$1"', "paperclip-source-tools", command], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 65_536,
  });
  const executable = result.stdout?.trim();
  return result.status === 0 && executable && path.isAbsolute(executable) && existsSync(executable) ? executable : null;
}

function clientPair() {
  const explicitDump = process.env.PAPERCLIP_PG_DUMP_PATH;
  const explicitPsql = process.env.PAPERCLIP_PSQL_PATH;
  assert.equal(Boolean(explicitDump), Boolean(explicitPsql), "Set both native client overrides together");
  const candidates = explicitDump
    ? [[explicitDump, explicitPsql]]
    : [[`/usr/lib/postgresql/${server.major}/bin/pg_dump`, `/usr/lib/postgresql/${server.major}/bin/psql`],
       [resolveCommand("pg_dump"), resolveCommand("psql")],
       ...["/run/current-system/sw/bin", "/usr/bin"].map(bin => [path.join(bin, "pg_dump"), path.join(bin, "psql")])];
  for (const [dump, psql] of candidates) {
    if (!dump || !psql || !existsSync(dump) || !existsSync(psql)) continue;
    const dumpVersion = version(dump, "pg_dump");
    const psqlVersion = version(psql, "psql");
    if (dumpVersion?.major === server.major && psqlVersion?.major === server.major) return { pg_dump: dumpVersion, psql: psqlVersion };
  }
  assert.ok(!explicitDump, "Explicit native PostgreSQL clients must match the actual embedded server major");
  return null;
}

let clients = clientPair();
if (!clients && !verifyOnly) {
  // Noble includes PostgreSQL 16. Use the upstream signed repository for 18.
  // https://www.postgresql.org/download/linux/ubuntu/
  const osRelease = readFileSync("/etc/os-release", "utf8");
  assert.match(osRelease, /^ID=ubuntu$/m, "Provisioning is defined for Ubuntu 24.04");
  assert.match(osRelease, /^VERSION_CODENAME=noble$/m, "Review provisioning for a different Ubuntu release");
  const response = await fetch("https://www.postgresql.org/media/keys/ACCC4CF8.asc", {
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, "Cannot fetch the official PostgreSQL repository key");
  const key = Buffer.from(await response.arrayBuffer());
  assert.equal(sha256(key), "0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76",
    "Review a changed PostgreSQL repository key before provisioning");
  const keyFile = path.join(evidence, "pgdg-key.asc");
  const sourcesFile = path.join(evidence, "pgdg.sources");
  writeFileSync(keyFile, key, { flag: "wx" });
  writeFileSync(sourcesFile, ["Types: deb", "URIs: https://apt.postgresql.org/pub/repos/apt",
    "Suites: noble-pgdg", "Components: main",
    "Signed-By: /usr/share/postgresql-common/pgdg/paperclip-qualification.asc", ""].join("\n"), { flag: "wx" });
  provision(["install", "-D", "-m", "644", keyFile, "/usr/share/postgresql-common/pgdg/paperclip-qualification.asc"]);
  provision(["install", "-D", "-m", "644", sourcesFile, "/etc/apt/sources.list.d/paperclip-qualification-pgdg.sources"]);
  install(`postgresql-client-${server.major}`);
  clients = clientPair();
}
assert.ok(clients, "The source lane requires actual pg_dump and psql matching the embedded server major");
let zsh = resolveCommand("zsh");
if (!zsh && !verifyOnly) {
  install("zsh");
  zsh = resolveCommand("zsh");
}
assert.ok(zsh, "The source lane requires the actual zsh executable");
const zshVersion = execFileSync(zsh, ["--version"], { encoding: "utf8", timeout: 5_000, maxBuffer: 65_536 }).trim();
assert.match(zshVersion, /^zsh /);

const inventory = {
  schema: "paperclip.source-native-tools.v1",
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
  helperSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  nativeRuntimeHelperSha256: sha256(readFileSync(path.join(root, "packages/db/src/embedded-postgres-native.ts"))),
  dependencyLockSha256: sha256(readFileSync(path.join(root, "pnpm-lock.yaml"))),
  platform: process.platform,
  arch: process.arch,
  runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  verificationOnly: verifyOnly,
  producerAcceptanceQualified: false,
  tools: { postgres: server, ...clients, zsh: { binary: zsh, resolvedBinary: realpathSync(zsh), version: zshVersion } },
  installOperations: operations,
};
for (const tool of Object.values(inventory.tools)) tool.sha256 = sha256(readFileSync(tool.binary));
writeFileSync(path.join(evidence, "native-tools.json"), JSON.stringify(inventory, null, 2) + "\n", { flag: "wx" });
if (!verifyOnly) {
  const bindings = [`PAPERCLIP_PG_DUMP_PATH=${clients.pg_dump.binary}`, `PAPERCLIP_PSQL_PATH=${clients.psql.binary}`];
  assert.ok(bindings.every(binding => !/[\r\n]/.test(binding)), "Environment paths must be single-line");
  writeFileSync(process.env.GITHUB_ENV, bindings.join("\n") + "\n", { flag: "a" });
}
console.log(JSON.stringify(inventory, null, 2));
