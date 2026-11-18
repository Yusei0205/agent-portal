/**
 * Auto-fix delivery (server/autofix/delivery.ts) through the session PR flow: the gate before the project's PR setting, the fix
 * branch name, the PR body, draft and label on GitHub, and what the finding records. The runner (finalize mode) and GitHub are
 * stand-ins; the database is real.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { run, all, one } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import { _setAgentCoreInvokerOverride } from '../server/agent/kiro-agentcore.ts';
import { createPullRequest, deleteRemoteBranch, _setPullRequestClients } from '../server/pull-requests.ts';
import type { Repository } from '../server/repos.ts';
import { setPullRequestSettings } from '../server/project-settings-pr.ts';
import { handleRepoChanges, finalizeRunPayloadFlag, createPullRequestForSession, createRequestedSessionPullRequest, _setSessionPrDeps } from '../server/session-pr.ts';
import type { RepoChange } from '../server/session-pr.ts';
import { getAutofixFindingsRepository } from '../server/repositories/autofix-findings.ts';
import type { AutofixFinding } from '../server/repositories/autofix-findings.ts';
import { saveAutofixPolicy } from '../server/autofix/policy.ts';
import type { AutofixPolicy } from '../server/autofix/policy.ts';
import { checkDiff } from '../server/autofix/guardrails.ts';
import { fixBranchName, buildPrBody, _setCheckDiffForTest } from '../server/autofix/delivery.ts';

const ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/test-runtime';
const SHA = 'a'.repeat(40);
const FP = 'abcdef0123456789abcdef';

let baseUrl = '';
let cookie = '';
let userId = '';
let seq = 0;

interface Fix { projectId: string; workflowId: string; runId: string; repoId: string; findingId: string }

const repo = () => getAutofixFindingsRepository();

/** A finished fix session whose last run's check passed (unless `checkOk` is false), with its finding 'fixing'. */
async function makeFix(opts: {
  mode?: AutofixPolicy['mode']; checkOk?: boolean | null; withFinding?: boolean; attempts?: number; limits?: Partial<AutofixPolicy['limits']>;
} = {}): Promise<Fix> {
  const projectId = generateId();
  run('INSERT INTO projects (id, slug, name, description, notes, created_at) VALUES (?,?,?,?,?,?)',
    projectId, `afd-${projectId.slice(0, 8)}`, 'AFD', '', '', now());
  const repoId = generateId();
  run(`INSERT INTO repositories (id, project_id, name, url, provider, status, default_branch, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    repoId, projectId, 'shop', 'https://github.com/acme/shop', 'github', 'ready', 'main', now());
  const workflowId = generateId();
  run(`INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    workflowId, projectId, 'Fix the failing tests\nmore', 'done', 'claude-code', 0, JSON.stringify([repoId]), userId, now(), now());
  const runId = generateId();
  run(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?,?,'done',?)`, runId, workflowId, now());
  if (opts.checkOk !== null) {
    run(`INSERT INTO p6_events (run_id, type, payload, created_at) VALUES (?,?,?,?)`, runId, 'check-result',
      JSON.stringify({ ok: opts.checkOk ?? true, ranAt: now(), steps: [{ step: 'verify', ok: opts.checkOk ?? true, output: 'verify: 12 passed', durationMs: 5, required: true }] }), now());
  }
  await saveAutofixPolicy(projectId, {
    mode: opts.mode ?? 'draft_pr', verify: { command: 'npm test', quick_commands: [] }, run_as: userId,
    ...(opts.limits ? { limits: { ...(await import('../server/autofix/policy.ts')).DEFAULT_POLICY.limits, ...opts.limits } } : {}),
  }, { actorId: userId, isAdmin: true });
  let findingId = '';
  if (opts.withFinding !== false) {
    const { finding } = await repo().upsertByFingerprint({
      project_id: projectId, source: 'ci_failed', kind: 'tests', fingerprint: `${FP}${++seq}`, severity: 'medium',
      evidence: 'FAIL test/cart.test.ts: expected 2, got 3\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      repo_id: repoId, branch: 'main', commit_sha: 'abc123',
    });
    findingId = finding.id;
    await repo().transition(findingId, ['new'], { status: 'fixing', workflow_id: workflowId, attempts: opts.attempts ?? 0 });
  }
  return { projectId, workflowId, runId, repoId, findingId };
}

const ctxOf = (s: Fix) => ({ workflowId: s.workflowId, runId: s.runId, projectId: s.projectId, userId, engine: 'claude-code' as const });
const clean: RepoChange = {
  repo: 'shop', base: 'main', commits: 1, files: 2,
  paths: [{ path: 'src/cart.ts', added: 3, removed: 1 }, { path: 'test/cart.test.ts', added: 1, removed: 0 }],
};

function prEvents(s: Fix): Array<Record<string, any>> {
  return all<{ payload: string }>(`SELECT payload FROM p6_events WHERE run_id = ? AND type = 'pull-request' ORDER BY id`, s.runId)
    .map((r) => JSON.parse(r.payload));
}
const states = (s: Fix): string[] => prEvents(s).map((e) => e.state);
function inbox(s: Fix): Array<{ id: string; type: string; payload: Record<string, any> }> {
  return all<{ id: string; type: string; payload: string }>('SELECT id, type, payload FROM p6_inbox WHERE workflow_id = ? ORDER BY created_at', s.workflowId)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
function auditFor(target: string, action: string): Array<Record<string, any>> {
  return all<{ detail: string }>('SELECT detail FROM audit_log WHERE target = ? AND action = ?', target, action).map((r) => JSON.parse(r.detail));
}
const finding = async (s: Fix): Promise<AutofixFinding> => (await repo().getById(s.findingId))!;

let finalizeCalls: Array<Record<string, any>> = [];
let pushReply: (p: Record<string, any>) => Array<Record<string, unknown>>;
let ghCalls: Array<{ url: string; method: string; body: any }> = [];
let labelStatus = 200;
/** What GitHub's compare API answers for the pushed branch (default: the clean change). */
let compareReply: () => Response;
const compareFiles = (files: Array<{ filename: string; previous_filename?: string }>) =>
  () => new Response(JSON.stringify({ files: files.map((f) => ({ additions: 1, deletions: 0, status: 'modified', ...f })) }), { status: 200 });

/** The git trees GitHub answers for the base tip and the pushed branch head (server check of the two-dot tree difference). */
const BASE_C = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);
const BASE_T = 'd'.repeat(40);
const HEAD_T = 'e'.repeat(40);
type TreeEntry = { path: string; mode: string; type: string; sha: string };
const blob = (p: string, id: string): TreeEntry => ({ path: p, mode: '100644', type: 'blob', sha: id.padEnd(40, '0') });
let baseTree: TreeEntry[] = [];
let headTree: TreeEntry[] = [];
let treeTruncated = false;
/** The answer for the pushed branch's ref, and for the base's. */
let refStatus = 200;
let baseRefStatus = 200;
/** What GitHub answers for GET /pulls/<n> (null: the default reply, which has no state). */
let pullState: 'open' | 'closed' | null = null;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond()) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

before(async () => {
  process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN = ARN;
  // Most tests here exercise the unattended path; the default (a person approves every push) has its own tests below.
  process.env.AUTOFIX_ALLOW_UNATTENDED_PUSH = '1';
  ({ baseUrl } = await createTestServer());
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST', body: { email: `afd-${Date.now()}@example.com`, name: 'Admin', password: 'password1234', provider: 'demo' },
  });
  cookie = r.cookie ?? '';
  userId = one<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
});
after(async () => { delete process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN; delete process.env.AUTOFIX_ALLOW_UNATTENDED_PUSH; await cleanup(); });

beforeEach(() => {
  finalizeCalls = [];
  ghCalls = [];
  labelStatus = 200;
  compareReply = compareFiles([{ filename: 'src/cart.ts' }, { filename: 'test/cart.test.ts' }]);
  baseTree = [blob('a.txt', '1'), { path: 'src', mode: '040000', type: 'tree', sha: 'f'.repeat(40) }, blob('src/cart.ts', '2'), blob('.github/workflows/ci.yml', '3')];
  headTree = [blob('a.txt', '1'), { path: 'src', mode: '040000', type: 'tree', sha: 'a'.repeat(40) }, blob('src/cart.ts', '4'), blob('test/cart.test.ts', '5'), blob('.github/workflows/ci.yml', '3')];
  treeTruncated = false;
  refStatus = 200;
  baseRefStatus = 200;
  pullState = null;
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
      if (/\/labels$/.test(String(url))) return new Response('{}', { status: labelStatus });
      if (/\/compare\//.test(String(url))) return compareReply();
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      const u = String(url);
      if (pullState && /\/pulls\/\d+$/.test(u) && (init?.method ?? 'GET') === 'GET') return json({ state: pullState });
      let m: RegExpExecArray | null;
      if ((m = /\/git\/ref\/heads\/(.+)$/.exec(u))) {
        if (m[1] === 'main' ? baseRefStatus !== 200 : refStatus !== 200) return json({ message: 'Not Found' }, m[1] === 'main' ? baseRefStatus : refStatus);
        return json({ ref: `refs/heads/${m[1]}`, object: { type: 'commit', sha: m[1] === 'main' ? BASE_C : HEAD_C } });
      }
      if ((m = /\/git\/commits\/([0-9a-f]+)$/.exec(u))) return json({ sha: m[1], tree: { sha: m[1] === BASE_C ? BASE_T : HEAD_T } });
      if ((m = /\/git\/trees\/([0-9a-f]+)\?recursive=1$/.exec(u))) return json({ sha: m[1], tree: m[1] === BASE_T ? baseTree : headTree, truncated: treeTruncated });
      return new Response(JSON.stringify({ number: 42, html_url: 'https://github.com/acme/shop/pull/42' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
});
afterEach(() => {
  _setAgentCoreInvokerOverride(null);
  _setSessionPrDeps();
  _setPullRequestClients();
  _setCheckDiffForTest(null);
});

describe('names and text', () => {
  it('fixBranchName is autofix/<kind>-<first 8 of the fingerprint>', () => {
    assert.equal(fixBranchName('tests', 'abcdef0123456789'), 'autofix/tests-abcdef01');
    assert.equal(fixBranchName('Type Errors!', 'ABCDEF0123'), 'autofix/type-errors-abcdef01');
  });

  it('buildPrBody contains the evidence, the check output and the finding id, and no secret', () => {
    const f = {
      id: 'find-1', project_id: 'p1', workflow_id: 'wf-1', kind: 'tests', source: 'ci_failed', branch: 'main',
      evidence: 'FAIL cart.test.ts expected 2\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    } as AutofixFinding;
    const body = buildPrBody(f, 'verify: ok\npassword=hunter2hunter2 ```fence```');
    assert.match(body, /FAIL cart\.test\.ts expected 2/);
    assert.match(body, /verify: ok/);
    assert.match(body, /Finding: find-1/);
    assert.match(body, /Session: /);
    assert.doesNotMatch(body, /ghp_abcdefghij/);
    assert.doesNotMatch(body, /hunter2hunter2/);
    assert.match(body, /````\nverify: ok/, 'the fence is longer than any backtick run in the text');
  });
});

describe('createPullRequest draft and labels', () => {
  const ghRepo = { id: 'r1', project_id: 'p1', name: 'shop', url: 'https://github.com/acme/shop', provider: 'github', status: 'ready', default_branch: 'main', connection_id: 'c1' } as Repository;

  it('sends draft true and the autofix label for GitHub', async () => {
    const pr = await createPullRequest({ repo: ghRepo, base: 'main', head: 'autofix/tests-abcdef01', title: 't', body: 'b', draft: true, labels: ['autofix'] });
    assert.equal(pr.number, 42);
    const create = ghCalls.find((c) => c.method === 'POST' && /\/pulls$/.test(c.url))!;
    assert.equal(create.body.draft, true);
    const label = ghCalls.find((c) => /\/issues\/42\/labels$/.test(c.url))!;
    assert.equal(label.method, 'POST');
    assert.deepEqual(label.body, { labels: ['autofix'] });
  });

  it('a label failure (refused, or GitHub unreachable) does not fail the PR', async () => {
    labelStatus = 500;
    assert.equal((await createPullRequest({ repo: ghRepo, base: 'main', head: 'x', title: 't', body: 'b', labels: ['autofix'] })).number, 42);
    _setPullRequestClients({
      credentials: async () => ({ kind: 'github' as const, token: 'tok-github-123' }),
      fetch: (async (url: any) => {
        if (/\/labels$/.test(String(url))) throw new Error('socket hang up');
        return new Response(JSON.stringify({ number: 7, html_url: 'https://github.com/acme/shop/pull/7' }), { status: 201 });
      }) as typeof fetch,
    });
    assert.equal((await createPullRequest({ repo: ghRepo, base: 'main', head: 'x', title: 't', body: 'b', labels: ['autofix'] })).number, 7);
  });

  it('without draft or labels the request is as before', async () => {
    await createPullRequest({ repo: ghRepo, base: 'main', head: 'x', title: 't', body: 'b' });
    assert.equal(ghCalls.length, 1);
    assert.deepEqual(Object.keys(ghCalls[0].body).sort(), ['base', 'body', 'head', 'title']);
  });
});

describe('the gate in the session PR flow', () => {
  it('a diff touching .github/workflows/ci.yml is blocked: nothing is pushed, the finding is needs_human, audit and blocked item', async () => {
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [{ ...clean, paths: [...clean.paths!, { path: '.github/workflows/ci.yml', added: 1, removed: 1 }] }]);
    assert.equal(finalizeCalls.length, 0);
    assert.equal(ghCalls.length, 0);
    assert.deepEqual(states(s), []);
    assert.equal((await finding(s)).status, 'needs_human');
    const items = inbox(s);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'blocked');
    assert.equal(items[0].payload.kind, 'autofix');
    assert.equal(items[0].payload.findingId, s.findingId);
    assert.match(String(items[0].payload.reason), /\.github\/workflows\/ci\.yml/);
    assert.equal(auditFor(s.findingId, 'autofix.pr.blocked').length, 1);
  });

  it('draft_pr mode with a clean diff goes ahead (setting off): the finding becomes pr_open with pr_number, pr_url and fix_branch', async () => {
    const s = await makeFix();
    await setPullRequestSettings(s.projectId, { openPullRequests: false });
    await handleRepoChanges(ctxOf(s), [clean]);
    const f = await finding(s);
    const branch = fixBranchName('tests', f.fingerprint);
    assert.equal(finalizeCalls.length, 1);
    assert.equal(finalizeCalls[0].branch, branch);
    assert.equal(states(s).slice(0, 3).join(), 'pushing,pushed,opened');
    const create = ghCalls.find((c) => c.method === 'POST' && /\/pulls$/.test(c.url))!;
    assert.equal(create.body.draft, true);
    assert.equal(create.body.head, branch);
    assert.match(create.body.title, /^Auto-fix: tests failure on main/);
    assert.match(create.body.body, new RegExp(`Finding: ${s.findingId}`));
    assert.match(create.body.body, /Checks PASSED/);
    assert.match(create.body.body, /FAIL test\/cart\.test\.ts/);
    assert.doesNotMatch(create.body.body, /ghp_abcdefghij/);
    assert.ok(ghCalls.some((c) => /\/issues\/42\/labels$/.test(c.url)));
    assert.equal(f.status, 'pr_open');
    assert.equal(f.pr_number, 42);
    assert.equal(f.pr_url, 'https://github.com/acme/shop/pull/42');
    assert.equal(f.fix_branch, branch);
  });

  it('opening the PR records its branch and the pushed commit on the finding', async () => {
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [clean]);
    const f = await finding(s);
    assert.equal(f.status, 'pr_open');
    assert.equal(f.pr_branch, fixBranchName('tests', f.fingerprint));
    assert.equal(f.pr_head_sha, SHA);
  });

  it('a retry after red CI pushes to the open PR\'s branch (no -2 branch) and opens no second PR', async () => {
    const s = await makeFix();
    const prBranch = 'autofix/tests-abcdef01';
    await repo().transition(s.findingId, ['fixing'], {
      status: 'fixing', pr_branch: prBranch, pr_number: 42, pr_url: 'https://github.com/acme/shop/pull/42', pr_head_sha: 'f'.repeat(40), attempts: 1,
    });
    _setSessionPrDeps({ listBranches: async () => ['main', prBranch] });
    pullState = 'open';
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.equal(finalizeCalls.length, 1);
    assert.equal(finalizeCalls[0].branch, prBranch);
    assert.ok(Array.isArray(finalizeCalls[0].denyPaths), 'still the checked auto-fix push');
    assert.equal(ghCalls.filter((c) => c.method === 'POST' && /\/pulls$/.test(c.url)).length, 0);
    const f = await finding(s);
    assert.equal(f.status, 'pr_open');
    assert.equal(f.pr_number, 42);
    assert.equal(f.fix_branch, prBranch);
    assert.equal(f.pr_branch, prBranch);
    assert.equal(f.pr_head_sha, SHA);
  });

  it('a retry whose PR was closed meanwhile pushes nothing, opens no PR and ends needs_human', async () => {
    const s = await makeFix();
    const prBranch = 'autofix/tests-abcdef02';
    await repo().transition(s.findingId, ['fixing'], { status: 'fixing', pr_branch: prBranch, pr_number: 41, pr_url: 'https://github.com/acme/shop/pull/41' });
    _setSessionPrDeps({ listBranches: async () => ['main', prBranch] });
    pullState = 'closed';
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.equal(finalizeCalls.length, 0, 'nothing pushed');
    assert.equal(ghCalls.filter((c) => c.method === 'POST' && /\/pulls$/.test(c.url)).length, 0, 'no PR created');
    const f = await finding(s);
    assert.equal(f.status, 'needs_human');
    const items = inbox(s).filter((i) => i.type === 'blocked');
    assert.equal(items.length, 1);
    assert.equal(items[0].payload.reason, 'the fix PR was closed');
  });

  it('a retry whose PR state cannot be read pushes nothing and ends needs_human (fail closed)', async () => {
    const s = await makeFix();
    const prBranch = 'autofix/tests-abcdef03';
    await repo().transition(s.findingId, ['fixing'], { status: 'fixing', pr_branch: prBranch, pr_number: 41, pr_url: 'https://github.com/acme/shop/pull/41' });
    pullState = null; // the default reply has no state
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.equal(finalizeCalls.length, 0);
    assert.equal((await finding(s)).status, 'needs_human');
  });

  it('on a retry, a pushed-branch check that cannot complete keeps the PR branch (no delete) and ends needs_human', async () => {
    const s = await makeFix();
    const prBranch = 'autofix/tests-abcdef04';
    await repo().transition(s.findingId, ['fixing'], { status: 'fixing', pr_branch: prBranch, pr_number: 42, pr_url: 'https://github.com/acme/shop/pull/42' });
    pullState = 'open';
    compareReply = () => new Response('{"message":"rate limited"}', { status: 403 });
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.equal(finalizeCalls.length, 1);
    assert.equal(ghCalls.filter((c) => c.method === 'DELETE').length, 0, 'the open PR branch is kept');
    assert.equal(ghCalls.filter((c) => c.method === 'POST' && /\/pulls$/.test(c.url)).length, 0);
    const f = await finding(s);
    assert.equal(f.status, 'needs_human');
    assert.equal(f.pr_number, 42);
  });

  it('on a retry, a real protected-path violation found after the push still deletes the branch (blocked)', async () => {
    const s = await makeFix();
    const prBranch = 'autofix/tests-abcdef05';
    await repo().transition(s.findingId, ['fixing'], { status: 'fixing', pr_branch: prBranch, pr_number: 42, pr_url: 'https://github.com/acme/shop/pull/42' });
    pullState = 'open';
    compareReply = compareFiles([{ filename: 'src/cart.ts' }, { filename: '.github/workflows/ci.yml' }]);
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.ok(ghCalls.some((c) => c.method === 'DELETE' && c.url.includes(prBranch)));
    assert.equal((await finding(s)).status, 'needs_human');
  });

  it('a later fix of a finding whose PR was merged (pr_number kept, pr_branch cleared) opens a new PR on a fresh branch', async () => {
    const s = await makeFix();
    await repo().transition(s.findingId, ['fixing'], { status: 'fixing', pr_number: 41, pr_url: 'https://github.com/acme/shop/pull/41', pr_branch: null });
    const f0 = await finding(s);
    const old = fixBranchName('tests', f0.fingerprint);
    _setSessionPrDeps({ listBranches: async () => ['main', old] });
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.equal(finalizeCalls[0].branch, `${old}-2`);
    const create = ghCalls.find((c) => c.method === 'POST' && /\/pulls$/.test(c.url))!;
    assert.equal(create.body.head, `${old}-2`);
    assert.equal((await finding(s)).pr_number, 42);
  });

  it('by default (AUTOFIX_ALLOW_UNATTENDED_PUSH not set) draft_pr with a clean diff asks a person instead of pushing', async () => {
    delete process.env.AUTOFIX_ALLOW_UNATTENDED_PUSH;
    try {
      for (const v of [undefined, '0', 'true']) {
        if (v === undefined) delete process.env.AUTOFIX_ALLOW_UNATTENDED_PUSH; else process.env.AUTOFIX_ALLOW_UNATTENDED_PUSH = v;
        finalizeCalls = [];
        const s = await makeFix();
        await handleRepoChanges(ctxOf(s), [clean]);
        assert.equal(finalizeCalls.length, 0, `nothing pushed (${v})`);
        assert.deepEqual(states(s), ['asked']);
        const items = inbox(s);
        assert.equal(items.length, 1);
        assert.equal(items[0].type, 'push');
        assert.equal(items[0].payload.kind, 'autofix');
        assert.match(String(items[0].payload.body), /Unattended push is disabled on this portal; approve to push/);
        assert.equal((await finding(s)).status, 'fixing');
        // Approval still delivers end to end.
        const r = await fetchJson(baseUrl, `/api/inbox/${items[0].id}/resolve`, { method: 'POST', body: { response: 'approve' }, cookie });
        assert.equal(r.status, 200);
        await waitFor(async () => (await finding(s)).status === 'pr_open');
        assert.equal((await finding(s)).status, 'pr_open');
        assert.equal(finalizeCalls.length, 1);
      }
    } finally { process.env.AUTOFIX_ALLOW_UNATTENDED_PUSH = '1'; }
  });

  it('with AUTOFIX_ALLOW_UNATTENDED_PUSH=1 the gate goes ahead', async () => {
    const { autofixGate, unattendedPushAllowed } = await import('../server/autofix/delivery.ts');
    assert.equal(unattendedPushAllowed(), true);
    const s = await makeFix();
    assert.equal(await autofixGate(ctxOf(s), clean), 'go');
    delete process.env.AUTOFIX_ALLOW_UNATTENDED_PUSH;
    try {
      assert.equal(unattendedPushAllowed(), false);
      const t = await makeFix();
      assert.equal(await autofixGate(ctxOf(t), clean), 'ask');
    } finally { process.env.AUTOFIX_ALLOW_UNATTENDED_PUSH = '1'; }
  });

  it("writes the audit entry autofix.pr.opened with the PR number and repository when the PR is opened", async () => {
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.deepEqual(auditFor(s.findingId, 'autofix.pr.opened'), [{ prNumber: 42, repo: 'shop' }]);
  });

  it("propose mode creates a 'push' inbox item with payload.kind 'autofix' and pushes nothing until it is approved", async () => {
    const s = await makeFix({ mode: 'propose' });
    await handleRepoChanges(ctxOf(s), [clean]);
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.equal(finalizeCalls.length, 0);
    assert.equal(ghCalls.length, 0);
    assert.deepEqual(states(s), ['asked']);
    const items = inbox(s);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'push');
    assert.equal(items[0].payload.kind, 'autofix');
    assert.equal(items[0].payload.findingId, s.findingId);
    assert.equal(items[0].payload.repoId, s.repoId);
    assert.equal((await finding(s)).status, 'fixing');

    // Approving runs the ordinary createPullRequestForSession path, with the fix branch, a draft and the label.
    const r = await fetchJson(baseUrl, `/api/inbox/${items[0].id}/resolve`, { method: 'POST', body: { response: 'approve' }, cookie });
    assert.equal(r.status, 200);
    await waitFor(async () => (await finding(s)).status === 'pr_open');
    const f = await finding(s);
    assert.equal(f.status, 'pr_open');
    assert.equal(finalizeCalls.length, 1);
    assert.equal(finalizeCalls[0].branch, fixBranchName('tests', f.fingerprint));
    assert.equal(ghCalls.find((c) => /\/pulls$/.test(c.url))!.body.draft, true);
  });

  it('declining the auto-fix question moves the finding to needs_human and pushes nothing', async () => {
    const s = await makeFix({ mode: 'propose' });
    await handleRepoChanges(ctxOf(s), [clean]);
    const item = inbox(s)[0];
    await fetchJson(baseUrl, `/api/inbox/${item.id}/resolve`, { method: 'POST', body: { response: 'decline' }, cookie });
    assert.equal((await finding(s)).status, 'needs_human');
    assert.equal(finalizeCalls.length, 0);
  });

  it('a change with no paths (an older runner) asks instead of going ahead', async () => {
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [{ repo: 'shop', base: 'main', commits: 1, files: 2 }]);
    assert.equal(finalizeCalls.length, 0);
    assert.deepEqual(states(s), ['asked']);
    assert.equal(inbox(s)[0].payload.kind, 'autofix');
    assert.match(String(inbox(s)[0].payload.body), /did not report the changed files/);
  });

  it('a diff larger than the limits asks', async () => {
    const s = await makeFix();
    const paths = Array.from({ length: 11 }, (_, i) => ({ path: `src/f${i}.ts`, added: 1, removed: 0 }));
    await handleRepoChanges(ctxOf(s), [{ ...clean, files: 11, paths }]);
    assert.equal(finalizeCalls.length, 0);
    assert.deepEqual(states(s), ['asked']);
  });

  it('more than 2000 files asks without calling checkDiff', async () => {
    let called = 0;
    _setCheckDiffForTest((...a) => { called++; return checkDiff(...a); });
    const s = await makeFix();
    const paths = Array.from({ length: 2001 }, (_, i) => ({ path: `src/f${i}.ts`, added: 0, removed: 0 }));
    await handleRepoChanges(ctxOf(s), [{ ...clean, files: 2001, paths }]);
    assert.equal(called, 0);
    assert.equal(finalizeCalls.length, 0);
    assert.deepEqual(states(s), ['asked']);
  });

  it('a path longer than 1024 characters asks without calling checkDiff', async () => {
    let called = 0;
    _setCheckDiffForTest((...a) => { called++; return checkDiff(...a); });
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [{ ...clean, paths: [{ path: 'a/'.repeat(750), added: 1, removed: 0 }] }]);
    assert.equal(called, 0);
    assert.equal(finalizeCalls.length, 0);
    assert.deepEqual(states(s), ['asked']);
  });

  it('a run whose check did not pass delivers nothing yet', async () => {
    const s = await makeFix({ checkOk: false });
    await handleRepoChanges(ctxOf(s), [clean]);
    const s2 = await makeFix({ checkOk: null });
    await handleRepoChanges(ctxOf(s2), [clean]);
    for (const x of [s, s2]) {
      assert.deepEqual(states(x), []);
      assert.equal(inbox(x).length, 0);
      assert.equal((await finding(x)).status, 'fixing');
      assert.equal((await finding(x)).fix_branch, null);
    }
    assert.equal(finalizeCalls.length, 0);
  });

  it("a push failure leaves the finding 'new' with an attempt counted and a cooldown; at the attempt limit, needs_human", async () => {
    pushReply = (p) => [{ type: 'repo-pushed', repo: p.repo, branch: p.branch, error: 'remote: Permission to acme/shop.git denied (403)' }];
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [clean]);
    let f = await finding(s);
    assert.equal(f.status, 'new');
    assert.equal(f.attempts, 1);
    assert.ok(f.cooldown_until && Date.parse(f.cooldown_until) > Date.now());
    assert.equal(f.fix_branch, null);
    assert.deepEqual(ghCalls.map((c) => c.url.replace(/^.*\/repos\/acme\/shop/, '')), ['/git/ref/heads/main'], 'only the base tip was read');

    const s2 = await makeFix({ attempts: 1 }); // max_attempts is 2
    await handleRepoChanges(ctxOf(s2), [clean]);
    f = await finding(s2);
    assert.equal(f.status, 'needs_human');
    assert.equal(f.attempts, 2);
    assert.equal(inbox(s2).find((i) => i.type === 'blocked')?.payload.reason, 'attempt limit reached');
  });

  it('a workflow that belongs to no finding, or to a finding not fixing, is untouched', async () => {
    const s = await makeFix({ withFinding: false });
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.deepEqual(states(s), ['asked']);
    const pl = inbox(s)[0].payload;
    assert.equal(pl.kind, undefined);
    assert.equal(pl.title, 'Open a pull request for shop?');
    assert.equal(pl.body, '2 files changed in 1 commit(s) in shop. Approve to push a new branch and open a pull request.');

    const s2 = await makeFix();
    await repo().transition(s2.findingId, ['fixing'], { status: 'pr_open' });
    await handleRepoChanges(ctxOf(s2), [clean]);
    assert.deepEqual(states(s2), ['asked']);
    assert.equal(inbox(s2)[0].payload.kind, undefined);
  });

  it("mode 'off' while the fix ran falls through to the ordinary flow", async () => {
    const s = await makeFix();
    await saveAutofixPolicy(s.projectId, { mode: 'off' }, { actorId: userId, isAdmin: true });
    await setPullRequestSettings(s.projectId, { openPullRequests: false });
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.deepEqual(states(s), ['available'], 'setting off: the ordinary flow only offers the button');
    assert.equal(finalizeCalls.length, 0);
    assert.equal(inbox(s).length, 0);
    const f = await finding(s);
    assert.equal(f.status, 'fixing');
    assert.equal(f.fix_branch, null);
  });

  it('finalizeRunPayloadFlag asks the runner for changes of a fix session even with the setting off', async () => {
    const s = await makeFix();
    await setPullRequestSettings(s.projectId, { openPullRequests: false });
    assert.equal(await finalizeRunPayloadFlag(s.projectId, false), false);
    assert.equal(await finalizeRunPayloadFlag(s.projectId, false, s.workflowId), true);
    assert.equal(await finalizeRunPayloadFlag(s.projectId, false, 'not-a-fix-session'), false);
  });
});

describe('guardrails at and after the push', () => {
  const prPosts = () => ghCalls.filter((c) => c.method === 'POST' && /\/pulls$/.test(c.url));

  it('the finalize request carries the protected paths as denyPaths (a deps fix may touch the lockfiles)', async () => {
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.ok(finalizeCalls[0].denyPaths.includes('.github/workflows/**'));
    assert.ok(finalizeCalls[0].denyPaths.includes('package-lock.json'));
    const { denyPathsFor } = await import('../server/autofix/delivery.ts');
    const { DEFAULT_POLICY } = await import('../server/autofix/policy.ts');
    const deps = denyPathsFor(DEFAULT_POLICY, 'deps');
    assert.ok(!deps.includes('package-lock.json') && !deps.includes('**/package-lock.json') && deps.includes('**/.env*'));
  });

  it('a push the runner refuses for a protected path: needs_human, audit, blocked item, no PR', async () => {
    pushReply = (p) => [{ type: 'repo-pushed', repo: p.repo, branch: p.branch, error: 'Refusing to push: .github/workflows/ci.yml is a protected path (.github/workflows/**)', errorCode: 'protected-path' }];
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [clean]);
    const f = await finding(s);
    assert.equal(f.status, 'needs_human');
    assert.equal(f.attempts, 0);
    assert.equal(prPosts().length, 0);
    assert.equal(prEvents(s).at(-1)!.errorCode, 'protected-path');
    assert.match(String(inbox(s).find((i) => i.type === 'blocked')?.payload.reason), /ci\.yml is a protected path/);
    assert.equal(auditFor(s.findingId, 'autofix.pr.blocked').length, 1);
  });

  it('a runner too old for denyPaths fails closed: nothing pushed, needs_human, no attempt counted', async () => {
    pushReply = (p) => [{ type: 'error', message: 'Unknown field: "denyPaths"' }];
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [clean]);
    const f = await finding(s);
    assert.equal(f.status, 'needs_human');
    assert.equal(f.attempts, 0);
    assert.equal(prPosts().length, 0);
    assert.match(String(prEvents(s).at(-1)!.error), /redeploy the runners/);
  });

  for (const [name, reply, why] of [
    ['a protected path on the pushed branch', compareFiles([{ filename: 'src/cart.ts' }, { filename: '.github/workflows/release.yml' }]), /protected path: \.github\/workflows\/release\.yml/],
    ['a rename away from a protected path', compareFiles([{ filename: 'ci.yml', previous_filename: '.github/workflows/ci.yml' }]), /\.github\/workflows\/ci\.yml/],
    ['a list GitHub may have cut (300 files)', compareFiles(Array.from({ length: 300 }, (_, i) => ({ filename: `src/f${i}.ts` }))), /may be cut/],
    ['a failed compare call', () => new Response('{}', { status: 500 }), /answered 500/],
    ['an unreachable GitHub', () => { throw new Error('ECONNRESET'); }, /could not be reached/],
    ['an answer without a file list', () => new Response('{}', { status: 200 }), /without a file list/],
  ] as Array<[string, () => Response, RegExp]>) {
    it(`the server's check after the push blocks ${name}: branch deleted, no PR, needs_human`, async () => {
      compareReply = reply;
      const s = await makeFix();
      await handleRepoChanges(ctxOf(s), [clean]);
      const f = await finding(s);
      assert.equal(finalizeCalls.length, 1, 'the push happened');
      assert.equal(prPosts().length, 0, 'no pull request');
      assert.ok(ghCalls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/git/refs/heads/${finalizeCalls[0].branch}`)), 'branch deleted');
      assert.equal(f.status, 'needs_human');
      assert.match(String(inbox(s).find((i) => i.type === 'blocked')?.payload.reason), why);
      const audit = auditFor(s.findingId, 'autofix.pr.blocked');
      assert.equal(audit.length, 1);
      assert.equal(audit[0].deletedBranch, finalizeCalls[0].branch);
      assert.equal(prEvents(s).at(-1)!.errorCode, 'protected-path');
    });
  }

  it('the finalize request carries the repository URL the runner fetches the base from and pushes to', async () => {
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.equal(finalizeCalls[0].remoteUrl, 'https://github.com/acme/shop');
    assert.equal(finalizeCalls[0].baseSha, BASE_C, 'the base tip read from GitHub just before the push');
  });

  it('when the base tip cannot be read from the host nothing is pushed (fail closed), needs_human', async () => {
    baseRefStatus = 404;
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.equal(finalizeCalls.length, 0);
    assert.equal(prPosts().length, 0);
    assert.equal((await finding(s)).status, 'needs_human');
    assert.match(String(prEvents(s).at(-1)!.error), /base branch/);
  });

  it('a runner too old for baseSha fails closed', async () => {
    pushReply = () => [{ type: 'error', message: 'Unknown field: "baseSha"' }];
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.equal((await finding(s)).status, 'needs_human');
    assert.match(String(prEvents(s).at(-1)!.error), /redeploy the runners/);
  });

  it('a runner too old for remoteUrl fails closed: nothing pushed, needs_human, no attempt counted', async () => {
    pushReply = () => [{ type: 'error', message: 'Unknown field: "remoteUrl"' }];
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [clean]);
    const f = await finding(s);
    assert.equal(f.status, 'needs_human');
    assert.equal(f.attempts, 0);
    assert.equal(prPosts().length, 0);
    assert.match(String(prEvents(s).at(-1)!.error), /redeploy the runners/);
  });

  for (const [name, prep, why] of [
    ['a workflow the base deleted, resurrected on the branch (6c)', () => { headTree.push(blob('.github/workflows/old-deploy.yml', '6')); }, /old-deploy\.yml.*rebase/],
    ['a workflow the base changed since the fork', () => { baseTree[3] = blob('.github/workflows/ci.yml', '9'); }, /ci\.yml.*rebase/],
    ['a tree listing GitHub cut', () => { treeTruncated = true; }, /cut/],
    ['a branch GitHub cannot resolve', () => { refStatus = 404; }, /answered 404/],
  ] as Array<[string, () => void, RegExp]>) {
    it(`the server's tree check (base tip vs branch head) blocks ${name}: branch deleted, no PR, needs_human`, async () => {
      prep();
      const s = await makeFix();
      await handleRepoChanges(ctxOf(s), [clean]);
      assert.equal(finalizeCalls.length, 1, 'the push happened');
      assert.equal(prPosts().length, 0, 'no pull request');
      assert.ok(ghCalls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/git/refs/heads/${finalizeCalls[0].branch}`)), 'branch deleted');
      assert.equal((await finding(s)).status, 'needs_human');
      assert.match(String(inbox(s).find((i) => i.type === 'blocked')?.payload.reason), why);
    });
  }

  it('the tree check reads the base tip and the pushed branch head', async () => {
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [clean]);
    assert.ok(ghCalls.some((c) => c.url.endsWith('/git/ref/heads/main')));
    assert.ok(ghCalls.some((c) => c.url.endsWith(`/git/ref/heads/${finalizeCalls[0].branch}`)));
    assert.ok(ghCalls.some((c) => c.url.endsWith(`/git/trees/${BASE_T}?recursive=1`)));
    assert.ok(ghCalls.some((c) => c.url.endsWith(`/git/trees/${HEAD_T}?recursive=1`)));
    assert.equal((await finding(s)).status, 'pr_open');
  });

  it('the compare call names the base and the pushed branch', async () => {
    const s = await makeFix();
    await handleRepoChanges(ctxOf(s), [clean]);
    const cmp = ghCalls.find((c) => /\/compare\//.test(c.url))!;
    assert.ok(cmp.url.includes(`/compare/main...${finalizeCalls[0].branch}`), cmp.url);
    assert.equal((await finding(s)).status, 'pr_open');
  });
});

describe('no way around the gate', () => {
  it("the agent's own PR request (Codex tool) is refused for an auto-fix session", async () => {
    const s = await makeFix();
    await createRequestedSessionPullRequest({ ...ctxOf(s), engine: 'codex' }, { repo: 'shop', base: 'main' });
    assert.equal(finalizeCalls.length, 0);
    assert.equal(ghCalls.length, 0);
    assert.match(String(prEvents(s).at(-1)!.error), /cannot open a pull request itself/);
    assert.equal((await finding(s)).status, 'fixing');
  });

  it('createPullRequestForSession not from an Inbox approval is refused while the finding is fixing', async () => {
    const s = await makeFix();
    await createPullRequestForSession(s.workflowId, s.repoId);
    assert.equal(finalizeCalls.length, 0);
    assert.match(String(prEvents(s).at(-1)!.error), /approve its Inbox question/);
  });

  it('POST /api/sessions/:id/pull-request answers 409 while the finding is fixing', async () => {
    const s = await makeFix();
    const r = await fetchJson(baseUrl, `/api/sessions/${s.workflowId}/pull-request`, { method: 'POST', body: { repoId: s.repoId }, cookie });
    assert.equal(r.status, 409);
    assert.match(String((r.body as any).error), /Inbox question/);
    assert.equal(finalizeCalls.length, 0);
  });

  it('a duplicate change judged go while the first push failed opens no ordinary PR', async () => {
    pushReply = (p) => [{ type: 'repo-pushed', repo: p.repo, branch: p.branch, error: 'remote: something broke' }];
    const s = await makeFix();
    await Promise.all([handleRepoChanges(ctxOf(s), [clean]), handleRepoChanges(ctxOf(s), [clean])]);
    assert.equal(finalizeCalls.length, 1);
    assert.deepEqual(ghCalls.map((c) => c.url.replace(/^.*\/repos\/acme\/shop/, '')), ['/git/ref/heads/main'], 'only the base tip was read');
    assert.equal((await finding(s)).status, 'new');
  });
});

describe("the run's in-memory check result", () => {
  it('goes ahead on the engine\'s passing check although the stored check-result event is not written yet (DynamoDB lag)', async () => {
    const s = await makeFix({ checkOk: null });
    await handleRepoChanges({ ...ctxOf(s), check: { ok: true } }, [clean]);
    assert.equal((await finding(s)).status, 'pr_open');
  });

  it('the in-memory result wins over the stored one, and null (checks ran, no result) waits', async () => {
    const s = await makeFix({ checkOk: true });
    await handleRepoChanges({ ...ctxOf(s), check: { ok: false } }, [clean]);
    await handleRepoChanges({ ...ctxOf(s), check: null }, [clean]);
    assert.equal(finalizeCalls.length, 0);
    assert.deepEqual(states(s), []);
  });
});

describe('deleteRemoteBranch', () => {
  const ghRepo = { id: 'r1', project_id: 'p1', name: 'shop', url: 'https://github.com/acme/shop', provider: 'github', status: 'ready', default_branch: 'main', connection_id: 'c1' } as Repository;
  it('deletes only autofix/ branches and refuses anything else without calling GitHub', async () => {
    for (const b of ['main', 'portal/x', 'refs/heads/autofix/x', 'autofix', 'autofix/', 'autofix/../main', 'release/autofix/x']) {
      await assert.rejects(deleteRemoteBranch(ghRepo, b), /only autofix\/ branches/, b);
    }
    assert.equal(ghCalls.length, 0);
    assert.equal(await deleteRemoteBranch(ghRepo, 'autofix/tests-abcdef01'), true);
    assert.ok(ghCalls[0].url.endsWith('/git/refs/heads/autofix/tests-abcdef01') && ghCalls[0].method === 'DELETE');
  });
});
