import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./qualification-roster.mjs";

export function bindMockTailscale(root) {
  assert.equal(process.platform, "linux", "The mock keeps actual Linux peer credentials and listener ownership");
  assert.equal(process.env.PAPERCLIP_TEST_TAILSCALE_MOCK, "1");
  assert.notEqual(process.env.PAPERCLIP_LIVE_BROKER_EXERCISE, "1", "Mocked and live profiles must be separate");
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0", "TLS validation must remain enabled");
  const broker = "packages/tailscale-https-broker";
  const fixture = "server/src/__tests__/helpers/mock-tailscale-broker.ts";
  const nativeAddon = `${broker}/dist/peercred-native.node`;
  const files = [fixture, `${broker}/scripts/build-native.mjs`, `${broker}/tsconfig.json`, `${broker}/dist/native-peercred.js`, nativeAddon,
    ...readdirSync(path.join(root, broker, "src")).filter(name => /\.(ts|c)$/.test(name) && !name.endsWith(".test.ts"))
      .map(name => `${broker}/src/${name}`)];
  const hashes = Object.fromEntries(files.sort().map(file => [file, sha256(readFileSync(path.join(root, file)))]));
  const openssl = realpathSync(execFileSync("which", ["openssl"], { encoding: "utf8", timeout: 5_000 }).trim());
  return { providerMocked: true, liveProviderVerified: false, fixtureSha256: hashes[fixture], nativeAddonSha256: hashes[nativeAddon],
    openssl, opensslSha256: sha256(readFileSync(openssl)),
    opensslVersion: execFileSync(openssl, ["version"], { encoding: "utf8", timeout: 5_000 }).trim(), files: hashes };
}

export function verifyMockTailscaleExercise(receipt, binding) {
  assert.equal(receipt.schema, "paperclip.mocked-tailscale-exercise.v1");
  assert.equal(receipt.platform, "linux");
  assert.equal(receipt.providerMocked, true);
  assert.equal(receipt.liveProviderVerified, false, "A mock cannot qualify the live provider");
  assert.equal(receipt.producerAcceptanceQualified, false);
  for (const field of ["nativePeerCredentialsVerified", "procOwnershipVerified", "untrustedCertificateRejected",
    "wrongHostnameRejected", "primaryPreserved", "cleanupPassed"]) assert.equal(receipt[field], true, `Missing mock journey evidence: ${field}`);
  for (const field of ["fixtureSha256", "nativeAddonSha256", "openssl", "opensslSha256", "opensslVersion"]) {
    assert.equal(receipt[field], binding[field], `Mock prerequisite drift: ${field}`);
  }
  assert.equal(receipt.exposedListeners, 2);
  assert.equal(receipt.removedListeners, 2);
  assert.ok(Number.isSafeInteger(receipt.httpsRequests) && receipt.httpsRequests >= 2);
  assert.match(receipt.certificateSha256, /^[a-f0-9]{64}$/);
}
