// NEW-2 "Keep docs current": stale diagrams and documents refreshed in one firing and proposed as one pull request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { waitFor } from './client.ts';
import { bootWorkflowFixture, type WorkflowFixture } from './workflows-fixture.ts';

let f: WorkflowFixture;
let repoId = '';
let diagramId = '';
let diagramSlug = '';
let docId = '';
let specId = '';
let secret = '';
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsync-repo-'));
const git = (...a: string[]) => execFileSync('git', a, { cwd: repoDir, stdio: 'pipe' }).toString().trim();
const gitId = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

before(async () => {
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repoDir, 'app.py'), 'def handler(event, context):\n    return {"ok": True}\n');
  git('add', '-A');
  git(...gitId, 'commit', '-qm', 'init');
  f = await bootWorkflowFixture();
  repoId = (await f.admin.post(`/api/projects/${f.pid}/repos`, { localPath: repoDir, name: 'payments' })).repo.id;
  await syncWait();
  const dg = await f.admin.post(`/api/projects/${f.pid}/diagrams`, { kind: 'components', repoId, title: 'Payments components' });
  diagramId = dg.diagram.id;
  diagramSlug = dg.diagram.slug;
  await waitFor(async () => ((await f.admin.get(`/api/projects/${f.pid}/diagrams/${diagramId}`)).diagram.status !== 'generating' ? true : null), 'diagram');
  const doc = await f.admin.post(`/api/projects/${f.pid}/generated-docs`, { type: 'architecture', repoIds: [repoId], title: 'Payments architecture', diagramIds: [diagramId] });
  docId = doc.document.id;
  await waitFor(async () => ((await f.admin.get(`/api/projects/${f.pid}/generated-docs/${docId}`)).document.status !== 'generating' ? true : null), 'document');
});

after(async () => {
  await f.srv.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

const sp = () => `/api/projects/${f.pid}/loop-specs`;
async function syncWait() {
  await f.admin.post(`/api/repos/${repoId}/sync`);
  await waitFor(async () => ((await f.admin.get(`/api/projects/${f.pid}/repos`)).repos.find((r: any) => r.id === repoId).status === 'ready' ? true : null), 'sync');
}
let n = 0;
async function commitUpstream() {
  const name = `m${++n}.py`;
  fs.writeFileSync(path.join(repoDir, name), `# ${name}\n`);
  git('add', '-A');
  git(...gitId, 'commit', '-qm', `add ${name}`);
  await syncWait();
}
const putSpec = async (patch: Record<string, unknown>) => {
  const cur = (await f.admin.get(`${sp()}/${specId}`)).spec;
  const { triggerConfig, ...rest } = patch as any;
  return (await f.admin.req('PUT', `${sp()}/${specId}`, { triggerConfig: { ...cur.trigger_config, ...(triggerConfig ?? {}) }, ...rest })).data.spec;
};
const job = async () => (await import('../server/docs-sync.ts')).docsSyncJob;
async function waitPublished(wid: string) {
  const docsSyncJob = await job();
  return waitFor(async () => {
    const j = docsSyncJob(wid);
    const w = (await f.admin.get(`/api/workflows/${wid}`)).workflow;
    return j && j.status !== 'waiting' && w.status !== 'running' ? { j, w } : null;
  }, 'the firing to be ready', 60_000);
}
test('validation: an action list is checked and a list of one is stored as the single action', async () => {
  const { specActions } = await import('../server/loop-specs.ts');
  const post = (triggerConfig: unknown, triggerKind = 'manual') => f.admin.req('POST', sp(), { name: `v${Math.random()}`, triggerKind, triggerConfig });
  for (const [cfg, re] of [
    [{ actions: ['refresh_diagrams', 'format_disk'] }, /Action must be refresh_diagrams or refresh_docs/],
    [{ actions: 'refresh_docs' }, /Actions must be a list/],
    [{ actions: ['refresh_docs', 'refresh_docs'] }, /each action once/],
    [{ actions: ['refresh_docs', 'refresh_diagrams', 'refresh_docs'] }, /each action once/],
    [{ action: 'refresh_docs', actions: ['refresh_diagrams', 'refresh_docs'] }, /either action or actions/],
    [{ publishPr: true }, /publishPr needs an action/],
    [{ publishPr: 'yes', actions: ['refresh_docs'] }, /publishPr must be true or false/],
    [{ mergedOnly: true }, /mergedOnly is for github_event/],
    [{ actions: ['refresh_docs'], publishPr: true, repoId: 'nope' }, /repoId must be a repository of this project/],
  ] as [unknown, RegExp][]) {
    const r = await post(cfg);
    assert.equal(r.status, 400, JSON.stringify(cfg));
    assert.match(r.data.error, re);
  }
  const bad = await post({ cron: '* * *' , actions: ['refresh_docs'] }, 'github_event');
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Cron must have 5 fields/);

  const one = await post({ actions: ['refresh_docs'], maxPerHour: 0 });
  assert.equal(one.data.spec.trigger_config.action, 'refresh_docs');
  assert.equal(one.data.spec.trigger_config.actions, undefined);
  const two = await post({ actions: ['refresh_docs', 'refresh_diagrams'], maxPerHour: 0 });
  assert.deepEqual(two.data.spec.trigger_config.actions, ['refresh_docs', 'refresh_diagrams']);
  assert.equal(two.data.spec.trigger_config.action, undefined);
  assert.deepEqual(specActions(two.data.spec.trigger_config), ['refresh_diagrams', 'refresh_docs'], 'diagrams always run first');
  assert.deepEqual(specActions({ action: 'refresh_docs' }), ['refresh_docs'], 'the single action stays valid');
  for (const r of [one, two]) await f.admin.del(`${sp()}/${r.data.spec.id}`);
});

test('the Keep docs current spec is seeded and editable', async () => {
  const seeded = await f.admin.post(`${sp()}/seed`, {});
  assert.ok(seeded.created.includes('Keep docs current'));
  const spec = (await f.admin.get(sp())).specs.find((s: any) => s.name === 'Keep docs current');
  specId = spec.id;
  assert.equal(spec.trigger_kind, 'github_event');
  assert.deepEqual(spec.trigger_config.actions, ['refresh_diagrams', 'refresh_docs']);
  assert.equal(spec.trigger_config.publishPr, true);
  assert.equal(spec.trigger_config.mergedOnly, true);
  assert.equal(spec.trigger_config.cron, '0 1 * * *');
  assert.equal(spec.push_mode, 'ask');
  assert.ok(spec.trigger_config.secret, 'a webhook secret was generated');
  secret = spec.trigger_config.secret;
  const edited = await putSpec({ description: 'Edited', triggerConfig: { maxPerHour: 0 } });
  assert.equal(edited.description, 'Edited');
  assert.equal(edited.trigger_config.publishPr, true);
  assert.equal(edited.trigger_config.secret, secret);
  const again = await f.admin.post(`${sp()}/seed`, {});
  assert.ok(!again.created.includes('Keep docs current'), 'seeding is idempotent');
});

test('nothing stale: no session and no pull request', async () => {
  const r = await f.admin.post(`${sp()}/${specId}/run`, {});
  assert.equal(r.workflow.id, null);
  assert.equal(r.workflow.refreshed.refresh_diagrams.started.length, 0);
  assert.equal(r.workflow.refreshed.refresh_docs.started.length, 0);
  const { workflows } = await f.admin.get(`/api/projects/${f.pid}/workflows`);
  assert.equal(workflows.filter((w: any) => w.loop_spec_id === specId).length, 0);
});

let firstBranch = '';
test('stale diagrams and documents are refreshed in one firing and end as one pull-request-ready branch', async () => {
  await commitUpstream();
  const ran = await f.admin.post(`${sp()}/${specId}/run`, {});
  const wid = ran.workflow.id;
  assert.ok(wid);
  assert.equal(ran.workflow.loop_spec_id, specId);
  assert.equal(ran.workflow.status, 'paused');
  assert.equal(ran.workflow.refreshed.refresh_diagrams.started.length, 1);

  const { j, w } = await waitPublished(wid);
  assert.equal(j.status, 'publishing');
  assert.deepEqual(j.items.map((i) => [i.kind, i.ok]), [['diagram', true], ['doc', true]]);
  assert.equal(j.results.refresh_docs.started.length, 1, 'documents were started after the diagrams were stored');
  assert.equal(w.status, 'paused');
  assert.equal(w.push_mode, 'ask');
  assert.ok(w.pending_push, 'waiting for a person to allow the push');
  assert.match(w.pending_push.branch, /^docs\/keep-current-\d{8}-[a-z0-9]{6}$/);
  assert.equal(w.pending_push.pr, true);
  assert.match(w.title, /1 diagram and 1 document/);
  firstBranch = w.pending_push.branch;

  const dg = (await f.admin.get(`/api/projects/${f.pid}/diagrams/${diagramId}`)).diagram;
  const doc = (await f.admin.get(`/api/projects/${f.pid}/generated-docs/${docId}`)).document;
  assert.equal(dg.version, 2);
  assert.equal(doc.version, 2);
  assert.equal(doc.diagrams[0].used_version, 2, 'the document embeds the diagram version stored in this firing');

  const wt = (await f.admin.get(`/api/workflows/${wid}`)).workflow;
  const run = (await import('../server/agent/runner.ts')).getRun(wt.last_run_id);
  const meta = JSON.parse(run.meta);
  const wtDir = path.join(f.srv.dataDir, 'projects', (await f.admin.get(`/api/projects/${f.pid}`)).project.slug, meta.repos[0].worktree);
  assert.equal(fs.readFileSync(path.join(wtDir, 'docs/diagrams', `${diagramSlug}.mmd`), 'utf8').trim(), dg.mermaid.trim());
  const md = fs.readFileSync(path.join(wtDir, 'docs/generated/payments-architecture.md'), 'utf8');
  assert.match(md, /^# /);
  assert.ok(md.includes(dg.mermaid.trim().split('\n')[0]), 'the document carries the diagram');
  assert.equal(run.result.includes('docs/diagrams/'), true, 'the pull request body lists the files');

  const busy = await f.admin.post(`${sp()}/${specId}/run`, {});
  assert.equal(busy.workflow.id, null);
  assert.match(busy.workflow.stop_reason, /previous run of this spec has not finished/);

  const allowed = await f.admin.post(`/api/workflows/${wid}/push/allow`, {});
  assert.equal(allowed.push.ok, true, JSON.stringify(allowed.push));
  assert.equal(allowed.workflow.status, 'done');
  const branches = git('branch', '--list', firstBranch);
  assert.match(branches, /keep-current/);
  assert.match(git('show', `${firstBranch}:docs/diagrams/${diagramSlug}.mmd`), /flowchart/);
  assert.match(git('show', `${firstBranch}:docs/generated/payments-architecture.md`), /^# /);
  assert.equal(git('ls-tree', '-r', '--name-only', firstBranch, '--', 'docs').split('\n').sort().join(','), `docs/diagrams/${diagramSlug}.mmd,docs/generated/payments-architecture.md`);
});

test('after the pull request is merged, the documentation commits alone do not start another one', async () => {
  git(...gitId, 'merge', '--no-ff', '-m', 'Merge docs', firstBranch);
  await syncWait();
  const r = await f.admin.post(`${sp()}/${specId}/run`, {});
  assert.equal(r.workflow.id, null);
  assert.match(r.workflow.refreshed.refresh_diagrams.skipped[0].reason, /Only generated files changed/);
  const before = (await f.admin.get(`/api/projects/${f.pid}/diagrams/${diagramId}`)).diagram.version;
  assert.equal(before, 2);
});

function ghPayload(over: Record<string, unknown> = {}) {
  return { action: 'closed', number: 7, pull_request: { node_id: `PR_${over.id ?? 'x'}`, number: 7, merged: true, base: { ref: 'main' }, head: { ref: 'feature' } }, repository: { name: 'payments', full_name: 'acme/payments', default_branch: 'main' }, ...over };
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

test('github_event: only a pull request merged into the default branch fires', async () => {
  await commitUpstream();
  const notMerged = await deliver(ghPayload({ pull_request: { node_id: 'PR_a', merged: false, base: { ref: 'main' } } }));
  assert.equal(notMerged.data.ignored, true);
  assert.match(notMerged.data.reason, /not merged/);
  const opened = await deliver(ghPayload({ action: 'opened' }));
  assert.equal(opened.data.ignored, true);
  const otherBase = await deliver(ghPayload({ pull_request: { node_id: 'PR_b', merged: true, base: { ref: 'release-2' } } }));
  assert.equal(otherBase.data.ignored, true);
  assert.match(otherBase.data.reason, /default branch/);
  const noHistory = (await f.admin.get(`${sp()}/${specId}/trigger-history`)).history;
  assert.equal(noHistory.filter((h: any) => h.kind === 'github_event').length, 0);

  const ok = await deliver(ghPayload({ id: 'good' }));
  assert.equal(ok.status, 200);
  assert.ok(ok.data.workflowId, JSON.stringify(ok.data));
  const dup = await deliver(ghPayload({ id: 'good' }));
  assert.equal(dup.data.duplicate, true, 'a redelivery of the same merge is a duplicate');
  const { j, w } = await waitPublished(ok.data.workflowId);
  assert.equal(j.status, 'publishing');
  assert.ok(w.pending_push);
  const denied = await f.admin.post(`/api/workflows/${ok.data.workflowId}/push/deny`, {});
  assert.equal(denied.workflow.status, 'done');
  const events = (await f.admin.get(`${sp()}/${specId}/trigger-history`)).history;
  assert.equal(events.filter((h: any) => h.kind === 'github_event').length, 1);
});

test('cron: the nightly schedule fires a github_event spec once per minute', async () => {
  await commitUpstream();
  const { tickCron, setNowMs } = await import('../server/loop-triggers.ts');
  setNowMs(() => new Date(2030, 0, 7, 1, 0, 0).getTime());
  try {
    await tickCron();
    await tickCron();
  } finally {
    setNowMs(null);
  }
  const hist = (await f.admin.get(`${sp()}/${specId}/trigger-history`)).history.filter((h: any) => h.kind === 'cron');
  assert.equal(hist.length, 1);
  assert.ok(hist[0].workflow_id);
  const { w } = await waitPublished(hist[0].workflow_id);
  assert.ok(w.pending_push);
  await f.admin.post(`/api/workflows/${hist[0].workflow_id}/push/deny`, {});
});

test('rate limit: a spec cannot fire more often than maxPerHour', async () => {
  await putSpec({ triggerConfig: { maxPerHour: 1, cron: undefined } });
  const hist = (await f.admin.get(`${sp()}/${specId}/trigger-history`)).history.length;
  assert.ok(hist >= 1);
  const r = await f.admin.req('POST', `${sp()}/${specId}/run`, {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /already fired 1 time/);
});

test('auto push mode pushes without asking; the spec budget stops a firing', async () => {
  await putSpec({ pushMode: 'auto', triggerConfig: { maxPerHour: 0 } });
  await commitUpstream();
  const r = await f.admin.post(`${sp()}/${specId}/run`, {});
  const w = await waitFor(async () => {
    const x = (await f.admin.get(`/api/workflows/${r.workflow.id}`)).workflow;
    return x.status === 'done' ? x : null;
  }, 'the automatic push', 60_000);
  assert.equal(w.pending_push, null);
  assert.match(git('branch', '--list', w.work_branch), /keep-current/);
  const push = (await f.admin.get(`/api/workflows/${r.workflow.id}`)).events?.find((e: any) => e.kind === 'push');
  if (push) assert.equal(push.data.results[0].ok, true);

  await putSpec({ monthlyBudgetUsd: 0.000001 });
  const { run: exec } = await import('../server/db.ts');
  exec('UPDATE workflows SET spent_usd = 1 WHERE id = ?', r.workflow.id);
  const stopped = await f.admin.req('POST', `${sp()}/${specId}/run`, {});
  assert.equal(stopped.status, 400);
  assert.match(stopped.data.error, /monthly budget/);
});

test('a failing verification step blocks the firing, keeps the files for review and escalates to the Inbox', async () => {
  const { run: exec, one } = await import('../server/db.ts');
  exec('UPDATE loop_specs SET monthly_budget_usd = NULL WHERE id = ?', specId);
  await putSpec({ pushMode: 'ask', verification: [{ step: 'always-fails', cmd: 'node -e "process.exit(1)"', required: true, kind: 'cmd' }] });
  await commitUpstream();
  const r = await f.admin.post(`${sp()}/${specId}/run`, {});
  const { j, w } = await waitPublished(r.workflow.id);
  assert.equal(j.status, 'finished');
  assert.equal(w.status, 'blocked');
  assert.match(w.stop_reason, /verification pipeline failed/);
  assert.equal(w.pending_push, null, 'nothing is proposed');
  const esc = one<any>("SELECT body FROM workflow_events WHERE workflow_id = ? AND kind = 'escalation'", r.workflow.id);
  assert.match(esc.body, /escalated \(blocked\)/);
});
