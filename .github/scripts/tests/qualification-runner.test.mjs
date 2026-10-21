import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bindQualificationRunner, bindRemoteContinuity } from "../qualification-runner.mjs";
import { sha256 } from "../qualification-roster.mjs";

test("runner binding follows the source fallback and rejects shadowing or incompatible artifacts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qualification-runner-"));
  try {
    const binary = path.join(root, "runner/target/debug/paperclip-runnerd");
    mkdirSync(path.dirname(binary), { recursive: true });
    for (const [file, bytes] of [["runner/Cargo.toml", "[workspace]\n"], ["runner/Cargo.lock", "version = 4\n"],
      ["rust-toolchain.toml", '[toolchain]\nchannel = "1.97.1"\n']]) writeFileSync(path.join(root, file), bytes);
    const bytes = Buffer.alloc(32);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    bytes.writeUInt16LE(62, 18);
    writeFileSync(binary, bytes, { mode: 0o755 });
    const providerFixture = path.join(path.dirname(binary), "fake-codex-app-server");
    writeFileSync(providerFixture, bytes, { mode: 0o755 });
    const bind = () => bindQualificationRunner(root, binary, "linux", "x64");
    const original = bind();
    bytes[31] = 2;
    writeFileSync(providerFixture, bytes);
    assert.notEqual(bind().providerFixture.binarySha256, original.providerFixture.binarySha256,
      "Changed provider fixture bytes must change the retained binding");
    chmodSync(providerFixture, 0o644);
    assert.throws(bind, /executable/);
    chmodSync(providerFixture, 0o755);
    const retainedFixture = providerFixture + ".retained";
    writeFileSync(retainedFixture, bytes, { mode: 0o755 });
    rmSync(providerFixture);
    assert.throws(bind, /ENOENT/);
    symlinkSync(retainedFixture, providerFixture);
    assert.throws(bind, /redirect/);
    rmSync(providerFixture);
    writeFileSync(providerFixture, bytes, { mode: 0o755 });
    bytes[31] = 1;
    writeFileSync(binary, bytes);
    assert.notEqual(bind().binarySha256, original.binarySha256, "Changed artifact bytes must change the retained binding");
    assert.throws(() => bindQualificationRunner(root, binary, "linux", "arm64"), /target/);
    assert.throws(() => bindQualificationRunner(root, binary, "darwin", "x64"), /Linux/);
    chmodSync(binary, 0o644);
    assert.throws(bind, /executable/);
    chmodSync(binary, 0o755);
    const alias = path.join(path.dirname(binary), "alias");
    symlinkSync(binary, alias);
    assert.throws(() => bindQualificationRunner(root, alias, "linux", "x64"), /fallback/);
    for (const output of ["src", "dist"]) {
      const shadow = path.join(root, output, "bin/linux-x64/paperclip-runnerd");
      mkdirSync(path.dirname(shadow), { recursive: true });
      writeFileSync(shadow, readFileSync(binary));
      assert.throws(bind, /shadow/);
      rmSync(shadow);
    }
    const retained = binary + ".retained";
    writeFileSync(retained, readFileSync(binary), { mode: 0o755 });
    rmSync(binary);
    symlinkSync(retained, binary);
    assert.throws(bind, /redirect/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote continuity binds actual container state and rejects changed source, image, tools and attempts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qualification-remote-"));
  const originalEnvironment = { ...process.env };
  try {
    const bin = path.join(root, "commands");
    mkdirSync(bin);
    const head = "a".repeat(40), container = "b".repeat(64), runId = "17";
    const helper = path.join(root, ".github/scripts/prepare-remote-continuity.sh");
    mkdirSync(path.dirname(helper), { recursive: true });
    writeFileSync(helper, "selected helper\n");
    const artifact = (file, text) => {
      const binary = path.join(root, file);
      mkdirSync(path.dirname(binary), { recursive: true });
      writeFileSync(binary, text);
      return { binary, sha256: sha256(text) };
    };
    const receipt = { schema: "paperclip.remote-continuity.v1", head, container, runId, runAttempt: 1,
      image: "node:24-trixie@sha256:a3e43f3f15bea8c59c689afeebe63c945885677ae469ae8d12578567ef18f1df",
      imageId: `sha256:${"c".repeat(64)}`, port: "43217", tools: "original container tool hashes",
      helperSha256: sha256(readFileSync(helper)),
      runner: artifact("packages/paperclip-runner/runner/target/release/paperclip-runnerd", "runner"),
      provider: { ...artifact("packages/paperclip-runner/runner/target/release/fake-codex-app-server", "provider"), remote: "/opt/continuity/fake-codex-app-server" },
      wrapper: artifact("fake-codex", "wrapper"), certificate: artifact("test.crt", "certificate") };
    const stateFile = path.join(root, "state.json");
    const actual = { State: { Running: true }, Image: receipt.imageId,
      Config: { Image: receipt.image, Labels: { "paperclip.qualification.run": runId } },
      NetworkSettings: { Ports: { "43127/tcp": [{ HostIp: "127.0.0.1", HostPort: receipt.port }] } } };
    let state = { actual, providerSha256: receipt.provider.sha256, tools: receipt.tools };
    const write = () => {
      writeFileSync(stateFile, JSON.stringify(state));
      writeFileSync(path.join(root, "remote-continuity.json"), JSON.stringify(receipt));
    };
    writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nconsole.log(${JSON.stringify(head)});\n`, { mode: 0o755 });
    writeFileSync(path.join(bin, "docker"), `#!${process.execPath}
const fs=require('node:fs');
const state=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}));
const args=process.argv.slice(2);
if(args[0]==='inspect') console.log(JSON.stringify([state.actual]));
else if(args[2]==='sha256sum') console.log(state.providerSha256+'  '+args[3]);
else if(args[2]==='sh') console.log(state.tools);
else process.exit(1);
`, { mode: 0o755 });
    Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_RUN_ID: runId,
      PAPERCLIP_TEST_RUNNER_CONTAINER: container, PAPERCLIP_TEST_RUNNER_PORT: receipt.port,
      PAPERCLIP_TEST_LINUX_RUNNER_BINARY: receipt.runner.binary, PAPERCLIP_TEST_FAKE_CODEX_WRAPPER: receipt.wrapper.binary,
      NODE_EXTRA_CA_CERTS: receipt.certificate.binary });
    const bind = () => { write(); return bindRemoteContinuity(root, root); };
    assert.equal(bind().providerSha256, receipt.provider.sha256);
    for (const mutate of [
      () => { state.actual.State.Running = false; },
      () => { state.actual.Image = "changed"; },
      () => { state.actual.NetworkSettings.Ports["43127/tcp"][0].HostIp = "0.0.0.0"; },
      () => { state.providerSha256 = "changed"; },
      () => { state.tools = "changed"; },
    ]) {
      const original = structuredClone(state);
      mutate(); assert.throws(bind); state = original;
    }
    receipt.runAttempt = 2; assert.throws(bind); receipt.runAttempt = 1;
    receipt.image = receipt.image.replace("a3e4", "0000"); assert.throws(bind);
    receipt.image = state.actual.Config.Image;
    writeFileSync(receipt.runner.binary, "changed"); assert.throws(bind, /artifact changed/);
  } finally {
    process.env = originalEnvironment;
    rmSync(root, { recursive: true, force: true });
  }
});
