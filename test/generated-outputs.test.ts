import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { waitFor, startSingleRun, type Client } from './client.ts';
import { bootWorkflowFixture, type WorkflowFixture } from './workflows-fixture.ts';
import { rendererProblem } from '../server/docimage.ts';
import { diagramDensity, diagramRules, composeDiagramPrompt, READABLE_NODES } from '../server/diagram-text.ts';

let f: WorkflowFixture;
let repoId: string;
let vaultRoot: string;
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outputs-repo-'));
const git = (...a: string[]) => execFileSync('git', a, { cwd: repoDir, stdio: 'pipe' }).toString().trim();

before(async () => {
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repoDir, 'app.py'), 'def handler(event, context):\n    return {"ok": True}\n\n# end\n');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# payments\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  f = await bootWorkflowFixture();
  const { repo } = await f.admin.post(`/api/projects/${f.pid}/repos`, { localPath: repoDir, name: 'payments' });
  repoId = repo.id;
  await waitFor(async () => ((await f.admin.get(`/api/projects/${f.pid}/repos`)).repos.find((r: any) => r.id === repoId).status === 'ready' ? true : null), 'clone');
  vaultRoot = path.join(f.srv.dataDir, 'vault', 'projects', f.pid);
});

after(async () => {
  await f.srv.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

const dg = () => `/api/projects/${f.pid}/diagrams`;
const docs = () => `/api/projects/${f.pid}/generated-docs`;
const decks = () => `/api/projects/${f.pid}/presentations`;
const vaultList = async (c: Client = f.admin) => (await c.get(`/api/vault?scope=project&projectId=${f.pid}`)) as { files: { path: string; dir: boolean; size: number; noRunCopy?: boolean }[]; noRunCopy: string[] };
const vaultPaths = async () => (await vaultList()).files.map((e) => e.path);
const vaultText = (rel: string) => fs.readFileSync(path.join(vaultRoot, ...rel.split('/')), 'utf8');
const diagramSettled = (id: string) =>
  waitFor(async () => {
    const r = await f.admin.get(`${dg()}/${id}`);
    return r.diagram.status !== 'generating' ? r : null;
  }, 'the diagram to settle');
const sessionEvents = async (wid: string) => (await f.admin.get(`/api/workflows/${wid}`)).events as { kind: string; body: string }[];
const sessionOutput = async (wid: string) => (await f.admin.get(`/api/workflows/${wid}`)).output;
/** Change what the demo agent is asked in an existing session, then send it a follow-up message. */
async function followUp(wid: string, edit: (goal: string) => string, text = 'Please redraw it') {
  const w = (await f.admin.get(`/api/workflows/${wid}`)).workflow;
  // Markers of an earlier step must not carry over into this one.
  const clean = w.goal.replace(/\n?\[demo-[a-z-]+\]/g, '');
  await f.admin.put(`/api/workflows/${wid}`, { goal: edit(clean) });
  await f.admin.post(`/api/workflows/${wid}/messages`, { body: text });
}

/* ------------------------------------------------------------------ */
/* The text side                                                       */
/* ------------------------------------------------------------------ */

test('prompt and rules tell the agent about readability, where the diagram goes and what a follow-up means', () => {
  const rules = diagramRules('Payments flow');
  assert.match(rules, /Create page \(Diagrams tab\)/);
  assert.match(rules, /Vault \(generated\/diagrams\/\)/);
  assert.match(rules, /Never say that no file was written/);
  assert.match(rules, /reply again in the same format with the complete new diagram/);
  assert.match(rules, new RegExp(`at most about ${READABLE_NODES} nodes`));
  assert.match(rules, /600 lines or 20000 characters/);
  const prompt = composeDiagramPrompt('data_flow', 'Flow', [{ name: 'payments', slug: 'payments', default_branch: 'main' }]);
  assert.match(prompt, /at most about 40 nodes/);
  assert.match(prompt, /group related things into subgraphs/);
  assert.match(prompt, /separate diagram/);
});

test('density: a small flowchart is fine, a big graph is flagged as very dense', () => {
  const small = diagramDensity('flowchart LR\n  A[One] --> B[Two]\n  B --> C{Three}\n');
  assert.equal(small.nodes, 3);
  assert.equal(small.dense, false);
  const many = ['flowchart LR', ...Array.from({ length: 60 }, (_, i) => `  n${i}["Node ${i}"] -->|calls| n${i + 1}["Node ${i + 1}"]`)].join('\n');
  const big = diagramDensity(many);
  assert.equal(big.nodes, 61);
  assert.equal(big.dense, true);
  assert.equal(diagramDensity('sequenceDiagram\n  A->>B: hi\n').dense, false);
  assert.equal(diagramDensity(['sequenceDiagram', ...Array.from({ length: 200 }, () => '  A->>B: hi')].join('\n')).dense, true, 'a long sequence is dense by its length');
});

/* ------------------------------------------------------------------ */
/* A reply that cannot be stored is visible from the session            */
/* ------------------------------------------------------------------ */

let failedId = '';
let failedWid = '';

test('a first reply that is too large leaves an error on the diagram, in the session banner data, and in the session history', async () => {
  const c = await f.admin.post(dg(), { kind: 'system_context', repoId, title: 'Huge picture', focus: '[demo-huge-mermaid]' });
  failedId = c.diagram.id;
  failedWid = c.workflow.id;
  const done = await diagramSettled(failedId);
  assert.equal(done.diagram.status, 'error');
  assert.equal(done.diagram.version, 0);
  assert.match(done.diagram.error, /too long \(max 20000 characters\)/);
  assert.equal(done.diagram.session_id, failedWid);
  const list = await f.admin.get(dg());
  const row = list.diagrams.find((d: any) => d.id === failedId);
  assert.equal(row.status, 'error');
  assert.match(row.error, /too long/);

  const out = await sessionOutput(failedWid);
  assert.equal(out.kind, 'diagram');
  assert.equal(out.label, 'Diagram');
  assert.equal(out.title, 'Huge picture');
  assert.equal(out.status, 'error');
  assert.match(out.error, /too long/);
  assert.equal(out.tab, 'diagrams');
  assert.equal(out.id, failedId);
  assert.deepEqual(out.vault_files, []);
  const history = (await sessionEvents(failedWid)).filter((e) => e.kind === 'status').map((e) => e.body);
  assert.ok(history.some((b) => /Huge picture" was not stored: .*too long/.test(b) && /Reply in this session to ask the agent for a smaller or corrected diagram/.test(b)), history.join(' | '));
  assert.deepEqual(await vaultPaths(), [], 'nothing is saved for a diagram that was not stored');
});

test('a follow-up message that fixes it stores version 1 from the same session, and the Vault gets its copy', async () => {
  await followUp(failedWid, (g) => g.replace(/Focus on: ?\s*$/m, ''), 'Draw it small this time');
  const ok = await diagramSettled(failedId);
  assert.equal(ok.diagram.status, 'ready', JSON.stringify(ok.diagram));
  assert.equal(ok.diagram.version, 1);
  assert.equal(ok.diagram.error, null);
  assert.equal(ok.diagram.session_id, failedWid, 'one session, one diagram');
  assert.equal(ok.versions[0].workflow_id, failedWid);
  const out = await sessionOutput(failedWid);
  assert.equal(out.status, 'ready');
  assert.equal(out.version, 1);
  assert.deepEqual(out.vault_files, [`generated/diagrams/${ok.diagram.slug}.mmd`].concat(out.vault_files.filter((x: string) => x.endsWith('.png'))));
  assert.equal(vaultText(`generated/diagrams/${ok.diagram.slug}.mmd`).trim(), ok.diagram.mermaid.trim());
});

test('a valid but very big graph is stored and flagged as very dense in the diagram, the list and the session output', async () => {
  const c = await f.admin.post(dg(), { kind: 'system_context', repoId, title: 'Dense picture', focus: '[demo-dense-mermaid]' });
  const done = await diagramSettled(c.diagram.id);
  assert.equal(done.diagram.status, 'ready', JSON.stringify(done.diagram));
  assert.equal(done.diagram.density.dense, true);
  assert.equal(done.diagram.density.nodes, 61);
  const row = (await f.admin.get(dg())).diagrams.find((d: any) => d.id === c.diagram.id);
  assert.equal(row.density.dense, true);
  assert.equal(row.mermaid, undefined, 'the list stays light');
  assert.equal((await sessionOutput(c.workflow.id)).density.dense, true);
  await f.admin.del(`${dg()}/${c.diagram.id}`);
});

/* ------------------------------------------------------------------ */
/* Follow-up messages in a diagram session                              */
/* ------------------------------------------------------------------ */

let diagramId = '';
let diagramSlug = '';
let diagramWid = '';

test('a new diagram is saved to the Vault as generated/diagrams/<slug>.mmd; the folder is flagged as not copied into runs', async () => {
  const c = await f.admin.post(dg(), { kind: 'system_context', repoId, title: 'Payments context' });
  diagramId = c.diagram.id;
  diagramSlug = c.diagram.slug;
  diagramWid = c.workflow.id;
  const done = await diagramSettled(diagramId);
  assert.equal(done.diagram.version, 1);
  assert.match(done.diagram.vault_files.join(','), new RegExp(`generated/diagrams/${diagramSlug}\\.mmd`));
  const v = await vaultList();
  const rel = `generated/diagrams/${diagramSlug}.mmd`;
  assert.ok(v.files.some((e) => e.path === rel && !e.dir && e.noRunCopy === true), 'the file is listed and flagged');
  assert.ok(v.files.find((e) => e.path === 'generated')?.noRunCopy);
  assert.deepEqual(v.noRunCopy, ['generated']);
  assert.equal(vaultText(rel).trim(), done.diagram.mermaid.trim());
  // The picture is added when the renderer exists; without one there is only the source.
  const png = `generated/diagrams/${diagramSlug}.png`;
  if (rendererProblem() === null) {
    await waitFor(async () => ((await vaultPaths()).includes(png) ? true : null), 'the PNG copy', 60_000);
    assert.equal(fs.readFileSync(path.join(vaultRoot, ...png.split('/'))).subarray(1, 4).toString(), 'PNG');
  } else {
    assert.ok(!(await vaultPaths()).includes(png));
  }
  // Downloadable like any vault file.
  const dl = await f.admin.req('GET', `/api/vault/download?scope=project&projectId=${f.pid}&path=${encodeURIComponent(rel)}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.buf!.toString().trim(), done.diagram.mermaid.trim());
  // A viewer of the project can see and download it too.
  assert.ok((await vaultList(f.viewer)).files.some((e) => e.path === rel));
  // The personal and team vaults have no such flag.
  assert.deepEqual((await f.admin.get('/api/vault?scope=mine')).noRunCopy, []);
});

test('a follow-up whose reply holds the stored diagram, or no diagram, changes nothing and says so in the session', async () => {
  await followUp(diagramWid, (g) => g, 'where is the diagram');
  const same = await diagramSettled(diagramId);
  assert.equal(same.diagram.version, 1, 'the same diagram is not stored again');
  assert.equal(same.diagram.status, 'ready');
  assert.equal(same.diagram.error, null);
  assert.ok((await sessionEvents(diagramWid)).some((e) => e.kind === 'status' && /already stored, so no new version was made/.test(e.body)));

  await followUp(diagramWid, (g) => g + '\n[demo-no-diagram]', 'explain it');
  const none = await diagramSettled(diagramId);
  assert.equal(none.diagram.version, 1);
  assert.equal(none.diagram.status, 'ready');
  assert.equal(none.diagram.error, null, 'a reply without a diagram is not an error in a follow-up');
  assert.ok((await sessionEvents(diagramWid)).some((e) => e.kind === 'status' && /held no Mermaid diagram, so nothing was changed/.test(e.body)));
  assert.equal((await sessionOutput(diagramWid)).status, 'ready');
});

test('a follow-up that draws something new stores version 2 in the same diagram, and the Vault copy is replaced in place', async () => {
  const rel = `generated/diagrams/${diagramSlug}.mmd`;
  const before1 = vaultText(rel);
  await followUp(diagramWid, (g) => g.replace('Payments context', 'Payments context renamed'), 'Rename the system box');
  const two = await diagramSettled(diagramId);
  assert.equal(two.diagram.version, 2);
  assert.deepEqual(two.versions.map((v: any) => v.version), [2, 1]);
  assert.equal(two.versions[0].workflow_id, diagramWid);
  assert.match(two.diagram.mermaid, /renamed/i);
  const after1 = vaultText(rel);
  assert.notEqual(after1, before1);
  assert.equal(after1.trim(), two.diagram.mermaid.trim(), 'latest only, in the same file');
  const mmds = (await vaultPaths()).filter((p) => p === rel);
  assert.equal(mmds.length, 1);
  assert.equal((await f.admin.get(`${dg()}/${diagramId}/versions/1`)).version.mermaid.trim().includes('renamed'), false, 'older versions stay in the portal');
  assert.ok((await sessionEvents(diagramWid)).some((e) => e.kind === 'status' && /is now version 2/.test(e.body)));
  // The audit trail knows about the copy.
  const audit = await f.admin.get(`/api/admin/audit-log?action=vault.generated&project=${f.pid}`);
  const mine = audit.entries.filter((e: any) => e.action === 'vault.generated' && e.detail.name === diagramSlug);
  assert.ok(mine.length >= 2, 'one entry per saved version');
  assert.ok(mine.some((e: any) => e.detail.saved.includes(`generated/diagrams/${diagramSlug}.mmd`)));
});

test('a follow-up whose diagram is invalid keeps the stored version and shows why on the diagram, the banner data and the session', async () => {
  await followUp(diagramWid, (g) => g + '\n[demo-invalid-mermaid]', 'Add the audit log');
  const bad = await diagramSettled(diagramId);
  assert.equal(bad.diagram.version, 2);
  assert.equal(bad.diagram.status, 'ready');
  assert.match(bad.diagram.error, /Mermaid syntax error/);
  assert.match(bad.diagram.error, /previous version \(v2\) was kept/);
  const out = await sessionOutput(diagramWid);
  assert.equal(out.status, 'ready');
  assert.match(out.error, /Mermaid syntax error/);
  assert.ok((await sessionEvents(diagramWid)).some((e) => e.kind === 'status' && /was not stored: Mermaid syntax error/.test(e.body)));
  assert.match(vaultText(`generated/diagrams/${diagramSlug}.mmd`), /renamed/i, 'the Vault keeps the last good version');
  // A good reply afterwards clears the error.
  await followUp(diagramWid, (g) => g, 'Never mind');
  const fixed = await diagramSettled(diagramId);
  assert.equal(fixed.diagram.error, null);
});

test('the session output is null for an ordinary session, and the diagram view reports its density', async () => {
  const { workflow } = await startSingleRun(f.admin, f.pid, { prompt: 'Just a plain session', permissionMode: 'plan' });
  assert.equal((await f.admin.get(`/api/workflows/${workflow.id}`)).output, null);
  const d = (await f.admin.get(`${dg()}/${diagramId}`)).diagram;
  assert.equal(typeof d.density.nodes, 'number');
  assert.equal(d.density.dense, false);
});

/* ------------------------------------------------------------------ */
/* Vault copies: setting, delete, backfill                              */
/* ------------------------------------------------------------------ */

test('the setting "Save generated files to the Vault": off stops new copies, turning it on copies what exists, delete always cleans up', async () => {
  const rel = `generated/diagrams/${diagramSlug}.mmd`;
  assert.equal((await f.admin.get(`/api/projects/${f.pid}`)).project.vault_generated, 1, 'on by default');
  await f.admin.patch(`/api/projects/${f.pid}`, { vaultGenerated: false });
  assert.equal((await f.admin.get(`/api/projects/${f.pid}`)).project.vault_generated, 0);
  const frozen = vaultText(rel);
  await followUp(diagramWid, (g) => g.replace('Payments context renamed', 'Payments context third'), 'Rename again');
  const three = await diagramSettled(diagramId);
  assert.equal(three.diagram.version, 3);
  assert.equal(vaultText(rel), frozen, 'with the setting off the copy is not updated');
  assert.equal((await sessionOutput(diagramWid)).vault_enabled, false);

  await f.admin.patch(`/api/projects/${f.pid}`, { vaultGenerated: true });
  assert.match(vaultText(rel), /third/i, 'turning it on copies the current version');
  assert.equal(vaultText(rel).trim(), three.diagram.mermaid.trim());

  // Only owners change the setting.
  const denied = await f.viewer.req('PATCH', `/api/projects/${f.pid}`, { vaultGenerated: false });
  assert.equal(denied.status, 403);

  // Delete removes the copy even when the setting is off.
  await f.admin.patch(`/api/projects/${f.pid}`, { vaultGenerated: false });
  await f.admin.del(`${dg()}/${diagramId}`);
  assert.ok(!fs.existsSync(path.join(vaultRoot, ...rel.split('/'))));
  await f.admin.patch(`/api/projects/${f.pid}`, { vaultGenerated: true });
  assert.ok(!(await vaultPaths()).some((p) => p.includes(diagramSlug)));
  const gone = (await f.admin.get(`/api/admin/audit-log?action=vault.generated_remove&project=${f.pid}`)).entries;
  assert.ok(gone.some((e: any) => e.detail.name === diagramSlug && e.detail.removed.includes(rel)), 'the removal is audited');
  const setting = (await f.admin.get(`/api/admin/audit-log?action=vault.generated_setting&project=${f.pid}`)).entries;
  assert.ok(setting.length >= 3);
});

/* ------------------------------------------------------------------ */
/* Documents and decks                                                  */
/* ------------------------------------------------------------------ */

test('a document is saved as .md and .docx, a follow-up that rewrites it replaces them in place, delete removes them', async () => {
  const c = await f.admin.post(docs(), { type: 'overview', repoIds: [repoId], title: 'Payments overview' });
  const id = c.document.id;
  const wid = c.workflow.id;
  const settled = () =>
    waitFor(async () => {
      const r = await f.admin.get(`${docs()}/${id}`);
      return r.document.status !== 'generating' ? r : null;
    }, 'the document session to finish');
  const one = await settled();
  assert.equal(one.document.status, 'ready', JSON.stringify(one.document));
  assert.equal(one.document.version, 1);
  const files = one.document.vault_files as string[];
  assert.deepEqual(files.map((p) => p.replace(/^generated\/docs\/[^.]+/, '')), ['.docx', '.md']);
  const md = files.find((p) => p.endsWith('.md'))!;
  const docx = files.find((p) => p.endsWith('.docx'))!;
  assert.equal(vaultText(md).trim(), one.document.markdown.trim());
  assert.equal(fs.readFileSync(path.join(vaultRoot, ...docx.split('/'))).subarray(0, 2).toString(), 'PK', 'a Word file is a zip');
  const out = await sessionOutput(wid);
  assert.equal(out.kind, 'doc');
  assert.equal(out.label, 'Document');
  assert.equal(out.tab, 'documents');
  assert.deepEqual(out.vault_files, files);

  // A follow-up: the agent writes the document again in its run folder, which is a new version.
  await f.admin.post(`/api/workflows/${wid}/messages`, { body: 'Please rewrite it' });
  const two = await settled();
  assert.equal(two.document.version, 2, JSON.stringify(two.document));
  assert.deepEqual(two.document.vault_files, files, 'same names: replaced in place');
  assert.equal(vaultText(md).trim(), two.document.markdown.trim());

  // Another document with the same title gets its own file name.
  const c2 = await f.admin.post(docs(), { type: 'overview', repoIds: [repoId], title: 'Payments overview' });
  const second = await waitFor(async () => {
    const r = await f.admin.get(`${docs()}/${c2.document.id}`);
    return r.document.status !== 'generating' ? r : null;
  }, 'second document');
  assert.notDeepEqual(second.document.vault_files, files);
  assert.ok(second.document.vault_files.every((p: string) => /-2\.(md|docx)$/.test(p)), second.document.vault_files.join(','));

  await f.admin.del(`${docs()}/${id}`);
  for (const p of files) assert.ok(!fs.existsSync(path.join(vaultRoot, ...p.split('/'))), `${p} removed`);
  assert.ok(second.document.vault_files.every((p: string) => fs.existsSync(path.join(vaultRoot, ...p.split('/')))), 'the other document keeps its copies');
  await f.admin.del(`${docs()}/${c2.document.id}`);
});

test('a deck is saved as .pptx; delete removes it; the session output names the deck', async () => {
  const c = await f.admin.post(decks(), { topic: 'Why the refund approval limits changed in Q4. Agents may refund up to 100. Managers may refund up to 5000. Finance reviews every refund above 5000.', slideCount: 4, title: 'Refund limits' });
  const id = c.presentation.id;
  const wid = c.workflow.id;
  const done = await waitFor(async () => {
    const r = await f.admin.get(`${decks()}/${id}`);
    return r.presentation.status !== 'generating' ? r : null;
  }, 'the deck session to finish');
  assert.equal(done.presentation.status, 'ready', JSON.stringify(done.presentation));
  assert.deepEqual(done.presentation.vault_files, ['generated/decks/refund-limits.pptx']);
  const bytes = fs.readFileSync(path.join(vaultRoot, 'generated', 'decks', 'refund-limits.pptx'));
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  const stored = await f.admin.req('GET', `${decks()}/${id}/download`);
  assert.equal(stored.buf!.length, bytes.length);
  const out = await sessionOutput(wid);
  assert.equal(out.kind, 'deck');
  assert.equal(out.label, 'Deck');
  assert.equal(out.tab, 'presentations');
  assert.equal(out.status, 'ready');
  assert.deepEqual(out.vault_files, ['generated/decks/refund-limits.pptx']);
  await f.admin.del(`${decks()}/${id}`);
  assert.ok(!fs.existsSync(path.join(vaultRoot, 'generated', 'decks', 'refund-limits.pptx')));
});

test('a deck session that failed shows the reason in its output', async () => {
  const c = await f.admin.post(decks(), { topic: 'A deck that will not be written because the demo agent is told to skip the file [demo-no-deck]', slideCount: 4, title: 'No file deck' });
  const done = await waitFor(async () => {
    const r = await f.admin.get(`${decks()}/${c.presentation.id}`);
    return r.presentation.status !== 'generating' ? r : null;
  }, 'the deck session to finish');
  assert.equal(done.presentation.status, 'error');
  const out = await sessionOutput(c.workflow.id);
  assert.equal(out.status, 'error');
  assert.match(out.error, /without saving a .pptx file/);
  assert.ok((await sessionEvents(c.workflow.id)).some((e) => e.kind === 'status' && /No file deck" was not stored/.test(e.body)));
  assert.deepEqual(await vaultPaths().then((p) => p.filter((x) => x.includes('no-file-deck'))), []);
  await f.admin.del(`${decks()}/${c.presentation.id}`);
});

/* ------------------------------------------------------------------ */
/* Runs do not get the generated folder                                 */
/* ------------------------------------------------------------------ */

test('the project vault is copied into runs, except the generated folder', async () => {
  const up = (rel: string, text: string) => f.admin.req('PUT', `/api/vault/file?scope=project&projectId=${f.pid}&path=${encodeURIComponent(rel)}`, undefined, { raw: Buffer.from(text) });
  assert.equal((await up('docs/fsd.md', 'FSD for the run')).status, 200);
  assert.equal((await up('generated/diagrams/big.mmd', 'flowchart LR\n  A --> B\n' + '%% filler\n'.repeat(5000))).status, 200);
  assert.equal((await up('generated/note.txt', 'also not copied')).status, 200);

  const { workflow, run } = await startSingleRun(f.admin, f.pid, { prompt: 'Read the vault', permissionMode: 'plan' });
  assert.ok(workflow || run);
  await waitFor(async () => {
    const r = await f.admin.get(`/api/runs/${run.id}`);
    return ['completed', 'failed', 'waiting'].includes(r.run.status) ? r : null;
  }, 'run');
  const { project } = await f.admin.get(`/api/projects/${f.pid}`);
  const work = path.join(f.srv.dataDir, 'projects', project.slug, 'work', run.id, 'vault', 'project');
  assert.equal(fs.readFileSync(path.join(work, 'docs', 'fsd.md'), 'utf8'), 'FSD for the run');
  assert.ok(!fs.existsSync(path.join(work, 'generated')), 'the generated folder is not copied');
  // Still in the Vault, listed and downloadable, and part of the zip.
  assert.ok((await vaultPaths()).includes('generated/diagrams/big.mmd'));
  const zip = await f.admin.req('GET', `/api/vault/zip?scope=project&projectId=${f.pid}`);
  assert.equal(zip.status, 200);
  const JSZip = (await import('jszip')).default;
  const names = Object.keys((await JSZip.loadAsync(zip.buf!)).files);
  assert.ok(names.includes('generated/note.txt'));
});

test('copyVaultsInto leaves generated/ out of the size check, so a huge generated folder never blocks the rest', async () => {
  const { copyVaultsInto, MAX_RUN_COPY, isLeftOutOfRuns } = await import('../server/vault.ts');
  assert.equal(isLeftOutOfRuns('project', 'generated'), true);
  assert.equal(isLeftOutOfRuns('project', 'generated/docs/a.md'), true);
  assert.equal(isLeftOutOfRuns('project', 'generated-by-me/a.md'), false);
  assert.equal(isLeftOutOfRuns('project', 'docs/generated/a.md'), false);
  assert.equal(isLeftOutOfRuns('mine', 'generated/a.md'), false, 'only the project vault has the folder');
  const big = path.join(vaultRoot, 'generated', 'decks', 'huge.bin');
  fs.mkdirSync(path.dirname(big), { recursive: true });
  const fd = fs.openSync(big, 'w');
  fs.ftruncateSync(fd, MAX_RUN_COPY + 1024 * 1024);
  fs.closeSync(fd);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'run-copy-'));
  try {
    const note = copyVaultsInto(dest, 'work/x', 'u_none', f.pid);
    assert.match(note, /project vault \(\d+ files?\)/);
    assert.doesNotMatch(note, /too big/);
    assert.ok(fs.existsSync(path.join(dest, 'vault', 'project', 'docs', 'fsd.md')));
    assert.ok(!fs.existsSync(path.join(dest, 'vault', 'project', 'generated')));
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.rmSync(big, { force: true });
  }
});
