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
  const providerFixture = path.join(path.dirname(binary), "fake-codex-app-server");
  for (const executable of [binary, providerFixture]) {
    assert.equal(realpathSync(executable), executable, "Native executables cannot redirect to another artifact");
    assert.ok(lstatSync(executable).isFile() && (lstatSync(executable).mode & 0o111), "Native artifacts must be regular executables");
    assert.equal(runnerBinaryTarget(readFileSync(executable)), `${platform}-${arch}`, "Native artifact target differs from the executing host");
  }
  for (const output of ["src", "dist"]) {
    assert.equal(resolvePackagedRunnerBinary(path.join(packageRoot, output), platform, arch), null,
      "A packaged binary would shadow the freshly built source runner");
  }
  const bytes = readFileSync(binary);
  return { binary, binarySha256: sha256(bytes), platform, arch,
    providerFixture: { binary: providerFixture, binarySha256: sha256(readFileSync(providerFixture)) },
    cargoManifestSha256: sha256(readFileSync(path.join(packageRoot, "runner/Cargo.toml"))),
    cargoLockSha256: sha256(readFileSync(path.join(packageRoot, "runner/Cargo.lock"))),
    toolchainSha256: sha256(readFileSync(path.join(packageRoot, "rust-toolchain.toml"))) };
}
