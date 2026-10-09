import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import QualificationJUnitReporter from "../../scripts/qualification-junit-reporter.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const reporter = path.join(repoRoot, "scripts/qualification-junit-reporter.mjs");
const evidence = process.env.EVIDENCE;

function readReport(file) {
  const parsed = spawnSync("python3", ["-c", `
import json, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
print(json.dumps([{"classname": c.get("classname"), "name": c.get("name"),
 "failure": c.find("failure") is not None, "skipped": c.find("skipped") is not None}
 for c in root.findall(".//testcase")]))
`, file], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  return JSON.parse(parsed.stdout);
}

function retain(label, file, output) {
  if (!evidence) return;
  const directory = path.join(evidence, "reporter-contract");
  mkdirSync(directory, { recursive: true });
  // These are explicitly negative reporter fixtures, separate from the mandatory
  // application XML. Keep their unmodified raw bytes in the hashed receipt.
  writeFileSync(path.join(directory, `${label}.expected-negative-junit.txt`), readFileSync(file));
  if (output) writeFileSync(path.join(directory, `${label}.log`), output);
}

function fixture(source, retry = 0) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qualification-reporter-"));
  try {
    symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "junction");
    writeFileSync(path.join(root, "fixture.test.mjs"), source);
    const config = path.join(root, "vitest.config.mjs");
    writeFileSync(config, `export default { test: { root: ${JSON.stringify(root)}, include: ["fixture.test.mjs"], maxWorkers: 1 } };`);
    const file = path.join(root, "report.xml");
    const result = spawnSync("pnpm", ["exec", "vitest", "run", "--config", config,
      `--reporter=${reporter}`, `--outputFile.junit=${file}`, `--retry=${retry}`, "--allowOnly=false"],
    { cwd: repoRoot, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.error, undefined, result.stderr);
    return { status: result.status, output: result.stdout + result.stderr, file,
      cases: readReport(file), cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test("real Vitest preserves distinct same-title cases, failures and skips", () => {
  const result = fixture(`import { it } from "vitest";
    it("same display title", () => {});
    it("same display title", () => {});
    it("same display title", () => { throw new Error("preserved assertion failure"); });
    it.skip("same display title", () => {});`);
  try {
    assert.equal(result.status, 1, result.output);
    assert.equal(result.cases.length, 4);
    assert.equal(new Set(result.cases.map(c => `${c.classname}\0${c.name}`)).size, 4);
    assert.ok(result.cases.every(c => /^same display title \[vitest:.+\]$/.test(c.name)));
    assert.equal(result.cases.filter(c => c.failure).length, 1);
    assert.equal(result.cases.filter(c => c.skipped).length, 1);
    assert.match(readFileSync(result.file, "utf8"), /preserved assertion failure/);
    retain("same-title", result.file, result.output);
  } finally {
    result.cleanup();
  }
});

test("an actual failed-then-passed retry still fails qualification and retains its report", () => {
  const result = fixture(`import { it } from "vitest";
    let calls = 0;
    it("retried fixture", () => { if (++calls === 1) throw new Error("expected initial failure"); });`, 1);
  try {
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /Qualification received retried or repeated tasks/);
    assert.equal(result.cases.length, 1);
    retain("retry", result.file, result.output);
  } finally {
    result.cleanup();
  }
});

test("re-emitting the same framework task keeps its colliding identity", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qualification-repeat-"));
  try {
    const file = path.join(root, "report.xml");
    const instance = new QualificationJUnitReporter();
    await instance.onInit({ config: { root, outputFile: { junit: file } }, logger: { log() {} } });
    const task = { id: "stable-task-id", type: "test", name: "same display title", mode: "run",
      result: { state: "pass", duration: 1 }, annotations: [], benchmarks: [] };
    await instance.onTestRunEnd([{ task: { id: "module", type: "suite", name: "fixture.test.mjs",
      filepath: path.join(root, "fixture.test.mjs"), tasks: [task, task] } }]);
    const cases = readReport(file);
    assert.equal(cases.length, 2);
    assert.equal(new Set(cases.map(c => `${c.classname}\0${c.name}`)).size, 1);
    retain("duplicate-task", file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Node JUnit keeps equal titles source-bound and preserves raw failures, skips and same-source collisions", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qualification-node-reporter-"));
  const file = path.join(root, "report.xml");
  try {
    writeFileSync(path.join(root, "one.test.mjs"), `import { test } from "node:test";
      test("same title", () => {});
      test("same title", () => {});
      test.skip("skipped title", () => {});`);
    writeFileSync(path.join(root, "two.test.mjs"), `import { test } from "node:test";
      test("same title", () => { throw new Error("preserved Node assertion"); });`);
    const result = spawnSync(process.execPath, ["--test",
      `--test-reporter=${path.join(repoRoot, "scripts/qualification-node-junit-reporter.mjs")}`,
      `--test-reporter-destination=${file}`, "one.test.mjs", "two.test.mjs"],
    // This is an independent Node test process, not a nested run() invocation.
    { cwd: root, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
      encoding: "utf8", timeout: 60_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    const cases = readReport(file);
    assert.equal(cases.length, 4);
    assert.equal(cases.filter(row => row.failure).length, 1);
    assert.equal(cases.filter(row => row.skipped).length, 1);
    assert.deepEqual(cases.filter(row => row.name === "same title").map(row => row.classname).sort(),
      ["one.test.mjs", "one.test.mjs", "two.test.mjs"]);
    assert.match(readFileSync(file, "utf8"), /preserved Node assertion/);
    retain("node-source-identities", file, result.stdout + result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
