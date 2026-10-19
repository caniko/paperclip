import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import {
  checkForbiddenImports,
  defaultPackageRoot,
  findSpecifiers,
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

test("the parser ignores embedded fixtures but preserves executable imports and types", () => {
  const source = [
    '// import "comment";',
    '/* export * from "comment-export"; */',
    'const fixture = "import value from \\"fixture\\"";',
    'const template = `require("fixture-require"); import("fixture-dynamic")`;',
    'const pattern = /import\\("fixture-regex"\\)/;',
    'import "side-effect";',
    'import type { T } from "types";',
    'export { value } from "barrel";',
    'export * from "star";',
    'import equal = require("equal");',
    'type Imported = import("import-type").T;',
    'const cjs = require("cjs");',
    'const dynamic = import("dynamic", { with: { type: "json" } });',
    'const literal = import(`static-template`);',
    'const escaped = import("escaped\\u002dname");',
    'const interpolation = `text ${import("executed-interpolation")}`;',
  ].join("\n");
  const found = findSpecifiers(source);
  assert.deepEqual(found.map(({ specifier }) => specifier), [
    "side-effect", "types", "barrel", "star", "equal", "import-type", "cjs",
    "dynamic", "static-template", "escaped-name", "executed-interpolation",
  ]);
  assert.deepEqual(found.map(({ offset }) => source.slice(0, offset).split("\n").length),
    [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
});

test("the parser treats JSX fixture text separately from expression imports", () => {
  assert.deepEqual(findSpecifiers(
    '<div title={\'import("fixture")\'}>require("text") {import("executed")}</div>',
    "fixture.tsx",
  ).map(({ specifier }) => specifier), ["executed"]);
});

test("Rust include macros and path modules retain their boundary checks", () => {
  assert.deepEqual(findSpecifiers([
    'include!("../included.rs");',
    'include_str!("../text.txt");',
    'include_bytes!("../bytes.bin");',
    '#[path = "../module.rs"] mod module;',
  ].join("\n"), "source.rs").map(({ specifier }) => specifier),
  ["../included.rs", "../text.txt", "../bytes.bin", "../module.rs"]);
});

async function fixtureBoundary(t, { manifest = {}, files = {} } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "runner-import-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "src"), { recursive: true });
  await writeFile(resolve(root, "package.json"), JSON.stringify(manifest));
  for (const [file, source] of Object.entries(files)) {
    await mkdir(dirname(resolve(root, file)), { recursive: true });
    await writeFile(resolve(root, file), source);
  }
  return checkForbiddenImports({ packageRoot: root, scanRoots: ["src"], cargoRoots: [] });
}

const kernel = "@paperclipai/paperclip-eval-kernel";
const harness = "src/eval/workflow-harness.ts";
const reviewedManifest = {
  exports: { "./evals": "./dist/evals.js" },
  devDependencies: { [kernel]: "workspace:*" },
};

test("only exact declared public subpaths are admitted", async (t) => {
  const violations = await fixtureBoundary(t, {
    manifest: reviewedManifest,
    files: { "src/consumer.ts": [
      'import "@paperclipai/paperclip-runner/evals";',
      'import "@paperclipai/paperclip-runner/evals/private";',
      'import "@paperclipai/paperclip-runner/undeclared";',
    ].join("\n") },
  });
  assert.deepEqual(violations.map(({ specifier }) => specifier), [
    "@paperclipai/paperclip-runner/evals/private", "@paperclipai/paperclip-runner/undeclared",
  ]);
});

test("ADR0001 permits only the private development harness and reviewed package", async (t) => {
  assert.deepEqual(await fixtureBoundary(t, {
    manifest: reviewedManifest,
    files: { [harness]: `import { scenario } from "${kernel}";`, "src/evals.ts": "export const publicApi = true;" },
  }), []);
  for (const [file, specifier] of [
    ["src/other.ts", kernel], [harness, `${kernel}/private`], [harness, "@paperclipai/other"],
  ]) {
    const violations = await fixtureBoundary(t, {
      manifest: reviewedManifest, files: { [file]: `import "${specifier}";` },
    });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].specifier, specifier);
  }
  assert.equal((await fixtureBoundary(t, {
    files: { [harness]: `import "${kernel}";` },
  })).length, 1, "the exception requires the reviewed devDependency declaration");
});

test("the reviewed kernel is still forbidden in every production dependency group", async (t) => {
  for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const violations = await fixtureBoundary(t, {
      manifest: { ...reviewedManifest, [group]: { [kernel]: "workspace:*" } },
    });
    assert.equal(violations.length, 1, group);
    assert.equal(violations[0].specifier, kernel);
  }
});

test("direct or transitive public harness exposure revokes the dev-only exception", async (t) => {
  for (const entry of [
    "./dist/eval/workflow-harness.js",
    "./dist/evals.js",
  ]) {
    for (const imported of ["./eval/workflow-harness.js", "./eval/workflow-harness"]) {
      const violations = await fixtureBoundary(t, {
        manifest: { ...reviewedManifest, exports: { "./evals": { types: "./dist/evals.d.ts", import: entry } } },
        files: {
          [harness]: `import "${kernel}";`,
          "src/evals.ts": 'export * from "./barrel.js";',
          "src/barrel.ts": `export * from "${imported}";`,
        },
      });
      assert.equal(violations.length, 1, `${entry} via ${imported}`);
      assert.equal(violations[0].specifier, kernel);
    }
  }
});


test("unexpanded wildcard exports cannot expose the reviewed development harness", async (t) => {
  const violations = await fixtureBoundary(t, {
    manifest: { ...reviewedManifest, exports: { "./eval/*": "./dist/eval/*.js" } },
    files: { [harness]: `import "${kernel}";` },
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].specifier, kernel);
  assert.match(violations[0].reason, /outside the standalone boundary/);
});
