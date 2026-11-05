/**
 * Sessions open a pull request and start a review after a fix. The runner (finalize mode) and the host (GitHub) are
 * stand-ins; the database is real.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { run, all, one } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import { _setAgentCoreInvokerOverride } from '../server/agent/kiro-agentcore.ts';
import { _setPullRequestClients } from '../server/pull-requests.ts';
import { setPullRequestSettings } from '../server/project-settings-pr.ts';
import {
  handleRepoChanges, createPullRequestForSession, finalizeRunPayloadFlag, _setSessionPrDeps,
} from '../server/session-pr.ts';

const ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/test-runtime';
const SHA = 'a'.repeat(40);

let baseUrl = '';
let cookie = '';
let userId = '';

interface Session { projectId: string; workflowId: string; runId: string; repoId: string }

function makeSession(opts: { jiraKey?: string; summary?: string } = {}): Session {
  const projectId = generateId();
  run('INSERT INTO projects (id, slug, name, description, notes, created_at) VALUES (?,?,?,?,?,?)',
    projectId, `spr-${projectId.slice(0, 8)}`, 'SPR', '', '', now());
  const repoId = generateId();
  run(`INSERT INTO repositories (id, project_id, name, url, provider, status, default_branch, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    repoId, projectId, 'shop', 'https://github.com/acme/shop', 'github', 'ready', 'main', now());
  const workflowId = generateId();
  run(`INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, jira_key, jira_summary, jira_url, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    workflowId, projectId, 'Fix the login redirect\nmore detail', 'done', 'claude-code', 0, JSON.stringify([repoId]),
    opts.jiraKey ?? '', opts.summary ?? '', opts.jiraKey ? `https://x.atlassian.net/browse/${opts.jiraKey}` : '', userId, now(), now());
  const runId = generateId();
  run(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?,?,'done',?)`, runId, workflowId, now());
  run(`INSERT INTO p6_events (run_id, type, payload, created_at) VALUES (?,?,?,?)`,
    runId, 'run-complete', JSON.stringify({ result: 'Fixed it. token=abcdefghijklmnop1234', cost_usd: 0 }), now());
  return { projectId, workflowId, runId, repoId };
}

const ctxOf = (s: Session) => ({ workflowId: s.workflowId, runId: s.runId, projectId: s.projectId, userId, engine: 'claude-code' as const });
const change = { repo: 'shop', base: 'main', commits: 2, files: 5 };

function prEvents(s: Session): Array<Record<string, any>> {
  return all<{ payload: string }>(`SELECT payload FROM p6_events WHERE run_id = ? AND type = 'pull-request' ORDER BY id`, s.runId)
    .map((r) => JSON.parse(r.payload));
}
const states = (s: Session): string[] => prEvents(s).map((e) => e.state);
const inboxCount = (s: Session): number => (one<{ n: number }>('SELECT COUNT(*) AS n FROM p6_inbox WHERE workflow_id = ?', s.workflowId)?.n ?? 0);

let finalizeCalls: Array<Record<string, any>> = [];
let pushReply: (p: Record<string, any>) => Array<Record<string, unknown>>;
let ghCalls: Array<{ url: string; method: string; body: any }> = [];
let ghStatus = 201;

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

describe('session pull requests', () => {
  before(async () => {
    process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN = ARN;
    ({ baseUrl } = await createTestServer());
    const r = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST', body: { email: `spr-${Date.now()}@example.com`, name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    cookie = r.cookie ?? '';
    userId = one<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
  });
  after(async () => { delete process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN; await cleanup(); });

  beforeEach(() => {
    finalizeCalls = [];
    ghCalls = [];
    ghStatus = 201;
    pushReply = (p) => [{ type: 'repo-pushed', repo: p.repo, branch: p.branch, sha: SHA }];
    _setAgentCoreInvokerOverride(async function* (_arn, _sid, payload) {
      finalizeCalls.push(payload);
      for (const ev of pushReply(payload)) yield ev as never;
    });
    _setSessionPrDeps({ listBranches: async () => ['main'] });
    _setPullRequestClients({
      credentials: async () => ({ kind: 'github' as const, token: 'tok-github-123' }),
      fetch: (async (url: any, init: any) => {
        ghCalls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
        return ghStatus === 201
          ? new Response(JSON.stringify({ number: 42, html_url: 'https://github.com/acme/shop/pull/42' }), { status: 201, headers: { 'content-type': 'application/json' } })
          : new Response(JSON.stringify({ message: 'boom' }), { status: ghStatus, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
  });
  afterEach(() => {
    _setAgentCoreInvokerOverride(null);
    _setSessionPrDeps();
    _setPullRequestClients();
  });

  it('a ticket session pushes, opens the pull request and starts a draft review', async () => {
    const s = makeSession({ jiraKey: 'RLP-12', summary: 'Fix login redirect' });
    await handleRepoChanges(ctxOf(s), [change]);
    assert.deepEqual(states(s), ['pushing', 'pushed', 'opened', 'review-started']);
    assert.equal(finalizeCalls.length, 1);
    const p = finalizeCalls[0];
    assert.equal(p.mode, 'finalize');
    assert.equal(p.repo, 'shop');
    assert.equal(p.base, 'main');
    assert.equal(p.branch, 'portal/RLP-12-fix-login-redirect');
    assert.equal(p.message, 'RLP-12: Fix login redirect');
    assert.equal(p.defaultBranch, 'main');
    assert.ok(Array.isArray(p.protectedBranches) && p.protectedBranches.includes('main'));
    assert.ok(p.env && typeof p.env === 'object');
    assert.ok(p.identity.email);
    const pr = ghCalls.find((c) => c.method === 'POST')!;
    assert.equal(pr.body.title, 'RLP-12: Fix login redirect');
    assert.equal(pr.body.head, 'portal/RLP-12-fix-login-redirect');
    assert.match(pr.body.body, /RLP-12/);
    assert.match(pr.body.body, /Opened by Agent Portal/);
    assert.doesNotMatch(pr.body.body, /abcdefghijklmnop1234/);
    assert.ok(prEvents(s).every((e) => e.provider === 'github' && e.repo === 'shop'));
    const last = prEvents(s).at(-1)!;
    assert.equal(last.number, 42);
    assert.equal(last.url, 'https://github.com/acme/shop/pull/42');
    assert.ok(last.reviewId);
    const review = one<Record<string, any>>('SELECT * FROM p10_reviews WHERE id = ?', last.reviewId)!;
    assert.equal(review.post_mode, 'draft');
    assert.equal(review.pr_number, 42);
    assert.equal(review.head_ref, 'portal/RLP-12-fix-login-redirect');
  });

  it('a session without a ticket creates one Inbox item and nothing else', async () => {
    const s = makeSession();
    await handleRepoChanges(ctxOf(s), [change]);
    await handleRepoChanges(ctxOf(s), [change]);
    assert.deepEqual(states(s), ['asked']);
    assert.equal(inboxCount(s), 1);
    assert.equal(finalizeCalls.length, 0);
    assert.equal(ghCalls.length, 0);
    const item = one<Record<string, any>>('SELECT * FROM p6_inbox WHERE workflow_id = ?', s.workflowId)!;
    assert.equal(item.type, 'push');
    const pl = JSON.parse(item.payload);
    assert.equal(pl.title, 'Open a pull request for shop?');
    assert.equal(pl.body, '5 files changed in 2 commit(s) in shop. Approve to push a new branch and open a pull request.');
    assert.equal(prEvents(s)[0].inboxId, item.id);
  });

  it('approving the Inbox question opens the pull request from the first line of the goal', async () => {
    const s = makeSession();
    await handleRepoChanges(ctxOf(s), [change]);
    const item = one<{ id: string }>('SELECT id FROM p6_inbox WHERE workflow_id = ?', s.workflowId)!;
    const r = await fetchJson(baseUrl, `/api/inbox/${item.id}/resolve`, { method: 'POST', body: { response: 'approve' }, cookie });
    assert.equal(r.status, 200);
    await waitFor(() => states(s).includes('review-started'));
    assert.deepEqual(states(s), ['asked', 'pushing', 'pushed', 'opened', 'review-started']);
    assert.equal(finalizeCalls[0].branch, 'portal/fix-the-login-redirect');
    assert.equal(ghCalls.find((c) => c.method === 'POST')!.body.title, 'Fix the login redirect');
  });

  it('declining the Inbox question writes declined and pushes nothing', async () => {
    const s = makeSession();
    await handleRepoChanges(ctxOf(s), [change]);
    const item = one<{ id: string }>('SELECT id FROM p6_inbox WHERE workflow_id = ?', s.workflowId)!;
    const r = await fetchJson(baseUrl, `/api/inbox/${item.id}/resolve`, { method: 'POST', body: { response: 'decline' }, cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(states(s), ['asked', 'declined']);
    assert.equal(finalizeCalls.length, 0);
  });

  it('with the setting off it writes available and nothing else', async () => {
    const s = makeSession({ jiraKey: 'RLP-1', summary: 'x' });
    await setPullRequestSettings(s.projectId, { openPullRequests: false });
    await handleRepoChanges(ctxOf(s), [change]);
    assert.deepEqual(states(s), ['available']);
    assert.equal(inboxCount(s), 0);
    assert.equal(finalizeCalls.length, 0);
    assert.equal(prEvents(s)[0].files, 5);
  });

  it('refuses a protected branch name without pushing', async () => {
    const s = makeSession({ jiraKey: 'RLP-2', summary: 'Thing' });
    await setPullRequestSettings(s.projectId, { protectedBranches: ['portal/*'] });
    await handleRepoChanges(ctxOf(s), [change]);
    assert.deepEqual(states(s), ['failed']);
    assert.match(prEvents(s)[0].error, /protected/);
    assert.equal(finalizeCalls.length, 0);
    assert.equal(ghCalls.length, 0);
  });

  it('repeated repo-changes for the same repository create one pull request', async () => {
    const s = makeSession({ jiraKey: 'RLP-3', summary: 'Once' });
    await Promise.all([handleRepoChanges(ctxOf(s), [change]), handleRepoChanges(ctxOf(s), [change])]);
    await handleRepoChanges(ctxOf(s), [change]);
    assert.equal(finalizeCalls.length, 1);
    assert.equal(ghCalls.filter((c) => c.method === 'POST').length, 1);
    assert.equal(all('SELECT id FROM p10_reviews WHERE pr_number = 42 AND project_id = ?', s.projectId).length, 1);
  });

  it('shows the no-permission text when the push is refused', async () => {
    pushReply = (p) => [{ type: 'repo-pushed', repo: p.repo, branch: p.branch, error: 'remote: Permission to acme/shop.git denied (403)' }];
    const s = makeSession({ jiraKey: 'RLP-4', summary: 'Denied' });
    await handleRepoChanges(ctxOf(s), [change]);
    const last = prEvents(s).at(-1)!;
    assert.equal(last.state, 'failed');
    assert.equal(last.errorCode, 'no-permission');
    assert.equal(last.error, 'No permission to push to shop. A GitHub token needs repo write access; CodeCommit needs GitPush and CreatePullRequest.');
    assert.equal(ghCalls.length, 0);
  });

  it('trusts the error code the runner sends over the wording of its message', async () => {
    pushReply = (p) => [{ type: 'repo-pushed', repo: p.repo, branch: p.branch, error: 'something odd happened', errorCode: 'no-permission' }];
    const s = makeSession({ jiraKey: 'RLP-5', summary: 'Coded' });
    await handleRepoChanges(ctxOf(s), [change]);
    const last = prEvents(s).at(-1)!;
    assert.equal(last.errorCode, 'no-permission');
    assert.match(String(last.error), /^No permission to push to shop\./);
  });

  it('keeps the branch when the pull request fails after a push, and the button only creates the pull request', async () => {
    ghStatus = 500;
    const s = makeSession({ jiraKey: 'RLP-5', summary: 'Half' });
    await handleRepoChanges(ctxOf(s), [change]);
    const last = prEvents(s).at(-1)!;
    assert.equal(last.state, 'failed');
    assert.equal(last.branch, 'portal/RLP-5-half');
    assert.match(last.error, /^The branch portal\/RLP-5-half was pushed, but the pull request could not be opened: /);
    assert.equal(finalizeCalls.length, 1);

    ghStatus = 201;
    await createPullRequestForSession(s.workflowId, s.repoId);
    assert.equal(finalizeCalls.length, 1, 'no second push');
    assert.deepEqual(states(s).slice(-2), ['opened', 'review-started']);
    assert.equal(prEvents(s).at(-1)!.branch, 'portal/RLP-5-half');
  });

  describe('POST /api/sessions/:workflowId/pull-request', () => {
    it('returns 409 when a pull request is already open, 404 for an unknown repository or session', async () => {
      const s = makeSession({ jiraKey: 'RLP-6', summary: 'Route' });
      await handleRepoChanges(ctxOf(s), [change]);
      const url = `/api/sessions/${s.workflowId}/pull-request`;
      assert.equal((await fetchJson(baseUrl, url, { method: 'POST', body: { repoId: s.repoId }, cookie })).status, 409);
      assert.equal((await fetchJson(baseUrl, url, { method: 'POST', body: { repoId: 'nope' }, cookie })).status, 404);
      assert.equal((await fetchJson(baseUrl, '/api/sessions/nope/pull-request', { method: 'POST', body: { repoId: s.repoId }, cookie })).status, 404);
    });

    it('returns 202 and works in the background when the setting was off', async () => {
      const s = makeSession({ jiraKey: 'RLP-7', summary: 'Button' });
      await setPullRequestSettings(s.projectId, { openPullRequests: false });
      await handleRepoChanges(ctxOf(s), [change]);
      const r = await fetchJson(baseUrl, `/api/sessions/${s.workflowId}/pull-request`, { method: 'POST', body: { repoId: s.repoId }, cookie });
      assert.equal(r.status, 202);
      await waitFor(() => states(s).includes('review-started'));
      assert.deepEqual(states(s), ['available', 'pushing', 'pushed', 'opened', 'review-started']);
    });
  });

  it('finalizeRunPayloadFlag is true when the setting is on or the session has a ticket', async () => {
    const s = makeSession();
    assert.equal(await finalizeRunPayloadFlag(s.projectId, false), true);
    await setPullRequestSettings(s.projectId, { openPullRequests: false });
    assert.equal(await finalizeRunPayloadFlag(s.projectId, false), false);
    assert.equal(await finalizeRunPayloadFlag(s.projectId, true), true);
  });
});
