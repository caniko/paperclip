import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveCargoBinary, resolveCargoTargetDirectory } from "./cargo-artifacts.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "paperclip-cargo-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("queries locked offline metadata from the package root with the inherited environment", async (t) => {
  const root = await fixture(t);
  const packageRoot = join(root, "package");
  const effectiveTarget = join(root, "configured build target");
  const previousTarget = process.env.CARGO_TARGET_DIR;
  process.env.CARGO_TARGET_DIR = "../relative-build-target";
  t.after(() => {
    if (previousTarget === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = previousTarget;
  });
  let calls = 0;
  const targetDirectory = resolveCargoTargetDirectory({
    packageRoot,
    execFile(command, args, options) {
      calls += 1;
      assert.equal(command, "cargo");
      assert.deepEqual(args, [
        "metadata", "--format-version=1", "--no-deps",
        "--manifest-path", "runner/Cargo.toml", "--locked", "--offline",
      ]);
      assert.equal(options.cwd, packageRoot);
      assert.equal(options.env, process.env);
      assert.equal(options.env.CARGO_TARGET_DIR, "../relative-build-target");
      assert.equal(options.encoding, "utf8");
      return JSON.stringify({ target_directory: effectiveTarget });
    },
  });
  assert.equal(calls, 1);
  assert.equal(targetDirectory, effectiveTarget);
  await mkdir(join(effectiveTarget, "debug"), { recursive: true });
  const artifact = join(effectiveTarget, "debug", "fake-codex-app-server");
  await writeFile(artifact, "fixture artifact\n");
  assert.equal(resolveCargoBinary({ binary: "fake-codex-app-server", targetDirectory, platform: "linux" }), artifact);
});

test("rejects malformed JSON and missing or relative metadata targets", () => {
  assert.throws(() => resolveCargoTargetDirectory({ execFile: () => "not json" }), /invalid JSON/);
  for (const value of [null, {}, { target_directory: 4 }, { target_directory: "" }, { target_directory: "relative/target" }]) {
    assert.throws(() => resolveCargoTargetDirectory({ execFile: () => JSON.stringify(value) }), /target_directory must be an absolute path/);
  }
});

test("propagates Cargo failures instead of falling back to a guessed target", () => {
  const failure = new Error("cargo metadata failed offline");
  assert.throws(() => resolveCargoTargetDirectory({ execFile: () => { throw failure; } }), (error) => error === failure);
});

test("resolves release and platform-named binaries only from the effective target", async (t) => {
  const targetDirectory = await fixture(t);
  await mkdir(join(targetDirectory, "release"));
  const artifact = join(targetDirectory, "release", "paperclip-runnerd.exe");
  await writeFile(artifact, "fixture artifact\n");
  assert.equal(resolveCargoBinary({ binary: "paperclip-runnerd", profile: "release", platform: "win32", targetDirectory }), artifact);
  assert.throws(() => resolveCargoBinary({ binary: "paperclip-runnerd", platform: "win32", targetDirectory }), /Cargo artifact is missing/);
  assert.throws(() => resolveCargoBinary({ binary: "paperclip-runnerd", profile: "release", platform: "linux", targetDirectory }), /Cargo artifact is missing/);
});

test("fails when the artifact is absent or is a directory", async (t) => {
  const targetDirectory = await fixture(t);
  assert.throws(() => resolveCargoBinary({ binary: "fake-harness", targetDirectory }), /Run the matching locked Cargo build first/);
  await mkdir(join(targetDirectory, "debug", "fake-harness"), { recursive: true });
  assert.throws(() => resolveCargoBinary({ binary: "fake-harness", platform: "linux", targetDirectory }), /Cargo artifact is not a file/);
});

test("rejects path-shaped binary/profile names and nonabsolute target directories", async (t) => {
  const targetDirectory = await fixture(t);
  for (const binary of [undefined, "", "../runnerd", "/runnerd", "nested/runnerd"]) {
    assert.throws(() => resolveCargoBinary({ binary, targetDirectory }), /binary must be a single artifact name/);
  }
  assert.throws(() => resolveCargoBinary({ binary: "runnerd", profile: "../release", targetDirectory }), /profile must be a single artifact name/);
  assert.throws(() => resolveCargoBinary({ binary: "runnerd", targetDirectory: "relative/target" }), /target directory must be an absolute path/);
});
