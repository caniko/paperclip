import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../../workflows/commitperclip-review.yml', import.meta.url), 'utf8');

test('review checks the immutable base runtime before exposing the key or minting a token', (t) => {
  const preflight = workflow.indexOf('      - name: Verify trusted review runtime');
  assert.ok(preflight > workflow.indexOf('      - name: Set up Node'));
  assert.ok(preflight < workflow.indexOf('      - name: Generate commitperclip token'));
  const step = workflow.slice(preflight, workflow.indexOf('      - name: Generate commitperclip token'));
  assert.doesNotMatch(step, /COMMITPERCLIP_KEY|secrets\./);
  const script = step.match(/<<'JS'\n([\s\S]*?)\n {10}JS/)[1]
    .split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
  const root = mkdtempSync(join(tmpdir(), 'review-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const fault of ['none', 'missing-helper', 'old-exports']) {
    const cwd = join(root, fault);
    const scripts = join(cwd, '.github/scripts');
    mkdirSync(scripts, { recursive: true });
    const functions = `export function getInstallationToken() { throw new Error('must not mint'); }\n` +
      (fault === 'old-exports' ? '' : `export function revokeInstallationToken() { throw new Error('must not revoke'); }\n`);
    writeFileSync(join(scripts, 'get-bot-token.mjs'), functions);
    writeFileSync(join(scripts, 'run-quality-gates.mjs'), '');
    if (fault !== 'missing-helper') writeFileSync(join(scripts, 'revoke-bot-token.mjs'), '');
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], { cwd, input: script, encoding: 'utf8' });
    assert.equal(result.status === 0, fault === 'none', result.stderr);
    if (fault !== 'none') assert.match(result.stderr, /refresh the trusted base before minting/i);
    assert.doesNotMatch(result.stderr, /must not mint|must not revoke/);
  }
  const current = spawnSync(process.execPath, ['--input-type=module', '-'], {
    cwd: new URL('../../../', import.meta.url), input: script, encoding: 'utf8',
  });
  assert.equal(current.status, 0, current.stderr);
});
