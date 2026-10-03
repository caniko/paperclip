import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { checkEvalKernelBoundary, checkPublicRuntimeClosure } from "./lib/package-boundaries.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kernelName = "@paperclipai/paperclip-eval-kernel";
const appPackages = [
  "@paperclipai/server", "@paperclipai/ui", "@paperclipai/cli", "@paperclipai/db",
  "@paperclipai/shared", "@paperclipai/adapter-utils", "@paperclipai/adapter-codex-local",
  "@paperclipai/paperclip-runner", "@paperclipai/paperclip-runner/testing",
];

async function fixture(t, { runner = {}, kernel = {}, files = {} } = {}) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "runner-package-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runnerRoot = join(root, "runner");
  const kernelRoot = join(root, "paperclip-eval-kernel");
  const contents = {
    "runner/package.json": JSON.stringify({
      name: "@paperclipai/paperclip-runner", exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
      devDependencies: { [kernelName]: "workspace:*" }, ...runner,
    }),
    "runner/src/index.ts": "export const runtime = true;\n",
    "paperclip-eval-kernel/package.json": JSON.stringify({
      name: kernelName, private: true, devDependencies: { typescript: "^7.0.2", "@types/node": "^24.0.0" }, ...kernel,
    }),
    "paperclip-eval-kernel/src/index.ts": "export const kernel = true;\n",
    ...files,
  };
  for (const [path, source] of Object.entries(contents)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return { root, runnerRoot, kernelRoot };
}

test("the real kernel remains independent and every public export/bin closure excludes private eval code", async () => {
  assert.deepEqual(await checkEvalKernelBoundary({ kernelRoot: resolve(packageRoot, "../paperclip-eval-kernel") }), []);
  assert.deepEqual(await checkPublicRuntimeClosure({ packageRoot }), []);
});

test("generic local modules and declarations are allowed, including cycles", async (t) => {
  const { runnerRoot, kernelRoot } = await fixture(t, { files: {
    "runner/src/index.ts": 'export * from "./helper.js";\nexport type { Contract } from "./contract.js";',
    "runner/src/helper.ts": 'export * from "./index.js"; export const helper = true;',
    "runner/src/contract.d.ts": 'export interface Contract { readonly id: string }',
    "paperclip-eval-kernel/src/index.ts": 'export * from "./helper.js";',
    "paperclip-eval-kernel/src/helper.ts": 'export type Id = string;',
  } });
  assert.deepEqual(await checkEvalKernelBoundary({ kernelRoot }), []);
  assert.deepEqual(await checkPublicRuntimeClosure({ packageRoot: runnerRoot }), []);
});

for (const dependency of [...appPackages, "third-party-wrapper"]) {
  for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    test(`kernel rejects ${group} drift through ${dependency}`, async (t) => {
      const { kernelRoot } = await fixture(t, { kernel: { [group]: { [dependency]: "1.0.0" } } });
      const violations = await checkEvalKernelBoundary({ kernelRoot });
      assert.ok(violations.some((entry) => entry.specifier === dependency && /empty/.test(entry.reason)));
    });
  }
}

test("kernel cannot become public or acquire unreviewed development dependencies", async (t) => {
  const { kernelRoot } = await fixture(t, { kernel: { private: false, devDependencies: { "@paperclipai/shared": "workspace:*", "unreviewed-tool": "1" } } });
  const violations = await checkEvalKernelBoundary({ kernelRoot });
  assert.ok(violations.some((entry) => /private/.test(entry.reason)));
  for (const specifier of ["@paperclipai/shared", "unreviewed-tool"]) {
    assert.ok(violations.some((entry) => entry.specifier === specifier && /development/.test(entry.reason)));
  }
});

for (const dependency of appPackages) {
  for (const source of [
    `import "${dependency}";`,
    `export type { Value } from "${dependency}";`,
    `export type Value = import("${dependency}").Value;`,
    `export const value = import("${dependency}");`,
    `export const value = require("${dependency}");`,
  ]) {
    test(`kernel rejects source coupling: ${source}`, async (t) => {
      const { kernelRoot } = await fixture(t, { files: { "paperclip-eval-kernel/src/helper.ts": source } });
      const violations = await checkEvalKernelBoundary({ kernelRoot });
      assert.ok(violations.some((entry) => entry.specifier === dependency && /independent/.test(entry.reason)));
    });
  }
}

test("kernel rejects import-equals, declaration references, and package aliases", async (t) => {
  const { kernelRoot } = await fixture(t, { files: {
    "paperclip-eval-kernel/src/index.ts": 'import app = require("@paperclipai/shared"); export { app };',
    "paperclip-eval-kernel/src/contract.d.ts": '/// <reference types="@paperclipai/db" />\nexport type T = unknown;',
    "paperclip-eval-kernel/src/alias.ts": 'import "#app";',
  } });
  const violations = await checkEvalKernelBoundary({ kernelRoot });
  for (const specifier of ["@paperclipai/shared", "@paperclipai/db", "#app"]) {
    assert.ok(violations.some((entry) => entry.specifier === specifier));
  }
});

test("kernel local helper and symlink escapes fail", async (t) => {
  const { root, kernelRoot } = await fixture(t, { files: {
    "paperclip-eval-kernel/src/index.ts": 'export * from "./helper.js";',
    "paperclip-eval-kernel/src/helper.ts": 'export * from "../../runner/src/index.js";',
  } });
  await symlink(join(root, "runner/src/index.ts"), join(kernelRoot, "src/linked.ts"));
  const violations = await checkEvalKernelBoundary({ kernelRoot });
  assert.ok(violations.some((entry) => /escape/.test(entry.reason)));
  assert.ok(violations.some((entry) => /symlink/.test(entry.reason)));
});

test("kernel cannot hide source behind a directory symlink", async (t) => {
  const { root, kernelRoot } = await fixture(t);
  await rm(join(kernelRoot, "src"), { recursive: true });
  await symlink(join(root, "runner/src"), join(kernelRoot, "src"));
  const violations = await checkEvalKernelBoundary({ kernelRoot });
  assert.ok(violations.some((entry) => /symlink/.test(entry.reason)));
});

test("a wrapper cannot introduce an indirect kernel runtime dependency or undeclared source import", async (t) => {
  const { kernelRoot } = await fixture(t, {
    kernel: { dependencies: { wrapper: "1.0.0" } },
    files: {
      "paperclip-eval-kernel/src/index.ts": 'export * from "wrapper";',
      "paperclip-eval-kernel/node_modules/wrapper/package.json": JSON.stringify({ name: "wrapper", dependencies: { "@paperclipai/shared": "workspace:*" } }),
    },
  });
  const violations = await checkEvalKernelBoundary({ kernelRoot });
  assert.ok(violations.some((entry) => entry.specifier === "wrapper" && /empty/.test(entry.reason)));
  assert.ok(violations.some((entry) => entry.specifier === "wrapper" && /independent/.test(entry.reason)));
});

for (const source of [
  `export * from "${kernelName}";`,
  `export type T = import("${kernelName}").PaperclipEvalCandidate;`,
  `export const load = () => import("${kernelName}");`,
  `export const load = () => require("${kernelName}");`,
  'export * from "./eval/workflow-harness.js";',
]) {
  test(`public local barrel cannot leak kernel/workflow code: ${source}`, async (t) => {
    const { runnerRoot } = await fixture(t, { files: {
      "runner/src/index.ts": 'export * from "./barrel.js";',
      "runner/src/barrel.ts": source,
      "runner/src/eval/workflow-harness.ts": "export const matrix = true;",
    } });
    const violations = await checkPublicRuntimeClosure({ packageRoot: runnerRoot });
    assert.ok(violations.some((entry) => /private eval/.test(entry.reason)));
    assert.ok(violations.some((entry) => entry.reason.includes('export "."')));
  });
}

test("all export conditions, declaration targets, self subpaths, and bins are traversed", async (t) => {
  const { runnerRoot } = await fixture(t, { runner: {
    exports: {
      ".": "./dist/index.js",
      "./hidden": { browser: "./dist/hidden.js", types: "./src/public.d.ts" },
      "./self": "./dist/self.js",
    },
    bin: { "runner-leak": "./dist/cli/leak.js" },
  }, files: {
    "runner/src/hidden.ts": `import "${kernelName}";`,
    "runner/src/public.d.ts": `export type T = import("${kernelName}").PaperclipEvalCandidate;`,
    "runner/src/self.ts": 'export * from "@paperclipai/paperclip-runner/hidden";',
    "runner/src/cli/leak.ts": 'export * from "../eval/workflow-harness.js";',
    "runner/src/eval/workflow-harness.ts": "export const matrix = true;",
  } });
  const violations = await checkPublicRuntimeClosure({ packageRoot: runnerRoot });
  for (const label of ['export "./hidden"', 'export "./self"', 'bin "runner-leak"']) {
    assert.ok(violations.some((entry) => entry.reason.includes(label) && /private eval/.test(entry.reason)));
  }
  assert.ok(violations.some((entry) => entry.file.endsWith("public.d.ts")));
});

for (const source of [
  'export * from "./missing.js";',
  'export * from "./ambiguous.js";',
  'export const load = (path: string) => import(path);',
  'export const load = (path: string) => require(path);',
  'export * from "#local-alias";',
]) {
  test(`unresolved or ambiguous public modules fail pending review: ${source}`, async (t) => {
    const { runnerRoot } = await fixture(t, { files: {
      "runner/src/index.ts": source,
      "runner/src/ambiguous.ts": "export const ts = true;",
      "runner/src/ambiguous.tsx": "export const tsx = true;",
    } });
    const violations = await checkPublicRuntimeClosure({ packageRoot: runnerRoot });
    assert.ok(violations.some((entry) => /review/.test(entry.reason)));
  });
}

test("kernel unknown loaders, unresolved local modules, and parse errors fail", async (t) => {
  const { kernelRoot } = await fixture(t, { files: {
    "paperclip-eval-kernel/src/index.ts": 'export * from "./missing.js"; export const load = (x: string) => import(x);',
    "paperclip-eval-kernel/src/broken.ts": "export const broken = ;",
  } });
  const violations = await checkEvalKernelBoundary({ kernelRoot });
  assert.ok(violations.some((entry) => /literal/.test(entry.reason)));
  assert.ok(violations.some((entry) => /unresolved/.test(entry.reason)));
  assert.ok(violations.some((entry) => /parse/.test(entry.reason)));
});

for (const source of [
  `const load = require; export const value = load("${kernelName}");`,
  `import { createRequire as factory } from "node:module"; const load = factory(import.meta.url); export const value = load("${kernelName}");`,
  `import { createRequire } from "node:module"; export const value = createRequire(import.meta.url)("${kernelName}");`,
]) {
  test(`public require aliases cannot hide the kernel: ${source}`, async (t) => {
    const { runnerRoot } = await fixture(t, { files: { "runner/src/index.ts": source } });
    const violations = await checkPublicRuntimeClosure({ packageRoot: runnerRoot });
    assert.ok(violations.some((entry) => /private eval kernel/.test(entry.reason)));
  });
}

test("kernel rejects indirect loader factories and public unknown require aliases fail", async (t) => {
  const { runnerRoot, kernelRoot } = await fixture(t, { files: {
    "paperclip-eval-kernel/src/index.ts": 'import { createRequire } from "node:module"; const load = createRequire(import.meta.url);',
    "runner/src/index.ts": 'const load = require; export const value = (path: string) => load(path);',
  } });
  assert.ok((await checkEvalKernelBoundary({ kernelRoot })).some((entry) => /indirect/.test(entry.reason)));
  assert.ok((await checkPublicRuntimeClosure({ packageRoot: runnerRoot })).some((entry) => /literal/.test(entry.reason)));
});

test("public missing, escaping, and wildcard targets fail", async (t) => {
  const { runnerRoot } = await fixture(t, { runner: {
    exports: { ".": "./dist/missing.js", "./escape": "../paperclip-eval-kernel/src/index.ts", "./*": "./dist/*.js" },
  } });
  const violations = await checkPublicRuntimeClosure({ packageRoot: runnerRoot });
  for (const pattern of [/unresolved/, /escape/, /wildcard/]) {
    assert.ok(violations.some((entry) => pattern.test(entry.reason)));
  }
});

test("review P2.1: kernel follows safe outside-src declarations and helpers, including cycles", async (t) => {
  const { kernelRoot } = await fixture(t, { files: {
    "paperclip-eval-kernel/src/index.ts": 'export type { Contract } from "../types/contract.js";',
    "paperclip-eval-kernel/types/contract.d.ts": 'export * from "../lib/helper.js"; export interface Contract { id: string }',
    "paperclip-eval-kernel/lib/helper.ts": 'export * from "../src/index.js";',
  } });
  assert.deepEqual(await checkEvalKernelBoundary({ kernelRoot }), []);
});

test("review P2.1: kernel inspects application imports in outside-src declarations", async (t) => {
  const { kernelRoot } = await fixture(t, { files: {
    "paperclip-eval-kernel/src/index.ts": 'export type { Contract } from "../types/contract.js";',
    "paperclip-eval-kernel/types/contract.d.ts": 'export type { Contract } from "@paperclipai/shared";',
  } });
  const violations = await checkEvalKernelBoundary({ kernelRoot });
  assert.ok(violations.some((entry) => entry.file.endsWith("types/contract.d.ts") && entry.specifier === "@paperclipai/shared" && /independent/.test(entry.reason)));
});

test("review P2.1: kernel inspects package escapes in outside-src helpers", async (t) => {
  const { kernelRoot } = await fixture(t, { files: {
    "paperclip-eval-kernel/src/index.ts": 'export * from "../lib/helper.js";',
    "paperclip-eval-kernel/lib/helper.ts": 'export * from "../../runner/src/index.js";',
  } });
  const violations = await checkEvalKernelBoundary({ kernelRoot });
  assert.ok(violations.some((entry) => entry.file.endsWith("lib/helper.ts") && /escape/.test(entry.reason)));
});

for (const source of [
  `import { createRequire as factory } from "node:module"; const make = factory; const next = make; const load = next(import.meta.url); export const value = load("${kernelName}");`,
  `import * as module from "node:module"; const { createRequire: factory } = module; const make = factory; const load = make(import.meta.url); export const value = load("${kernelName}");`,
  `import { createRequire as factory } from "node:module"; const { make } = { make: factory }; const load = make(import.meta.url); export const value = load("${kernelName}");`,
  `import { createRequire as factory } from "node:module"; const factories = { factory }; const copy = factories; const { factory: make } = copy; const load = make(import.meta.url); export const value = load("${kernelName}");`,
]) {
  test(`review P2.2: public factory aliases cannot hide the kernel: ${source}`, async (t) => {
    const { runnerRoot } = await fixture(t, { files: { "runner/src/index.ts": source } });
    const violations = await checkPublicRuntimeClosure({ packageRoot: runnerRoot });
    assert.ok(violations.some((entry) => entry.specifier === kernelName && /private eval kernel/.test(entry.reason)));
  });
}

for (const source of [
  `/** @param {import("${kernelName}").PaperclipEvalCandidate} candidate */\nexport function run(candidate) { return candidate; }`,
  `/** @import { PaperclipEvalCandidate } from "${kernelName}" */\nexport function run() { return true; }`,
]) {
  test(`review P2.3: public JavaScript JSDoc references cannot leak the kernel: ${source}`, async (t) => {
    const { runnerRoot } = await fixture(t, { runner: { exports: { ".": "./src/public.js" } }, files: { "runner/src/public.js": source } });
    const violations = await checkPublicRuntimeClosure({ packageRoot: runnerRoot });
    assert.ok(violations.some((entry) => entry.specifier === kernelName && /private eval kernel/.test(entry.reason)));
  });
}

for (const source of [
  '/** @param {import("@paperclipai/shared").Contract} value */\nexport function use(value) { return value; }',
  '/** @import { Contract } from "@paperclipai/shared" */\nexport function use() { return true; }',
]) {
  test(`review P2.3: kernel JavaScript JSDoc references cannot hide application coupling: ${source}`, async (t) => {
    const { kernelRoot } = await fixture(t, { files: { "paperclip-eval-kernel/src/helper.js": source } });
    const violations = await checkEvalKernelBoundary({ kernelRoot });
    assert.ok(violations.some((entry) => entry.specifier === "@paperclipai/shared" && /independent/.test(entry.reason)));
  });
}

test("review P2.3: ordinary strings containing JSDoc imports are not module references", async (t) => {
  const source = 'export const fixture = \'/** @param {import("@paperclipai/shared").Contract} value */\\n/** @import { T } from "@paperclipai/paperclip-eval-kernel" */\';';
  const { runnerRoot, kernelRoot } = await fixture(t, { runner: { exports: { ".": "./src/public.js" } }, files: {
    "runner/src/public.js": source,
    "paperclip-eval-kernel/src/helper.js": source,
  } });
  assert.deepEqual(await checkEvalKernelBoundary({ kernelRoot }), []);
  assert.deepEqual(await checkPublicRuntimeClosure({ packageRoot: runnerRoot }), []);
});

for (const source of [
  `/** @param {import("${kernelName}").PaperclipEvalCandidate} candidate */\nexport function run(candidate: unknown) { return candidate; }`,
  `/** @import { PaperclipEvalCandidate } from "${kernelName}" */\nexport function run() { return true; }`,
]) {
  test(`review P2.3: public TypeScript attached JSDoc cannot leak the kernel: ${source}`, async (t) => {
    const { runnerRoot } = await fixture(t, { files: { "runner/src/index.ts": source } });
    const violations = await checkPublicRuntimeClosure({ packageRoot: runnerRoot });
    assert.ok(violations.some((entry) => entry.specifier === kernelName && /private eval kernel/.test(entry.reason)));
  });
}

test("review P2.3: kernel TypeScript attached JSDoc cannot hide application coupling", async (t) => {
  const { kernelRoot } = await fixture(t, { files: {
    "paperclip-eval-kernel/src/index.ts": '/** @param {import("@paperclipai/shared").Contract} value */\nexport function use(value: unknown) { return value; }',
    "paperclip-eval-kernel/src/helper.ts": '/** @import { Contract } from "@paperclipai/db" */\nexport function use() { return true; }',
  } });
  const violations = await checkEvalKernelBoundary({ kernelRoot });
  for (const specifier of ["@paperclipai/shared", "@paperclipai/db"]) assert.ok(violations.some((entry) => entry.specifier === specifier && /independent/.test(entry.reason)));
});

test("review P2.4: reference paths without dot prefixes resolve relative to their modules", async (t) => {
  const source = '/// <reference path="types.d.ts" />\nexport const value = true;';
  const contract = 'export interface Contract { id: string }';
  const { runnerRoot, kernelRoot } = await fixture(t, { files: {
    "runner/src/index.ts": source,
    "runner/src/types.d.ts": contract,
    "paperclip-eval-kernel/src/index.ts": source,
    "paperclip-eval-kernel/src/types.d.ts": contract,
  } });
  assert.deepEqual(await checkEvalKernelBoundary({ kernelRoot }), []);
  assert.deepEqual(await checkPublicRuntimeClosure({ packageRoot: runnerRoot }), []);
});

test("review P2.4: public reference paths traverse forbidden declaration closures", async (t) => {
  const { runnerRoot } = await fixture(t, { files: {
    "runner/src/index.ts": '/// <reference path="types.d.ts" />\nexport const value = true;',
    "runner/src/types.d.ts": `export type T = import("${kernelName}").PaperclipEvalCandidate;`,
  } });
  const violations = await checkPublicRuntimeClosure({ packageRoot: runnerRoot });
  assert.ok(violations.some((entry) => entry.file.endsWith("types.d.ts") && entry.specifier === kernelName && /private eval kernel/.test(entry.reason)));
});

test("review P2.4: kernel reference paths traverse forbidden declaration closures", async (t) => {
  const { kernelRoot } = await fixture(t, { files: {
    "paperclip-eval-kernel/src/index.ts": '/// <reference path="types.d.ts" />\nexport const value = true;',
    "paperclip-eval-kernel/src/types.d.ts": 'export type T = import("@paperclipai/shared").Contract;',
  } });
  const violations = await checkEvalKernelBoundary({ kernelRoot });
  assert.ok(violations.some((entry) => entry.specifier === "types.d.ts" && /independent/.test(entry.reason)) === false);
  assert.ok(violations.some((entry) => entry.specifier === "@paperclipai/shared" && /independent/.test(entry.reason)));
});

test("review P2.4: package type directives admit reviewed Node types without runtime dependencies", async (t) => {
  const source = '/// <reference types="node" />\nexport const value = true;';
  const { runnerRoot, kernelRoot } = await fixture(t, { runner: { devDependencies: { [kernelName]: "workspace:*", "@types/node": "^24" } }, files: {
    "runner/src/index.ts": source,
    "paperclip-eval-kernel/src/index.ts": source,
  } });
  assert.deepEqual(await checkEvalKernelBoundary({ kernelRoot }), []);
  assert.deepEqual(await checkPublicRuntimeClosure({ packageRoot: runnerRoot }), []);
});

test("review P2.4: package type directives still reject application and undeclared type packages", async (t) => {
  const source = '/// <reference types="@paperclipai/shared" />\n/// <reference types="unreviewed-types" />\nexport const value = true;';
  const { runnerRoot, kernelRoot } = await fixture(t, { files: {
    "runner/src/index.ts": source,
    "paperclip-eval-kernel/src/index.ts": source,
  } });
  for (const violations of [await checkEvalKernelBoundary({ kernelRoot }), await checkPublicRuntimeClosure({ packageRoot: runnerRoot })]) {
    for (const specifier of ["@paperclipai/shared", "unreviewed-types"]) assert.ok(violations.some((entry) => entry.specifier === specifier));
  }
});

for (const target of ["dist/cli.js", "scripts/cli.mjs"]) {
  test(`review P2.5: bin ${target} is a valid package-relative root without a dot prefix`, async (t) => {
    const { runnerRoot } = await fixture(t, { runner: { bin: target }, files: {
      "runner/src/cli.ts": 'export * from "../types/contract.js";',
      "runner/scripts/cli.mjs": 'export * from "../types/contract.js";',
      "runner/types/contract.d.ts": 'export interface Contract { id: string }',
    } });
    assert.deepEqual(await checkPublicRuntimeClosure({ packageRoot: runnerRoot }), []);
  });
  test(`review P2.5: bin ${target} still traverses kernel leaks`, async (t) => {
    const { runnerRoot } = await fixture(t, { runner: { bin: { "runner-leak": target } }, files: {
      "runner/src/cli.ts": `export * from "${kernelName}";`,
      "runner/scripts/cli.mjs": `export * from "${kernelName}";`,
    } });
    const violations = await checkPublicRuntimeClosure({ packageRoot: runnerRoot });
    assert.ok(violations.some((entry) => entry.reason.includes('bin "runner-leak"') && /private eval kernel/.test(entry.reason)));
  });
}

test("review P2.5: package-relative bins retain containment and symlink protection", async (t) => {
  const { root, runnerRoot } = await fixture(t, { runner: { bin: { outside: "../paperclip-eval-kernel/src/index.ts", linked: "scripts/linked.mjs" } } });
  await mkdir(join(runnerRoot, "scripts"));
  await symlink(join(root, "paperclip-eval-kernel/src/index.ts"), join(runnerRoot, "scripts/linked.mjs"));
  const violations = await checkPublicRuntimeClosure({ packageRoot: runnerRoot });
  assert.ok(violations.some((entry) => entry.reason.includes('bin "outside"') && /escape/.test(entry.reason)));
  assert.ok(violations.some((entry) => entry.reason.includes('bin "linked"') && /symlink/.test(entry.reason)));
});
