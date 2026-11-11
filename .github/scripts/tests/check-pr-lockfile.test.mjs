import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLockfile } from '../check-pr-lockfile.mjs';

const makeFiles = (filenames) => filenames.map(f => ({ filename: f, status: 'modified' }));

test('passes when lockfile is not changed', () => {
  assert.equal(checkLockfile(makeFiles(['src/foo.ts']), 'someuser', 'fix/bug').passed, true);
});

test('passes when lockfile changed by refresh bot on correct branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'chore/refresh-lockfile'
  );
  assert.equal(result.passed, true);
});

test('fails when lockfile changed by regular user', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('pnpm-lock.yaml'));
});

test('fails when lockfile changed by bot on wrong branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'fix/something-else'
  );
  assert.equal(result.passed, false);
});

test('defers to the trusted policy job in the fork', () => {
  assert.equal(checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug', 'caniko/paperclip').passed, true);
  assert.equal(checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug', 'paperclipai/paperclip').passed, false);
  // The policy job skips its lock step on this branch name, so the bot-author check stays here.
  assert.equal(checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'chore/refresh-lockfile', 'caniko/paperclip').passed, false);
  assert.equal(checkLockfile(makeFiles(['pnpm-lock.yaml']), 'github-actions[bot]', 'chore/refresh-lockfile', 'caniko/paperclip').passed, true);
});
