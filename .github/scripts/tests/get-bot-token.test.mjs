import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInstallationId, resolveAppIdentity, getInstallationToken, revokeInstallationToken } from '../get-bot-token.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('owned forks require their issued app identity; upstream retains its identity', () => {
  assert.throws(() => resolveAppIdentity({ GH_REPO: 'caniko/paperclip' }), /owned app/);
  assert.throws(() => resolveAppIdentity({ GH_REPO: 'caniko/paperclip', COMMITPERCLIP_APP_ID: '123' }), /both/);
  assert.equal(resolveAppIdentity({ GH_REPO: 'paperclipai/paperclip' }).id, '3718661');
  assert.deepEqual(resolveAppIdentity({ GH_REPO: 'caniko/paperclip', COMMITPERCLIP_APP_ID: '123', COMMITPERCLIP_APP_SLUG: 'caniko-paperclip-review' }), {
    id: '123', slug: 'caniko-paperclip-review', botLogin: 'caniko-paperclip-review[bot]', configured: true,
  });
});

test('owned review token binds the issued app and exactly the declared repository', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = { GH_REPO: 'caniko/paperclip', COMMITPERCLIP_APP_ID: '123', COMMITPERCLIP_APP_SLUG: 'caniko-paperclip-review', COMMITPERCLIP_TOKEN_REPOSITORY: 'caniko/paperclip' };
  const seen = [];
  const fetch = async (path, _token, options) => {
    seen.push(path);
    if (path === '/app') return { id: 123, slug: 'caniko-paperclip-review', owner: { login: 'caniko' } };
    if (path.endsWith('/installation')) return { id: 42, app_id: 123, account: { login: 'caniko' }, suspended_at: null };
    if (path.endsWith('/access_tokens')) {
      assert.deepEqual(JSON.parse(options.body).repositories, ['paperclip']);
      return { token: 'short-lived-test-token' };
    }
    if (path === '/installation/repositories') return { total_count: 1, repositories: [{ full_name: 'caniko/paperclip' }] };
    throw new Error(`unexpected ${path}`);
  };
  assert.equal(await getInstallationToken(privateKey, env, fetch), 'short-lived-test-token');
  assert.deepEqual(seen, ['/app', '/repos/caniko/paperclip/installation', '/app/installations/42/access_tokens', '/installation/repositories']);
  await assert.rejects(getInstallationToken(privateKey, env, async () => ({ id: 123, slug: 'caniko-paperclip-review', owner: { login: 'paperclipai' } })), /identity/);
});

test('a broadened review token is revoked and refused', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = { GH_REPO: 'caniko/paperclip', COMMITPERCLIP_APP_ID: '123', COMMITPERCLIP_APP_SLUG: 'caniko-paperclip-review' };
  const calls = [];
  await assert.rejects(getInstallationToken(privateKey, env, async (path, _token, options) => {
    calls.push(path);
    if (path === '/app') return { id: 123, slug: env.COMMITPERCLIP_APP_SLUG, owner: { login: 'caniko' } };
    if (path.endsWith('/installation')) return { id: 42, app_id: 123, account: { login: 'caniko' } };
    if (path.endsWith('/access_tokens')) return { token: 'fixture-token' };
    if (path === '/installation/repositories') return { total_count: 2, repositories: [{ full_name: 'caniko/paperclip' }] };
    assert.equal(options.method, 'DELETE');
    return null;
  }), /exactly/);
  assert.equal(calls.at(-1), '/installation/token');
});

test('verification and revocation failures are both reported without returning a token', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = { GH_REPO: 'caniko/paperclip', COMMITPERCLIP_APP_ID: '123', COMMITPERCLIP_APP_SLUG: 'caniko-paperclip-review' };
  for (const verificationError of ['scope', 'GitHub API GET /installation/repositories → 503']) {
    let revocationAttempted = false;
    await assert.rejects(getInstallationToken(privateKey, env, async (path) => {
      if (path === '/app') return { id: 123, slug: env.COMMITPERCLIP_APP_SLUG, owner: { login: 'caniko' } };
      if (path.endsWith('/installation')) return { id: 42, app_id: 123, account: { login: 'caniko' } };
      if (path.endsWith('/access_tokens')) return { token: 'fixture-token' };
      if (path === '/installation/repositories') {
        if (verificationError !== 'scope') throw new Error(verificationError);
        return { total_count: 2, repositories: [{ full_name: 'caniko/paperclip' }] };
      }
      assert.equal(path, '/installation/token');
      revocationAttempted = true;
      throw new Error('GitHub API DELETE /installation/token → 503');
    }), (error) => {
      assert.match(error.message, verificationError === 'scope' ? /exactly/ : /GET.*503/);
      assert.match(error.message, /revocation.*failed/i);
      assert.doesNotMatch(error.message, /fixture-token|PRIVATE KEY/);
      return true;
    });
    assert.equal(revocationAttempted, true);
  }
});

test('revocation retains redacted success and failure evidence and refuses failed cleanup', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-revocation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const succeeds of [true, false]) {
    const receiptPath = join(directory, `${succeeds}.json`);
    const env = {
      COMMITPERCLIP_REVOCATION_RECEIPT: receiptPath,
      GH_REPO: 'caniko/paperclip', COMMITPERCLIP_TRUSTED_SOURCE_SHA: 'a'.repeat(40),
      GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
    };
    const result = revokeInstallationToken('fixture-token', env, async (path, token, options) => {
      assert.equal(path, '/installation/token');
      assert.equal(token, 'fixture-token');
      assert.equal(options.method, 'DELETE');
      if (!succeeds) throw new Error('fixture transport error with fixture-token');
    });
    if (succeeds) await result;
    else await assert.rejects(result, /transport/);
    const text = readFileSync(receiptPath, 'utf8');
    const receipt = JSON.parse(text);
    assert.equal(receipt.tokenRevoked, succeeds);
    assert.equal(receipt.trustedSourceSha, env.COMMITPERCLIP_TRUSTED_SOURCE_SHA);
    assert.equal(receipt.runId, '123');
    assert.equal(receipt.runAttempt, '2');
    assert.doesNotMatch(text, /fixture-token|transport error|PRIVATE KEY/);
    assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
  }
});

test('resolveInstallationId: uses the repo installation endpoint when repo context is available', async () => {
  const seenPaths = [];
  const installationId = await resolveInstallationId(async (path) => {
    seenPaths.push(path);
    return { id: 42 };
  }, 'jwt', 'paperclipai/paperclip', 'paperclipai');

  assert.equal(installationId, 42);
  assert.deepEqual(seenPaths, ['/repos/paperclipai/paperclip/installation']);
});

test('resolveInstallationId: falls back to the matching owner installation', async () => {
  const installationId = await resolveInstallationId(async () => ([
    { id: 1, account: { login: 'someone-else' } },
    { id: 7, account: { login: 'PaperclipAI' } },
  ]), 'jwt', undefined, 'paperclipai');

  assert.equal(installationId, 7);
});

test('resolveInstallationId: rejects ambiguous installations without repo or owner context', async () => {
  await assert.rejects(
    resolveInstallationId(async () => ([
      { id: 1, account: { login: 'org-one' } },
      { id: 2, account: { login: 'org-two' } },
    ]), 'jwt'),
    /Multiple commitperclip installations found/
  );
});
