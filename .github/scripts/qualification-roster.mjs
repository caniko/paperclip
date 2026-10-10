import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";

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
