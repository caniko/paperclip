import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SourceMap } from "node:module";
import path from "node:path";
import { transformSync } from "esbuild";
import { parseAst } from "vitest/node";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// Vitest concurrently appends discovered projects and does not promise ordering.
// Compare every identity, including pool, without discarding duplicates.
// https://github.com/vitest-dev/vitest/blob/v5.0.3/packages/vitest/src/node/specifications.ts
export function specificationRows(specifications, root) {
  const identities = new Set();
  return specifications.map(specification => {
    const file = path.relative(root, specification.moduleId).split(path.sep).join("/");
    assert.ok(file && !file.startsWith("../") && !path.isAbsolute(file), "Specification source must be inside the checkout");
    const row = { file, project: specification.project.name, pool: specification.pool };
    assert.ok(typeof row.project === "string" && typeof row.pool === "string", "Specification identity is incomplete");
    const key = JSON.stringify([row.project, row.file, row.pool]);
    assert.ok(!identities.has(key), "Duplicate configured specification");
    identities.add(key);
    return row;
  }).sort((a, b) => {
    const left = JSON.stringify([a.project, a.file, a.pool]);
    const right = JSON.stringify([b.project, b.file, b.pool]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

// Consume Vitest's task tree directly. The v5.0.3 `list --json` formatter
// discards skipped cases, which would remove required coverage from this map.
// https://github.com/vitest-dev/vitest/blob/v5.0.3/packages/vitest/src/node/cli/cli-api.ts
export function collectRows(modules, root) {
  const rows = [];
  const identities = new Set();
  for (const module of modules) {
    const file = path.relative(root, module.task.filepath).split(path.sep).join("/");
    assert.ok(file && !file.startsWith("../") && !path.isAbsolute(file), "Roster source must be inside the checkout");
    const project = module.task.projectName ?? "";
    const visit = (task, ancestors, inheritedSkip = false) => {
      const skipped = inheritedSkip || task.mode === "skip" || task.mode === "todo";
      if (task.type === "suite") {
        for (const child of task.tasks ?? []) visit(child, [...ancestors, task.name], skipped);
        return;
      }
      assert.equal(task.type, "test", "Unexpected framework task kind");
      assert.ok(typeof task.id === "string" && task.id, "Missing stable framework identity");
      const key = JSON.stringify([project, file, task.id]);
      assert.ok(!identities.has(key), "Duplicate framework task in collected roster");
      identities.add(key);
      rows.push({ id: task.id, project, file, name: [...ancestors, task.name].join(" > "),
        location: task.location ?? null, declared_mode: task.mode, skipped_in_environment: skipped,
        dynamic_declaration: task.dynamic === true || task.each === true,
        required: true, evidence: [], status: "unexecuted" });
    };
    for (const task of module.task.tasks) visit(task, [], ["skip", "todo"].includes(module.task.mode));
  }
  return rows.sort((a, b) => JSON.stringify([a.project, a.file, a.id]).localeCompare(JSON.stringify([b.project, b.file, b.id]), "en"));
}

export function declarationSites(declarations, rows, sources, policy = {}, provenance = []) {
  const imported = provenance.flatMap(entry => {
    assert.equal(entry.complete, true, "Imported source collection is incomplete");
    assert.equal(sha256(sources[entry.file]), entry.sha256, "Imported entry source drift");
    return entry.bindings.map(binding => {
      assert.equal(sha256(sources[binding.source_file]), binding.source_sha256, "Imported declaration source drift");
      return { project: entry.project, file: binding.source_file, id: binding.wrapper_id,
        location: binding.source_location, entry: entry.file, entry_sha256: entry.sha256 };
    });
  });
  rows = [...rows, ...imported];
  const byPosition = new Map(), sourceLines = new Map(), importedByPosition = new Map();
  const key = row => {
    const source = sources[row.file];
    if (!row.location || typeof source !== "string") return null;
    if (!sourceLines.has(row.file)) sourceLines.set(row.file, [0, ...Array.from(source.matchAll(/\n/g), match => match.index + 1)]);
    const lines = sourceLines.get(row.file);
    const start = lines[row.location.line - 1];
    if (start === undefined || !Number.isSafeInteger(row.location.column) || row.location.column < 1) return null;
    const offset = start + row.location.column - 1;
    if (offset >= (lines[row.location.line] ?? source.length + 1)) return null;
    // Static source maps can point at the title; runtime can point at `it`,
    // `test`, or a chained call's final `(`, including before a newline.
    // ponytail: normalize only literal call boundaries and whitespace; aliases
    // and other source-map gaps still need explicit provenance review.
    const boundary = source.slice(offset).match(/^(?:(?:it|test)(?:\.(?:skip|only|todo|concurrent|sequential|fails))*|skip|only|todo|concurrent|sequential|fails)?\(\s*/)?.[0].length ?? 0;
    return JSON.stringify([row.project, row.file, offset + boundary]);
  };
  for (const row of rows) {
    const position = key(row);
    if (position === null) continue;
    if (!byPosition.has(position)) byPosition.set(position, []);
    byPosition.get(position).push(row.id);
  }
  for (const row of imported) {
    const position = key(row);
    if (!importedByPosition.has(position)) importedByPosition.set(position, []);
    importedByPosition.get(position).push(row);
  }
  const sites = declarations.map(declaration => ({ ...declaration, matching_requires_environment_union_review: true,
    runtime_case_ids_at_site: byPosition.get(key(declaration)) ?? [] }));
  for (const site of sites) {
    const bindings = importedByPosition.get(key(site));
    if (bindings?.length) site.declaration_provenance = { kind: "source-bound-import-entry", bindings, execution_credit: false };
  }
  // Vitest 5's static parser also calls testEnvironment, testApp.use, etc.
  // "tests". Helpers inside test bodies/hooks cannot register during collection.
  // Retain every raw row and bind its disposition to the actual callback range.
  for (const file of new Set(sites.filter(site => !site.runtime_case_ids_at_site.length).map(site => site.file))) {
    const text = sources[file];
    if (!text) continue;
    const helpers = (policy.static_helper_calls ?? []).filter(rule => rule.file === file);
    for (const helper of helpers) {
      assert.equal(sha256(text), helper.source_sha256, `Static helper source drift: ${file}`);
      assert.ok(text.includes(helper.anchor) && helper.reason?.trim(), "Static helper provenance is incomplete");
    }
    const { code, map } = transformSync(text, { loader: /\.[jt]sx$/.test(file) ? "tsx" : "ts",
      format: "esm", target: "esnext", sourcefile: file, sourcemap: "external" });
    const sourceMap = new SourceMap(JSON.parse(map));
    const generatedLines = [0, ...[...code.matchAll(/\n/g)].map(match => match.index + 1)];
    const originalLines = [0, ...[...text.matchAll(/\n/g)].map(match => match.index + 1)];
    const offset = row => originalLines[row.location?.line - 1] + row.location?.column - 1;
    const originalOffset = position => {
      let low = 0, high = generatedLines.length;
      while (low + 1 < high) {
        const middle = (low + high) >>> 1;
        if (generatedLines[middle] <= position) low = middle; else high = middle;
      }
      const entry = sourceMap.findEntry(low, position - generatedLines[low]);
      return originalLines[entry.originalLine] + entry.originalColumn;
    };
    const calls = [];
    const visit = node => {
      if (!node || typeof node !== "object") return;
      if (node.type === "CallExpression") calls.push({ node, start: originalOffset(node.start),
        argumentsStart: originalOffset(node.arguments[0]?.start ?? node.end - 1) });
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") visit(value);
      }
    };
    visit(parseAst(code));
    // ponytail: scan only files with unmatched sites; index callback intervals
    // if this per-file calls × collected-cases scan becomes a collection cost.
    const callbacks = calls.flatMap(call => {
      const enclosing = rows.filter(row => row.file === file && call.start <= offset(row)
        && offset(row) <= call.argumentsStart);
      const hook = call.node.callee.type === "Identifier"
        && /^(?:before|after)(?:All|Each)$/.test(call.node.callee.name) ? call.node.callee.name : null;
      if (!enclosing.length && !hook) return [];
      return call.node.arguments.filter(argument => ["ArrowFunctionExpression", "FunctionExpression"].includes(argument.type))
        .map(callback => ({ start: originalOffset(callback.body.start), end: originalOffset(callback.body.end - 1),
          enclosing, hook }));
    });
    for (const site of sites.filter(site => site.file === file && !site.runtime_case_ids_at_site.length)) {
      const position = offset(site);
      const call = calls.filter(call => call.start <= position && position <= call.argumentsStart).at(-1);
      // Genuine nested Vitest declarations stay unresolved, even though
      // registering them inside a running test would itself be invalid.
      let callee = call?.node.callee;
      while (callee && ["CallExpression", "MemberExpression"].includes(callee.type)) {
        if (callee.type === "MemberExpression" && (callee.computed || callee.property.type !== "Identifier"
          || !["each", "for", "skip", "only", "todo", "concurrent", "sequential", "fails", "skipIf", "runIf", "extend"].includes(callee.property.name))) {
          callee = null;
          break;
        }
        callee = callee.type === "CallExpression" ? callee.callee : callee.object;
      }
      if (callee?.type === "Identifier" && ["it", "test"].includes(callee.name)) continue;
      const body = callbacks.find(body => body.start < position && position < body.end
        && (body.hook || body.enclosing.some(row => row.project === site.project)));
      if (body) site.non_declaration = { kind: body.hook ? "runtime-hook-body-call" : "runtime-test-body-call",
        callback_source_range: [body.start, body.end], hook: body.hook,
        enclosing_case_ids: body.enclosing.filter(row => row.project === site.project).map(row => row.id),
        source_sha256: sha256(text), execution_credit: false };
      else if (call) {
        const callee = code.slice(call.node.callee.start, call.node.callee.end);
        const helper = helpers.find(rule => rule.callees.includes(callee));
        if (helper) site.non_declaration = { kind: "source-bound-helper-call", callee,
          source_sha256: helper.source_sha256, anchor: helper.anchor, reason: helper.reason, execution_credit: false };
      }
    }
  }
  for (const factory of policy.declaration_branches ?? []) {
    const text = sources[factory.file];
    assert.equal(sha256(text), factory.source_sha256, `Declaration factory source drift: ${factory.file}`);
    assert.ok(text.includes(factory.anchor), "Declaration factory anchor is missing");
    const ranges = factory.calls.map(call => {
      const start = text.indexOf(call);
      assert.ok(start >= 0 && text.indexOf(call, start + 1) === -1, "Declaration factory call is missing or ambiguous");
      return [start, start + call.length];
    });
    const inFactory = row => {
      if (row.file !== factory.file || !row.location) return false;
      const position = sourceLines.get(row.file)[row.location.line - 1] + row.location.column - 1;
      return ranges.some(([start, end]) => start <= position && position < end);
    };
    for (const site of sites.filter(site => !site.runtime_case_ids_at_site.length && inFactory(site))) {
      const actual = rows.filter(row => row.project === site.project && inFactory(row));
      assert.ok(actual.length, "Neither branch of a required declaration factory was collected");
      site.runtime_case_ids_at_site = actual.map(row => row.id);
      site.declaration_provenance = { kind: "exclusive-factory-branch", ...factory, execution_credit: false };
    }
  }
  return sites;
}

export function mapEnvironments(rows, sources, policy) {
  assert.equal(policy.all_declared_cases_required, true, "Coverage policy cannot waive declared cases");
  const stale = [];
  for (const rule of [...policy.rules, ...(policy.conditional_expansions ?? [])]) {
    assert.ok(policy.environments[rule.environment], "Unknown environment");
    const source = sources[rule.file];
    if (!source || sha256(source) !== rule.source_sha256 || !source.includes(rule.anchor)) stale.push(rule);
  }
  return {
    stale_rules: stale,
    conditional_expansions: (policy.conditional_expansions ?? []).map(rule => ({ ...rule,
      required: true, evidence: [], status: "unexecuted", source_valid: !stale.includes(rule),
      observed_case_ids: rows.filter(row => row.file === rule.file && row.name.includes(rule.name_contains)).map(row => row.id) })),
    cases: rows.map(row => {
      const rules = policy.rules.filter(rule => rule.file === row.file && row.name.includes(rule.name_contains));
      const valid = rules.filter(rule => !stale.includes(rule));
      const environments = [...new Set(valid.map(rule => rule.environment))];
      if (!environments.length && !row.skipped_in_environment && !rules.length) environments.push("default-hosted");
      return { ...row, source_sha256: sha256(sources[row.file]), environments,
        environment_mapping: rules.some(rule => stale.includes(rule)) ? "source-drift"
          : !environments.length ? "unresolved" : rules.length ? "source-backed" : "observed-default-candidate" };
    }),
  };
}
