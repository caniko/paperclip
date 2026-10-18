import assert from "node:assert/strict";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { runnerBinaryTarget, resolvePackagedRunnerBinary } from "../../packages/paperclip-runner/src/live/runner-binary.ts";
import { sha256 } from "./qualification-roster.mjs";

// Content binding only. The hosted lane must first execute the matching locked
// build; the unchanged integration cases, not this binding, prove execution.
export function bindQualificationRunner(packageRoot, binary, platform = process.platform, arch = process.arch) {
  assert.equal(platform, "linux", "The native runner profile requires actual Linux");
  assert.equal(binary, path.join(packageRoot, "runner/target/debug/paperclip-runnerd"), "Runner tests require the source fallback target directory");
  assert.equal(realpathSync(binary), binary, "The runner binary cannot redirect to another artifact");
  assert.ok(lstatSync(binary).isFile() && (lstatSync(binary).mode & 0o111), "The runner must be a regular executable");
  for (const output of ["src", "dist"]) {
    assert.equal(resolvePackagedRunnerBinary(path.join(packageRoot, output), platform, arch), null,
      "A packaged binary would shadow the freshly built source runner");
  }
  const bytes = readFileSync(binary);
  assert.equal(runnerBinaryTarget(bytes), `${platform}-${arch}`, "Runner target differs from the executing host");
  return { binary, binarySha256: sha256(bytes), platform, arch,
    cargoManifestSha256: sha256(readFileSync(path.join(packageRoot, "runner/Cargo.toml"))),
    cargoLockSha256: sha256(readFileSync(path.join(packageRoot, "runner/Cargo.lock"))),
    toolchainSha256: sha256(readFileSync(path.join(packageRoot, "rust-toolchain.toml"))) };
}
