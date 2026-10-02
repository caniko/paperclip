#!/usr/bin/env node
/**
 * run-quality-gates.mjs
 * Orchestrates all quality gates. Fetches PR data once, runs all gates,
 * posts or updates a single consolidated comment via commitperclip.
 *
 * Env: GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR, PR_BRANCH
 * Exit: 0 if all quality gates pass, 1 if any fail.
 */
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { ghFetch, resolveAppIdentity } from './get-bot-token.mjs';
import { fetchAllPullRequestFiles } from './fetch-pr-files.mjs';
import { checkTemplate } from './check-pr-template.mjs';
import { checkLinkedIssue } from './check-pr-linked-issue.mjs';
import { checkDedupSearch } from './check-pr-dedup-search.mjs';
import { checkTestCoverage } from './check-pr-test-coverage.mjs';
import { checkLockfile } from './check-pr-lockfile.mjs';
import { checkDependencies } from './check-pr-dependencies.mjs';
import { checkReleaseBootstrap } from './check-pr-release-bootstrap.mjs';
import { checkCoauthors, fetchAllPullRequestCommits } from './check-pr-coauthors.mjs';

const COMMENT_MARKER = '<!-- paperclip-quality-gates -->';

function buildComment(author, failures, informational, identity) {
  const signature = `${COMMENT_MARKER}\n\n— ${identity.slug}`;
  if (failures.length === 0 && informational.length === 0) {
    return `✅ All checks passing — ready for Greptile review and maintainer approval.\n\n${signature}`;
  }

  const lines = [
    `Hey @${author}! Before this PR can be reviewed, a few things need attention:\n`,
  ];

  if (failures.length > 0) {
    lines.push('**Missing or incomplete:**');
    for (const f of failures) lines.push(`- [ ] ${f}`);
  }

  if (informational.length > 0) {
    if (failures.length > 0) lines.push('');
    lines.push('**Informational:**');
    for (const i of informational) lines.push(`- ${i}`);
  }

  lines.push(
    '\nOnce updated, push a new commit and these checks will re-run automatically.\n',
    signature
  );

  return lines.join('\n');
}

export async function findExistingComment(fetchFromGitHub, token, repo, prNumber,
  identity = resolveAppIdentity({ ...process.env, GH_REPO: repo })) {
  for (let page = 1; ; page += 1) {
    const comments = await fetchFromGitHub(
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      token
    );

    const existing = comments.find(
      c => c.user.login === identity.botLogin &&
           (!c.performed_via_github_app || String(c.performed_via_github_app.id) === identity.id) &&
           (c.body.includes(COMMENT_MARKER) || c.body.includes(`— ${identity.slug}`))
    );
    if (existing) return existing;

    if (comments.length < 100) return null;
  }
}

export async function upsertComment(token, repo, prNumber, body, existing, fetchFromGitHub = ghFetch) {
  return fetchFromGitHub(existing ? `/repos/${repo}/issues/comments/${existing.id}` : `/repos/${repo}/issues/${prNumber}/comments`, token, {
    method: existing ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

async function main() {
  const { GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR, PR_BRANCH } = process.env;

  if (!GH_TOKEN || !GH_REPO || !PR_NUMBER) {
    console.error('ERROR: GH_TOKEN, GH_REPO, PR_NUMBER env vars required');
    process.exit(1);
  }

  // Sanitize inputs before use in URL construction (prevents SSRF)
  const prNumber = parseInt(PR_NUMBER, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('ERROR: PR_NUMBER must be a positive integer');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(GH_REPO)) {
    console.error('ERROR: GH_REPO must be in owner/repo format');
    process.exit(1);
  }

  // Fetch PR data once — gates use this, no redundant API calls
  const [pr, files] = await Promise.all([
    ghFetch(`/repos/${GH_REPO}/pulls/${prNumber}`, GH_TOKEN),
    fetchAllPullRequestFiles(ghFetch, GH_REPO, prNumber, GH_TOKEN),
  ]);

  // Separate, and allowed to fail. The co-author note is informational: it
  // cannot fail a PR by design, so it must not be able to fail the workflow by
  // accident either. Sharing the Promise.all above would let one transient
  // 5xx on this request take down every gate, including the ones that block.
  let commits = [];
  try {
    commits = await fetchAllPullRequestCommits(ghFetch, GH_REPO, prNumber, GH_TOKEN);
  } catch (error) {
    console.error(`co-author lookup skipped: ${error.message}`);
  }

  const prBody = pr.body ?? '';
  const author = PR_AUTHOR ?? pr.user.login;
  const branch = PR_BRANCH ?? pr.head.ref;

  // Run all quality gates (pure functions run sync, deps check is async)
  const prTitle = pr.title ?? '';
  const [templateResult, issueResult, dedupResult, testResult, lockfileResult, depsResult, bootstrapResult] =
    await Promise.all([
      Promise.resolve(checkTemplate(prBody)),
      Promise.resolve(checkLinkedIssue(prBody, prTitle)),
      Promise.resolve(checkDedupSearch(prBody, prTitle)),
      Promise.resolve(checkTestCoverage(files, prTitle)),
      Promise.resolve(checkLockfile(files, author, branch)),
      checkDependencies(files, GH_TOKEN, GH_REPO, prNumber, pr.base?.ref),
      checkReleaseBootstrap(files, GH_TOKEN, GH_REPO, prNumber, pr.base?.ref),
    ]);
  const coauthorResult = checkCoauthors(commits, author);

  const allFailures = [
    ...templateResult.failures,
    ...issueResult.failures,
    ...dedupResult.failures,
    ...testResult.failures,
    ...lockfileResult.failures,
  ];
  const informational = [
    ...(depsResult.informational ?? []),
    ...(bootstrapResult.informational ?? []),
    ...coauthorResult.informational,
  ];
  const allPassed = allFailures.length === 0;

  const identity = resolveAppIdentity();
  const commentBody = buildComment(author, allFailures, informational, identity);

  // One marked comment also records successful review and is updated on retry.
  const existing = await findExistingComment(ghFetch, GH_TOKEN, GH_REPO, prNumber);
  const comment = await upsertComment(GH_TOKEN, GH_REPO, prNumber, commentBody, existing);
  if (comment.user?.login !== identity.botLogin || String(comment.performed_via_github_app?.id) !== identity.id) {
    throw new Error('Review comment was not authored by the configured GitHub App.');
  }
  if (process.env.COMMITPERCLIP_COMMENT_RECEIPT) {
    writeFileSync(process.env.COMMITPERCLIP_COMMENT_RECEIPT, JSON.stringify({
      kind: 'actions-slot-review-comment', appId: identity.id, appSlug: identity.slug,
      repository: GH_REPO, prNumber, commentId: comment.id, action: existing ? 'updated' : 'created',
      trustedSourceSha: process.env.COMMITPERCLIP_TRUSTED_SOURCE_SHA,
      runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      qualityGatesPassed: allPassed,
    }, null, 2), { mode: 0o600 });
  }

  console.log(JSON.stringify({ passed: allPassed, failures: allFailures, informational }));
  process.exit(allPassed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
