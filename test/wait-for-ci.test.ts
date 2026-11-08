import { it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error pure JavaScript CI helper has no declaration file
import { waitForCi } from '../scripts/wait-for-ci.mjs';

type Run = { id: number; event: string; status: string; conclusion: string | null; created_at: string; html_url: string };
type Answer = Run[] | { status: number } | Error;

const SHA = '619d0de0123456789abcdef0123456789abcdef0';
const run = (id: number, status: string, conclusion: string | null = null, event = 'push', minute = id): Run => ({
  id, event, status, conclusion, created_at: `2026-11-09T10:${String(minute).padStart(2, '0')}:00Z`, html_url: `https://github.test/runs/${id}`,
});

/** Runs waitForCi against a scripted GitHub API: each poll takes the next answer (the last one repeats). */
async function wait(answers: Answer[], options: Record<string, unknown> = {}) {
  let clock = 0, polls = 0;
  const urls: string[] = [], auth: string[] = [], logs: string[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
    urls.push(url); auth.push(init.headers.Authorization);
    const answer = answers[Math.min(polls++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    if (!Array.isArray(answer)) return { ok: false, status: answer.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ workflow_runs: answer }) };
  };
  const result = await waitForCi({
    token: 'test-token', repository: 'owner/repo', sha: SHA, pollMs: 20_000, waitMs: 45 * 60_000, startMs: 10 * 60_000,
    fetchImpl, sleep: async (ms: number) => { clock += ms; }, now: () => clock, log: (line: string) => logs.push(line), ...options,
  });
  return { result, polls, urls, auth, logs, clock };
}

it('waits through queued and in-progress until CI passes, asking only for this commit\'s CI runs', async () => {
  const { result, polls, urls, auth, logs } = await wait([[], [run(1, 'queued')], [run(1, 'in_progress')], [run(1, 'in_progress')], [run(1, 'completed', 'success')]]);
  assert.equal(result.ok, true);
  assert.equal(polls, 5);
  assert.match(result.message, /CI passed on 619d0de/);
  assert.equal(urls[0], `https://api.github.com/repos/owner/repo/actions/workflows/ci.yml/runs?head_sha=${SHA}&per_page=30`);
  assert.deepEqual([...new Set(auth)], ['Bearer test-token']);
  assert.deepEqual(logs.map(line => line.split(':')[1].trim().split(' ')[0]), ['queued', 'in_progress', 'success'], 'each state is logged once');
});

it('refuses a failed, cancelled or timed-out CI run and says how to retry', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'startup_failure']) {
    const { result } = await wait([[run(1, 'in_progress')], [run(1, 'completed', conclusion)]]);
    assert.equal(result.ok, false, conclusion);
    assert.match(result.message, new RegExp(`CI ended "${conclusion}" on 619d0de, so it is not deployed: https://github.test/runs/1`));
    assert.match(result.message, /re-run CI's failed jobs, then re-run this workflow's failed jobs/);
  }
});

it('lets the newest run decide and ignores pull request runs', async () => {
  // An older failure was followed by a passing manual run on the same commit.
  assert.equal((await wait([[run(1, 'completed', 'failure'), run(2, 'completed', 'success', 'workflow_dispatch')]])).result.ok, true);
  // ...and the other way round.
  assert.equal((await wait([[run(2, 'completed', 'failure'), run(1, 'completed', 'success')]])).result.ok, false);
  // A pull request run is newer and passed, but it tested a merge, not this commit: keep waiting for the push run.
  const { result, polls } = await wait([
    [run(5, 'completed', 'success', 'pull_request'), run(1, 'in_progress')],
    [run(5, 'completed', 'success', 'pull_request'), run(1, 'completed', 'failure')],
  ]);
  assert.equal(result.ok, false); assert.equal(polls, 2);
  // Only pull request runs: treated as no run at all, so it gives up once the start time is over.
  const onlyPr = await wait([[run(5, 'completed', 'success', 'pull_request_target')]]);
  assert.equal(onlyPr.result.ok, false); assert.match(onlyPr.result.message, /No CI run started on 619d0de within 10 minutes/);
});

it('gives up when no CI run starts in time, or the run does not finish in time', async () => {
  const none = await wait([[]]);
  assert.equal(none.result.ok, false);
  assert.match(none.result.message, /No CI run started on 619d0de within 10 minutes, so it is not deployed/);
  assert.equal(none.clock, 10 * 60_000);

  const stuck = await wait([[run(1, 'in_progress')]], { waitMs: 5 * 60_000 });
  assert.equal(stuck.result.ok, false);
  assert.match(stuck.result.message, /CI on 619d0de did not finish within 5 minutes/);
  assert.equal(stuck.clock, 5 * 60_000);

  // A run that appears after the start window counts as long as one is there when it is checked.
  const late = await wait([[], [run(1, 'completed', 'success')]], { startMs: 20_000 });
  assert.equal(late.result.ok, true);
});

it('retries network errors and GitHub 5xx or 429 answers, but stops at once on other errors', async () => {
  const flaky = await wait([new TypeError('fetch failed'), { status: 502 }, { status: 429 }, [run(1, 'completed', 'success')]]);
  assert.equal(flaky.result.ok, true); assert.equal(flaky.polls, 4);
  assert.equal(flaky.logs.filter(line => line.startsWith('Could not read CI runs')).length, 3);

  for (const status of [401, 403, 404]) {
    const denied = await wait([{ status }, [run(1, 'completed', 'success')]]);
    assert.equal(denied.result.ok, false, String(status)); assert.equal(denied.polls, 1);
    assert.match(denied.result.message, new RegExp(`GitHub answered ${status} when listing CI runs.*actions: read`));
  }
});

it('needs a token, repository and commit', async () => {
  for (const missing of ['token', 'repository', 'sha']) {
    const { result, polls } = await wait([[run(1, 'completed', 'success')]], { [missing]: '' });
    assert.equal(result.ok, false); assert.equal(polls, 0);
    assert.match(result.message, /GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA are required/);
  }
});
