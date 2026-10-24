// NEW-3 "Review new pull requests": a pull request event starts a review, findings are filtered, deduplicated, capped,
// redacted and posted (or held for approval). Demo provider and a stubbed GitHub API; the repository is a local clone
// whose address is rewritten to a GitHub one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { waitFor } from './client.ts';
import { bootWorkflowFixture, type WorkflowFixture } from './workflows-fixture.ts';

const realFetch = globalThis.fetch;
const gh = {
  calls: [] as { method: string; path: string; body: any }[],
  existing: [] as { body: string }[],
  failReviewPost: false,
  rejectInline: false,
};
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
  const u = new URL(url);
  const method = String(init?.method ?? 'GET');
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  gh.calls.push({ method, path: u.pathname, body });
  const m = u.pathname.match(/^\/repos\/acme\/payments\/pulls\/(\d+)(?:\/(\w+))?$/);
  if (!m) return new Response('{"message":"not found"}', { status: 404 });
  if (method === 'GET' && !m[2]) return Response.json({ number: Number(m[1]), title: 'Manual', state: 'open', draft: false, html_url: `https://github.com/acme/payments/pull/${m[1]}`, head: { ref: 'feature', sha: featureSha }, base: { ref: 'main' } });
  if (method === 'GET') return Response.json(gh.existing);
  if (method === 'POST' && m[2] === 'reviews') {
    if (gh.failReviewPost) return new Response('{"message":"Server Error"}', { status: 500 });
    if (gh.rejectInline && body.comments.length) return new Response('{"message":"Unprocessable Entity: line must be part of the diff"}', { status: 422 });
    return Response.json({ id: 1 });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

let f: WorkflowFixture;
let repoId = '';
let specId = '';
let secret = '';
let featureSha = '';
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prreview-repo-'));
const git = (...a: string[]) => execFileSync('git', a, { cwd: repoDir, stdio: 'pipe' }).toString().trim();
const gitId = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const sp = () => `/api/projects/${f.pid}/loop-specs`;

const APP = [
  'export const version = 1;',
  'const password = "hunter2-secret-99";',
  'console.log("debug");',
  'const value: any = load();',
  'export const q = "SELECT * FROM t WHERE id=" + id;',
  'try { run(); } catch (e) {}',
  '// TODO later',
  ...Array.from({ length: 12 }, (_, i) => `export const step${i} = ${i};`),
].join('\n') + '\n';

before(async () => {
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repoDir, 'src'));
  fs.writeFileSync(path.join(repoDir, 'src/readme.txt'), 'base\n');
  git('add', '-A');
  git(...gitId, 'commit', '-qm', 'init');
  git('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(repoDir, 'src/app.ts'), APP);
  git('add', '-A');
  git(...gitId, 'commit', '-qm', 'feature');
  featureSha = git('rev-parse', 'HEAD');
  for (const n of [7, 8, 11, 12, 13, 14, 21]) git('update-ref', `refs/pull/${n}/head`, featureSha);
  git('checkout', '-q', 'main');

  f = await bootWorkflowFixture();
  const { setSecret } = await import('../server/secrets.ts');
  await setSecret('github.token', 'ghp_test_token_1234');
  repoId = (await f.admin.post(`/api/projects/${f.pid}/repos`, { localPath: repoDir, name: 'payments' })).repo.id;
  await waitFor(async () => ((await f.admin.get(`/api/projects/${f.pid}/repos`)).repos.find((r: any) => r.id === repoId).status === 'ready' ? true : null), 'sync');
  f.exec("UPDATE repos SET provider = 'github', url = 'https://github.com/acme/payments' WHERE id = ?", repoId);
  const seeded = await f.admin.post(`${sp()}/seed`, {});
  assert.ok(seeded.created.includes('Review new pull requests'));
  const spec = (await f.admin.get(sp())).specs.find((s: any) => s.name === 'Review new pull requests');
  specId = spec.id;
  secret = spec.trigger_config.secret;
  await putSpec({ triggerConfig: { maxPerHour: 0 } });
});

after(async () => {
  globalThis.fetch = realFetch;
  await f.srv.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

async function putSpec(patch: Record<string, unknown>) {
  const cur = (await f.admin.get(`${sp()}/${specId}`)).spec;
  const { triggerConfig, ...rest } = patch as any;
  const r = await f.admin.req('PUT', `${sp()}/${specId}`, { triggerConfig: { ...cur.trigger_config, ...(triggerConfig ?? {}) }, ...rest });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.spec;
}

function prEvent(over: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) {
  const number = Number((over as any).number ?? 7);
  return {
    action: 'opened',
    number,
    pull_request: { number, node_id: `PR_${number}`, title: 'Add payments', html_url: `https://github.com/acme/payments/pull/${number}`, state: 'open', draft: false, merged: false, user: { login: 'dev' }, head: { ref: 'feature', sha: featureSha }, base: { ref: 'main' }, ...pr },
    repository: { name: 'payments', full_name: 'acme/payments', default_branch: 'main' },
    ...over,
  };
}
async function deliver(payload: any, event = 'pull_request', delivery = crypto.randomUUID()) {
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const res = await fetch(`${f.srv.base}/api/loop-specs/${specId}/github`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig, 'x-github-event': event, 'x-github-delivery': delivery, 'x-requested-with': 'agent-portal' },
    body,
  });
  return { status: res.status, data: (await res.json()) as any };
}
async function settled(reviewId: string) {
  return waitFor(async () => {
    const d = await f.admin.get(`/api/reviews/${reviewId}`);
    const w = d.review.workflow_id ? (await f.admin.get(`/api/workflows/${d.review.workflow_id}`)).workflow : null;
    return d.review.status !== 'running' && (!w || ['done', 'failed', 'blocked', 'stopped'].includes(w.status)) ? { ...d, workflow: w } : null;
  }, 'the review to settle', 40_000);
}
const reviewPosts = () => gh.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reviews'));
const inbox = async () => (await f.admin.get('/api/inbox?filter=all')).items as any[];

test('validation: review_pr is exclusive, needs a pull request trigger and checks its options', async () => {
  const post = (triggerConfig: unknown, triggerKind = 'github_event') => f.admin.req('POST', sp(), { name: `r${Math.random()}`, triggerKind, triggerConfig });
  for (const [cfg, kind, re] of [
    [{ actions: ['review_pr', 'refresh_docs'] }, 'github_event', /cannot be combined/],
    [{ action: 'review_pr' }, 'cron', /github_event trigger/],
    [{ action: 'review_pr', publishPr: true }, 'github_event', /publishPr does not apply/],
    [{ action: 'review_pr', mergedOnly: true }, 'github_event', /mergedOnly does not apply/],
    [{ action: 'review_pr', cron: '0 1 * * *' }, 'github_event', /cron does not apply/],
    [{ action: 'review_pr', postMode: 'maybe' }, 'github_event', /postMode must be one of/],
    [{ action: 'review_pr', minSeverity: 'huge' }, 'github_event', /minSeverity must be one of/],
    [{ action: 'review_pr', maxComments: 0 }, 'github_event', /maxComments must be between/],
    [{ action: 'review_pr', minConfidence: 2 }, 'github_event', /minConfidence must be between/],
    [{ action: 'review_pr', includeDrafts: 'yes' }, 'github_event', /includeDrafts must be true or false/],
    [{ action: 'review_pr', prActions: ['closed'] }, 'github_event', /prActions must be a list of/],
    [{ action: 'review_pr', repoIds: ['nope'] }, 'github_event', /repoIds must be repositories of this project/],
    [{ postMode: 'auto' }, 'github_event', /postMode is for review_pr specs/],
    [{ action: 'refresh_docs', maxComments: 5 }, 'manual', /maxComments is for review_pr specs/],
    [{ action: 'format_disk' }, 'github_event', /Action must be refresh_diagrams or refresh_docs/],
  ] as [unknown, string, RegExp][]) {
    const r = await post(cfg, kind);
    assert.equal(r.status, 400, JSON.stringify(cfg));
    assert.match(r.data.error, re);
  }
  const ok = await post({ action: 'review_pr', repoIds: [repoId] });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.spec.trigger_config.postMode, 'draft', 'draft is the default');
  assert.equal(ok.data.spec.trigger_config.minSeverity, 'medium');
  assert.equal(ok.data.spec.trigger_config.maxComments, 20);
  assert.ok(ok.data.spec.trigger_config.secret, 'a webhook secret was generated');
  const one = await post({ actions: ['review_pr'] });
  assert.equal(one.data.spec.trigger_config.action, 'review_pr', 'a list of one is stored as the single action');
  for (const r of [ok, one]) await f.admin.del(`${sp()}/${r.data.spec.id}`);
});

test('the seeded spec: draft mode, medium severity, cap 20, a budget, idempotent', async () => {
  const spec = (await f.admin.get(`${sp()}/${specId}`)).spec;
  assert.equal(spec.trigger_kind, 'github_event');
  assert.equal(spec.trigger_config.action, 'review_pr');
  assert.deepEqual(spec.trigger_config.events, ['pull_request']);
  assert.equal(spec.trigger_config.postMode, 'draft');
  assert.equal(spec.trigger_config.minSeverity, 'medium');
  assert.equal(spec.trigger_config.maxComments, 20);
  assert.equal(spec.monthly_budget_usd, 20);
  assert.equal(spec.push_mode, 'never');
  const again = await f.admin.post(`${sp()}/seed`, {});
  assert.ok(!again.created.includes('Review new pull requests'));
  assert.equal((await f.admin.get(sp())).specs.filter((s: any) => s.name === 'Review new pull requests').length, 1);
});

test('events: drafts, the portal\'s own branches, closed pull requests, other actions and other repositories are ignored', async () => {
  const before_ = (await f.admin.get(`/api/projects/${f.pid}/reviews`)).reviews.length;
  const ignored = async (payload: any, re: RegExp, event = 'pull_request') => {
    const r = await deliver(payload, event);
    assert.equal(r.status, 200);
    assert.equal(r.data.ignored, true, JSON.stringify(r.data));
    assert.match(r.data.reason, re);
  };
  await ignored(prEvent({}, { draft: true }), /Draft/);
  await ignored(prEvent({}, { head: { ref: 'docs/keep-current-20261024-abc123', sha: featureSha } }), /portal itself/);
  await ignored(prEvent({ action: 'closed' }, { state: 'closed', merged: true }), /does not start a review/);
  await ignored(prEvent({ action: 'opened' }, { state: 'closed' }), /closed/);
  await ignored(prEvent({ action: 'labeled' }), /does not start a review/);
  await ignored(prEvent({ repository: { name: 'other', full_name: 'acme/other', default_branch: 'main' } }), /not one this spec reviews/);
  await ignored(prEvent(), /event filter/, 'push');
  assert.equal((await f.admin.get(`/api/projects/${f.pid}/reviews`)).reviews.length, before_, 'none of these started a review');
});

test("the spec can opt in to draft pull requests, the portal's own branches and fewer event actions", async () => {
  const { decideGithubEvent } = await import('../server/pr-review.ts');
  const spec = (await f.admin.get(`${sp()}/${specId}`)).spec;
  const withCfg = (c: Record<string, unknown>) => ({ ...spec, trigger_config: { ...spec.trigger_config, ...c } });
  const draft = prEvent({}, { draft: true });
  const bot = prEvent({}, { head: { ref: 'docs/keep-current-20261024-abc123', sha: featureSha } });
  assert.equal(decideGithubEvent(spec, 'pull_request', draft).fire, false);
  assert.equal(decideGithubEvent(withCfg({ includeDrafts: true }), 'pull_request', draft).fire, true);
  assert.equal(decideGithubEvent(spec, 'pull_request', bot).fire, false);
  assert.equal(decideGithubEvent(withCfg({ includeBotPrs: true }), 'pull_request', bot).fire, true);
  assert.equal(decideGithubEvent(withCfg({ botBranchPrefixes: ['agent/'] }), 'pull_request', bot).fire, true, 'only the listed prefixes count as the portal');
  const ready = decideGithubEvent(spec, 'pull_request', prEvent({ action: 'ready_for_review' }));
  assert.equal(ready.fire, true, 'ready_for_review starts a review');
  assert.equal(decideGithubEvent(withCfg({ prActions: ['opened'] }), 'pull_request', prEvent({ action: 'synchronize' })).fire, false);
  assert.equal(decideGithubEvent(withCfg({ repoIds: ['g_other'] }), 'pull_request', prEvent()).fire, false, 'a repository the spec does not cover');
  if (ready.fire) assert.equal(ready.key, `github:pr-review:${repoId}#7@${featureSha}`);
});

let firstReview = '';
test('opened: a review runs, findings are stored like a manual review, and draft mode waits for approval', async () => {
  const r = await deliver(prEvent());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.workflowId && r.data.reviewId);
  firstReview = r.data.reviewId;
  const d = await settled(firstReview);
  assert.equal(d.review.status, 'done');
  assert.equal(d.review.source, 'auto');
  assert.equal(d.review.pr_number, 7);
  assert.equal(d.review.head_sha, featureSha);
  assert.equal(d.review.loop_spec_id, specId);
  assert.equal(d.review.post_mode, 'draft');
  assert.equal(d.review.post_state, 'awaiting');
  assert.equal(d.review.pr_title, 'Add payments');
  assert.ok(d.findings.length >= 7, 'every finding is stored, also those that will not be posted');
  assert.deepEqual(d.findings.map((x: any) => x.severity).filter((s: string) => s === 'critical'), ['critical']);
  assert.equal(reviewPosts().length, 0, 'draft mode posts nothing by itself');
  assert.equal(d.workflow.status, 'done');
  assert.match(d.workflow.stop_reason, /Review ready: approve to post 4 comments/);
  assert.equal(d.workflow.loop_spec_id, specId);

  const item = (await inbox()).find((i) => i.kind === 'review_ready');
  assert.ok(item, 'the Inbox asks for approval');
  assert.equal(item.reviewId, firstReview);
  assert.equal(item.prNumber, 7);
  assert.match(item.detail, /approve to post 4 comments/);
  const needs = await f.admin.get('/api/inbox');
  assert.ok(needs.items.some((i: any) => i.kind === 'review_ready'), 'it is in Needs you');
  const list = (await f.admin.get(`/api/projects/${f.pid}/reviews`)).reviews.find((x: any) => x.id === firstReview);
  assert.equal(list.source, 'auto');
  assert.equal(list.post_state, 'awaiting');
});

test('the same pull request at the same commit is reviewed once, however often it is delivered', async () => {
  const again = await deliver(prEvent(), 'pull_request', crypto.randomUUID());
  assert.equal(again.status, 200);
  assert.ok(again.data.duplicate || again.data.ignored, JSON.stringify(again.data));
  const reopened = await deliver(prEvent({ action: 'reopened' }));
  assert.equal(reopened.data.duplicate, true, 'a repeated event is a duplicate within the hour');
  // The record of the hour is gone, but the review of that commit is still there.
  f.exec('DELETE FROM trigger_history WHERE spec_id = ?', specId);
  const later = await deliver(prEvent({ action: 'reopened' }));
  assert.equal(later.data.ignored, true);
  assert.match(later.data.reason, /already reviewed/);
  const n = (await f.admin.get(`/api/projects/${f.pid}/reviews`)).reviews.filter((x: any) => x.pr_number === 7).length;
  assert.equal(n, 1);
});

test('approving posts the findings at or above the severity as one review: inline comments plus one summary, with secrets scrubbed', async () => {
  const out = await f.admin.post(`/api/reviews/${firstReview}/post-github`);
  assert.equal(out.posted, 4);
  assert.equal(out.inline, 3);
  assert.equal(out.listed, 1);
  assert.equal(out.held.severity, 3, 'low and info findings stay out');
  const posts = reviewPosts();
  assert.equal(posts.length, 1, 'one review carries the summary and the inline comments');
  const body = posts[0].body;
  assert.equal(body.event, 'COMMENT');
  assert.equal(body.commit_id, featureSha);
  assert.equal(body.comments.length, 3);
  assert.ok(body.comments.every((c: any) => c.side === 'RIGHT' && c.path === 'src/app.ts' && c.line > 0));
  assert.deepEqual(body.comments.map((c: any) => c.body.split('**')[1]).sort(), ['critical', 'high', 'medium']);
  assert.match(body.body, /no test changes/, 'the file-level finding is in the summary');
  assert.match(body.body, /Left out: 3 below medium severity/);
  const after_ = (await f.admin.get(`/api/reviews/${firstReview}`)).review;
  assert.equal(after_.post_state, 'posted');
  assert.ok(after_.posted_at);
  assert.equal((await inbox()).filter((i) => i.kind === 'review_ready').length, 0, 'the Inbox item is gone');
  // Approving twice posts nothing new.
  const twice = await f.admin.post(`/api/reviews/${firstReview}/post-github`);
  assert.equal(twice.posted, 0);
  assert.equal(reviewPosts().length, 1);
  const { all } = await import('../server/db.ts');
  const actions = all<{ action: string }>("SELECT action FROM audit_log WHERE target = ?", `review:${firstReview}`).map((a) => a.action);
  assert.ok(actions.includes('review.auto'), 'starting is audited');
  assert.ok(actions.includes('review.post'), 'posting is audited');
});

test('comments never carry a secret value, also when the reviewer quoted one', async () => {
  const r = await deliver(prEvent({ number: 14 }));
  const d = await settled(r.data.reviewId);
  assert.equal(d.review.post_state, 'awaiting');
  const secretFinding = d.findings.find((x: any) => x.severity === 'critical');
  f.exec('UPDATE findings SET message = ?, suggestion = ? WHERE id = ?', 'The password hunter2-secret-99 is hard-coded; also AKIAABCDEFGHIJKLMNOP', 'Move hunter2-secret-99 to a vault. token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"', secretFinding.id);
  f.exec('UPDATE reviews SET summary = ? WHERE id = ?', 'Found the password hunter2-secret-99 in the change.', d.review.id);
  gh.calls.length = 0;
  await f.admin.post(`/api/reviews/${d.review.id}/post-github`);
  const wire = JSON.stringify(reviewPosts()[0].body);
  for (const leaked of ['hunter2-secret-99', 'AKIAABCDEFGHIJKLMNOP', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']) assert.ok(!wire.includes(leaked), `${leaked} is not sent`);
  assert.match(wire, /\[redacted\]/);
  assert.match(wire, /hard-coded/, 'the rest of the text is kept');
});

let secondReview = '';
test('synchronize: new commits are reviewed, and a finding already posted on the pull request is not posted again', async () => {
  await putSpec({ triggerConfig: { postMode: 'auto' } });
  git('checkout', '-q', 'feature');
  fs.appendFileSync(path.join(repoDir, 'src/app.ts'), 'export const q2 = "DELETE FROM t WHERE id=" + other;\n');
  git('add', '-A');
  git(...gitId, 'commit', '-qm', 'more');
  const sha2 = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/pull/7/head', sha2);
  git('checkout', '-q', 'main');
  gh.calls.length = 0;
  const r = await deliver(prEvent({ action: 'synchronize' }, { head: { ref: 'feature', sha: sha2 } }));
  assert.ok(r.data.reviewId, JSON.stringify(r.data));
  secondReview = r.data.reviewId;
  const d = await settled(secondReview);
  assert.equal(d.review.head_sha, sha2);
  assert.equal(d.review.post_mode, 'auto');
  assert.equal(d.review.post_state, 'posted');
  const posts = reviewPosts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.comments.length, 1, 'only the new finding is posted inline');
  assert.match(posts[0].body.comments[0].body, /SQL is built by joining strings/);
  assert.equal(posts[0].body.comments[0].line, 20);
  assert.match(d.workflow.stop_reason, /Posted 1 comment to pull request #7/);
  assert.equal(d.workflow.status, 'done');
  const { one } = await import('../server/db.ts');
  assert.equal(Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM review_comments WHERE pr_number = 7')!.n), 5, 'four from the first review, one new');
});

test('a finding that GitHub already shows (marker in a comment) is not posted again even without local records', async () => {
  const { fingerprint } = await import('../server/review-post.ts');
  const { one } = await import('../server/db.ts');
  f.exec('DELETE FROM review_comments WHERE pr_number = 7');
  const d = await f.admin.get(`/api/reviews/${secondReview}`);
  const sql = d.findings.find((x: any) => /SQL/.test(x.message) && x.line === 20);
  gh.existing = [{ body: `earlier\n<!-- agent-portal:fp=${fingerprint(sql.file, sql.line, sql.message)} -->` }];
  gh.calls.length = 0;
  const out = await f.admin.post(`/api/reviews/${secondReview}/post-github`);
  assert.equal(out.held.duplicate, 1);
  assert.equal(out.posted, 4, 'the other findings are new to the pull request now');
  gh.existing = [];
  assert.equal(Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM review_comments WHERE pr_number = 7')!.n), 4);
});

test('the comment cap counts every finding the portal has put on a pull request', async () => {
  await putSpec({ triggerConfig: { postMode: 'auto', maxComments: 2 } });
  gh.calls.length = 0;
  const r = await deliver(prEvent({ number: 8 }));
  const d = await settled(r.data.reviewId);
  assert.equal(d.review.post_state, 'posted');
  const posts = reviewPosts();
  assert.equal(posts.length, 1);
  const total = posts[0].body.comments.length + (posts[0].body.body.match(/^- \*\*/gm) ?? []).length;
  assert.equal(total, 2, 'two findings, the most serious ones');
  assert.deepEqual(posts[0].body.comments.map((c: any) => c.body.split('**')[1]).sort(), ['critical', 'high']);
  assert.equal(d.review.post_result.held.cap, 2);
  assert.match(posts[0].body.body, /2 more findings not posted because 2 is the most/);
  // A second review of the same pull request cannot exceed the cap either.
  git('checkout', '-q', 'feature');
  fs.appendFileSync(path.join(repoDir, 'src/app.ts'), 'eval(userInput);\n');
  git('add', '-A');
  git(...gitId, 'commit', '-qm', 'eval');
  const sha3 = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/pull/8/head', sha3);
  git('checkout', '-q', 'main');
  gh.calls.length = 0;
  const r2 = await deliver(prEvent({ number: 8, action: 'synchronize' }, { head: { ref: 'feature', sha: sha3 } }));
  const d2 = await settled(r2.data.reviewId);
  assert.equal(d2.review.post_state, 'nothing');
  assert.equal(reviewPosts().length, 0, 'nothing more is posted once the pull request has its two');
  assert.match(d2.workflow.stop_reason, /Nothing to post/);
});

test('a finding below the confidence threshold is held back unless a person accepted it', async () => {
  const { planPost, MANUAL_POST_OPTIONS } = await import('../server/review-post.ts');
  const files = [{ oldPath: 'a.ts', newPath: 'a.ts', status: 'modified', binary: false, additions: 2, deletions: 0, hunks: [{ header: '@@', lines: [{ type: 'add', text: 'x', oldLine: null, newLine: 1 }, { type: 'add', text: 'y', oldLine: null, newLine: 2 }] }] }] as any;
  const mk = (id: string, line: number, over: Record<string, unknown> = {}) => ({ id, file: 'a.ts', line, severity: 'high', category: 'c', message: `m${id}`, suggestion: null, status: 'open', confidence: 0.9, ...over });
  const opts = { ...MANUAL_POST_OPTIONS, minConfidence: 0.6, minSeverity: 'medium' as const, dedupe: true };
  const plan = planPost([mk('1', 1), mk('2', 2, { confidence: 0.2 }), mk('3', 2, { confidence: 0.2, status: 'accepted', message: 'accepted' }), mk('4', 99), mk('5', 1, { severity: 'low', status: 'accepted', message: 'low accepted' }), mk('6', 1, { status: 'dismissed', message: 'gone' })], files, opts, new Set(), 0);
  assert.deepEqual(plan.held.map((h) => [h.f.id, h.reason]), [['2', 'confidence']]);
  assert.deepEqual(plan.inline.map((p) => p.f.id).sort(), ['1', '3', '5']);
  assert.deepEqual(plan.listed.map((p) => p.f.id), ['4'], 'a line outside the diff goes in the summary, not inline');
});

test('GitHub refusing an inline line falls back to one summary comment holding everything', async () => {
  await putSpec({ triggerConfig: { postMode: 'auto', maxComments: 20 } });
  gh.rejectInline = true;
  gh.calls.length = 0;
  const r = await deliver(prEvent({ number: 11 }));
  const d = await settled(r.data.reviewId);
  gh.rejectInline = false;
  assert.equal(d.review.post_state, 'posted');
  assert.equal(d.review.post_result.inline, 0);
  assert.equal(d.review.post_result.listed, 4);
  const posts = reviewPosts();
  assert.equal(posts.length, 2, 'the refused review and the fallback');
  assert.equal(posts[1].body.comments.length, 0);
  assert.match(posts[1].body.body, /Findings:/);
});

test('failure: a review that cannot run stops its session as failed and lands in the Inbox', async () => {
  const r = await deliver(prEvent({ number: 9 }));
  assert.ok(r.data.reviewId, JSON.stringify(r.data));
  const d = await waitFor(async () => {
    const x = await f.admin.get(`/api/reviews/${r.data.reviewId}`);
    return x.review.status === 'error' ? x : null;
  }, 'the review to fail');
  assert.equal(d.review.status, 'error');
  const w = await waitFor(async () => {
    const x = (await f.admin.get(`/api/workflows/${d.review.workflow_id}`)).workflow;
    return x.status === 'failed' ? x : null;
  }, 'the session to fail');
  assert.match(w.stop_reason, /The review failed while preparing the changes/);
  const esc = (await inbox()).find((i) => i.kind === 'escalation' && i.workflowId === d.review.workflow_id);
  assert.ok(esc, 'the failure is an Inbox escalation');
  assert.match(esc.detail, /escalated \(failed\)/);
  const { one } = await import('../server/db.ts');
  assert.ok(one("SELECT 1 AS x FROM audit_log WHERE action = 'review.auto_error' AND target = ?", `review:${r.data.reviewId}`), 'the failure is audited');

  // Once the cause is fixed, Resume on the session reviews again.
  git('update-ref', 'refs/pull/9/head', featureSha);
  await f.admin.post(`/api/workflows/${d.review.workflow_id}/resume`);
  const again = await settled(r.data.reviewId);
  assert.equal(again.review.status, 'done');
  assert.equal(again.review.post_state, 'posted', 'the spec is in auto mode at this point');
  assert.equal(again.workflow.status, 'done');
});

test('failure while posting in auto mode keeps the review and escalates', async () => {
  gh.failReviewPost = true;
  const r = await deliver(prEvent({ number: 12 }));
  const d = await waitFor(async () => {
    const x = await f.admin.get(`/api/reviews/${r.data.reviewId}`);
    return x.review.post_state === 'failed' ? x : null;
  }, 'posting to fail');
  gh.failReviewPost = false;
  assert.equal(d.review.status, 'done', 'the review itself is kept');
  assert.ok(d.findings.length > 0);
  assert.match(d.review.post_result.error, /GitHub said 500/);
  const w = await waitFor(async () => {
    const x = (await f.admin.get(`/api/workflows/${d.review.workflow_id}`)).workflow;
    return x.status === 'failed' ? x : null;
  }, 'the session to fail');
  assert.match(w.stop_reason, /posting the comments/);
  const retry = await f.admin.post(`/api/reviews/${d.review.id}/post-github`);
  assert.equal(retry.posted, 4, 'a person can post it again');
});

test('one running review per pull request, the rate limit, and the spec budget', async () => {
  // A review still running for pull request 13 means a second event waits.
  const rid = 'v_fakebusy';
  f.exec(
    "INSERT INTO reviews (id, project_id, repo_id, base, head, pr_number, head_sha, status, created_at, source, loop_spec_id) VALUES (?, ?, ?, 'main', 'pr/13', 13, 'other-sha', 'running', ?, 'auto', ?)",
    rid, f.pid, repoId, new Date().toISOString(), specId,
  );
  const busy = await deliver(prEvent({ number: 13 }));
  assert.equal(busy.data.ignored, true);
  assert.match(busy.data.reason, /still running/);
  f.exec('DELETE FROM reviews WHERE id = ?', rid);

  // Rate limit: the spec fired a few times in the last hour.
  await putSpec({ triggerConfig: { maxPerHour: 1 } });
  const limited = await deliver(prEvent({ number: 13 }));
  assert.equal(limited.status, 429);
  await putSpec({ triggerConfig: { maxPerHour: 0 } });

  // Budget: the sessions of the spec have used the month's money.
  f.exec('UPDATE workflows SET spent_usd = 25 WHERE loop_spec_id = ? AND created_at = (SELECT MAX(created_at) FROM workflows WHERE loop_spec_id = ?)', specId, specId);
  const reviewsBefore = (await f.admin.get(`/api/projects/${f.pid}/reviews`)).reviews.length;
  const broke = await deliver(prEvent({ number: 13 }));
  assert.equal(broke.status, 400);
  assert.match(broke.data.error, /monthly budget of \$20 is used up/);
  assert.equal((await f.admin.get(`/api/projects/${f.pid}/reviews`)).reviews.length, reviewsBefore, 'no review was started');
  await putSpec({ monthlyBudgetUsd: 1000 });
});

test('draft mode keeps the choice with a person: skip removes the Inbox item, a newer commit supersedes it', async () => {
  await putSpec({ triggerConfig: { postMode: 'draft' } });
  const r = await deliver(prEvent({ number: 13 }));
  assert.ok(r.data.reviewId, JSON.stringify(r.data));
  const d = await settled(r.data.reviewId);
  assert.equal(d.review.post_state, 'awaiting');
  const waiting = (id: string) => inbox().then((items) => items.filter((i) => i.kind === 'review_ready' && i.reviewId === id).length);
  assert.equal(await waiting(r.data.reviewId), 1);
  // A newer commit replaces a review that still waits.
  git('checkout', '-q', 'feature');
  fs.appendFileSync(path.join(repoDir, 'src/app.ts'), 'export const z = 1;\n');
  git('add', '-A');
  git(...gitId, 'commit', '-qm', 'z');
  const sha4 = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/pull/13/head', sha4);
  git('checkout', '-q', 'main');
  const b = await deliver(prEvent({ number: 13, action: 'synchronize' }, { head: { ref: 'feature', sha: sha4 } }));
  await settled(b.data.reviewId);
  assert.equal((await f.admin.get(`/api/reviews/${r.data.reviewId}`)).review.post_state, 'superseded');
  assert.equal(await waiting(r.data.reviewId), 0);
  assert.equal(await waiting(b.data.reviewId), 1);

  assert.equal((await f.viewer.req('POST', `/api/reviews/${b.data.reviewId}/skip-post`, {})).status, 403, 'a viewer cannot decide');
  await f.admin.post(`/api/reviews/${b.data.reviewId}/skip-post`);
  assert.equal((await f.admin.get(`/api/reviews/${b.data.reviewId}`)).review.post_state, 'skipped');
  assert.equal(await waiting(b.data.reviewId), 0);
  assert.equal((await f.admin.req('POST', `/api/reviews/${b.data.reviewId}/skip-post`, {})).status, 400);
});

test('a person can run the spec on a pull request by number', async () => {
  const bad = await f.admin.req('POST', `${sp()}/${specId}/run`, {});
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /pr\.number/);
  gh.calls.length = 0;
  const ran = await f.admin.post(`${sp()}/${specId}/run`, { vars: { 'pr.number': 21 } });
  assert.ok(ran.workflow.id, JSON.stringify(ran.workflow));
  assert.ok(gh.calls.some((c) => c.method === 'GET' && c.path.endsWith('/pulls/21')), 'the pull request is read from GitHub');
  assert.equal(ran.workflow.review.id.startsWith('v_'), true);
  const d = await settled(ran.workflow.review.id);
  assert.equal(d.review.source, 'auto');
  assert.equal(d.review.pr_number, 21);
  assert.equal(d.review.pr_title, 'Manual');
});

test('CodeCommit: a pull request reviewed by hand gets one summary comment and no inline comments', async () => {
  const cc = await import('../server/codecommit.ts');
  const sent: any[] = [];
  cc.setCodeCommitClientFactory(() => ({
    send: async (cmd: any) => {
      const n = cmd.constructor.name;
      sent.push({ n, input: cmd.input });
      if (n === 'GetPullRequestCommand') {
        return { pullRequest: { title: 'CC change', pullRequestTargets: [{ repositoryName: 'payments', sourceReference: 'refs/heads/feature', destinationReference: 'refs/heads/main', sourceCommit: featureSha, destinationCommit: 'basecommit' }] } };
      }
      return {};
    },
  }) as any);
  const ccRepo = (await f.admin.post(`/api/projects/${f.pid}/repos`, { localPath: repoDir, name: 'payments-cc' })).repo.id;
  await waitFor(async () => ((await f.admin.get(`/api/projects/${f.pid}/repos`)).repos.find((r: any) => r.id === ccRepo).status === 'ready' ? true : null), 'sync cc');
  f.exec("UPDATE repos SET provider = 'codecommit', url = 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/payments' WHERE id = ?", ccRepo);
  await putSpec({ triggerConfig: { postMode: 'auto' } });
  const ran = await f.admin.post(`${sp()}/${specId}/run`, { vars: { 'pr.number': 5, 'repo.id': ccRepo } });
  assert.ok(ran.workflow.id, JSON.stringify(ran.workflow));
  const d = await settled(ran.workflow.review.id);
  assert.equal(d.review.post_state, 'posted', JSON.stringify(d.review.post_result));
  const comments = sent.filter((s) => s.n === 'PostCommentForPullRequestCommand');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].input.beforeCommitId, 'basecommit');
  assert.equal(comments[0].input.afterCommitId, featureSha);
  assert.equal(comments[0].input.location, undefined, 'no inline location');
  assert.match(comments[0].input.content, /Agent Portal review/);
  assert.match(comments[0].input.content, /src\/app\.ts:\d+/);
  assert.ok(!comments[0].input.content.includes('hunter2-secret-99'));
  assert.equal(d.review.post_result.inline, 0);
});

test('redaction: values with a secret\'s shape or assigned to a secret-like name are scrubbed', async () => {
  const { redactSecrets, secretLiterals } = await import('../server/agent/heuristics.ts');
  assert.equal(redactSecrets('password = "abcdef123456" and api_key: \'zzzzzzzz9999\''), 'password = "[redacted]" and api_key: \'[redacted]\'');
  assert.equal(redactSecrets('use AKIAIOSFODNN7EXAMPLE now'), 'use [redacted] now');
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'), 'Authorization: Bearer [redacted]');
  assert.equal(redactSecrets('the value is s3cr3t-value here', ['s3cr3t-value']), 'the value is [redacted] here');
  assert.deepEqual(secretLiterals('const apiKey = "tok_abcdef123456";'), ['tok_abcdef123456']);
  assert.equal(redactSecrets('nothing to hide, short = "abc"'), 'nothing to hide, short = "abc"');
});
