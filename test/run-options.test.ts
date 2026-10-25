// Lead agent and "trust all tools" for the features that start a session of their own: diagrams, generated documents and presentations.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { waitFor } from './client.ts';
import { bootWorkflowFixture, type WorkflowFixture } from './workflows-fixture.ts';
import { alwaysBlockedCommand, blockedCommand } from '../server/guardrails.ts';

let f: WorkflowFixture;
let repoId: string;
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runopt-repo-'));
const git = (...a: string[]) => execFileSync('git', a, { cwd: repoDir, stdio: 'pipe' }).toString().trim();

before(async () => {
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repoDir, 'app.py'), 'def handler(event, context):\n    return {"ok": True}\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  f = await bootWorkflowFixture();
  const { repo } = await f.admin.post(`/api/projects/${f.pid}/repos`, { localPath: repoDir, name: 'payments' });
  repoId = repo.id;
  await waitFor(async () => ((await f.admin.get(`/api/projects/${f.pid}/repos`)).repos.find((r: any) => r.id === repoId).status === 'ready' ? true : null), 'clone');
  await f.admin.put(`/api/projects/${f.pid}/agents/tech-lead`, { description: 'Plans and reviews', prompt: 'You plan the work.', model: 'sonnet', tools: ['Read'] });
  await f.admin.put(`/api/projects/${f.pid}/agents/developer`, { description: 'Implements', prompt: 'You build.', model: 'sonnet', tools: ['Read'] });
});

after(async () => {
  await f.srv.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

const P = () => `/api/projects/${f.pid}`;
const docs = () => `${P()}/generated-docs`;
const diagrams = () => `${P()}/diagrams`;
const decks = () => `${P()}/presentations`;
const docSettled = (id: string) =>
  waitFor(async () => {
    const r = await f.admin.get(`${docs()}/${id}`);
    return r.document.status !== 'generating' ? r : null;
  }, 'the document session');
const diagramSettled = (id: string) =>
  waitFor(async () => {
    const r = await f.admin.get(`${diagrams()}/${id}`);
    return r.diagram.status !== 'generating' ? r : null;
  }, 'the diagram session');
const deckSettled = (id: string) =>
  waitFor(async () => {
    const r = await f.admin.get(`${decks()}/${id}`);
    return r.presentation.status !== 'generating' ? r : null;
  }, 'the presentation session');
const session = async (id: string) => (await f.admin.get(`/api/workflows/${id}`)).workflow;

test('every list response carries the lead agent choices, the default and the trust default', async () => {
  for (const url of [diagrams(), docs(), decks()]) {
    const r = (await f.admin.get(url)).runOptions;
    assert.equal(r.engine, 'claude');
    assert.deepEqual(r.leadAgents.map((a: any) => a.name).sort(), ['developer', 'tech-lead']);
    assert.equal(r.leadAgents[0].kind, 'claude');
    assert.equal(typeof r.leadAgents[0].description, 'string');
    assert.equal(r.defaultLeadAgent, '');
    assert.equal(r.trustAllTools, false);
  }
  await f.admin.patch(P(), { defaultLeadAgent: 'tech-lead' });
  assert.equal((await f.admin.get(docs())).runOptions.defaultLeadAgent, 'tech-lead');
  await f.admin.patch(P(), { defaultLeadAgent: 'gone-agent' });
  assert.equal((await f.admin.get(docs())).runOptions.defaultLeadAgent, '', 'a default that cannot lead is not offered');
  await f.admin.patch(P(), { defaultLeadAgent: '' });
});

test('invalid leadAgent and trustAllTools are refused with the launcher messages, before anything is created', async () => {
  const bad = await f.admin.req('POST', docs(), { type: 'overview', title: 'Bad lead', leadAgent: 'ghost' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /"ghost" is not an enabled agent in this project/);
  const launcher = await f.admin.req('POST', `${P()}/workflows`, { goal: 'x', leadAgent: 'ghost', playground: true });
  assert.equal(bad.data.error, launcher.data.error, 'the same message as the normal launcher');
  assert.equal((await f.admin.req('POST', docs(), { type: 'overview', leadAgent: 5 })).status, 400);
  assert.equal((await f.admin.req('POST', docs(), { type: 'overview', trustAllTools: 'yes' })).status, 400);
  assert.equal((await f.admin.req('POST', diagrams(), { kind: 'components', repoId, leadAgent: 'ghost' })).status, 400);
  assert.equal((await f.admin.req('POST', decks(), { topic: 'Refund policy', leadAgent: 'ghost' })).status, 400);
  assert.equal((await f.admin.req('POST', `${docs()}/refresh-stale`, { leadAgent: 'ghost' })).status, 400);
  assert.equal((await f.admin.req('POST', `${diagrams()}/refresh-stale`, { trustAllTools: 1 })).status, 400);
  assert.equal((await f.admin.get(docs())).documents.length, 0, 'nothing was created');
  assert.equal((await f.admin.get(diagrams())).diagrams.length, 0);
  assert.equal((await f.admin.get(decks())).presentations.length, 0);
  assert.equal((await f.viewer.req('POST', docs(), { type: 'overview', leadAgent: 'developer' })).status, 403);
});

test('documents: the chosen lead and trust reach the session, are stored, and are reused or overridden on regenerate', async () => {
  const plain = await f.admin.post(docs(), { type: 'overview', title: 'Plain' });
  assert.equal(plain.document.lead_agent, '');
  assert.equal(plain.document.trust_all_tools, false);
  assert.deepEqual(plain.warnings, []);
  const w0 = await session(plain.workflow.id);
  assert.equal(w0.lead_agent, '');
  assert.equal(w0.trust_tools, false);
  assert.equal(w0.playground, true);
  assert.equal(w0.push_mode, 'never');
  await docSettled(plain.document.id);

  const c = await f.admin.post(docs(), { type: 'overview', title: 'Trusted', leadAgent: 'developer', trustAllTools: true });
  assert.equal(c.document.lead_agent, 'developer');
  assert.equal(c.document.trust_all_tools, true);
  const w1 = await session(c.workflow.id);
  assert.equal(w1.lead_agent, 'developer');
  assert.equal(w1.trust_tools, true, 'the launcher trust flag is set on the session');
  assert.equal(w1.push_mode, 'never', 'push rules are unchanged');
  assert.equal(w1.repo_id, null, 'no repository, so the trusted push path never applies');
  const id = c.document.id;
  await docSettled(id);

  const again = await f.admin.post(`${docs()}/${id}/regenerate`, {});
  const w2 = await session(again.workflow.id);
  assert.equal(w2.lead_agent, 'developer', 'stored lead reused');
  assert.equal(w2.trust_tools, true, 'stored trust reused');
  await docSettled(id);

  const over = await f.admin.post(`${docs()}/${id}/regenerate`, { leadAgent: 'tech-lead', trustAllTools: false });
  const w3 = await session(over.workflow.id);
  assert.equal(w3.lead_agent, 'tech-lead');
  assert.equal(w3.trust_tools, false);
  assert.equal(over.document.lead_agent, 'tech-lead', 'the new choice is stored');
  assert.equal(over.document.trust_all_tools, false);
  await docSettled(id);

  const next = await f.admin.post(`${docs()}/${id}/regenerate`, {});
  const w4 = await session(next.workflow.id);
  assert.equal(w4.lead_agent, 'tech-lead');
  assert.equal(w4.trust_tools, false);
  await docSettled(id);

  const list = await f.admin.get(docs());
  const row = list.documents.find((d: any) => d.id === id);
  assert.equal(row.lead_agent, 'tech-lead');
  assert.equal(row.trust_all_tools, false);
});

test('a stored lead agent that is not available any more falls back to the default with a warning', async () => {
  const c = await f.admin.post(docs(), { type: 'overview', title: 'Fallback', leadAgent: 'developer' });
  await docSettled(c.document.id);
  await f.admin.post(`${P()}/agents/developer/enabled`, { enabled: false });
  const again = await f.admin.post(`${docs()}/${c.document.id}/regenerate`, {});
  assert.equal(again.warnings.length, 1);
  assert.match(again.warnings[0], /"developer".*not available any more/);
  const w = await session(again.workflow.id);
  assert.equal(w.lead_agent, '', 'the default agent leads');
  assert.equal(again.document.lead_agent, 'developer', 'the stored choice is kept, not overwritten');
  await docSettled(c.document.id);

  await f.admin.patch(P(), { defaultLeadAgent: 'tech-lead' });
  const viaDefault = await f.admin.post(`${docs()}/${c.document.id}/regenerate`, {});
  assert.equal((await session(viaDefault.workflow.id)).lead_agent, 'tech-lead', 'the project default lead agent is the fallback');
  await docSettled(c.document.id);
  await f.admin.patch(P(), { defaultLeadAgent: '' });
  await f.admin.post(`${P()}/agents/developer/enabled`, { enabled: true });
});

test('a new item with no choice uses the project default lead agent', async () => {
  await f.admin.patch(P(), { defaultLeadAgent: 'tech-lead' });
  try {
    const c = await f.admin.post(docs(), { type: 'overview', title: 'Default lead' });
    assert.equal((await session(c.workflow.id)).lead_agent, 'tech-lead');
    await docSettled(c.document.id);
  } finally {
    await f.admin.patch(P(), { defaultLeadAgent: '' });
  }
});

test('diagrams: create, refresh and refresh-stale carry the choices; refresh reuses what was stored', async () => {
  const c = await f.admin.post(diagrams(), { kind: 'components', repoId, title: 'Opts', leadAgent: 'tech-lead', trustAllTools: true });
  assert.equal(c.diagram.lead_agent, 'tech-lead');
  assert.equal(c.diagram.trust_all_tools, true);
  const w1 = await session(c.workflow.id);
  assert.equal(w1.lead_agent, 'tech-lead');
  assert.equal(w1.trust_tools, true);
  const id = c.diagram.id;
  await diagramSettled(id);

  const re = await f.admin.post(`${diagrams()}/${id}/refresh`, {});
  const w2 = await session(re.workflow.id);
  assert.equal(w2.lead_agent, 'tech-lead');
  assert.equal(w2.trust_tools, true);
  assert.deepEqual(re.warnings, []);
  await diagramSettled(id);

  const off = await f.admin.post(`${diagrams()}/${id}/refresh`, { trustAllTools: false });
  assert.equal((await session(off.workflow.id)).trust_tools, false);
  assert.equal(off.diagram.trust_all_tools, false);
  assert.equal(off.diagram.lead_agent, 'tech-lead');
  await diagramSettled(id);

  fs.writeFileSync(path.join(repoDir, 'more.py'), 'x = 1\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'more');
  await f.admin.post(`/api/repos/${repoId}/sync`);
  await waitFor(async () => ((await f.admin.get(`${P()}/repos`)).repos.find((r: any) => r.id === repoId).status === 'ready' ? true : null), 'sync');
  const stale = await f.admin.post(`${diagrams()}/refresh-stale`, { leadAgent: 'developer', trustAllTools: true });
  assert.equal(stale.started.length, 1, JSON.stringify(stale));
  assert.deepEqual(stale.warnings, []);
  const w3 = await session(stale.started[0].workflowId);
  assert.equal(w3.lead_agent, 'developer');
  assert.equal(w3.trust_tools, true);
  await diagramSettled(id);
});

test('loop-spec driven refreshes use the spec lead agent and trust fields', async () => {
  const { startGeneration } = await import('../server/generated-docs.ts');
  const { startGeneration: startDiagram } = await import('../server/diagrams.ts');
  const spec = await f.admin.post(`${P()}/loop-specs`, { name: 'Docs keeper', goalTemplate: 'Keep docs current', leadAgent: 'developer', trustTools: true, triggerKind: 'manual' });
  const specId = spec.spec?.id ?? spec.loopSpec?.id ?? spec.id;
  assert.ok(specId, JSON.stringify(spec));
  const userId = (await f.admin.get('/api/auth/me')).user.id;

  const c = await f.admin.post(docs(), { type: 'overview', title: 'By spec', leadAgent: 'tech-lead', trustAllTools: false });
  await docSettled(c.document.id);
  const w = await startGeneration(c.document.id, userId, { specId });
  assert.equal(w.lead_agent, 'developer', 'the spec lead wins over the stored one');
  assert.equal(w.trust_tools, 1);
  await docSettled(c.document.id);
  assert.equal((await f.admin.get(docs())).documents.find((d: any) => d.id === c.document.id).lead_agent, 'tech-lead', 'a spec does not overwrite the stored choice');

  const d = await f.admin.post(diagrams(), { kind: 'system_context', repoId, title: 'By spec diagram' });
  await diagramSettled(d.diagram.id);
  const dw = await startDiagram(d.diagram.id, userId, { specId });
  assert.equal(dw.lead_agent, 'developer');
  assert.equal(dw.trust_tools, 1);
  await diagramSettled(d.diagram.id);

  const bare = await f.admin.post(`${P()}/loop-specs`, { name: 'No overrides', goalTemplate: 'Keep docs current', triggerKind: 'manual' });
  const bareId = bare.spec?.id ?? bare.loopSpec?.id ?? bare.id;
  const w2 = await startGeneration(c.document.id, userId, { specId: bareId });
  assert.equal(w2.lead_agent, 'tech-lead', 'a spec with no lead agent falls back to the stored one');
  await docSettled(c.document.id);
});

test('presentations: the choices reach the session and are stored on the deck', async () => {
  const plain = await f.admin.post(decks(), { topic: 'Refund policy overview' });
  assert.equal(plain.presentation.lead_agent, '');
  assert.equal(plain.presentation.trust_all_tools, false);
  assert.equal((await session(plain.workflow.id)).trust_tools, false);
  await deckSettled(plain.presentation.id);

  const c = await f.admin.post(decks(), { topic: 'Refund policy overview', leadAgent: 'tech-lead', trustAllTools: true });
  assert.equal(c.presentation.lead_agent, 'tech-lead');
  assert.equal(c.presentation.trust_all_tools, true);
  assert.deepEqual(c.warnings, []);
  const w = await session(c.workflow.id);
  assert.equal(w.lead_agent, 'tech-lead');
  assert.equal(w.trust_tools, true);
  await deckSettled(c.presentation.id);
  const list = await f.admin.get(decks());
  assert.equal(list.presentations.find((p: any) => p.id === c.presentation.id).lead_agent, 'tech-lead');
});

test('trusting tools does not lift the always-blocked commands (FR-GUARD-1)', () => {
  for (const cmd of ['cdk deploy --all', 'terraform apply -auto-approve', 'kubectl apply -f x.yaml', 'aws s3 rm s3://b/k', 'docker push img:latest']) {
    assert.ok(alwaysBlockedCommand(cmd), `always blocked: ${cmd}`);
    assert.ok(blockedCommand(cmd), `blocked for untrusted sessions too: ${cmd}`);
  }
});
