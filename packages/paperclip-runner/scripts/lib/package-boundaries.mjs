import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import * as ts from "typescript/unstable/ast";

export const EVAL_KERNEL_PACKAGE = "@paperclipai/paperclip-eval-kernel";
export const EVAL_KERNEL_IMPORTER = "src/eval/workflow-harness.ts";
const MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const RUNTIME_GROUPS = ["dependencies", "optionalDependencies", "peerDependencies"];
const REVIEWED_KERNEL_DEV_DEPENDENCIES = new Set(["typescript", "@types/node"]);

export function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path));
}

function violation(file, specifier, reason, line = 1) {
  return { file, line, specifier, reason };
}

function isStringLiteralLike(node) {
  return ts.isStringLiteral(node) || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral;
}

async function collectModules(root) {
  const files = [];
  const violations = [];
  if ((await lstat(root)).isSymbolicLink()) {
    return { files, violations: [violation(root, root, "source directory symlinks require an explicit boundary review")] };
  }
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        violations.push(violation(path, path, "source symlinks require an explicit boundary review"));
      } else if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && MODULE_EXTENSIONS.has(extname(entry.name))) {
        files.push(path);
      }
    }
  }
  await walk(root);
  return { files: files.sort(), violations };
}

/** Parse only: virtual no-emit/no-resolve project, no typecheck or filesystem writes. */
export async function readModuleReferences(files, root) {
  if (files.length === 0) return new Map();
  const contents = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")])));
  const config = resolve(root, ".paperclip-boundary.tsconfig.json");
  contents[config] = JSON.stringify({
    compilerOptions: { noEmit: true, noResolve: true, noLib: true, types: [], allowJs: true, jsx: "preserve" },
    files,
  });
  const api = new API({ cwd: root, fs: createVirtualFileSystem(contents) });
  let snapshot;
  try {
    snapshot = api.updateSnapshot({ openProjects: [config] });
    const program = snapshot.getProject(config)?.program;
    if (program === undefined) throw new Error("TypeScript boundary parser could not open its virtual project");
    const graph = new Map();
    for (const file of files) {
      const source = program.getSourceFile(file);
      if (source === undefined) throw new Error(`TypeScript boundary parser did not load ${file}`);
      const references = [];
      const requireNames = new Set(["require"]);
      const factoryNames = new Set(["createRequire"]);
      const loaderObjects = new Map();
      const referenceKeys = new Set();
      const diagnostics = program.getSyntacticDiagnostics(file).map((diagnostic) =>
        violation(file, file, `module parse failed; boundary review required: ${diagnostic.messageText}`));
      const add = (specifier, offset, reason, details = {}) => {
        const key = JSON.stringify([specifier, offset, reason, details]);
        if (referenceKeys.has(key)) return;
        referenceKeys.add(key);
        references.push({
          specifier, offset, line: source.getLineAndCharacterOfPosition(offset).line + 1, ...(reason === undefined ? {} : { reason }),
          ...details,
        });
      };
      const propertyKind = (node) => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
        ? loaderObjects.get(node.expression.text)?.get(node.name.text) : undefined;
      const isFactory = (node) => ts.isIdentifier(node) && factoryNames.has(node.text)
        || ts.isPropertyAccessExpression(node) && node.name.text === "createRequire"
        || propertyKind(node) === "factory";
      const isRequire = (node) => ts.isIdentifier(node) && requireNames.has(node.text)
        || ts.isPropertyAccessExpression(node) && node.name.text === "require"
        || propertyKind(node) === "require"
        || ts.isCallExpression(node) && isFactory(node.expression);
      const moduleLoaders = new Map([["createRequire", "factory"]]);
      function objectLoaders(node) {
        if (ts.isIdentifier(node)) return loaderObjects.get(node.text);
        if (ts.isAwaitExpression(node)) return objectLoaders(node.expression);
        if (ts.isCallExpression(node) && (
          node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequire(node.expression)
        ) && node.arguments[0] !== undefined && isStringLiteralLike(node.arguments[0]) && ["node:module", "module"].includes(node.arguments[0].text)) return moduleLoaders;
        if (!ts.isObjectLiteralExpression(node)) return undefined;
        const properties = new Map();
        for (const property of node.properties) {
          const value = ts.isPropertyAssignment(property) ? property.initializer
            : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
          if (value === undefined) continue;
          const kind = isFactory(value) ? "factory" : isRequire(value) ? "require" : undefined;
          if (kind !== undefined) properties.set(property.name.text, kind);
        }
        return properties;
      }
      function collectLoaders(node) {
        if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "createRequire") factoryNames.add(node.name.text);
        if (ts.isImportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier) && ["node:module", "module"].includes(node.moduleSpecifier.text)) {
          const clause = node.importClause;
          if (clause?.name !== undefined) loaderObjects.set(clause.name.text, moduleLoaders);
          if (clause?.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) loaderObjects.set(clause.namedBindings.name.text, moduleLoaders);
        }
        if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
          const properties = objectLoaders(node.initializer);
          if (ts.isIdentifier(node.name)) {
            if (isFactory(node.initializer)) factoryNames.add(node.name.text);
            if (isRequire(node.initializer)) requireNames.add(node.name.text);
            if (properties !== undefined && properties.size > 0) {
              const known = loaderObjects.get(node.name.text) ?? new Map();
              for (const [name, kind] of properties) known.set(name, kind);
              loaderObjects.set(node.name.text, known);
            }
          } else if (ts.isObjectBindingPattern(node.name)) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const kind = properties?.get((element.propertyName ?? element.name).text);
              if (kind === "factory") factoryNames.add(element.name.text);
              if (kind === "require") requireNames.add(element.name.text);
            }
          }
        }
        node.forEachChild(collectLoaders);
      }
      const countLoaders = () => requireNames.size + factoryNames.size + [...loaderObjects.values()].reduce((count, properties) => count + properties.size, 0);
      let loaderCount;
      do {
        loaderCount = countLoaders();
        collectLoaders(source);
      } while (loaderCount !== countLoaders());
      function literal(node, owner, details) {
        if (node !== undefined && isStringLiteralLike(node)) add(node.text, owner.getStart(source), undefined, details);
        else add(null, owner.getStart(source), "module loaders require a literal specifier; boundary review required", details);
      }
      const visitedNodes = new Set();
      function visit(node) {
        if (visitedNodes.has(node)) return;
        visitedNodes.add(node);
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isJSDocImportTag(node)) {
          if (node.moduleSpecifier !== undefined) literal(node.moduleSpecifier, node);
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
          literal(node.moduleReference.expression, node);
        } else if (ts.isImportTypeNode(node)) {
          literal(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, node);
        } else if (ts.isModuleDeclaration(node) && isStringLiteralLike(node.name)) {
          literal(node.name, node);
        } else if (ts.isCallExpression(node)) {
          const expression = node.expression;
          const resolveOnly = ts.isPropertyAccessExpression(expression) && expression.name.text === "resolve" && isRequire(expression.expression);
          if (expression.kind === ts.SyntaxKind.ImportKeyword || isRequire(expression) || resolveOnly) {
            literal(node.arguments[0], node, { resourceOnly: resolveOnly });
          }
          if (isFactory(expression)) add("node:module", node.getStart(source), undefined, { loaderFactory: true });
        }
        node.forEachChild(visit);
        for (const doc of node.jsDoc ?? []) visit(doc);
      }
      visit(source);
      for (const reference of source.referencedFiles) add(reference.fileName, reference.pos, undefined, { referenceKind: "path" });
      for (const reference of source.typeReferenceDirectives) add(reference.fileName, reference.pos, undefined, { referenceKind: "types" });
      graph.set(file, { references, diagnostics });
    }
    return graph;
  } finally {
    snapshot?.dispose();
    api.close();
  }
}

async function existingFile(path) {
  try {
    const info = await lstat(path);
    return info.isFile() || info.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

// Map compiled JS/declaration paths back to source without reading stale dist.
// Multiple source candidates or unsupported mappings always require review.
async function resolveLocalModule(root, file, specifier) {
  let target = resolve(dirname(file), specifier);
  if (!isInside(root, target)) return { reason: "local modules may not escape the package boundary" };
  const path = relative(root, target).split(/[\\/]/).join("/");
  if (path.startsWith("dist/")) target = resolve(root, "src", path.slice("dist/".length));
  let candidates;
  if (/\.(?:d\.)?(?:m|c)?(?:js|ts)$/.test(target)) {
    const stem = target.replace(/\.(?:d\.)?(?:m|c)?(?:js|ts)$/, "");
    const extensions = /\.(?:mjs|mts)$/.test(target) ? [".mts", ".d.mts", ".mjs"]
      : /\.(?:cjs|cts)$/.test(target) ? [".cts", ".d.cts", ".cjs"]
        : [".ts", ".tsx", ".d.ts", ".js", ".jsx"];
    candidates = extensions.map((extension) => stem + extension);
  } else if (extname(target) === "") {
    candidates = [".ts", ".tsx", ".d.ts", ".js", ".jsx"].flatMap((extension) => [target + extension, resolve(target, "index" + extension)]);
  } else {
    candidates = [target];
  }
  const found = [];
  for (const candidate of candidates) if (await existingFile(candidate)) found.push(candidate);
  if (found.length !== 1) return { reason: `${found.length === 0 ? "unresolved" : "ambiguous"} local module ${JSON.stringify(specifier)}; boundary review required` };
  const concrete = await realpath(found[0]);
  if (!isInside(root, concrete)) return { reason: "local module symlinks may not escape the package boundary" };
  if (!MODULE_EXTENSIONS.has(extname(concrete)) && ![".json", ".css"].includes(extname(concrete))) {
    return { reason: "unsupported local module kind; boundary review required" };
  }
  return { file: concrete };
}

export async function checkEvalKernelBoundary({ kernelRoot }) {
  kernelRoot = await realpath(kernelRoot);
  const manifestPath = resolve(kernelRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const violations = [];
  if (manifest.name !== EVAL_KERNEL_PACKAGE || manifest.private !== true) {
    violations.push(violation(manifestPath, manifest.name, "eval kernel must remain the named workspace-private development package"));
  }
  for (const group of RUNTIME_GROUPS) {
    for (const dependency of Object.keys(manifest[group] ?? {})) {
      violations.push(violation(manifestPath, dependency, `eval kernel ${group} must remain empty; transitive runtime additions require boundary review`));
    }
  }
  for (const dependency of Object.keys(manifest.devDependencies ?? {})) {
    if (!REVIEWED_KERNEL_DEV_DEPENDENCIES.has(dependency)) {
      violations.push(violation(manifestPath, dependency, "eval kernel development dependency requires boundary review"));
    }
  }
  const modules = await collectModules(resolve(kernelRoot, "src"));
  violations.push(...modules.violations);
  if (modules.files.length === 0) violations.push(violation(manifestPath, "src", "eval kernel must contain inspectable source modules"));
  const graph = await readModuleReferences(modules.files, kernelRoot);
  const queue = [...modules.files];
  const seen = new Set();
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!graph.has(file) && MODULE_EXTENSIONS.has(extname(file))) {
      const parsed = await readModuleReferences([file], kernelRoot);
      graph.set(file, parsed.get(file));
    }
    const module = graph.get(file);
    if (module === undefined) continue; // Validated JSON/CSS leaf.
    const { references, diagnostics } = module;
    violations.push(...diagnostics);
    for (const reference of references) {
      let reason = reference.reason;
      if (reference.loaderFactory) reason = "eval kernel indirect module loaders require an explicit boundary review";
      if (reason === undefined) {
        if (reference.referenceKind === "path" || reference.specifier.startsWith(".")) {
          const target = await resolveLocalModule(kernelRoot, file, reference.specifier);
          reason = target.reason;
          if (reason === undefined) queue.push(target.file);
        } else if (reference.referenceKind === "types" && reference.specifier === "node" && Object.hasOwn(manifest.devDependencies ?? {}, "@types/node")) {
          // Node's reviewed development types are not a runtime dependency.
        } else if (!isBuiltin(reference.specifier)) {
          reason = "eval kernel must remain independent: only package-local modules and Node builtins are admitted";
        }
      }
      if (reason !== undefined) violations.push(violation(file, reference.specifier, reason, reference.line));
    }
  }
  return violations;
}

function exportTargets(value, label, violations, manifestPath) {
  if (value === null) return [];
  if (typeof value === "string") {
    if (value.includes("*")) {
      violations.push(violation(manifestPath, value, `${label}: wildcard export targets require boundary review`));
      return [];
    }
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((entry) => exportTargets(entry, label, violations, manifestPath));
  if (value !== null && typeof value === "object") return Object.values(value).flatMap((entry) => exportTargets(entry, label, violations, manifestPath));
  violations.push(violation(manifestPath, String(value), `${label}: unsupported export target requires boundary review`));
  return [];
}

export async function checkPublicRuntimeClosure({ packageRoot }) {
  packageRoot = await realpath(packageRoot);
  const manifestPath = resolve(packageRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const violations = [];
  const exports = manifest.exports ?? {};
  const exportMap = typeof exports === "object" && !Array.isArray(exports) && exports !== null && Object.keys(exports).some((key) => key.startsWith("."))
    ? exports : { ".": exports };
  const roots = [];
  const publicPaths = new Map();
  for (const [subpath, value] of Object.entries(exportMap)) {
    const label = `export ${JSON.stringify(subpath)}`;
    if (subpath.includes("*")) {
      violations.push(violation(manifestPath, subpath, `${label}: wildcard exports require boundary review`));
      continue;
    }
    const targets = exportTargets(value, label, violations, manifestPath);
    publicPaths.set(subpath === "." ? manifest.name : manifest.name + subpath.slice(1), targets);
    roots.push(...targets.map((target) => ({ label, target })));
  }
  for (const [name, target] of Object.entries(typeof manifest.bin === "string" ? { [manifest.name]: manifest.bin } : manifest.bin ?? {})) {
    roots.push(...exportTargets(target, `bin ${JSON.stringify(name)}`, violations, manifestPath).map((target) => ({
      label: `bin ${JSON.stringify(name)}`,
      // Unlike exports, npm bin paths may omit ./; still resolve inside the package.
      target: target.startsWith("./") || isAbsolute(target) || /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : `./${target}`,
    })));
  }
  const modules = await collectModules(resolve(packageRoot, "src"));
  const sourceFiles = new Set(modules.files);
  const extraFiles = new Set();
  // Explicit package-local script/JS/declaration exports are also roots, not just src.
  for (const { label, target } of roots) {
    if (!target.startsWith("./")) {
      violations.push(violation(manifestPath, target, `${label}: export/bin targets may not escape or alias the package boundary`));
      continue;
    }
    const result = await resolveLocalModule(packageRoot, manifestPath, target);
    if (result.reason !== undefined) violations.push(violation(manifestPath, target, `${label}: ${result.reason}`));
    else if (MODULE_EXTENSIONS.has(extname(result.file)) && !sourceFiles.has(result.file)) extraFiles.add(result.file);
  }
  const graph = await readModuleReferences([...sourceFiles, ...extraFiles], packageRoot);
  // Follow local files outside src (for example a declared script bin) lazily.
  async function load(file) {
    if (!graph.has(file) && MODULE_EXTENSIONS.has(extname(file))) {
      const parsed = await readModuleReferences([file], packageRoot);
      graph.set(file, parsed.get(file));
    }
    return graph.get(file);
  }
  for (const { label, target } of roots) {
    if (!target.startsWith("./")) continue;
    const entry = await resolveLocalModule(packageRoot, manifestPath, target);
    if (entry.reason !== undefined) continue;
    const queue = [entry.file];
    const seen = new Set();
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      const relativeFile = relative(packageRoot, file).split(/[\\/]/).join("/");
      if (relativeFile.startsWith("src/eval/") || relativeFile.startsWith("dist/eval/")) {
        violations.push(violation(file, relativeFile, `${label}: public closure reaches private eval implementation`));
        continue;
      }
      const module = await load(file);
      if (module === undefined) continue; // Validated JSON/CSS leaf.
      violations.push(...module.diagnostics.map((entry) => ({ ...entry, reason: `${label}: ${entry.reason}` })));
      for (const reference of module.references) {
        const specifier = reference.specifier;
        // Provider metadata resolution is not a module load. Literal resolver
        // targets are still inspected; unknown executable module loads fail.
        if (specifier === null && reference.resourceOnly) continue;
        let reason = reference.reason;
        let targets = [];
        if (reason === undefined) {
          if (reference.referenceKind === "path") {
            targets = [{ file, specifier }];
          } else if (specifier === EVAL_KERNEL_PACKAGE || specifier.startsWith(`${EVAL_KERNEL_PACKAGE}/`)) {
            reason = "public closure reaches private eval kernel";
          } else if (specifier.startsWith(".")) {
            targets = [{ file, specifier }];
          } else if (publicPaths.has(specifier)) {
            targets = publicPaths.get(specifier).map((specifier) => ({ file: manifestPath, specifier }));
          } else if (specifier.startsWith("@paperclipai/") || ["server", "ui", "cli"].some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
            reason = "public closure may not couple to Paperclip workspace implementations";
          } else if (specifier.startsWith("#") || isAbsolute(specifier) || /^(?:file|https?):/.test(specifier)) {
            reason = "unsupported module alias or location; boundary review required";
          } else if (!isBuiltin(specifier)) {
            const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
            const typesPackage = packageName.startsWith("@types/") ? packageName : `@types/${packageName.replace(/^@/, "").replace("/", "__")}`;
            const declaredTypes = reference.referenceKind === "types" && [...RUNTIME_GROUPS, "devDependencies"].some((group) => Object.hasOwn(manifest[group] ?? {}, typesPackage));
            if (!declaredTypes && !RUNTIME_GROUPS.some((group) => Object.hasOwn(manifest[group] ?? {}, packageName))) {
              reason = "public closure reaches an undeclared runtime dependency; boundary review required";
            }
          }
        }
        if (reason !== undefined) violations.push(violation(file, specifier, `${label}: ${reason}`, reference.line));
        for (const target of targets) {
          const result = await resolveLocalModule(packageRoot, target.file, target.specifier);
          if (result.reason !== undefined) violations.push(violation(file, specifier, `${label}: ${result.reason}`, reference.line));
          else queue.push(result.file);
        }
      }
    }
  }
  return violations;
}
