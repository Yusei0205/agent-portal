import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { waitFor } from './client.ts';
import { bootWorkflowFixture, type WorkflowFixture } from './workflows-fixture.ts';
import { composeDiagramPrompt, diagramType, parseDiagramReply, validateMermaid, DiagramError, DIAGRAM_LIMITS } from '../server/diagram-text.ts';
import { rendererProblem } from '../server/docimage.ts';

let f: WorkflowFixture;
let repoId: string;
let slugDir: string;
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-repo-'));
const git = (...a: string[]) => execFileSync('git', a, { cwd: repoDir, stdio: 'pipe' }).toString().trim();

before(async () => {
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repoDir, 'app.py'), 'def handler(event, context):\n    return {"ok": True}\n');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# payments\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  f = await bootWorkflowFixture();
  const { repo } = await f.admin.post(`/api/projects/${f.pid}/repos`, { localPath: repoDir, name: 'payments' });
  repoId = repo.id;
  await waitFor(async () => ((await f.admin.get(`/api/projects/${f.pid}/repos`)).repos.find((r: any) => r.id === repoId).status === 'ready' ? true : null), 'clone');
  const { project } = await f.admin.get(`/api/projects/${f.pid}`);
  slugDir = path.join(f.srv.dataDir, 'projects', project.slug);
});

after(async () => {
  await f.srv.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

const base = () => `/api/projects/${f.pid}/diagrams`;
const settled = (id: string) =>
  waitFor(async () => {
    const r = await f.admin.get(`${base()}/${id}`);
    return r.diagram.status !== 'generating' ? r : null;
  }, 'the diagram session to finish');
const commitUpstream = (name: string) => {
  fs.writeFileSync(path.join(repoDir, name), `# ${name}\n`);
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', `add ${name}`);
  return git('rev-parse', 'HEAD');
};
const syncRepo = async () => {
  await f.admin.post(`/api/repos/${repoId}/sync`);
  await waitFor(async () => ((await f.admin.get(`/api/projects/${f.pid}/repos`)).repos.find((r: any) => r.id === repoId).status === 'ready' ? true : null), 'sync');
};

let diagramId = '';
let diagramSlug = '';

test('generate: a session draws the diagram and it is stored as version 1 and committed to the project repo', async () => {
  const head = git('rev-parse', 'HEAD');
  const created = await f.admin.post(base(), { kind: 'components', repoId, title: 'Payments components' });
  assert.equal(created.diagram.status, 'generating');
  assert.equal(created.diagram.kind, 'components');
  assert.match(created.workflow.title, /^Diagram: Payments components/);
  assert.equal(created.workflow.status === 'running' || created.workflow.status === 'queued', true);
  assert.match(created.workflow.goal, /repos\/payments\//);
  diagramId = created.diagram.id;
  diagramSlug = created.diagram.slug;

  const done = await settled(diagramId);
  assert.equal(done.diagram.status, 'ready', JSON.stringify(done.diagram));
  assert.equal(done.diagram.version, 1);
  assert.equal(done.diagram.stale, 0);
  assert.match(done.diagram.mermaid, /^flowchart TB/);
  assert.match(done.diagram.mermaid, /app\.py/);
  assert.match(done.diagram.description, /payments\/app\.py|payments\/README\.md/);
  assert.ok(done.diagram.citations.length >= 1);
  assert.equal(done.diagram.sources[0].sha, head);
  assert.equal(done.diagram.sources[0].repoId, repoId);
  assert.equal(done.versions.length, 1);
  assert.equal(done.versions[0].mermaid, undefined, 'the version list stays light');

  const mmd = fs.readFileSync(path.join(slugDir, 'docs/diagrams', `${diagramSlug}.mmd`), 'utf8');
  assert.equal(mmd.trim(), done.diagram.mermaid.trim());
  const meta = JSON.parse(fs.readFileSync(path.join(slugDir, 'docs/diagrams', `${diagramSlug}.json`), 'utf8'));
  assert.equal(meta.version, 1);
  assert.equal(meta.sources[0].sha, head);
  const log = execFileSync('git', ['log', '--format=%s', '--', 'docs/diagrams'], { cwd: slugDir }).toString();
  assert.match(log, /Add diagram Payments components \(v1\)/);

  const list = await f.admin.get(base());
  assert.equal(list.diagrams.length, 1);
  assert.equal(list.diagrams[0].mermaid, undefined);
  assert.deepEqual(list.kinds.map((k: any) => k.id), ['system_context', 'components', 'data_flow']);
});

test('stale: the diagram is flagged when its repository HEAD moves, and clears when it is redrawn (a new version)', async () => {
  const before1 = (await f.admin.get(`${base()}/${diagramId}`)).diagram;
  const newHead = commitUpstream('worker.py');
  await syncRepo();
  const staleNow = await f.admin.get(`${base()}/${diagramId}`);
  assert.equal(staleNow.diagram.stale, 1);
  assert.equal((await f.admin.get(base())).diagrams[0].stale, 1);

  const r = await f.admin.post(`${base()}/${diagramId}/refresh`, {});
  assert.equal(r.diagram.status, 'generating');
  assert.ok(r.workflow.id);
  const second = await settled(diagramId);
  assert.equal(second.diagram.version, 2);
  assert.equal(second.diagram.stale, 0);
  assert.equal(second.diagram.sources[0].sha, newHead);
  assert.match(second.diagram.mermaid, /worker\.py/);
  assert.deepEqual(second.versions.map((v: any) => v.version), [2, 1]);

  const v1 = await f.admin.get(`${base()}/${diagramId}/versions/1`);
  assert.equal(v1.current, false);
  assert.equal(v1.version.mermaid.trim(), before1.mermaid.trim());
  assert.doesNotMatch(v1.version.mermaid, /worker\.py/);
  assert.notEqual(v1.version.sources[0].sha, newHead);
  const v2 = await f.admin.get(`${base()}/${diagramId}/versions/2`);
  assert.equal(v2.current, true);
  assert.equal((await f.admin.req('GET', `${base()}/${diagramId}/versions/9`)).status, 404);

  const log = execFileSync('git', ['log', '--format=%s', '--', 'docs/diagrams'], { cwd: slugDir }).toString();
  assert.match(log, /Update diagram Payments components \(v2\)/);
});

test('invalid Mermaid is refused: the previous version is kept and the error is reported', async () => {
  const bad = await f.admin.post(`${base()}/${diagramId}/refresh`, { focus: '[demo-invalid-mermaid]' });
  assert.equal(bad.diagram.status, 'generating');
  const after = await settled(diagramId);
  assert.equal(after.diagram.version, 2, 'no new version');
  assert.equal(after.diagram.status, 'ready');
  assert.match(after.diagram.error, /Mermaid syntax error/);
  assert.match(after.diagram.error, /previous version \(v2\) was kept/);
  assert.match(after.diagram.mermaid, /worker\.py/);
  assert.equal(after.versions.length, 2);

  await f.admin.post(`${base()}/${diagramId}/refresh`, { focus: '[demo-no-diagram]' });
  const none = await settled(diagramId);
  assert.equal(none.diagram.version, 2);
  assert.match(none.diagram.error, /did not return a Mermaid diagram/);

  await f.admin.post(`${base()}/${diagramId}/refresh`, { focus: '[demo-huge-mermaid]' });
  const huge = await settled(diagramId);
  assert.equal(huge.diagram.version, 2);
  assert.match(huge.diagram.error, /too long \(max 20000 characters\)/);

  await f.admin.post(`${base()}/${diagramId}/refresh`, { focus: '' });
  const ok = await settled(diagramId);
  assert.equal(ok.diagram.version, 3);
  assert.equal(ok.diagram.error, null, 'a good version clears the error');
});

test('a new diagram whose first reply is invalid ends in error with no version', async () => {
  const c = await f.admin.post(base(), { kind: 'data_flow', repoId, title: 'Broken flow', focus: '[demo-invalid-mermaid]' });
  const done = await settled(c.diagram.id);
  assert.equal(done.diagram.status, 'error');
  assert.equal(done.diagram.version, 0);
  assert.match(done.diagram.error, /Mermaid syntax error/);
  assert.equal(fs.existsSync(path.join(slugDir, 'docs/diagrams', `${c.diagram.slug}.mmd`)), false, 'nothing is committed for it');
  await f.admin.del(`${base()}/${c.diagram.id}`);
});

test('kinds: system context and data flow diagrams validate too', async () => {
  for (const [kind, re] of [['system_context', /^flowchart LR/], ['data_flow', /^sequenceDiagram/]] as const) {
    const c = await f.admin.post(base(), { kind, repoIds: [repoId] });
    const done = await settled(c.diagram.id);
    assert.equal(done.diagram.status, 'ready', JSON.stringify(done.diagram));
    assert.match(done.diagram.mermaid, re);
    await f.admin.del(`${base()}/${c.diagram.id}`);
  }
});

test('requests are checked: kind, repository, and a second generate while one is running', async () => {
  const bad = async (body: any, status: number, re: RegExp) => {
    const r = await f.admin.req('POST', base(), body);
    assert.equal(r.status, status, JSON.stringify(r.data));
    assert.match(r.data.error, re);
  };
  await bad({ kind: 'nope', repoId }, 400, /Kind must be/);
  await bad({ kind: 'components' }, 400, /at least one repository/);
  await bad({ kind: 'components', repoId: 'g_missing' }, 404, /not found/i);
  const before1 = (await f.admin.get(base())).diagrams.length;
  assert.equal((await f.admin.get(base())).diagrams.length, before1, 'a refused request leaves nothing behind');
});

test('roles: a viewer reads and exports, an editor generates, an outsider sees nothing', async () => {
  const v = f.viewer;
  assert.equal((await v.get(base())).diagrams.length, 1);
  const detail = await v.get(`${base()}/${diagramId}`);
  assert.equal(detail.diagram.version, 3);
  assert.ok((await v.get(`${base()}/${diagramId}/versions/1`)).version.mermaid);
  const mmd = await v.req('GET', `${base()}/${diagramId}/export?format=mmd`);
  assert.equal(mmd.status, 200);
  assert.match(mmd.headers.get('content-disposition') ?? '', new RegExp(`${diagramSlug}\\.mmd`));
  assert.equal(mmd.data.trim(), detail.diagram.mermaid.trim());

  for (const [method, url, body] of [
    ['POST', base(), { kind: 'components', repoId }],
    ['POST', `${base()}/${diagramId}/refresh`, {}],
    ['POST', `${base()}/refresh-stale`, {}],
    ['PATCH', `${base()}/${diagramId}`, { title: 'x' }],
    ['DELETE', `${base()}/${diagramId}`, undefined],
  ] as const) {
    const r = await v.req(method, url, body);
    assert.equal(r.status, 403, `${method} ${url} -> ${r.status}`);
  }
  assert.equal((await f.admin.get(`${base()}/${diagramId}`)).diagram.version, 3, 'nothing changed');

  for (const [method, url, body] of [
    ['GET', base(), undefined],
    ['GET', `${base()}/${diagramId}`, undefined],
    ['GET', `${base()}/${diagramId}/export?format=mmd`, undefined],
    ['POST', base(), { kind: 'components', repoId }],
    ['DELETE', `${base()}/${diagramId}`, undefined],
  ] as const) {
    const r = await f.outsider.req(method, url, body);
    assert.ok(r.status === 403 || r.status === 404, `${method} ${url} -> ${r.status}`);
  }
});

test('export: the Mermaid source downloads; PNG says clearly when no browser is available', async () => {
  const mmd = await f.admin.req('GET', `${base()}/${diagramId}/export?format=mmd&version=1`);
  assert.equal(mmd.status, 200);
  assert.match(mmd.headers.get('content-type') ?? '', /text\/plain/);
  assert.match(mmd.headers.get('content-disposition') ?? '', /-v1\.mmd/);
  assert.equal((await f.admin.req('GET', `${base()}/${diagramId}/export?format=svg`)).status, 400);
  assert.equal((await f.admin.req('GET', `${base()}/${diagramId}/export?format=mmd&version=40`)).status, 404);

  const old = process.env.DOC_BROWSER;
  process.env.DOC_BROWSER = path.join(os.tmpdir(), 'no-such-browser-for-diagrams');
  try {
    const png = await f.admin.req('GET', `${base()}/${diagramId}/export?format=png`);
    assert.equal(png.status, 501);
    assert.match(png.data.error, /PNG export is not available/);
    assert.match(png.data.error, /no headless browser was found/);
    assert.match(png.data.error, /format=mmd/);
    const list = await f.admin.get(base());
    assert.equal(list.export.png, false);
    assert.match(list.export.pngReason, /no headless browser/);
  } finally {
    if (old === undefined) delete process.env.DOC_BROWSER;
    else process.env.DOC_BROWSER = old;
  }
});

test('export: PNG through the NEW-8 renderer when a browser is present', { skip: rendererProblem() ?? false, timeout: 90_000 }, async () => {
  const png = await f.admin.req('GET', `${base()}/${diagramId}/export?format=png`);
  assert.equal(png.status, 200, String(png.data).slice(0, 300));
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(png.buf!.subarray(1, 4).toString('ascii'), 'PNG');
});

test('a loop spec can refresh stale diagrams (action refresh_diagrams); with none stale it starts nothing', async () => {
  const bad = await f.admin.req('POST', `/api/projects/${f.pid}/loop-specs`, { name: 'bad', triggerKind: 'manual', triggerConfig: { action: 'format_disk' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Action must be refresh_diagrams/);

  const { spec } = await f.admin.post(`/api/projects/${f.pid}/loop-specs`, { name: 'Keep diagrams current', triggerKind: 'manual', triggerConfig: { action: 'refresh_diagrams', maxPerHour: 0 } });
  assert.equal(spec.trigger_config.action, 'refresh_diagrams');

  const idle = await f.admin.post(`/api/projects/${f.pid}/loop-specs/${spec.id}/run`, {});
  assert.equal(idle.workflow.id, null);
  assert.equal(idle.workflow.refreshed.stale, 0);
  assert.equal(idle.workflow.refreshed.started.length, 0);

  const newHead = commitUpstream('billing.py');
  await syncRepo();
  assert.equal((await f.admin.get(`${base()}/${diagramId}`)).diagram.stale, 1);
  const ran = await f.admin.post(`/api/projects/${f.pid}/loop-specs/${spec.id}/run`, {});
  assert.equal(ran.workflow.refreshed.stale, 1);
  assert.equal(ran.workflow.refreshed.started.length, 1);
  assert.equal(ran.workflow.refreshed.started[0].diagramId, diagramId);
  assert.equal(ran.workflow.id, ran.workflow.refreshed.started[0].workflowId);
  assert.equal(ran.workflow.loop_spec_id, spec.id);
  const done = await settled(diagramId);
  assert.equal(done.diagram.version, 4);
  assert.equal(done.diagram.stale, 0);
  assert.equal(done.diagram.sources[0].sha, newHead);
  assert.match(done.diagram.mermaid, /billing\.py/);

  const history = await f.admin.get(`/api/projects/${f.pid}/loop-specs/${spec.id}/trigger-history`);
  assert.equal(history.history.length, 2);
});

test('the refresh-stale route does the same for editors', async () => {
  commitUpstream('ledger.py');
  await syncRepo();
  const r = await f.admin.post(`${base()}/refresh-stale`, {});
  assert.equal(r.stale, 1);
  assert.equal(r.started.length, 1);
  assert.equal(r.workflows.length, 1);
  await settled(diagramId);
  const again = await f.admin.post(`${base()}/refresh-stale`, {});
  assert.equal(again.stale, 0);
});

test('other features can embed a stored diagram: Mermaid source and a ready-made fence for make-doc', async () => {
  const { diagramSource, diagramMarkdown } = await import('../server/diagrams.ts');
  const src = diagramSource(f.pid, diagramSlug)!;
  assert.equal(src.id, diagramId);
  assert.equal(src.version, 5);
  assert.match(src.mermaid, /^flowchart TB/);
  assert.equal(diagramSource(f.pid, diagramId, 1)!.version, 1);
  assert.equal(diagramSource(f.pid, 'nope'), null);
  const md = diagramMarkdown(f.pid, diagramSlug, { heading: true, description: true })!;
  assert.match(md, /^## Payments components\n\n```mermaid\nflowchart TB/);
  assert.match(md, /```\n\nDescription|```\n\nDemo/);
  assert.equal(diagramMarkdown(f.pid, 'nope'), null);
});

test('actions are audited', async () => {
  for (const action of ['diagram.create', 'diagram.refresh', 'diagram.version', 'diagram.export']) {
    const { entries } = await f.admin.get(`/api/admin/audit-log?action=${action}&limit=50`);
    assert.ok(entries.length >= 1, `${action} is in the audit log`);
  }
  const { entries } = await f.admin.get('/api/admin/audit-log?action=diagram.version&limit=50');
  assert.ok(entries.some((e: any) => /"ok":false/.test(typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail))), 'failed attempts are recorded too');
});

test('delete removes the diagram, its versions and its files, and commits that', async () => {
  const { diagram } = await f.admin.get(`${base()}/${diagramId}`);
  assert.equal((await f.admin.del(`${base()}/${diagramId}`)).ok, true);
  assert.equal((await f.admin.req('GET', `${base()}/${diagramId}`)).status, 404);
  assert.equal((await f.admin.get(base())).diagrams.length, 0);
  assert.equal(fs.existsSync(path.join(slugDir, 'docs/diagrams', `${diagram.slug}.mmd`)), false);
  assert.equal(fs.existsSync(path.join(slugDir, 'docs/diagrams', `${diagram.slug}.json`)), false);
  assert.match(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: slugDir }).toString(), /Delete diagram Payments components/);
});

/* ---- the text side, without a server ---- */

test('prompt: names the repos, the kind, the output format and the safety rules', () => {
  const p = composeDiagramPrompt('data_flow', 'Orders', [{ name: 'orders', slug: 'orders', default_branch: 'main' }], 'the checkout path');
  assert.match(p, /^Architecture diagram request: data_flow/);
  assert.match(p, /repos\/orders\//);
  assert.match(p, /Focus on: the checkout path/);
  assert.match(p, /```mermaid/);
  assert.match(p, /Description:/);
  assert.match(p, /Never copy secrets/);
  assert.match(composeDiagramPrompt('components', 'x', [{ name: 'x', slug: 'x', default_branch: 'main' }]), /Cover the whole system/);
});

test('reply: the first mermaid fence is the diagram, the rest is the description with its citations', () => {
  const r = parseDiagramReply('Here you go.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nDescription: Requests enter at `api/app.py:12` and reach the queue in lib/queue.ts:40.\n');
  assert.equal(r.mermaid, 'flowchart LR\n  A --> B');
  assert.match(r.description, /^Here you go\.\s+Requests enter/);
  assert.deepEqual(r.citations, ['api/app.py:12', 'lib/queue.ts:40']);
  assert.throws(() => parseDiagramReply('no fence here'), DiagramError);
  assert.throws(() => parseDiagramReply('```js\nx\n```'), /did not return a Mermaid diagram/);
});

test('validation: size, type, active content and real syntax', async () => {
  const ok = await validateMermaid('flowchart LR\n  A[Request] --> B{Valid?}\n  B -->|yes| C[Approve]');
  assert.equal(ok.type, 'flowchart');
  assert.equal(ok.parsed, true);
  assert.equal((await validateMermaid('---\ntitle: T\n---\nsequenceDiagram\n  A->>B: hi')).type, 'sequenceDiagram');
  assert.equal((await validateMermaid('erDiagram\n  A ||--o{ B : has')).parsed, true);
  assert.equal((await validateMermaid('%% note\nclassDiagram\n  class A')).type, 'classDiagram');
  const c4 = await validateMermaid('C4Context\n  title Payments\n  Person(user, "User")\n  System(sys, "Payments")\n  Rel(user, sys, "Uses")');
  assert.equal(c4.type, 'C4Context');

  const refuse = async (src: unknown, re: RegExp) => await assert.rejects(validateMermaid(src), (e: any) => e instanceof DiagramError && re.test(e.message), String(src).slice(0, 40));
  await refuse('', /must be Mermaid text/);
  await refuse(undefined, /must be Mermaid text/);
  await refuse('flowchart LR\n' + 'A --> B\n'.repeat(3000), /too long/);
  await refuse('flowchart LR\n' + '\n'.repeat(DIAGRAM_LIMITS.lines + 10) + 'A-->B', /too long|lines/);
  await refuse('pie title Pets\n  "Dogs": 5', /supported Mermaid type/);
  await refuse('hello world', /supported Mermaid type/);
  await refuse('flowchart LR\n  A[Open] --> B\n  click A call alert()', /click directives/);
  await refuse('flowchart LR\n  A["<script>alert(1)</script>"] --> B', /scripts/);
  await refuse('%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\n  A --> B', /(security settings|init directives)/);
  await refuse('flowchart LR\n  A -->', /Mermaid syntax error/);
  await refuse('sequenceDiagram\n  A->>', /Mermaid syntax error/);
  assert.equal(diagramType('flowchart-elk TD\n A-->B'), 'flowchart-elk');
  assert.equal(diagramType('\n\n%% only comments'), null);
});
