import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReleasePackagePlan,
  checkConfiguration,
  findUnpublishableWorkspaceEdges,
  getReleasePackages,
  loadReleaseManifest,
  packOnlyPackageNames,
} from "./release-package-map.mjs";

function pkg(name, { publishFromCi, packOnly, ...deps } = {}) {
  return { name, dir: name, publishFromCi, packOnly, pkg: { name, ...deps } };
}

test("release package manifest covers all public packages with explicit CI enrollment", () => {
  const packages = buildReleasePackagePlan();
  assert.ok(packages.length > 0);
  assert.ok(packages.every((pkg) => typeof pkg.publishFromCi === "boolean"));
});

test("release package list only contains CI-enrolled and pack-only packages", () => {
  const enabledPackages = getReleasePackages();
  assert.ok(enabledPackages.length > 0);
  assert.ok(enabledPackages.every((pkg) => pkg.publishFromCi === true || pkg.packOnly === true));
});

test("T3 is pack-only and stays in the release list before the server", () => {
  const name = "@paperclipai/adapter-t3code-local";
  const packages = getReleasePackages();
  const t3Index = packages.findIndex((pkg) => pkg.name === name);
  const serverIndex = packages.findIndex((pkg) => pkg.name === "@paperclipai/server");

  assert.ok(t3Index >= 0 && t3Index < serverIndex);
  assert.equal(packages[t3Index].publishFromCi, false);
  assert.equal(packages[t3Index].packOnly, true);
  assert.deepEqual(packOnlyPackageNames(), [name]);
});

test("manifest only accepts packOnly:true with publishFromCi:false", () => {
  const entry = { dir: "packages/a", name: "@paperclipai/a", publishFromCi: false };
  assert.doesNotThrow(() => loadReleaseManifest([{ ...entry, packOnly: true }]));
  for (const invalid of [
    { ...entry, publishFromCi: true, packOnly: true },
    ...[false, null, "true", 1].map((packOnly) => ({ ...entry, packOnly })),
  ]) {
    assert.throws(() => loadReleaseManifest([invalid]), /"packOnly" must be true and requires "publishFromCi": false/);
  }
});

test("release package list publishes the installable channel entrypoint last", () => {
  const enabledPackages = getReleasePackages();

  assert.equal(enabledPackages.at(-1)?.name, "paperclipai");
  assert.ok(enabledPackages.slice(0, -1).some((pkg) => pkg.name === "@paperclipai/server"));
});

test("release package list keeps runtime workspace dependencies ahead of consumers", () => {
  const enabledPackages = getReleasePackages();
  const publishIndexByName = new Map(enabledPackages.map((pkg, index) => [pkg.name, index]));

  for (const pkg of enabledPackages) {
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dependencyName, spec] of Object.entries(pkg.pkg[section] ?? {})) {
        if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
        const dependencyIndex = publishIndexByName.get(dependencyName);
        if (dependencyIndex === undefined) continue;

        assert.ok(
          dependencyIndex < publishIndexByName.get(pkg.name),
          `${dependencyName} must publish before ${pkg.name}`,
        );
      }
    }
  }
});

test("Hermes release surface publishes the unified built-in package and keeps gateway as a shim", () => {
  const packages = buildReleasePackagePlan();
  const hermes = packages.find((pkg) => pkg.name === "@paperclipai/hermes-paperclip-adapter");
  const gatewayShim = packages.find((pkg) => pkg.name === "@paperclipai/adapter-hermes-gateway");

  assert.equal(hermes?.dir, "packages/adapters/hermes");
  assert.equal(hermes?.publishFromCi, true);
  assert.equal(gatewayShim?.dir, "packages/adapters/hermes-gateway");
  assert.equal(gatewayShim?.publishFromCi, false);
});

test("release package configuration validates successfully", () => {
  assert.doesNotThrow(() => checkConfiguration());
});

test("guard flags a publishFromCi:true package depending on a publishFromCi:false package", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      dependencies: { "@paperclipai/skills-catalog": "workspace:*" },
    }),
    pkg("@paperclipai/skills-catalog", { publishFromCi: false }),
  ]);

  assert.equal(problems.length, 1);
  assert.match(problems[0], /@paperclipai\/server/);
  assert.match(problems[0], /@paperclipai\/skills-catalog/);
  assert.match(problems[0], /neither publishFromCi:true nor packOnly:true/);
});

test("guard inspects optional and peer dependency sections too", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      optionalDependencies: { "@paperclipai/opt": "workspace:^" },
      peerDependencies: { "@paperclipai/peer": "workspace:*" },
    }),
    pkg("@paperclipai/opt", { publishFromCi: false }),
    pkg("@paperclipai/peer", { publishFromCi: false }),
  ]);

  assert.equal(problems.length, 2);
});

test("guard treats a workspace dep on an unknown @paperclipai package as unpublishable", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      dependencies: { "@paperclipai/private-internal": "workspace:*" },
    }),
  ]);

  assert.equal(problems.length, 1);
});

test("guard allows true->true workspace edges", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      dependencies: { "@paperclipai/shared": "workspace:*" },
    }),
    pkg("@paperclipai/shared", { publishFromCi: true }),
  ]);

  assert.deepEqual(problems, []);
});

test("guard allows CI-enrolled packages to depend on pack-only packages", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      dependencies: { "@paperclipai/packed": "workspace:*" },
    }),
    pkg("@paperclipai/packed", { publishFromCi: false, packOnly: true }),
  ]);

  assert.deepEqual(problems, []);
});

test("guard also validates workspace edges from pack-only packages", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/packed", {
      publishFromCi: false,
      packOnly: true,
      dependencies: { "@paperclipai/disabled": "workspace:*" },
    }),
    pkg("@paperclipai/disabled", { publishFromCi: false }),
  ]);

  assert.equal(problems.length, 1);
});

test("guard ignores non-workspace specs, non-internal deps, and edges from off-train packages", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      dependencies: {
        "@paperclipai/pinned": "0.3.1",
        zod: "^3.0.0",
      },
    }),
    pkg("@paperclipai/pinned", { publishFromCi: false }),
    pkg("@paperclipai/offtrain", {
      publishFromCi: false,
      dependencies: { "@paperclipai/also-off": "workspace:*" },
    }),
    pkg("@paperclipai/also-off", { publishFromCi: false }),
  ]);

  assert.deepEqual(problems, []);
});

test("the live release manifest has no unpublishable workspace edges", () => {
  assert.deepEqual(findUnpublishableWorkspaceEdges(buildReleasePackagePlan()), []);
});
