import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { collectRows, sha256 } from "./qualification-roster.mjs";

function relativeSource(file, root) {
  const resolved = realpathSync(file);
  const relative = path.relative(realpathSync(root), resolved).split(path.sep).join("/");
  assert.ok(relative && !relative.startsWith("../") && !path.isAbsolute(relative), "Imported declaration source escapes the checkout");
  return relative;
}

// Only side-effect imports of real test sources can establish this provenance.
// Any declaration, export, setup code or non-test import leaves the entry point
// to the ordinary parser. Never infer an import edge from a matching title.
export function importEntries(specifications, root) {
  const entries = [];
  for (const specification of specifications) {
    const file = relativeSource(specification.moduleId, root);
    const text = readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    assert.equal(ast.parseDiagnostics.length, 0, `Invalid declaration source: ${file}`);
    if (!ast.statements.length || !ast.statements.every(statement =>
      ts.isImportDeclaration(statement) && !statement.importClause
      && ts.isStringLiteral(statement.moduleSpecifier)
      && /^\.{1,2}\/.+\.test\.(?:js|ts)$/.test(statement.moduleSpecifier.text))) continue;
    const sources = ast.statements.map(statement => {
      const imported = statement.moduleSpecifier.text;
      const target = path.resolve(root, path.dirname(file), imported.replace(/\.js$/, ".ts"));
      const source = relativeSource(target, root);
      return { file: source, sha256: sha256(readFileSync(path.join(root, source))), import: imported };
    });
    assert.equal(new Set(sources.map(source => source.file)).size, sources.length, "Duplicate declaration import");
    entries.push({ file, project: specification.project.name, pool: specification.pool,
      sha256: sha256(text), sources });
  }
  return entries;
}

// Public Vitest 5.0.3 TestProject.createSpecification keeps the importing
// project's actual environment and transforms for an otherwise undiscovered
// declaration source. Keep these supplemental specifications separate.
// https://github.com/vitest-dev/vitest/blob/v5.0.3/packages/vitest/src/node/project.ts
export function supplementalSpecifications(specifications, entries, root) {
  const known = new Set(specifications.map(spec => JSON.stringify([spec.project.name, spec.moduleId, spec.pool])));
  const additional = [];
  for (const entry of entries) {
    const importer = specifications.find(spec => spec.moduleId === path.resolve(root, entry.file)
      && spec.project.name === entry.project && spec.pool === entry.pool);
    assert.ok(importer, "Declaration importer specification is missing");
    for (const source of entry.sources) {
      const spec = importer.project.createSpecification(path.resolve(root, source.file));
      const key = JSON.stringify([spec.project.name, spec.moduleId, spec.pool]);
      if (!known.has(key)) {
        additional.push(spec);
        known.add(key);
      }
    }
  }
  return additional;
}

function registrationRows(module, root) {
  const rows = new Map(collectRows([module], root).map(row => [row.id, row]));
  const ordered = [];
  const visit = task => {
    if (task.type === "suite") for (const child of task.tasks) visit(child);
    else ordered.push(rows.get(task.id));
  };
  for (const task of module.task.tasks) visit(task);
  assert.equal(ordered.length, rows.size, "Registration tree lost a declaration");
  return ordered;
}

export function reconcileImportEntry(entry, modules, declarations, root) {
  const find = file => modules.find(module => module.task.filepath === path.resolve(root, file)
    && (module.task.projectName ?? "") === entry.project);
  const result = { ...entry, complete: false, collection_is_execution_evidence: false, bindings: [] };
  const wrapper = find(entry.file);
  const sources = entry.sources.map(source => find(source.file));
  if (!wrapper || sources.some(source => !source)) return { ...result, reason: "Missing source collection" };
  if (entry.sources.some(source => !declarations.some(row => row.file === source.file && row.project === entry.project))) {
    return { ...result, reason: "Imported source has no static declarations" };
  }
  const actual = registrationRows(wrapper, root);
  const expected = sources.flatMap(source => registrationRows(source, root));
  if (!actual.length || actual.length !== expected.length) return { ...result, reason: "Imported case cardinality differs" };
  const shape = row => JSON.stringify([row.name, row.declared_mode, row.skipped_in_environment, row.dynamic_declaration]);
  for (let index = 0; index < actual.length; index++) {
    const row = actual[index], source = expected[index];
    if (shape(row) !== shape(source) || !source.location) {
      return { ...result, reason: "Registration order, case shape or source location differs", index };
    }
    result.bindings.push({ wrapper_id: row.id, source_file: source.file, source_id: source.id,
      source_location: source.location, registration_index: index,
      source_sha256: entry.sources.find(item => item.file === source.file).sha256 });
  }
  return { ...result, complete: true };
}
