import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { sha256 } from "./qualification-roster.mjs";

export function inventory(directory, base = directory, files = {}) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inventory(file, base, files);
    else if (entry.isFile()) files[path.relative(base, file).split(path.sep).join("/")] = sha256(readFileSync(file));
  }
  return files;
}

/** Compare complete package payloads and resolved dependencies, not npm/pnpm placement. */
export function packageInventory(directory) {
  const packages = {},
    visited = new Set();
  const manifest = (location) => JSON.parse(readFileSync(path.join(location, "package.json")));
  const identity = (value) => `${value.name}@${value.version}`;
  function visit(location) {
    const resolved = realpathSync(location);
    const declaration = manifest(resolved);
    const key = identity(declaration);
    if (visited.has(resolved)) return key;
    visited.add(resolved);
    const require = createRequire(path.join(resolved, "package.json"));
    const names = Object.keys({
      ...declaration.dependencies,
      ...declaration.optionalDependencies,
      ...declaration.peerDependencies,
    }).sort();
    const dependencies = {},
      roots = [];
    const fileSha256 = inventory(resolved);
    for (const name of names) {
      const target = require.resolve
        .paths(name)
        .map((base) => path.join(base, name))
        .find((candidate) => existsSync(path.join(candidate, "package.json")));
      if (!target) {
        assert.ok(
          name in (declaration.optionalDependencies ?? {}) || declaration.peerDependenciesMeta?.[name]?.optional,
          `Missing SDK dependency ${key} > ${name}`,
        );
        dependencies[name] = null;
        continue;
      }
      const installed = manifest(target);
      assert.equal(installed.name, name);
      dependencies[name] = identity(installed);
      roots.push(target);
      // These exact nested files are checked under the resolved package below.
      // Undeclared nested files remain in the payload and still reject borrowing.
      for (const file of Object.keys(fileSha256)) if (file.startsWith(`node_modules/${name}/`)) delete fileSha256[file];
    }
    const record = { fileSha256, dependencies };
    if (packages[key]) assert.deepEqual(record, packages[key], `SDK has differing copies of ${key}`);
    packages[key] = record;
    for (const target of roots) visit(target);
    return key;
  }
  return { root: visit(directory), packages };
}
