#!/usr/bin/env node
/**
 * scripts/wait-for-ci.mjs
 *
 * Used by the deploy workflows (deploy-portal.yml, deploy-agentcore.yml) before they deploy: waits for
 * the CI workflow's run on the commit being deployed and exits 1 unless that run passed. A commit whose
 * tests fail, or whose CI was cancelled, is therefore never deployed.
 *
 * Environment, set by GitHub Actions: GITHUB_TOKEN (with actions: read), GITHUB_REPOSITORY, GITHUB_SHA.
 * Optional: CI_WORKFLOW (default ci.yml), CI_WAIT_MINUTES (default 45), CI_START_MINUTES (how long a
 * run may take to appear, default 10), CI_POLL_SECONDS (default 20).
 *
 * Pull request runs are ignored: they test the pull request merged into its base, not this commit.
 * When CI has run more than once on the commit, the newest run decides. A re-run of CI's failed jobs
 * updates that run, so after one passes, re-running the deploy's failed jobs deploys the commit.
 */

import { pathToFileURL } from 'node:url';

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/** The newest run of the CI workflow on this commit, or null when none has started. */
async function newestRun(listUrl, token, fetchImpl) {
  const res = await fetchImpl(listUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agent-portal-wait-for-ci',
    },
  });
  if (!res.ok) {
    const error = new Error(`GitHub answered ${res.status} when listing CI runs`);
    error.retry = RETRY_STATUSES.has(res.status);
    throw error;
  }
  const { workflow_runs: runs = [] } = await res.json();
  const own = runs.filter(run => !String(run.event).startsWith('pull_request'));
  own.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id);
  return own[0] ?? null;
}

/**
 * Polls until the newest CI run on `sha` completes. Resolves { ok, message, run? }; never throws for a
 * failed or missing run. Network errors and GitHub 5xx/429 answers are retried until the time runs out.
 */
export async function waitForCi({
  token, repository, sha, workflow = 'ci.yml', apiUrl = 'https://api.github.com',
  waitMs = 45 * 60_000, startMs = 10 * 60_000, pollMs = 20_000,
  fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, log = console.log,
}) {
  if (!token || !repository || !sha) return { ok: false, message: 'GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA are required.' };
  const listUrl = `${apiUrl.replace(/\/+$/, '')}/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}`
    + `/runs?head_sha=${encodeURIComponent(sha)}&per_page=30`;
  const short = sha.slice(0, 7);
  const span = ms => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`);
  const started = now();
  let lastState = '';

  for (;;) {
    let run = null;
    try {
      run = await newestRun(listUrl, token, fetchImpl);
    } catch (err) {
      // A 4xx other than 429 (bad token, missing permission, unknown workflow) will not fix itself.
      if (err && err.retry === false) return { ok: false, message: `${err.message}. Check the job's "actions: read" permission and CI_WORKFLOW.` };
      log(`Could not read CI runs (${err?.message || err}); trying again.`);
      lastState = '';
    }

    if (run) {
      const state = run.status === 'completed' ? run.conclusion : run.status;
      if (state !== lastState) { log(`CI on ${short}: ${state} (${run.html_url})`); lastState = state; }
      if (run.status === 'completed') {
        if (run.conclusion === 'success') return { ok: true, run, message: `CI passed on ${short}: ${run.html_url}` };
        return {
          ok: false, run,
          message: `CI ended "${run.conclusion}" on ${short}, so it is not deployed: ${run.html_url}. `
            + 'Fix the failure, or re-run CI\'s failed jobs, then re-run this workflow\'s failed jobs.',
        };
      }
    } else if (now() - started >= startMs) {
      return { ok: false, message: `No CI run started on ${short} within ${span(startMs)}, so it is not deployed.` };
    }

    if (now() - started >= waitMs) {
      return { ok: false, run, message: `CI on ${short} did not finish within ${span(waitMs)}, so it is not deployed.` };
    }
    await sleep(pollMs);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = process.env;
  const number = (value, fallback) => (value && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  const result = await waitForCi({
    token: env.GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
    sha: env.GITHUB_SHA,
    workflow: env.CI_WORKFLOW || 'ci.yml',
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    waitMs: number(env.CI_WAIT_MINUTES, 45) * 60_000,
    startMs: number(env.CI_START_MINUTES, 10) * 60_000,
    pollMs: number(env.CI_POLL_SECONDS, 20) * 1000,
  });
  if (env.GITHUB_STEP_SUMMARY) {
    const fs = await import('node:fs');
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### CI check\n${result.message}\n`);
  }
  if (result.ok) console.log(result.message);
  else { console.error(result.message); process.exitCode = 1; }
}
