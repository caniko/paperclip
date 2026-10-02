import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExistingComment, upsertComment } from '../run-quality-gates.mjs';

test('findExistingComment: paginates until it finds the commitperclip comment', async () => {
  const seenPaths = [];
  const comment = await findExistingComment(async (path) => {
    seenPaths.push(path);
    if (path.endsWith('page=1')) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: 'someone-else' },
        body: 'unrelated',
      }));
    }
    if (path.endsWith('page=2')) {
      return [{
        id: 200,
        user: { login: 'commitperclip[bot]' },
        body: 'Looks good.\n\n— commitperclip',
      }];
    }
    return [];
  }, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment.id, 200);
  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=1',
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=2',
  ]);
});

test('findExistingComment: returns null when no signed comment exists', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 1,
      user: { login: 'commitperclip[bot]' },
      body: 'Unsigned status update',
    },
  ]), 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment, null);
});

test('owned app updates its own marked comment and refuses an upstream or mismatched app author', async () => {
  const identity = { id: '123', slug: 'caniko-paperclip-review', botLogin: 'caniko-paperclip-review[bot]' };
  const comment = await findExistingComment(async () => [
    { id: 1, user: { login: 'commitperclip[bot]' }, body: '— commitperclip' },
    { id: 2, user: { login: identity.botLogin }, body: '<!-- paperclip-quality-gates -->', performed_via_github_app: { id: 999 } },
    { id: 3, user: { login: identity.botLogin }, body: '<!-- paperclip-quality-gates -->', performed_via_github_app: { id: 123 } },
  ], 'token', 'caniko/paperclip', 1, identity);
  assert.equal(comment.id, 3);
});

test('repeat review updates the existing comment instead of creating another', async () => {
  const calls = [];
  const fetch = async (path, _token, options) => {
    calls.push({ path, method: options.method, body: JSON.parse(options.body).body });
    return { id: 42 };
  };
  const comment = await upsertComment('token', 'caniko/paperclip', 1, 'first review', null, fetch);
  await upsertComment('token', 'caniko/paperclip', 1, 'second review', comment, fetch);
  assert.deepEqual(calls, [
    { path: '/repos/caniko/paperclip/issues/1/comments', method: 'POST', body: 'first review' },
    { path: '/repos/caniko/paperclip/issues/comments/42', method: 'PATCH', body: 'second review' },
  ]);
});
