import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { profileSelection, verifyProfileResults } from "../qualification-profiles.mjs";
import { mapEnvironments, sha256 } from "../qualification-roster.mjs";
import { verifyMockTailscaleExercise } from "../qualification-tailscale-mock.mjs";

const root = new URL("../../../", import.meta.url);
const policy = JSON.parse(readFileSync(new URL(".github/qualification/coverage-environments.json", root)));
const file = "server/src/__tests__/workspace-runtime-https-live-exercise.test.ts";
const sources = { [file]: readFileSync(new URL(file, root), "utf8") };
const row = { id: "original-case", project: "server", file, required: true, skipped_in_environment: false,
  name: "PAP-17158 live HTTPS backfill exercise > upgrades a pre-existing HTTP workspace in place to a browser-trusted HTTPS URL" };

test("mocked Tailscale executes the original case without granting live-provider environment credit", () => {
  const selected = profileSelection("tailscale-mock", "linux", [row], sources, policy);
  assert.deepEqual(selected.requiredCases, [row]);
  assert.equal(verifyProfileResults(selected, [{ ...row, outcome: "passed", retryCount: 0, repeatCount: 0 }], []).passed, 1);
  assert.deepEqual(mapEnvironments([row], sources, policy).cases[0].environments, ["live-tailscale"]);
  for (const cases of [[], [{ ...row, skipped_in_environment: true }], [{ ...row, required: false }]]) {
    assert.throws(() => profileSelection("tailscale-mock", "linux", cases, sources, policy));
  }
  assert.throws(() => profileSelection("tailscale-mock", "darwin", [row], sources, policy));
});

const binding = { fixtureSha256: sha256("fixture"), nativeAddonSha256: sha256("native"),
  openssl: "/usr/bin/openssl", opensslSha256: sha256("openssl"), opensslVersion: "OpenSSL test" };
const passed = { ...binding, schema: "paperclip.mocked-tailscale-exercise.v1", providerMocked: true, liveProviderVerified: false,
  platform: "linux", nativePeerCredentialsVerified: true, procOwnershipVerified: true,
  untrustedCertificateRejected: true, wrongHostnameRejected: true, primaryPreserved: true, cleanupPassed: true,
  exposedListeners: 2, removedListeners: 2, httpsRequests: 2, certificateSha256: sha256("certificate"), producerAcceptanceQualified: false };

test("mocked-provider receipts require executed TLS, ownership, primary preservation and cleanup evidence", () => {
  verifyMockTailscaleExercise(passed, binding);
  for (const field of ["nativePeerCredentialsVerified", "procOwnershipVerified", "untrustedCertificateRejected",
    "wrongHostnameRejected", "primaryPreserved", "cleanupPassed", "providerMocked"]) {
    assert.throws(() => verifyMockTailscaleExercise({ ...passed, [field]: false }, binding));
  }
  for (const change of [{ liveProviderVerified: true }, { producerAcceptanceQualified: true }, { platform: "darwin" },
    { schema: "other" }, { exposedListeners: 0 }, { removedListeners: 1 }, { httpsRequests: 1 }, { httpsRequests: NaN },
    { certificateSha256: "absent" }, ...Object.keys(binding).map(field => ({ [field]: "changed" }))]) {
    assert.throws(() => verifyMockTailscaleExercise({ ...passed, ...change }, binding));
  }
});
