import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMigrationOrder } from '../check-pr-migration-order.mjs';

const migration = (name) => `packages/db/src/migrations/${name}.sql`;

test('passes when a PR has no new migrations', () => {
  const result = checkMigrationOrder([migration('0230_on_master')], []);

  assert.equal(result.passed, true);
});

test('passes when every PR migration follows the target branch', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0231_first_in_pr'), migration('0232_second_in_pr')],
  );

  assert.equal(result.passed, true);
});

test('fails with renumbering guidance when a PR reuses the target branch number', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0230_from_stale_branch')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /already contains migrations through .*0230_on_master\.sql/);
  assert.match(result.message, /renumber this PR's migrations starting at 0231/);
  assert.match(result.message, /meta\/_journal\.json/);
});

test('fails when a PR inserts a migration before the target branch tip', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0229_from_stale_branch'), migration('0231_valid_but_after_stale')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /0229_from_stale_branch\.sql/);
  assert.doesNotMatch(result.message, /- packages\/db\/src\/migrations\/0231_valid_but_after_stale\.sql/);
});

test('exempts only the listed upstream-identical migrations', () => {
  const upstream = migration('0230_upstream');
  const result = checkMigrationOrder(
    [migration('0232_on_master')],
    [upstream, migration('0231_fork_authored')],
    [upstream],
  );

  assert.equal(result.passed, false);
  assert.doesNotMatch(result.message, /- .*0230_upstream\.sql/);
  assert.match(result.message, /- .*0231_fork_authored\.sql/);
  assert.equal(
    checkMigrationOrder([migration('0232_on_master')], [upstream], [upstream]).passed,
    true,
  );
});

test('compares blobs with upstream master and fails closed without it', () => {
  const script = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'check-pr-migration-order.mjs',
  );
  const dir = mkdtempSync(path.join(tmpdir(), 'migration-order-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (name, body) => {
    const file = path.join(dir, 'packages/db/src/migrations', `${name}.sql`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  const commit = (message) => {
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const run = (...shas) => {
    try {
      execFileSync('node', [script, ...shas], { cwd: dir, stdio: 'pipe' });
      return 0;
    } catch (error) {
      return error.status;
    }
  };

  git('init', '-q');
  write('0001_base', 'select 1;');
  write('0002_base', 'select 2;');
  const base = commit('base');
  write('0001_upstream', 'select 3;');
  const upstream = commit('upstream');
  git('reset', '-q', '--hard', base);
  write('0001_upstream', 'select 3;');
  const identical = commit('identical');
  git('reset', '-q', '--hard', base);
  write('0001_upstream', 'select 3; -- modified');
  const modified = commit('modified');
  git('reset', '-q', '--hard', base);
  write('0001_fork', 'select 4;');
  const fork = commit('fork');

  assert.equal(run(base, identical, upstream), 0);
  assert.equal(run(base, modified, upstream), 1);
  assert.equal(run(base, fork, upstream), 1);
  assert.equal(run(base, identical), 1);
});
