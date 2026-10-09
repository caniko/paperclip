import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const workflow = readFileSync(path.join(root, ".github/workflows/source-qualification.yml"), "utf8");
const application = workflow.split("\n  application:\n")[1].split("\n  retention:\n")[0];
const lanes = [...application.matchAll(/^          - lane: ([\w-]+)\n((?:            [\w_]+: [\w-]+\n)*)/gm)]
  .map(([, lane, fields]) => ({ lane, ...Object.fromEntries(
    [...fields.matchAll(/^            (\w+): ([\w-]+)$/gm)].map(([, key, value]) => [key, value]),
  ) }));

function plan(args) {
  return JSON.parse(execFileSync(process.execPath, ["scripts/run-vitest-stable.mjs", ...args, "--dry-run"], {
    cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_WORKFLOW: "Exact-head source qualification" },
  }));
}

function args(lane) {
  const result = ["--mode", lane.mode];
  if (lane.group) result.push("--group", lane.group);
  if (lane.shard_count) result.push("--shard-index", lane.shard_index, "--shard-count", lane.shard_count);
  return result;
}

test("the exact-head matrix covers every server suite once, including chat and native execution", () => {
  const server = lanes.filter(lane => lane.group === "general-server");
  const serialized = lanes.filter(lane => lane.mode === "serialized");
  assert.ok(server.length > 1 && serialized.length > 1, "both long-running groups need shards");
  const expectedServer = plan(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"]);
  const expectedSerialized = plan(["--mode", "serialized"]);
  const actualServer = server.flatMap(lane => plan(args(lane)).selectedGeneralServerSuites);
  const actualSerialized = serialized.flatMap(lane => plan(args(lane)).selectedSerializedSuites);
  assert.deepEqual(actualServer.sort(), expectedServer.selectedGeneralServerSuites.sort());
  assert.deepEqual(actualSerialized.sort(), expectedSerialized.selectedSerializedSuites.sort());
  assert.equal(new Set([...actualServer, ...actualSerialized]).size, actualServer.length + actualSerialized.length);
  for (const file of ["server/src/__tests__/chat-channels.integration.test.ts",
    "server/src/services/native-runtime/native-codex-runner.integration.test.ts",
    "server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts"]) {
    assert.ok(actualServer.includes(file), `missing real runtime suite: ${file}`);
  }
});

test("the exact-head matrix covers each configured workspace and each native file shard", () => {
  const a = lanes.filter(lane => lane.group === "general-workspaces-a");
  const b = lanes.filter(lane => lane.group === "general-workspaces-b");
  assert.ok(a.length > 0);
  assert.equal(b.length, 1);
  const aPlans = a.map(lane => plan(args(lane)));
  assert.deepEqual(aPlans.map(p => p.workspacesVitestShard).sort(), ["1/2", "2/2"]);
  for (const p of aPlans) assert.deepEqual(p.workspaceProjects, aPlans[0].workspaceProjects);
  const actual = [...aPlans[0].workspaceProjects, ...plan(args(b[0])).workspaceProjects].sort();
  const config = readFileSync(path.join(root, "vitest.config.ts"), "utf8");
  const projects = [...config.matchAll(/^\s+"([^"]+)",?\s*$/gm)].map(match => match[1]).filter(p => p !== "server");
  const expected = projects.map(p => JSON.parse(readFileSync(path.join(root, p, "package.json"), "utf8")).name).sort();
  assert.deepEqual(actual, expected, "every configured non-server project must remain covered exactly once");
});

test("all source shards retain strict reports, the two-hour deadline and their own required artifact", () => {
  assert.equal(new Set(lanes.map(lane => lane.lane)).size, lanes.length);
  assert.deepEqual(lanes.filter(lane => !lane.lane.startsWith("tests-")).map(lane => lane.lane).sort(),
    ["build", "regression", "typecheck"]);
  assert.match(application, /timeout-minutes: 120\n/);
  assert.match(application, /fail-fast: false\n/);
  assert.match(application, /max-parallel: 2\n/);
  assert.match(application, /tests-\*\|regression\) strict\+=\(--strict-reports\)/);
  assert.match(application, /pnpm test:run -- "\$\{args\[@\]\}"/);
  assert.match(application, /name: source-proof-\$\{\{ matrix.lane \}\}/);
  assert.match(application, /retention-days: 31\n/);
  const count = Number(workflow.match(/qualification-evidence\.py artifacts source-proof- (\d+) retention\.json/)[1]);
  assert.equal(count, lanes.length + 1, "retention must require all matrix lanes and the original RED artifact");
  assert.match(workflow, /needs: \[application, expected_red, harness_identity\]/);
  for (const name of ["LANES", "EXPECTED_RED", "HARNESS_IDENTITY"]) assert.ok(workflow.includes(`test "$${name}" = success`));
});
