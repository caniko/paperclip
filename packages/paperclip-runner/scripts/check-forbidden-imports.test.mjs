import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  checkForbiddenImports,
  defaultPackageRoot,
} from "./lib/forbidden-imports.mjs";

test("the package passes its standalone boundary", async () => {
  assert.deepEqual(await checkForbiddenImports(), []);
});

test("a negative fixture proves that a core import is rejected", async () => {
  const violations = await checkForbiddenImports({
    scanRoots: ["test-fixtures/forbidden-import"],
    cargoRoots: [],
    checkManifest: false,
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].specifier, "../../../../server/src/services/heartbeat.js");
  assert.match(violations[0].reason, /may not escape/);
  assert.ok(violations[0].file.startsWith(defaultPackageRoot));
});

test("a negative Cargo fixture proves that a core path dependency is rejected", async () => {
  const violations = await checkForbiddenImports({
    scanRoots: [],
    cargoRoots: ["test-fixtures/forbidden-cargo-path"],
    checkManifest: false,
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].specifier, "../../../../server");
  assert.match(violations[0].reason, /Cargo path dependencies may not escape/);
  assert.ok(violations[0].file.startsWith(defaultPackageRoot));
});

test("a negative fixture proves that a browser UI runtime import is rejected", async () => {
  const violations = await checkForbiddenImports({
    scanRoots: ["devtools/browser", "test-fixtures/forbidden-ui-runtime/devtools/browser"],
    cargoRoots: [],
    checkManifest: false,
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].specifier, "@ai-sdk/react");
  assert.match(violations[0].reason, /adapts component source/);
  assert.ok(violations[0].file.startsWith(defaultPackageRoot));
});

test("a negative fixture proves that an SDK consumer deep import is rejected", async () => {
  const violations = await checkForbiddenImports({
    scanRoots: ["test-fixtures/forbidden-sdk-consumer/examples"],
    cargoRoots: [],
    checkManifest: false,
  });

  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /may not deep-import/);
});

const kernelName = "@paperclipai/paperclip-eval-kernel";

async function fixturePackage(t, { path = "src/eval/workflow-harness.ts", source = "", manifest = {} } = {}) {
  const packageRoot = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "runner-import-boundary-"));
  t.after(() => rm(packageRoot, { recursive: true, force: true }));
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await mkdir(dirname(join(packageRoot, path)), { recursive: true });
  await writeFile(join(packageRoot, path), source);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "@paperclipai/paperclip-runner",
    exports: { "./evals": { import: "./dist/evals/index.js" } },
    devDependencies: { [kernelName]: "workspace:*" },
    ...manifest,
  }));
  return checkForbiddenImports({ packageRoot, scanRoots: ["src"], cargoRoots: [] });
}

test("only the exact private workflow importer and development manifest admit the kernel root", async (t) => {
  assert.deepEqual(await fixturePackage(t, { source: `import { runPaperclipEvalMatrix } from "${kernelName}";` }), []);
});

test("declared evals consumers are allowed and undeclared/private deep subpaths remain rejected", async (t) => {
  assert.deepEqual(await fixturePackage(t, { path: "src/consumer.ts", source: 'import "@paperclipai/paperclip-runner/evals";' }), []);
  for (const specifier of ["@paperclipai/paperclip-runner/eval", "@paperclipai/paperclip-runner/src/eval/workflow-harness.js", "@paperclipai/paperclip-runner/evals/private"]) {
    const violations = await fixturePackage(t, { source: `import "${specifier}";` });
    assert.ok(violations.some((entry) => entry.specifier === specifier && /public subpaths/.test(entry.reason)));
  }
  const violations = await fixturePackage(t, { source: 'import "@paperclipai/paperclip-runner/evals";', manifest: { exports: {} } });
  assert.ok(violations.some((entry) => /public subpaths/.test(entry.reason)));
});

for (const path of ["src/index.ts", "src/evals/index.ts", "src/cli/leak.ts", "src/eval/other.ts"]) {
  for (const source of [
    `import "${kernelName}";`,
    `export type T = import("${kernelName}").PaperclipEvalCandidate;`,
    `export const load = () => import("${kernelName}");`,
    `export const load = () => require("${kernelName}");`,
  ]) {
    test(`kernel source exception cannot expand to ${path}: ${source}`, async (t) => {
      const violations = await fixturePackage(t, { path, source });
      assert.ok(violations.some((entry) => entry.specifier === kernelName && /standalone boundary/.test(entry.reason)));
    });
  }
}

test("kernel deep imports and non-workspace development aliases remain rejected", async (t) => {
  const violations = await fixturePackage(t, {
    source: `export * from "${kernelName}/dist/index.js";`,
    manifest: { devDependencies: { [kernelName]: "file:../paperclip-eval-kernel" } },
  });
  assert.equal(violations.length, 2);
});

for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  test(`runner kernel ${group} is still forbidden`, async (t) => {
    const violations = await fixturePackage(t, { manifest: { [group]: { [kernelName]: "workspace:*" } } });
    assert.ok(violations.some((entry) => entry.specifier === kernelName && /review/.test(entry.reason)));
  });
}

for (const specifier of ["@paperclipai/server", "@paperclipai/ui", "@paperclipai/cli", "@paperclipai/db", "@paperclipai/shared", "@paperclipai/adapter-utils", "@paperclipai/adapter-codex-local"]) {
  test(`runner still rejects application source and development dependency ${specifier}`, async (t) => {
    const violations = await fixturePackage(t, {
      source: `import type { Value } from "${specifier}";`,
      manifest: { devDependencies: { [kernelName]: "workspace:*", [specifier]: "workspace:*" } },
    });
    assert.equal(violations.length, 2);
    assert.ok(violations.every((entry) => entry.specifier === specifier));
  });
}

test("AST inspection ignores fixture string contents but checks long/escaped real module references", async (t) => {
  const violations = await fixturePackage(t, { path: "src/consumer.ts", source: [
    'const fixture = \'import "@paperclipai/db";\';',
    `import type { ${Array.from({ length: 100 }, (_, index) => `Type${index}`).join(", ")} } from "@paperclipai/shared";`,
    'import "@paperclipai/\\u0064b";',
  ].join("\n") });
  assert.equal(violations.length, 2);
  assert.deepEqual(violations.map((entry) => entry.specifier), ["@paperclipai/shared", "@paperclipai/db"]);
});
