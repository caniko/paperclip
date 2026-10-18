import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bindQualificationRunner } from "../qualification-runner.mjs";

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
