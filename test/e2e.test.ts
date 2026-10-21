import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bootServer, Client, waitFor, type TestServer } from './client.ts';
import { FSD_MD, FSD_MD_V2, makeDocx, makePdf, makeRepo, makeXlsx } from './fixtures.ts';

let srv: TestServer;
let admin: Client;
let editor: Client;
let viewer: Client;
let pid: string;
let projectDir: string;
let repoId: string;
let bareRepo: string;
const docs: Record<string, string> = {};

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  editor = new Client(srv.base);
  viewer = new Client(srv.base);
});

after(async () => {
  await srv.close();
});

async function runDone(c: Client, runId: string) {
  let last: any = null;
  try {
    return await waitFor(async () => {
      const r = (last = await c.get(`/api/runs/${runId}`));
      return ['completed', 'failed', 'stopped'].includes(r.run.status) ? r : null;
    }, `run ${runId} to finish`);
  } catch (e) {
    throw new Error(`${e}; last status ${last?.run.status}, inputs ${JSON.stringify(last?.inputs.map((i: any) => [i.type, i.status]))}, last events ${JSON.stringify(last?.events.slice(-3).map((x: any) => x.type))}`);
  }
}

async function pendingInput(c: Client, runId: string, type: string) {
  return waitFor(async () => {
    const r = await c.get(`/api/runs/${runId}`);
    return r.inputs.find((i: any) => i.status === 'pending' && i.type === type) ?? null;
  }, `a pending ${type} on ${runId}`);
}

test('first-run setup, sign-in and CSRF protection', async () => {
  const state = await admin.get('/api/auth/state');
  assert.equal(state.needsSetup, true);
  await admin.post('/api/auth/setup', { email: 'yusei@example.com', name: 'Yusei', password: 'a-long-password-1' });
  const again = await admin.req('POST', '/api/auth/setup', { email: 'x@example.com', name: 'X', password: 'a-long-password-1' });
  assert.equal(again.status, 409);

  const noHeader = await admin.req('POST', '/api/projects', { name: 'X' }, { noCsrf: true });
  assert.equal(noHeader.status, 403, 'state-changing calls need the custom header');

  await admin.post('/api/users', { email: 'editor@example.com', name: 'Eddie', password: 'a-long-password-2' });
  await admin.post('/api/users', { email: 'viewer@example.com', name: 'Vera', password: 'a-long-password-3' });
  const bad = await editor.req('POST', '/api/auth/login', { email: 'editor@example.com', password: 'wrong-password' });
  assert.equal(bad.status, 401);
  await editor.post('/api/auth/login', { email: 'editor@example.com', password: 'a-long-password-2' });
  await viewer.post('/api/auth/login', { email: 'viewer@example.com', password: 'a-long-password-3' });
  const me = await editor.get('/api/auth/me');
  assert.equal(me.user.name, 'Eddie');
});

test('settings: provider, budget and secrets never leak', async () => {
  const s = await admin.get('/api/settings');
  assert.equal(s.provider.mode, 'demo');
  await admin.put('/api/settings', { budget: { monthlyUsd: 25 }, aws: { region: 'ap-southeast-1', auth: 'keys' } });
  const info = await admin.post('/api/settings/secrets/anthropic.api_key', { value: 'sk-ant-test-0123456789' });
  assert.equal(info.set, true);
  const s2 = await admin.get('/api/settings');
  assert.equal(s2.budget.monthlyUsd, 25);
  assert.equal(s2.secretsInfo['anthropic.api_key'].hint, '…6789');
  assert.ok(!JSON.stringify(s2).includes('sk-ant-test'), 'secret value must not be returned');
  const forEditor = await editor.req('PUT', '/api/settings', { budget: { monthlyUsd: 1 } });
  assert.equal(forEditor.status, 403);
  const badRegion = await admin.req('PUT', '/api/settings', { aws: { region: 'mars' } });
  assert.equal(badRegion.status, 400);
});

test('projects: folder, git history, members and access levels', async () => {
  const { project } = await admin.post('/api/projects', { name: 'Refunds', description: 'Refund service for card payments' });
  pid = project.id;
  projectDir = path.join(srv.dataDir, 'projects', project.slug);
  for (const f of ['CLAUDE.md', 'docs/decisions.md', '.claude/skills/project-docs/SKILL.md', '.gitignore']) {
    assert.ok(fs.existsSync(path.join(projectDir, f)), `${f} exists`);
  }
  const log = execFileSync('git', ['log', '--oneline'], { cwd: projectDir }).toString();
  assert.match(log, /Create project/);

  await admin.post(`/api/projects/${pid}/members`, { email: 'editor@example.com', access: 'editor', role: 'Backend developer' });
  await admin.post(`/api/projects/${pid}/members`, { email: 'viewer@example.com', access: 'viewer', role: 'Business analyst' });
  const list = await viewer.get('/api/projects');
  assert.equal(list.projects.length, 1);
  const forbidden = await viewer.req('PATCH', `/api/projects/${pid}`, { notes: 'x' });
  assert.equal(forbidden.status, 403);
  await admin.patch(`/api/projects/${pid}`, { notes: 'Use the refunds table, never the payments table.' });
  assert.match(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8'), /never the payments table/);
  const lastOwner = await admin.req('DELETE', `/api/projects/${pid}/members/${(await admin.get('/api/auth/me')).user.id}`);
  assert.equal(lastOwner.status, 400, 'cannot remove the last owner');
});

test('knowledge: upload and convert md, docx, xlsx and pdf; search', async () => {
  const up = async (name: string, buf: Buffer) => (await editor.ok('PUT', `/api/projects/${pid}/documents?name=${encodeURIComponent(name)}`, undefined, { raw: buf })).document;
  const fsd = await up('Refunds FSD.md', Buffer.from(FSD_MD));
  assert.equal(fsd.status, 'ready');
  assert.ok(fsd.sections_count >= 4);
  docs.fsd = fsd.id;

  const tsd = await up('Refunds TSD.docx', await makeDocx());
  assert.equal(tsd.status, 'ready', tsd.error);
  const tsdView = await editor.get(`/api/documents/${tsd.id}`);
  assert.match(tsdView.markdown, /^# Refunds TSD/m);
  assert.match(tsdView.markdown, /^## Components/m);
  assert.match(tsdView.markdown, /- RefundController handles POST \/v1\/refunds & GET/);
  assert.match(tsdView.markdown, /\| amount \| decimal\(12,2\) \|/);
  docs.tsd = tsd.id;

  const xlsx = await up('Limits.xlsx', await makeXlsx());
  assert.equal(xlsx.status, 'ready', xlsx.error);
  assert.match((await editor.get(`/api/documents/${xlsx.id}`)).markdown, /\| Max refund without approval \| 500 \|/);

  const pdf = await up('Meeting notes.pdf', await makePdf());
  assert.equal(pdf.status, 'ready', pdf.error);
  const pdfMd = (await editor.get(`/api/documents/${pdf.id}`)).markdown;
  assert.match(pdfMd, /batch job/);
  assert.match(pdfMd, /## 1 Meeting notes/);

  const bad = await editor.req('PUT', `/api/projects/${pid}/documents?name=evil.exe`, undefined, { raw: Buffer.from('MZ') });
  assert.equal(bad.status, 400);
  const asViewer = await viewer.req('PUT', `/api/projects/${pid}/documents?name=x.md`, undefined, { raw: Buffer.from('# x') });
  assert.equal(asViewer.status, 403);

  const s = await viewer.get(`/api/projects/${pid}/search?q=${encodeURIComponent('finance manager approval')}`);
  assert.ok(s.hits.length > 0);
  assert.ok(s.hits.slice(0, 3).some((h: any) => h.heading === 'Refund rules'));
  assert.ok(s.hits[0].snippet.includes(s.markStart));
  const log = execFileSync('git', ['log', '--oneline'], { cwd: projectDir }).toString();
  assert.match(log, /Add document Refunds FSD/);
});

test('ask the documents, send unknowns to the inbox, answers become decisions', async () => {
  const a = await viewer.post(`/api/projects/${pid}/ask`, { question: 'Who must approve large refunds?' });
  assert.equal(a.missing, false);
  assert.ok(a.sources.some((s: any) => s.cited && s.heading === 'Refund rules'));
  assert.match(a.answer, /\[1\]/);

  const b = await viewer.post(`/api/projects/${pid}/ask`, { question: 'zebra quantum lighthouse?' });
  assert.equal(b.missing, true);
  const { input } = await viewer.post(`/api/projects/${pid}/inbox`, { question: 'Which currency are refunds paid in?', options: ['Original currency', 'USD'] });
  const inbox = await editor.get(`/api/projects/${pid}/inputs`);
  assert.equal(inbox.inputs.length, 1);
  await editor.post(`/api/inputs/${input.id}/answer`, { answers: { 'Which currency are refunds paid in?': 'Original currency' } });
  const decisions = fs.readFileSync(path.join(projectDir, 'docs/decisions.md'), 'utf8');
  assert.match(decisions, /\*\*Q:\*\* Which currency are refunds paid in\?\n\*\*A:\*\* Original currency/);
  const s = await editor.get(`/api/projects/${pid}/search?q=currency`);
  assert.ok(s.hits.some((h: any) => h.docKind === 'decisions'), 'decisions log is searchable');
  const twice = await editor.req('POST', `/api/inputs/${input.id}/answer`, { answers: { x: 'y' } });
  assert.equal(twice.status, 400);
});

test('builder: roles, custom agents and skills, library, and a test run', async () => {
  const roles = await editor.get('/api/roles');
  // 7 starter roles, 8 generated from Claude Code agents (roles-library.ts) and the AI delivery team (roles-delivery.ts).
  const starters = ['business-analyst', 'solution-architect', 'backend-developer', 'frontend-developer', 'qa-engineer', 'reviewer', 'technical-writer'];
  assert.equal(roles.roles.length, 16);
  assert.ok(starters.every((k) => roles.roles.some((r: any) => r.key === k)), 'the starter roles are still offered');
  await editor.post(`/api/projects/${pid}/roles/business-analyst/apply`);
  await editor.post(`/api/projects/${pid}/roles/qa-engineer/apply`);
  await editor.post(`/api/projects/${pid}/roles/reviewer/apply`);
  const agents = (await editor.get(`/api/projects/${pid}/agents`)).agents;
  const ba = agents.find((a: any) => a.name === 'business-analyst');
  assert.ok(ba && ba.enabled && ba.model === 'haiku' && ba.skills.includes('fsd-to-stories'));
  const fileText = fs.readFileSync(path.join(projectDir, '.claude/agents/business-analyst.md'), 'utf8');
  assert.match(fileText, /^---\nname: business-analyst\n/);
  assert.match(fileText, /tools: Read, Grep, Glob, Write/);

  await editor.put(`/api/projects/${pid}/agents/refund-expert`, {
    description: 'Knows the refund rules in depth.',
    tools: ['Read', 'Grep'],
    model: 'sonnet',
    skills: ['glossary'],
    prompt: 'You are the refund domain expert. Always cite the FSD.',
  });
  const bad = await editor.req('PUT', `/api/projects/${pid}/agents/Bad_Name`, { description: 'x', prompt: 'y' });
  assert.equal(bad.status, 400);
  await editor.put(`/api/projects/${pid}/skills/refund-math`, { description: 'Use when calculating partial refunds.', body: '# Refund math\n\nNever exceed the captured amount.' });
  await editor.put(`/api/projects/${pid}/skills/refund-math/file`, { path: 'examples.md', content: '- 100 captured, 40 refunded, 60 left' });
  const traversal = await editor.req('PUT', `/api/projects/${pid}/skills/refund-math/file`, { path: '../../evil.md', content: 'x' });
  assert.equal(traversal.status, 400);
  const skills = (await editor.get(`/api/projects/${pid}/skills`)).skills;
  assert.deepEqual(skills.find((s: any) => s.name === 'refund-math').files, ['examples.md']);

  await editor.post(`/api/projects/${pid}/roles/qa-engineer/enabled`, { enabled: false });
  assert.ok(fs.existsSync(path.join(projectDir, '.claude/_disabled/agents/qa-engineer.md')));
  assert.ok(!fs.existsSync(path.join(projectDir, '.claude/agents/qa-engineer.md')));
  await editor.post(`/api/projects/${pid}/roles/qa-engineer/enabled`, { enabled: true });

  await editor.post(`/api/projects/${pid}/library/save`, { type: 'skills', name: 'refund-math' });
  await editor.del(`/api/projects/${pid}/skills/refund-math`);
  await editor.post(`/api/projects/${pid}/library/install`, { type: 'skills', name: 'refund-math' });
  assert.ok(fs.existsSync(path.join(projectDir, '.claude/skills/refund-math/examples.md')));

  const { run } = await editor.post(`/api/projects/${pid}/builder/test`, { type: 'agent', name: 'refund-expert', prompt: 'Summarise the refund rules' });
  const done = await runDone(editor, run.id);
  assert.equal(done.run.status, 'completed');
  assert.ok(done.events.some((e: any) => e.parent && e.type === 'assistant'), 'the subagent produced messages');
  const log = execFileSync('git', ['log', '--oneline'], { cwd: projectDir }).toString();
  assert.match(log, /Add role: Business analyst/);
});

test('repositories: connect, clone and list branches', async () => {
  bareRepo = makeRepo(path.join(srv.dataDir, 'fixture'));
  // file:/// with forward slashes, so Windows paths (C:\...) are accepted too.
  const url = `file:///${bareRepo.replace(/\\/g, '/').replace(/^\//, '')}`;
  const notAdmin = await editor.req('POST', `/api/projects/${pid}/repos`, { provider: 'git', url });
  assert.equal(notAdmin.status, 400, 'only admins may use local paths');
  const { repo } = await admin.post(`/api/projects/${pid}/repos`, { provider: 'git', url, name: 'refund-service' });
  repoId = repo.id;
  const ready = await waitFor(async () => {
    const r = (await editor.get(`/api/projects/${pid}/repos`)).repos.find((x: any) => x.id === repoId);
    return r.status === 'ready' ? r : r.status === 'error' ? Promise.reject(new Error(r.error)) : null;
  }, 'clone');
  assert.equal(ready.default_branch, 'main');
  const b = await editor.get(`/api/repos/${repoId}/branches`);
  assert.deepEqual(b.branches.map((x: any) => x.name).sort(), ['feature/refund-api', 'main']);
  assert.ok(fs.existsSync(path.join(projectDir, 'repos/refund-service/src/refunds.ts')));
  await waitFor(async () => fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8').includes('repos/refund-service/'), 'CLAUDE.md lists the repo');
  const badGh = await editor.req('POST', `/api/projects/${pid}/repos`, { provider: 'github', url: 'https://gitlab.com/a/b' });
  assert.equal(badGh.status, 400);
});

let firstRunId = '';

test('agent run: questions, approvals, subagents, live stream, push', async () => {
  const { run } = await editor.post(`/api/projects/${pid}/runs`, {
    prompt: 'Design and build the refund approval flow for Finance Managers',
    repoId,
    branch: 'main',
    permissionMode: 'default',
  });
  firstRunId = run.id;

  // Live stream: collect events while the run waits for us.
  const ctrl = new AbortController();
  const streamed: any[] = [];
  const streaming = (async () => {
    const res = await fetch(`${srv.base}/api/runs/${run.id}/stream`, { headers: { cookie: editor.cookie }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = chunk.match(/^event: (.*)$/m)?.[1];
        const data = chunk.match(/^data: (.*)$/m)?.[1];
        if (ev && data) streamed.push({ ev, data: JSON.parse(data) });
      }
    }
  })().catch(() => undefined);

  const q = await pendingInput(editor, run.id, 'question');
  assert.equal(q.payload.questions[0].header, 'Approach');
  const roleQ = q.payload.questions.find((x: any) => x.header === 'Roles');
  assert.ok(roleQ.options.some((o: any) => o.label === 'business-analyst'));
  // Viewers may answer questions but not approvals.
  await viewer.post(`/api/inputs/${q.id}/answer`, {
    answers: { [q.payload.questions[0].question]: 'New module', [roleQ.question]: ['business-analyst', 'qa-engineer'] },
  });

  const approval = await pendingInput(editor, run.id, 'approval');
  assert.equal(approval.tool_name, 'Write');
  const viewerApproval = await viewer.req('POST', `/api/inputs/${approval.id}/answer`, { decision: 'allow' });
  assert.equal(viewerApproval.status, 403);
  await editor.post(`/api/inputs/${approval.id}/answer`, { decision: 'allow' });

  const done = await runDone(editor, run.id);
  ctrl.abort();
  await streaming;
  assert.equal(done.run.status, 'completed', done.run.error);
  assert.ok(done.run.meta.estimatedUsd > 0);
  assert.ok(streamed.some((s) => s.ev === 'event' && s.data.type === 'portal:input'), 'stream carried the question');

  const agentCalls = done.events.filter((e: any) => e.type === 'assistant').flatMap((e: any) => e.data.message.content).filter((b: any) => b.type === 'tool_use' && b.name === 'Agent');
  assert.deepEqual(agentCalls.map((c: any) => c.input.subagent_type).sort(), ['business-analyst', 'qa-engineer']);
  const childMsgs = done.events.filter((e: any) => e.parent && agentCalls.some((c: any) => c.id === e.parent));
  assert.ok(childMsgs.length >= 4, 'subagent messages are tagged with their parent tool call');

  const wt = path.join(projectDir, done.run.worktree);
  assert.ok(fs.existsSync(path.join(wt, 'AGENT_PLAN.md')));
  assert.match(fs.readFileSync(path.join(projectDir, 'docs/decisions.md'), 'utf8'), /\*\*A:\*\* New module/);

  const changes = await editor.get(`/api/runs/${run.id}/changes`);
  assert.match(changes.diff, /AGENT_PLAN\.md/);
  const pushed = await editor.post(`/api/runs/${run.id}/push`, { branch: 'agent/refund-approval', message: 'Plan for refund approvals' });
  assert.equal(pushed.pushed, true);
  const branches = execFileSync('git', ['branch', '--list'], { cwd: bareRepo }).toString();
  assert.match(branches, /agent\/refund-approval/);
  const toMain = await editor.req('POST', `/api/runs/${run.id}/push`, { branch: 'main' });
  assert.equal(toMain.status, 400);
});

test('decisions are not asked twice; follow-ups resume; stop works', async () => {
  const { run } = await editor.post(`/api/projects/${pid}/runs`, { prompt: 'Design and build the refund approval flow for Finance Managers', permissionMode: 'acceptEdits' });
  const done = await runDone(editor, run.id);
  assert.equal(done.run.status, 'completed');
  assert.equal(done.inputs.length, 0, 'no question and no approval in acceptEdits mode with a recorded decision');
  assert.ok(done.events.some((e: any) => e.type === 'assistant' && JSON.stringify(e.data).includes("so I won't ask again")));

  const follow = await editor.post(`/api/runs/${firstRunId}/continue`, { prompt: 'Summarise the notification requirements', permissionMode: 'plan' });
  const fdone = await runDone(editor, follow.run.id);
  assert.equal(fdone.run.status, 'completed');
  assert.equal(fdone.run.resume_of, firstRunId);

  const { run: r3 } = await editor.post(`/api/projects/${pid}/runs`, { prompt: 'Implement partial refunds' });
  await pendingInput(editor, r3.id, 'question');
  await editor.post(`/api/runs/${r3.id}/stop`);
  const stopped = await runDone(editor, r3.id);
  assert.equal(stopped.run.status, 'stopped');
  const leftovers = (await editor.get(`/api/projects/${pid}/inputs`)).inputs.filter((i: any) => i.run_id === r3.id);
  assert.equal(leftovers.length, 0, 'pending questions are cancelled when a run stops');
});

test('code review: findings from a branch diff, triage and status changes', async () => {
  const { review } = await editor.post(`/api/projects/${pid}/reviews`, { repoId, base: 'main', head: 'feature/refund-api', deep: true });
  const r = await waitFor(async () => {
    const x = await editor.get(`/api/reviews/${review.id}`);
    return x.review.status !== 'running' ? x : null;
  }, 'review');
  assert.equal(r.review.status, 'done', r.review.error);
  const sev = r.findings.map((f: any) => f.severity);
  assert.ok(sev.includes('critical'), 'hard-coded key found');
  assert.ok(r.findings.some((f: any) => f.category === 'security' && /SQL/.test(f.message)));
  assert.ok(r.findings.some((f: any) => f.source === 'deep'), 'deep pass ran on flagged files');
  assert.equal(r.diff[0].newPath, 'src/api.ts');
  const f = r.findings[0];
  await editor.patch(`/api/findings/${f.id}`, { status: 'dismissed' });
  const list = await editor.get(`/api/projects/${pid}/reviews`);
  assert.equal(list.reviews[0].open_findings, r.findings.length - 1);
  const same = await editor.req('POST', `/api/projects/${pid}/reviews`, { repoId, base: 'main', head: 'main' });
  assert.equal(same.status, 400);
});

let learnDocId = '';
let quizId = '';

test('learn: two-view docs, quiz with verification, publishing and export', async () => {
  const { doc } = await editor.post(`/api/projects/${pid}/learn/docs`, { title: 'How refunds work', kind: 'overview', docIds: [docs.fsd, docs.tsd] });
  learnDocId = doc.id;
  const ready = await waitFor(async () => {
    const d = (await editor.get(`/api/learn/docs/${doc.id}`)).doc;
    return d.status !== 'generating' ? d : null;
  }, 'learn doc');
  assert.equal(ready.status, 'draft', ready.error);
  assert.match(ready.business_md, /^# How refunds work/);
  assert.match(ready.technical_md, /POST/);
  assert.match(ready.technical_md, /```mermaid/);
  assert.ok(ready.glossary.length > 0);

  const hidden = await viewer.req('GET', `/api/learn/docs/${doc.id}`);
  assert.equal(hidden.status, 404, 'viewers do not see drafts');
  await editor.post(`/api/learn/docs/${doc.id}/publish`);
  assert.ok(fs.existsSync(path.join(projectDir, 'docs/generated/how-refunds-work.business.md')));
  const html = await viewer.req('GET', `/api/learn/docs/${doc.id}/export?format=html`);
  assert.equal(html.status, 200);
  assert.match(html.data, /For everyone/);
  assert.ok(!/<script>alert/.test(html.data));

  const { quiz } = await editor.post(`/api/projects/${pid}/learn/quizzes`, { title: 'Refund basics', audience: 'business', difficulty: 'easy', count: 6, learnDocId: doc.id });
  quizId = quiz.id;
  const full = await waitFor(async () => {
    const q = (await editor.get(`/api/learn/quizzes/${quiz.id}`)).quiz;
    return q.status !== 'generating' ? q : null;
  }, 'quiz');
  assert.equal(full.status, 'draft', full.error);
  assert.ok(full.questions.length >= 3);
  assert.ok(full.questions.every((x: any) => x.verified && x.answer && x.source.heading));
  await editor.post(`/api/learn/quizzes/${quiz.id}/publish`);

  const take = (await viewer.get(`/api/learn/quizzes/${quiz.id}`)).quiz;
  assert.ok(take.questions.every((x: any) => x.answer === undefined), 'answers hidden from takers');
  const answers = Object.fromEntries(full.questions.map((x: any) => [x.id, x.answer]));
  const { attempt } = await viewer.post(`/api/learn/quizzes/${quiz.id}/attempts`, { answers });
  assert.equal(attempt.score, full.questions.length);
  assert.equal(attempt.passed, true);
  const wrong = (await viewer.post(`/api/learn/quizzes/${quiz.id}/attempts`, { answers: {} })).attempt;
  assert.equal(wrong.score, 0);

  await viewer.post(`/api/learn/docs/${doc.id}/read`);
  const { path: p } = await editor.post(`/api/projects/${pid}/learn/paths/auto`, { audience: 'business' });
  await editor.patch(`/api/learn/paths/${p.id}`, { status: 'published' });
  const vp = (await viewer.get(`/api/projects/${pid}/learn/paths`)).paths[0];
  assert.equal(vp.progress, 100);
  const team = await editor.get(`/api/projects/${pid}/learn/progress`);
  assert.equal(team.members.find((m: any) => m.name === 'Vera').progress[p.id], 100);

  const zip = await viewer.req('GET', `/api/projects/${pid}/learn/export.zip`);
  assert.equal(zip.status, 200);
  assert.equal(zip.buf!.subarray(0, 2).toString(), 'PK');
});

test('learn: changing a source document marks content as stale', async () => {
  await editor.ok('PUT', `/api/projects/${pid}/documents?name=${encodeURIComponent('Refunds FSD.md')}`, undefined, { raw: Buffer.from(FSD_MD_V2) });
  const d = (await editor.get(`/api/learn/docs/${learnDocId}`)).doc;
  assert.equal(d.stale, 1);
  const quizzes = (await editor.get(`/api/projects/${pid}/learn/quizzes`)).quizzes;
  assert.equal(quizzes.find((q: any) => q.id === quizId).stale, 1);
  await editor.post(`/api/learn/docs/${learnDocId}/regenerate`);
  const again = await waitFor(async () => {
    const x = (await editor.get(`/api/learn/docs/${learnDocId}`)).doc;
    return x.status !== 'generating' ? x : null;
  }, 'regenerated doc');
  assert.equal(again.stale, 0);
  assert.equal(again.status, 'draft', 'regenerated content needs approval again');
});

test('usage, connection test and budget', async () => {
  const t = await admin.post('/api/settings/test');
  assert.equal(t.ok, true);
  const u = await admin.get('/api/usage');
  assert.equal(u.totalUsd, 0, 'demo runs cost nothing');
  assert.ok(u.byKind.some((k: any) => k.kind === 'qa'));
  const runs = await editor.get(`/api/projects/${pid}/runs`);
  assert.ok(runs.runs.length >= 4);
  assert.ok(runs.runs.every((r: any) => ['chat', 'test', 'review'].includes(r.kind)));
});

test('several repositories: one working copy each, a combined diff, and a push per repository', async () => {
  const bare2 = makeRepo(path.join(srv.dataDir, 'fixture-two'));
  const url2 = `file:///${bare2.replace(/\\/g, '/').replace(/^\//, '')}`;
  const { repo: repo2 } = await admin.post(`/api/projects/${pid}/repos`, { provider: 'git', url: url2, name: 'refund-web' });
  await waitFor(async () => {
    const r = (await editor.get(`/api/projects/${pid}/repos`)).repos.find((x: any) => x.id === repo2.id);
    return r.status === 'ready' ? r : r.status === 'error' ? Promise.reject(new Error(r.error)) : null;
  }, 'clone of the second repository');

  const twice = await editor.req('POST', `/api/projects/${pid}/workflows`, { goal: 'x', start: false, repos: [{ repoId }, { repoId }] });
  assert.equal(twice.status, 400, 'a repository cannot be chosen twice');

  const { workflow } = await editor.post(`/api/projects/${pid}/workflows`, {
    goal: 'Change both services [demo-iterations: 1]',
    model: 'haiku',
    repos: [{ repoId, branch: 'main' }, { repoId: repo2.id }],
  });
  assert.deepEqual(workflow.repos.map((r: any) => r.name), ['refund-service', 'refund-web']);
  const d = await waitFor(async () => {
    const x = await editor.get(`/api/workflows/${workflow.id}`);
    return ['done', 'blocked', 'failed', 'paused'].includes(x.workflow.status) && !x.driving ? x : null;
  }, 'multi-repo session');
  const run = (await editor.get(`/api/runs/${d.workflow.last_run_id}`)).run;
  assert.equal(run.meta.repos.length, 2);
  for (const x of run.meta.repos) assert.ok(fs.existsSync(path.join(projectDir, x.worktree, 'src', 'refunds.ts')), `working copy of ${x.name}`);
  assert.match(run.prompt, /This session spans 2 repositories \(refund-service from main, refund-web from main\)/);
  assert.match(run.prompt, /refund-service/);
  assert.match(run.prompt, /refund-web/);

  // A change in the second repository shows up under its folder, and is pushed to that repository only.
  fs.writeFileSync(path.join(projectDir, run.meta.repos[1].worktree, 'src', 'web.ts'), 'export const web = 1;\n');
  const ch = await editor.get(`/api/runs/${run.id}/changes`);
  assert.deepEqual(ch.repos.map((r: any) => r.changed), [0, 1]);
  assert.match(ch.diff, /^diff --git a\/refund-web\/src\/web\.ts b\/refund-web\/src\/web\.ts/m);
  const file = await editor.get(`/api/runs/${run.id}/file?path=${encodeURIComponent('refund-web/src/web.ts')}`);
  assert.equal(file.content, 'export const web = 1;\n');
  const pushed = await editor.post(`/api/runs/${run.id}/push`, { repoId: repo2.id, branch: 'feature/two-repos', message: 'Both' });
  assert.equal(pushed.repoName, 'refund-web');
  assert.match(execFileSync('git', ['branch'], { cwd: bare2 }).toString(), /feature\/two-repos/);
  assert.doesNotMatch(execFileSync('git', ['branch'], { cwd: bareRepo }).toString(), /feature\/two-repos/);
  assert.equal((await editor.req('POST', `/api/runs/${run.id}/push`, { repoId: 'repo_nope', branch: 'x/y' })).status, 400);
});

test('workspaces: named repository sets that a session copies when it starts', async () => {
  const repos = (await editor.get(`/api/projects/${pid}/repos`)).repos;
  const web = repos.find((r: any) => r.name === 'refund-web');
  const svc = repos.find((r: any) => r.name === 'refund-service');
  const { workspace } = await editor.post(`/api/projects/${pid}/workspaces`, { name: 'Full stack', repos: [{ repoId: svc.id, branch: 'main' }, { repoId: web.id }] });
  assert.deepEqual(workspace.repos.map((r: any) => [r.name, r.branch]), [['refund-service', 'main'], ['refund-web', '']]);
  assert.equal((await editor.req('POST', `/api/projects/${pid}/workspaces`, { name: 'full STACK' })).status, 400, 'names are unique in a project');
  assert.equal((await editor.req('POST', `/api/projects/${pid}/workspaces`, { name: 'Twice', repos: [{ repoId: svc.id }, { repoId: svc.id }] })).status, 400);
  assert.equal((await viewer.req('POST', `/api/projects/${pid}/workspaces`, { name: 'Viewer' })).status, 403);

  const { workflow } = await editor.post(`/api/projects/${pid}/workflows`, { goal: 'From a workspace', start: false, workspaceId: workspace.id });
  assert.equal(workflow.workspace.name, 'Full stack');
  assert.deepEqual(workflow.repos.map((r: any) => r.name), ['refund-service', 'refund-web']);

  // Editing or deleting the workspace leaves the session's own copy alone.
  await editor.put(`/api/workspaces/${workspace.id}`, { repos: [{ repoId: web.id }] });
  assert.equal((await editor.get(`/api/workflows/${workflow.id}`)).workflow.repos.length, 2);
  await editor.del(`/api/workspaces/${workspace.id}`);
  const after = (await editor.get(`/api/workflows/${workflow.id}`)).workflow;
  assert.equal(after.workspace, null);
  assert.equal(after.repos.length, 2);
  await editor.del(`/api/workflows/${workflow.id}`);
});
