import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { traceLocalRunner } from "./trace-local-runner.mjs";

test("forwards an explicit binary pair exactly without querying Cargo", () => {
  const args = ["--quiet", "--runner-binary", "/explicit/runnerd", "--fake-harness-binary", "/explicit/fake-harness"];
  let calls = 0;
  const status = traceLocalRunner({
    args,
    resolveTargetDirectory: () => assert.fail("explicit pair must not require Cargo"),
    resolveBinary: () => assert.fail("explicit pair must not resolve default binaries"),
    spawn(command, forwarded, options) {
      calls += 1;
      assert.equal(command, process.execPath);
      assert.equal(forwarded[0], fileURLToPath(new URL("../dist/cli/local-runner.js", import.meta.url)));
      assert.deepEqual(forwarded.slice(1), args);
      assert.equal(options.env, process.env);
      assert.equal(options.stdio, "inherit");
      return { status: 7 };
    },
  });
  assert.equal(calls, 1);
  assert.equal(status, 7);
});

for (const supplied of ["paperclip-runnerd", "fake-harness"]) {
  test(`resolves only the missing default when ${supplied} is explicit`, () => {
    const runnerIsExplicit = supplied === "paperclip-runnerd";
    const suppliedFlag = runnerIsExplicit ? "--runner-binary" : "--fake-harness-binary";
    const missingFlag = runnerIsExplicit ? "--fake-harness-binary" : "--runner-binary";
    const missingBinary = runnerIsExplicit ? "fake-harness" : "paperclip-runnerd";
    const args = [suppliedFlag, "/explicit/binary", "--quiet"];
    let metadataCalls = 0;
    let binaryCalls = 0;
    traceLocalRunner({
      args,
      resolveTargetDirectory() { metadataCalls += 1; return "/effective/target"; },
      resolveBinary(options) {
        binaryCalls += 1;
        assert.deepEqual(options, { binary: missingBinary, targetDirectory: "/effective/target" });
        return `/effective/target/debug/${missingBinary}`;
      },
      spawn(_command, forwarded) {
        assert.deepEqual(forwarded.slice(1), [...args, missingFlag, `/effective/target/debug/${missingBinary}`]);
        return { status: 0 };
      },
    });
    assert.equal(metadataCalls, 1);
    assert.equal(binaryCalls, 1);
    assert.deepEqual(args, [suppliedFlag, "/explicit/binary", "--quiet"]);
  });
}

test("rejects missing binary-option values before Cargo or CLI startup", () => {
  for (const args of [["--runner-binary"], ["--fake-harness-binary", "--quiet"], ["--runner-binary", ""]]) {
    assert.throws(() => traceLocalRunner({
      args,
      resolveTargetDirectory: () => assert.fail("invalid options must not query Cargo"),
      spawn: () => assert.fail("invalid options must not spawn the CLI"),
    }), /--(?:runner|fake-harness)-binary requires a path/);
  }
});

test("reaches the CLI probe with explicit absolute binaries and Cargo unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-trace-wrapper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const cliRoot = join(root, "dist", "cli");
  const caller = join(root, "unrelated caller");
  await Promise.all([mkdir(scripts), mkdir(cliRoot, { recursive: true }), mkdir(caller)]);
  await Promise.all([
    copyFile(new URL("./trace-local-runner.mjs", import.meta.url), join(scripts, "trace-local-runner.mjs")),
    copyFile(new URL("./cargo-artifacts.mjs", import.meta.url), join(scripts, "cargo-artifacts.mjs")),
    writeFile(join(root, "package.json"), JSON.stringify({ type: "module" })),
    writeFile(join(cliRoot, "local-runner.js"), 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n'),
  ]);
  const runner = join(root, "explicit runnerd");
  const harness = join(root, "explicit fake-harness");
  await Promise.all([writeFile(runner, "fixture\n"), writeFile(harness, "fixture\n")]);
  const args = ["--runner-binary", runner, "--quiet", "--fake-harness-binary", harness];
  const stdout = execFileSync(process.execPath, [join(scripts, "trace-local-runner.mjs"), ...args], {
    cwd: caller,
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(stdout), { args, cwd: caller });
});
