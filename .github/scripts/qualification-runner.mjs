import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { runnerBinaryTarget, resolvePackagedRunnerBinary } from "../../packages/paperclip-runner/src/live/runner-binary.ts";
import { sha256 } from "./qualification-roster.mjs";

export function bindRemoteContinuity(root, evidence) {
  const raw = readFileSync(path.join(evidence, "remote-continuity.json"));
  const receipt = JSON.parse(raw);
  assert.equal(receipt.schema, "paperclip.remote-continuity.v1");
  assert.equal(receipt.head, execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
  assert.equal(receipt.runAttempt, 1);
  assert.equal(receipt.runId, process.env.GITHUB_RUN_ID);
  assert.match(receipt.container, /^[a-f0-9]{64}$/);
  assert.equal(receipt.container, process.env.PAPERCLIP_TEST_RUNNER_CONTAINER);
  assert.equal(receipt.port, process.env.PAPERCLIP_TEST_RUNNER_PORT);
  assert.equal(receipt.image, "node:24-trixie@sha256:a3e43f3f15bea8c59c689afeebe63c945885677ae469ae8d12578567ef18f1df");
  const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
  const actual = JSON.parse(docker(["inspect", receipt.container]))[0];
  assert.equal(actual.State.Running, true);
  assert.equal(actual.Config.Image, receipt.image);
  assert.equal(actual.Image, receipt.imageId);
  assert.equal(actual.Config.Labels["paperclip.qualification.run"], receipt.runId);
  assert.deepEqual(actual.NetworkSettings.Ports["43127/tcp"], [{ HostIp: "127.0.0.1", HostPort: receipt.port }]);
  assert.equal(receipt.helperSha256, sha256(readFileSync(path.join(root, ".github/scripts/prepare-remote-continuity.sh"))));
  assert.equal(receipt.runner.binary, path.join(root, "packages/paperclip-runner/runner/target/release/paperclip-runnerd"));
  assert.equal(receipt.provider.binary, path.join(path.dirname(receipt.runner.binary), "fake-codex-app-server"));
  assert.equal(receipt.provider.remote, "/opt/continuity/fake-codex-app-server");
  for (const artifact of [receipt.runner, receipt.provider, receipt.wrapper, receipt.certificate]) {
    assert.equal(sha256(readFileSync(artifact.binary)), artifact.sha256, "Remote fixture source artifact changed");
  }
  assert.equal(receipt.runner.binary, process.env.PAPERCLIP_TEST_LINUX_RUNNER_BINARY);
  assert.equal(receipt.wrapper.binary, process.env.PAPERCLIP_TEST_FAKE_CODEX_WRAPPER);
  assert.equal(receipt.certificate.binary, process.env.NODE_EXTRA_CA_CERTS);
  assert.equal(docker(["exec", receipt.container, "sha256sum", receipt.provider.remote]).split(/\s/)[0], receipt.provider.sha256);
  const tools = docker(["exec", receipt.container, "sh", "-eu", "-c", 'for tool in node sh tar base64 ps setsid; do sha256sum "$(command -v "$tool")"; done']);
  assert.equal(tools, receipt.tools);
  return { receiptSha256: sha256(raw), container: receipt.container, imageId: receipt.imageId,
    runnerSha256: receipt.runner.sha256, providerSha256: receipt.provider.sha256, tools };
}

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
