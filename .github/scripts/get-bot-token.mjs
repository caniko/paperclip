#!/usr/bin/env node
/**
 * get-bot-token.mjs
 * Generates a short-lived GitHub installation token for the commitperclip app.
 * Reads COMMITPERCLIP_KEY env var (PEM content of private key).
 * Prints the token to stdout.
 *
 * Also exports: generateJWT(privateKey, appId), ghFetch(path, token, options)
 * These are used by all other gate scripts.
 */
import { createSign, createHash, createPublicKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OWNER_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function resolveAppIdentity(env = process.env) {
  const repo = env.GH_REPO ?? env.GITHUB_REPOSITORY;
  const id = env.COMMITPERCLIP_APP_ID;
  const slug = env.COMMITPERCLIP_APP_SLUG;
  if (Boolean(id) !== Boolean(slug)) {
    throw new Error('Configure both COMMITPERCLIP_APP_ID and COMMITPERCLIP_APP_SLUG.');
  }
  if (!id && repo === 'paperclipai/paperclip') {
    return { id: '3718661', slug: 'commitperclip', botLogin: 'commitperclip[bot]', configured: false };
  }
  if (!id) throw new Error('Configure the GitHub-issued owned app identity for this repository.');
  if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug)) {
    throw new Error('Invalid GitHub App ID or slug.');
  }
  return { id, slug, botLogin: `${slug}[bot]`, configured: true };
}

export function generateJWT(privateKey, appId) {
  if (!/^[1-9][0-9]*$/.test(String(appId))) throw new Error('A GitHub-issued app ID is required.');
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 10, exp: now + 60, iss: String(appId) };
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = createSign('RSA-SHA256').update(data).sign(privateKey, 'base64url');
  return `${data}.${sig}`;
}

// Per-call timeout so a single slow/hung GitHub endpoint cannot eat the entire
// workflow budget. Overridable via options.timeoutMs for callers that need
// different bounds.
export const GH_FETCH_DEFAULT_TIMEOUT_MS = 15_000;

export async function ghFetch(path, token, options = {}) {
  const { timeoutMs = GH_FETCH_DEFAULT_TIMEOUT_MS, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`ghFetch timeout after ${timeoutMs}ms: ${path}`)), timeoutMs);
  const abortOnExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) abortOnExternal();
    else externalSignal.addEventListener('abort', abortOnExternal, { once: true });
  }
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...fetchOptions.headers,
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub API ${fetchOptions.method ?? 'GET'} ${path} → ${res.status}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', abortOnExternal);
  }
}

export async function resolveInstallationId(fetchInstallation, token, repo, owner) {
  if (repo) {
    if (!REPO_PATTERN.test(repo)) {
      throw new Error('ERROR: GH_REPO/GITHUB_REPOSITORY must be in owner/repo format.');
    }

    const installation = await fetchInstallation(`/repos/${repo}/installation`, token);
    return installation.id;
  }

  const installations = await fetchInstallation('/app/installations', token);
  if (!installations.length) {
    throw new Error(
      'ERROR: No installations found for commitperclip. Install URL: https://github.com/apps/commitperclip/installations/new'
    );
  }

  if (owner) {
    if (!OWNER_PATTERN.test(owner)) {
      throw new Error('ERROR: GITHUB_REPOSITORY_OWNER must be a valid GitHub owner name.');
    }

    const match = installations.find(
      installation => installation.account?.login?.toLowerCase() === owner.toLowerCase()
    );

    if (match) {
      return match.id;
    }
  }

  if (installations.length === 1) {
    return installations[0].id;
  }

  throw new Error(
    'ERROR: Multiple commitperclip installations found. Set GH_REPO or GITHUB_REPOSITORY so the correct installation can be selected.'
  );
}

export async function getInstallationToken(privateKey, env = process.env, fetchFromGitHub = ghFetch) {
  const identity = resolveAppIdentity(env);
  const repo = env.GH_REPO ?? env.GITHUB_REPOSITORY;
  if (!repo || !REPO_PATTERN.test(repo)) throw new Error('A valid repository context is required.');
  const owner = repo.split('/')[0];
  const jwt = generateJWT(privateKey, identity.id);
  const app = await fetchFromGitHub('/app', jwt);
  if (String(app.id) !== identity.id || app.slug !== identity.slug || app.owner?.login?.toLowerCase() !== owner.toLowerCase()) {
    throw new Error('Authenticated GitHub App identity does not match this repository configuration.');
  }
  const installation = await fetchFromGitHub(`/repos/${repo}/installation`, jwt);
  if (!Number.isSafeInteger(installation.id) || installation.id <= 0 ||
      String(installation.app_id) !== identity.id || installation.account?.login?.toLowerCase() !== owner.toLowerCase() || installation.suspended_at) {
    throw new Error('GitHub App installation identity is mismatched or suspended.');
  }
  const scopedRepo = env.COMMITPERCLIP_TOKEN_REPOSITORY ?? (identity.configured ? repo : undefined);
  if (scopedRepo && scopedRepo !== repo) throw new Error('Review token scope must match the repository context.');
  const { token } = await fetchFromGitHub(`/app/installations/${installation.id}/access_tokens`, jwt, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    ...(scopedRepo ? { body: JSON.stringify({ repositories: [repo.split('/')[1]], permissions: { contents: 'read', pull_requests: 'write', checks: 'write' } }) } : {}),
  });
  if (!token) throw new Error('GitHub did not return an installation token.');
  if (scopedRepo) {
    try {
      const scope = await fetchFromGitHub('/installation/repositories', token);
      if (scope.total_count !== 1 || scope.repositories?.length !== 1 || scope.repositories[0].full_name !== repo) {
        throw new Error('Review token is not scoped to exactly the declared repository.');
      }
      if (env.COMMITPERCLIP_VERIFICATION_RECEIPT) {
        writeFileSync(env.COMMITPERCLIP_VERIFICATION_RECEIPT, JSON.stringify({
          kind: 'actions-slot-authentication', appId: app.id, appSlug: app.slug,
          owner: app.owner.login, installationId: installation.id,
          repository: repo, repositoryId: scope.repositories[0].id,
          publicKeySha256: createHash('sha256').update(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })).digest('base64'),
          sourceSha: env.GITHUB_SHA, trustedSourceSha: env.COMMITPERCLIP_TRUSTED_SOURCE_SHA, runId: env.GITHUB_RUN_ID,
          runAttempt: env.GITHUB_RUN_ATTEMPT, verifiedAt: new Date().toISOString(),
          repositoryScopedTokenQualified: true,
        }, null, 2), { mode: 0o600 });
      }
    } catch (error) {
      await fetchFromGitHub('/installation/token', token, { method: 'DELETE' }).catch(() => {});
      throw error;
    }
  }
  return token;
}

async function main() {
  const privateKey = process.env.COMMITPERCLIP_KEY;
  if (!privateKey) {
    console.error('ERROR: COMMITPERCLIP_KEY env var not set.');
    console.error('Publish the GitHub-issued PEM to the repository Actions secret using secret-manager.');
    process.exit(1);
  }

  const token = await getInstallationToken(privateKey);
  process.stdout.write(token);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
