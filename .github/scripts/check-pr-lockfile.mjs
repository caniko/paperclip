#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Checks that pnpm-lock.yaml was not manually edited.
 * Export: checkLockfile(files, prAuthor, prBranch, repository) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

export function checkLockfile(files, prAuthor, prBranch, repository) {
  const lockfileChanged = files.some(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfileChanged) return { passed: true, failures: [] };
  // In this fork the trusted PR workflow's policy job decides: it accepts a lock change only
  // when it equals CI's own importer-only resolution of the PR's manifests. That job skips its
  // lock step on the refresh-bot branch name, so that branch keeps the bot-author check here.
  // The fork has no branch protection and pr.yml comes from the PR head; this relies on the
  // operator merging every PR after reviewing its CI, as the fork does today.
  if (repository === 'caniko/paperclip' && prBranch !== 'chore/refresh-lockfile') return { passed: true, failures: [] };

  const isRefreshBot =
    prAuthor === 'github-actions[bot]' && prBranch === 'chore/refresh-lockfile';

  return {
    passed: isRefreshBot,
    failures: isRefreshBot ? [] : [
      'You have changes to `pnpm-lock.yaml` — `pr.yml` will hard-fail this PR with a confusing message about lockfile edits. ' +
      'To fix: run `pnpm install` locally, exclude the lockfile from your commit, push again. ' +
      'The lockfile is regenerated automatically by the refresh bot on a schedule.',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkLockfile(files, process.env.PR_AUTHOR ?? '', process.env.PR_BRANCH ?? '', process.env.GH_REPO ?? '');
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
