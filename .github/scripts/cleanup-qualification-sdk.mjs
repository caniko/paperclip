#!/usr/bin/env node
import assert from "node:assert/strict";
import { lstatSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const evidence = path.resolve(process.argv[2]);
const receipt = JSON.parse(readFileSync(path.join(evidence, "sdk.json")));
assert.ok(["otel-sdk", "sentry-sdk"].includes(receipt.profile));
const manifest = JSON.parse(readFileSync(path.join(process.cwd(), ".github/qualification/sdks", receipt.profile, "package.json")));
const names = [...Object.keys(manifest.dependencies), ...(receipt.profile === "otel-sdk" ? ["@opentelemetry/api", "@opentelemetry/sdk-trace-base"] : [])];
assert.ok(receipt.borrowedPackages.every(row => row.name === "@opentelemetry/api"));
assert.deepEqual(receipt.links.map(link => link.name), names.filter(name => !receipt.borrowedPackages.some(row => row.name === name)));
for (const row of receipt.borrowedPackages) {
  assert.equal(row.link, path.join(process.cwd(), "server/node_modules", row.name));
  assert.equal(readlinkSync(row.link), row.target, "Borrowed SDK entry changed");
}
const sdk = receipt.installArgs[2];
assert.equal(receipt.installArgs[1], "--prefix");
const links = receipt.links.map(row => {
  assert.equal(row.link, path.join(process.cwd(), "server/node_modules", row.name));
  assert.equal(row.target, path.join(sdk, "node_modules", row.name));
  assert.ok(lstatSync(row.link).isSymbolicLink(), "SDK entry no longer belongs to this preparation");
  assert.equal(readlinkSync(row.link), row.target, "SDK link owner changed");
  return row.link;
});
for (const link of links) unlinkSync(link);
writeFileSync(path.join(evidence, "sdk-cleanup.json"), JSON.stringify({ ownedLinksRemoved: links,
  borrowedPackagesPreserved: receipt.borrowedPackages, installedSdkPreserved: sdk,
  producerAcceptanceQualified: false }, null, 2) + "\n", { flag: "wx" });
