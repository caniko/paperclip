import { readFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCKFILES, REPORT_LOCK_FILES } from '../lockfile-trust.mjs';

const workflows = [
  '.github/workflows/refresh-lockfile.yml',
  '.github/workflows/pr-trusted.yml',
  '.github/workflows/docker.yml',
];

const workflow = readFileSync(new URL('../../workflows/refresh-lockfile.yml', import.meta.url), 'utf8');
const job = name => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n {2}\w+:\n/)[0];
const step = (jobSource, name) => jobSource.split(`      - name: ${name}\n`)[1].split('      - name:')[0];
const runScript = (jobSource, name, cwd, env) => spawnSync('bash', [
  '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
  step(jobSource, name).split('        run: |\n')[1].replace(/^ {10}/gm, ''),
], { cwd, encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env } });
const lockPaths = [...LOCKFILES, ...REPORT_LOCK_FILES, 'tests/runner-e2e/source-sdk-public-inputs.json'];

test('refresh is read-only; only the separate canonical master job can publish', () => {
  const refresh = job('refresh');
  const publish = job('publish');
  const permissions = source => source.match(/^ {4}permissions:\n((?: {6}\S.*\n)+)/m)?.[1].trim().split(/\n\s*/);
  assert.deepEqual(permissions(refresh), ['contents: read']);
  assert.doesNotMatch(refresh, /^ {4}environment:|secrets\.|git push|gh pr/m);
  assert.match(refresh, /persist-credentials: false/);
  assert.ok(refresh.includes('canonical_master: ${{ steps.route.outputs.canonical_master }}'));
  assert.ok(refresh.includes('prepared: ${{ steps.route.outputs.prepared }}'));
  assert.match(publish, /^ {4}needs: \[refresh\]$/m);
  assert.match(publish, /^ {4}if: needs\.refresh\.outputs\.canonical_master == 'true' && needs\.refresh\.outputs\.changed == 'true'$/m);
  assert.deepEqual(permissions(publish), ['contents: write', 'pull-requests: write']);
  assert.deepEqual(permissions(job('held_input')), ['actions: read']);
  assert.doesNotMatch(job('held_input'), /actions\/checkout|secrets\./);
  assert.match(publish, /^ {4}environment: lockfile-refresh$/m);
  assert.doesNotMatch(publish, /pnpm (?:--dir|install)|prepare-report-lock\.mjs/);
  assert.doesNotMatch(workflow, /github\.ref\s*[!=]=\s*['"]refs\/heads\/master/);
  assert.ok(workflow.includes('group: refresh-lockfile-${{ github.ref_name }}'));
});

test('refresh uploads the complete proof with the original run identity and publish consumes its artifact ID', () => {
  const refresh = job('refresh');
  const retained = step(refresh, 'Upload refreshed locks and proof');
  assert.ok(retained.includes('name: prepared-lock-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}'));
  const paths = [...retained.matchAll(/^ {12}(\S+\.(?:yaml|json|patch))$/gm)].map(match => match[1]);
  assert.deepEqual(paths, lockPaths);
  assert.ok(refresh.includes('artifact_id: ${{ steps.upload-locks.outputs.artifact-id }}'));
  assert.ok(step(job('publish'), 'Download refreshed locks and proof').includes('artifact-ids: ${{ needs.refresh.outputs.artifact_id }}'));
});

test('refresh routes only the exact canonical master ref to publication', t => {
  const directory = mkdtempSync(join(tmpdir(), 'lock-refresh-route-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'output');
  for (const [repository, ref, canonical] of [
    ['paperclipai/paperclip', 'refs/heads/master', true],
    ['paperclipai/paperclip', 'refs/heads/Master', false],
    ['paperclipai/paperclip', 'refs/tags/master', false],
    ['PaperclipAI/paperclip', 'refs/heads/master', false],
    ['caniko/paperclip', 'refs/heads/master', false],
  ]) {
    writeFileSync(output, '');
    const result = runScript(job('refresh'), 'Classify refresh destination', directory, {
      GITHUB_REPOSITORY: repository, GITHUB_REF: ref, GITHUB_OUTPUT: output,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), `canonical_master=${canonical}\nprepared=${!canonical}\n`, `${repository}:${ref}`);
  }
});

test('publication rejects incomplete and symlinked artifacts before copying any lock', t => {
  const directory = mkdtempSync(join(tmpdir(), 'lock-refresh-publish-input-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifact = join(directory, 'prepared-lock');
  const checkout = join(directory, 'checkout');
  const setup = (root, bytes) => {
    for (const file of lockPaths) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), bytes);
    }
  };
  setup(artifact, 'refreshed');
  setup(checkout, 'original');
  const run = () => runScript(job('publish'), 'Apply refreshed locks and proof', checkout, {
    RUNNER_TEMP: directory, LOCKFILES: LOCKFILES.join(' '), REPORT_PROOF: REPORT_LOCK_FILES.join(' '), SDK_PROOF: lockPaths.at(-1),
  });
  const file = join(artifact, lockPaths.at(-1));
  rmSync(file);
  const missing = run();
  assert.equal(missing.status, 1, missing.stderr);
  assert.equal(readFileSync(join(checkout, LOCKFILES[0]), 'utf8'), 'original');
  symlinkSync(join(artifact, LOCKFILES[0]), file);
  const linked = run();
  assert.equal(linked.status, 1, linked.stderr);
  assert.equal(readFileSync(join(checkout, LOCKFILES[0]), 'utf8'), 'original');
  rmSync(file);
  writeFileSync(file, 'refreshed');
  const complete = run();
  assert.equal(complete.status, 0, complete.stderr);
  for (const path of lockPaths) assert.equal(readFileSync(join(checkout, path), 'utf8'), 'refreshed');
});

test('canonical upsert force-pushes the verified commit before looking up the PR', t => {
  const directory = mkdtempSync(join(tmpdir(), 'lock-refresh-upsert-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls');
  const output = join(directory, 'output');
  writeFileSync(join(directory, 'git'), `#!/bin/sh
printf 'git %s\\n' "$*" >> "$CALLS"
if [ "$1" = rev-parse ]; then echo refreshed; fi
`, { mode: 0o700 });
  writeFileSync(join(directory, 'gh'), `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$CALLS"
echo https://github.com/paperclipai/paperclip/pull/42
`, { mode: 0o700 });
  const result = runScript(job('publish'), 'Create or update pull request', directory, {
    PATH: `${directory}:${process.env.PATH}`, CALLS: log, GITHUB_OUTPUT: output,
    REFRESH_HEAD: 'refreshed', REPO_OWNER: 'paperclipai',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(readFileSync(log, 'utf8'), /^git checkout -B chore\/refresh-lockfile refreshed\ngit push --force origin chore\/refresh-lockfile\ngh pr list /m);
  assert.equal(readFileSync(output, 'utf8'), 'pr_url=https://github.com/paperclipai/paperclip/pull/42\nhead_sha=refreshed\n');
});

test('trusted lockfile policy can query Actions and never fetches the mutable refresh ref', async () => {
  const trusted = await readFile(workflows[1], 'utf8');
  const job = trusted.split('\n  policy:\n')[1].split(/\n {2}\w+:\n/)[0];
  const permissions = job.match(/^ {4}permissions:\n((?: {6}.*\n)+)/m)?.[1]
    ?? trusted.match(/^permissions:\n((?: {2}.*\n)+)/m)?.[1];
  assert.match(permissions, /^\s+actions: read$/m);
  assert.match(job.split('      - name: Block untrusted lockfile edits')[1].split('      - name:')[0],
    /^ {10}GH_TOKEN: \$\{\{ github\.token \}\}$/m);
  assert.doesNotMatch(trusted, /refs\/heads\/chore\/refresh-lockfile/);
});

test('lockfile repair workflows resolve dependencies instead of updating metadata only', async () => {
  for (const workflow of workflows) {
    const contents = await readFile(workflow, 'utf8');
    const repairCommands = contents
      .split('\n')
      .filter((line) => line.includes('pnpm install') && line.includes('--no-frozen-lockfile'));

    assert.ok(repairCommands.length > 0, `${workflow} must contain a lockfile repair command`);
    for (const command of repairCommands) {
      assert.match(command, /--resolution-only/);
      assert.match(command, /--ignore-scripts/);
      assert.doesNotMatch(command, /--lockfile-only/);
    }
  }
});
