import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { waitFor } from './client.ts';
import { bootWorkflowFixture, type WorkflowFixture } from './workflows-fixture.ts';
import { makeWordTemplate } from './docx-fixtures.ts';
import { makeTemplate } from './pptx-fixtures.ts';
import { rendererProblem } from '../server/docimage.ts';
import {
  DOC_TYPES,
  citationWarning,
  composeDocPrompt,
  extractCitations,
  normalizeMarkdown,
  parseDocReply,
  placeDiagrams,
} from '../server/generated-doc-text.ts';

let f: WorkflowFixture;
let repoId: string;
let projectDir: string;
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gendoc-repo-'));
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
  const { project } = await f.admin.get(`/api/projects/${f.pid}`);
  projectDir = path.join(f.srv.dataDir, 'projects', project.slug);
});

after(async () => {
  await f.srv.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

const base = () => `/api/projects/${f.pid}/generated-docs`;
const settled = (id: string) =>
  waitFor(async () => {
    const r = await f.admin.get(`${base()}/${id}`);
    return r.document.status !== 'generating' ? r : null;
  }, 'the documentation session to finish');
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
const unzip = async (buf: Buffer) => JSZip.loadAsync(buf);
const upload = async (name: string, md: string) => (await f.admin.ok('PUT', `/api/projects/${f.pid}/documents?name=${encodeURIComponent(name)}`, undefined, { raw: Buffer.from(md) })).document;
const templateUp = (filename: string, name: string, buf: Buffer, asDefault = false) => f.admin.req('POST', `/api/projects/${f.pid}/templates?filename=${filename}&name=${encodeURIComponent(name)}${asDefault ? '&default=1' : ''}`, undefined, { raw: buf });

/* ------------------------------------------------------------------ */
/* The text side                                                       */
/* ------------------------------------------------------------------ */

test('prompt: marker first line, sources, citation format, diagram markers, no Word building by the agent', () => {
  const p = composeDocPrompt({
    type: 'api',
    title: 'Payments API',
    audience: 'Integrators',
    repos: [{ name: 'payments', slug: 'payments', branch: 'main' }],
    knowledge: true,
    decisions: false,
    diagrams: [{ slug: 'payments-components', title: 'Payments components', kind: 'components', description: 'Two parts.' }],
  });
  assert.match(p, /^Documentation request: api\n/);
  assert.match(p, /API reference/);
  assert.match(p, /repos\/payments\//);
  assert.match(p, /Decisions log: do not use docs\/decisions\.md/);
  assert.match(p, /\{\{diagram:payments-components\}\}/);
  assert.match(p, /`payments\/src\/app\.py:42`/);
  assert.match(p, /docs\/md\/<file>\.md › <heading>/);
  assert.match(p, /Do not build a Word file/);
  assert.match(p, /document\.md/);
  const none = composeDocPrompt({ type: 'user-guide', title: 'Guide', audience: '', repos: [], knowledge: false, decisions: true, diagrams: [] });
  assert.match(none, /Repositories: none are included/);
  assert.match(none, /do not use docs\/md\//);
  assert.match(none, /Stored diagrams: none were chosen/);
  for (const t of DOC_TYPES) assert.match(composeDocPrompt({ type: t, title: 'T', audience: '', repos: [], knowledge: true, decisions: true, diagrams: [] }), new RegExp(`^Documentation request: ${t}\\n`));
  assert.deepEqual(parseDocReply('Done.\nDocument: work/r_1/document.md\n1. A'), { path: 'work/r_1/document.md' });
  assert.deepEqual(parseDocReply('**Document:** `work/x.md`'), { path: 'work/x.md' });
  assert.deepEqual(parseDocReply('nothing'), { path: null });
});

test('citations: code spans that look like files are found, fenced code and web addresses are not', () => {
  const md = [
    '# T',
    'See `payments/src/app.py:42` and `payments/src/app.py:10-30`, also `src/util.ts#L5` and `docs/md/spec.md › Limits`.',
    'A bare `package.json` is not a citation, but `package.json:3` is. So is `lib/index.js`.',
    'Not files: `Node.js`, `example.com:443`, `https://example.com/a.html`, `v1.2`, `GET /api/orders`, `a b.py`.',
    '```',
    'in a fence `fake/path.py:1`',
    '```',
    'Again `payments/src/app.py:42` (duplicate).',
  ].join('\n');
  const c = extractCitations(md);
  assert.deepEqual(
    c.map((x) => [x.path, x.line, x.lineEnd]),
    [
      ['payments/src/app.py', 42, null],
      ['payments/src/app.py', 10, 30],
      ['src/util.ts', 5, null],
      ['docs/md/spec.md', null, null],
      ['package.json', 3, null],
      ['lib/index.js', null, null],
    ],
  );
  assert.equal(citationWarning([]), null);
  const w = citationWarning([
    { ...c[0], repo: null, ok: false, reason: 'file not found' },
    { ...c[1], repo: 'payments', ok: true, reason: null },
  ])!;
  assert.match(w, /^1 of 2 cited locations? (does|do) not resolve/);
  assert.match(w, /payments\/src\/app\.py:42 \(file not found\)/);
});

test('diagram markers are replaced with the stored diagram; unplaced ones are appended; unknown ones are dropped; fences are left alone', () => {
  const dg = [
    { slug: 'a', markdown: '```mermaid\nflowchart LR\n  A --> B\n```\n\nDescription A.' },
    { slug: 'b', markdown: '```mermaid\nflowchart LR\n  C --> D\n```' },
  ];
  const r = placeDiagrams('# T\n\nText\n\n{{diagram:a}}\n\nMore\n\n{{diagram:zzz}}\n\n```\n{{diagram:b}}\n```\n', dg);
  assert.deepEqual(r.placed, ['a']);
  assert.deepEqual(r.appended, ['b']);
  assert.deepEqual(r.unknown, ['zzz']);
  assert.match(r.markdown, /Text\n\n```mermaid\nflowchart LR\n {2}A --> B\n```\n\nDescription A\.\n\nMore/);
  assert.match(r.markdown, /```\n\{\{diagram:b\}\}\n```/, 'a marker inside a code fence is not touched');
  assert.match(r.markdown, /\n## Diagrams\n\n```mermaid\nflowchart LR\n {2}C --> D/);
  assert.doesNotMatch(r.markdown, /\{\{diagram:(a|zzz)\}\}/);
});

test('markdown is normalised to start with one title line', () => {
  assert.equal(normalizeMarkdown('# Mine\n\ntext', 'Requested'), '# Mine\n\ntext\n');
  assert.equal(normalizeMarkdown('\n\nIntro first\n\n## Part', 'Requested'), '# Requested\n\nIntro first\n\n## Part\n');
  assert.equal(normalizeMarkdown('# A\n\ntext\n\n# B\n\n```\n# not a heading\n```', 'X'), '# A\n\ntext\n\n## B\n\n```\n# not a heading\n```\n');
});

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

test('requests are checked before anything starts', async () => {
  const bad = async (body: any, re: RegExp, status = 400) => {
    const r = await f.admin.req('POST', base(), body);
    assert.equal(r.status, status, JSON.stringify(r.data));
    assert.match(r.data.error, re);
  };
  await bad({}, /Type must be one of: overview, architecture, api, runbook, user-guide/);
  await bad({ type: 'novel', repoIds: [repoId] }, /Type must be one of/);
  await bad({ type: 'overview', includeKnowledge: false, includeDecisions: false }, /at least one source/);
  await bad({ type: 'overview', repoIds: 'x' }, /repoIds must be a list/);
  await bad({ type: 'overview', repoIds: ['r_missing'] }, /repository was not found/);
  await bad({ type: 'overview', repoIds: [repoId], includeKnowledge: 'yes' }, /includeKnowledge must be true or false/);
  await bad({ type: 'overview', repoIds: [repoId], diagramIds: ['dg_missing'] }, /diagram was not found/);
  await bad({ type: 'overview', repoIds: [repoId], templateId: 'tp_missing' }, /Template not found/, 404);
  const other = (await f.admin.post('/api/projects', { name: 'Elsewhere', description: 'd' })).project.id;
  await bad({ type: 'overview', repoIds: Array.from({ length: 9 }, (_, i) => `r${i}`) }, /at most 8 repositories/);
  const pptx = await f.admin.req('POST', `/api/projects/${f.pid}/templates?filename=Deck.pptx&name=Deck`, undefined, { raw: await makeTemplate() });
  assert.equal(pptx.status, 200);
  await bad({ type: 'overview', repoIds: [repoId], templateId: pptx.data.template.id }, /Choose a Word template/);
  assert.equal((await f.admin.get(base())).documents.length, 0, 'a refused request leaves nothing behind');
  void other;
});

/* ------------------------------------------------------------------ */
/* Generating                                                          */
/* ------------------------------------------------------------------ */

let diagramId = '';
let diagramMermaid = '';
let docA = '';

test('every document type is written by a session, cited, stored as version 1 and built as Word', async () => {
  await upload('Payments policy.md', '# Payments policy\n\n## Limits\n\nPayments above 5000 need approval.\n');
  const dg = await f.admin.post(`/api/projects/${f.pid}/diagrams`, { kind: 'components', repoId, title: 'Payments components' });
  diagramId = dg.diagram.id;
  const dgDone = await waitFor(async () => {
    const r = await f.admin.get(`/api/projects/${f.pid}/diagrams/${diagramId}`);
    return r.diagram.status !== 'generating' ? r : null;
  }, 'the diagram session');
  assert.equal(dgDone.diagram.version, 1);
  diagramMermaid = dgDone.diagram.mermaid;

  for (const type of DOC_TYPES) {
    const withDiagram = type === 'architecture';
    const created = await f.admin.post(base(), { type, repoIds: [repoId], title: `Payments ${type}`, audience: 'Engineers', ...(withDiagram ? { diagramIds: [diagramId] } : {}) });
    const d = created.document;
    assert.equal(d.status, 'generating');
    assert.equal(d.type, type);
    assert.equal(d.audience, 'Engineers');
    assert.equal(d.include_knowledge, true);
    assert.equal(d.include_decisions, true);
    assert.match(created.workflow.title, new RegExp(`^Document: Payments ${type}`));
    assert.match(created.workflow.goal, new RegExp(`^Documentation request: ${type}`));
    assert.equal(created.workflow.max_iterations, 1, 'a single run');
    assert.equal(created.workflow.playground, true);
    if (type === 'architecture') docA = d.id;

    const done = await settled(d.id);
    const doc = done.document;
    assert.equal(doc.status, 'ready', JSON.stringify(doc));
    assert.equal(doc.error, null);
    assert.equal(doc.version, 1);
    assert.equal(doc.stale, false);
    assert.equal(doc.has_word, true);
    assert.ok(doc.bytes > 1000);
    assert.match(doc.markdown, new RegExp(`^# Payments ${type}\\n`));
    assert.ok(doc.citations.total >= 2, `citations: ${doc.citations.total}`);
    assert.equal(doc.citations.unresolved, 0, JSON.stringify(doc.current.citations.items));
    assert.ok(doc.current.citations.items.some((c: any) => c.ok && c.repo === 'payments' && /^payments\/.+:1$/.test(c.text)));
    assert.ok(doc.current.citations.items.some((c: any) => c.ok && c.path.startsWith('docs/md/')), 'a project document is cited too');
    assert.match(doc.links.word, /format=docx/);
    assert.match(doc.links.markdown, /format=md/);
    assert.equal(done.workflow.status, 'done');
    assert.equal(doc.current.sources.repos[0].slug, 'payments');
    assert.match(doc.current.sources.repos[0].commit, /^[0-9a-f]{40}$/);
    assert.equal(doc.current.sources.knowledge.documents >= 1, true);
    assert.equal(doc.current.sources.decisions, true);

    const dl = await f.admin.req('GET', `${base()}/${d.id}/download`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition') ?? '', /Payments .*\.docx/);
    const z = await unzip(dl.buf!);
    const xml = await z.file('word/document.xml')!.async('string');
    assert.match(xml, new RegExp(`Payments ${type}`));
    assert.match(xml, /<w:pStyle w:val="Title"\/>/, 'the first heading is the Word title');
    assert.match(xml, /<w:pStyle w:val="Heading1"\/>/);
    const md = await f.admin.req('GET', `${base()}/${d.id}/download?format=md`);
    assert.equal(md.status, 200);
    assert.match(md.headers.get('content-type') ?? '', /markdown/);
    assert.equal(md.buf!.toString('utf8'), doc.markdown);
  }
  const list = await f.admin.get(base());
  assert.equal(list.documents.length, 5);
  assert.deepEqual(list.types.map((t: any) => t.id), [...DOC_TYPES]);
  assert.equal(list.word.diagrams, rendererProblem() === null);
  assert.equal(list.template, null);
});

test('stored diagrams are embedded exactly as stored, at the version the document started with', async () => {
  const { document: d } = await f.admin.get(`${base()}/${docA}`);
  assert.ok(d.markdown.includes('```mermaid\n' + diagramMermaid.trim() + '\n```'), 'the stored Mermaid is in the Markdown');
  assert.match(d.markdown, /Demo components diagram/, 'followed by the stored description');
  assert.doesNotMatch(d.markdown, /\{\{diagram:/);
  assert.deepEqual(d.diagrams.map((g: any) => [g.title, g.used_version, g.current_version, g.removed]), [['Payments components', 1, 1, false]]);
  assert.deepEqual(d.current.sources.diagrams.map((g: any) => g.version), [1]);
  assert.equal(d.warnings.some((w: string) => /Mermaid diagram not drawn/.test(w)), rendererProblem() !== null, 'without a headless browser the diagram is a code block with a warning');
  const z = await unzip((await f.admin.req('GET', `${base()}/${docA}/download`)).buf!);
  const xml = await z.file('word/document.xml')!.async('string');
  if (rendererProblem() === null) assert.match(xml, /<w:drawing>/);
  else assert.match(xml, /flowchart TB/);

  // A diagram the agent did not place is added at the end rather than lost.
  const c = await f.admin.post(base(), { type: 'overview', repoIds: [repoId], diagramIds: [diagramId], title: 'Skips diagram [demo-skip-diagram]' });
  const done = await settled(c.document.id);
  assert.match(done.document.markdown, /\n## Diagrams\n\n```mermaid\nflowchart TB/);
  assert.ok(done.document.warnings.some((w: string) => /did not place diagram "Payments components"/.test(w)), JSON.stringify(done.document.warnings));
  await f.admin.del(`${base()}/${c.document.id}`);
});

test('unresolved citations are reported as warnings, not failures; a document with no citations says so', async () => {
  const c = await f.admin.post(base(), { type: 'overview', repoIds: [repoId], title: 'Bad cites [demo-bad-citation]' });
  const done = await settled(c.document.id);
  const d = done.document;
  assert.equal(d.status, 'ready', 'the document is still stored');
  assert.equal(d.has_word, true);
  assert.equal(d.citations.unresolved, 2);
  const bad = d.current.citations.items.filter((x: any) => !x.ok);
  assert.deepEqual(bad.map((x: any) => x.text).sort(), ['payments/README.md:99999', 'payments/src/does/not/exist.py:10']);
  assert.match(bad.find((x: any) => /99999/.test(x.text)).reason, /past the end of the file, which has \d+ lines/);
  assert.match(bad.find((x: any) => /exist\.py/.test(x.text)).reason, /not found in the repository snapshot/);
  assert.match(d.warnings.join('\n'), /2 of \d+ cited locations do not resolve/);
  assert.ok(d.current.citations.items.some((x: any) => x.ok), 'the good ones still resolve');
  await f.admin.del(`${base()}/${d.id}`);

  const n = await f.admin.post(base(), { type: 'overview', repoIds: [repoId], title: 'No cites [demo-no-cite]' });
  const nd = (await settled(n.document.id)).document;
  assert.equal(nd.status, 'ready');
  assert.equal(nd.citations.total, 0);
  assert.match(nd.warnings.join('\n'), /cites no source files/);
  await f.admin.del(`${base()}/${nd.id}`);
});

test('a session that saves nothing, or a stub, ends as an error with the reason', async () => {
  for (const [marker, re] of [
    ['[demo-no-doc]', /without saving a Markdown file/],
    ['[demo-empty-doc]', /document is empty/],
  ] as const) {
    const c = await f.admin.post(base(), { type: 'overview', repoIds: [repoId], title: `Nothing ${marker}` });
    const d = (await settled(c.document.id)).document;
    assert.equal(d.status, 'error', marker);
    assert.match(d.error, re);
    assert.equal(d.version, 0);
    assert.equal(d.links, null);
    assert.equal((await f.admin.req('GET', `${base()}/${d.id}/download`)).status, 400);
    await f.admin.del(`${base()}/${d.id}`);
  }
});

/* ------------------------------------------------------------------ */
/* Word templates                                                      */
/* ------------------------------------------------------------------ */

let brandId = '';

test('the project default Word template is applied: styles, header with logo, footer and page setup are preserved', async () => {
  const up = await templateUp('Brand.dotx', 'Brand', await makeWordTemplate({ dotx: true }));
  assert.equal(up.status, 200, JSON.stringify(up.data));
  brandId = up.data.template.id;
  assert.equal(up.data.template.is_default, true);
  assert.equal(up.data.template.info.mapping.heading1, 'heading 1');
  assert.equal((await f.admin.get(base())).template.name, 'Brand');

  const c = await f.admin.post(base(), { type: 'runbook', repoIds: [repoId], title: 'Branded runbook' });
  assert.equal(c.document.template.requested_name, null, 'nothing was chosen: the default applies when the file is built');
  const d = (await settled(c.document.id)).document;
  assert.equal(d.status, 'ready', JSON.stringify(d));
  assert.equal(d.template.used, 'Brand');
  assert.deepEqual(d.warnings, []);
  const z = await unzip((await f.admin.req('GET', `${base()}/${d.id}/download`)).buf!);
  assert.match(await z.file('word/styles.xml')!.async('string'), /Georgia/);
  const doc = await z.file('word/document.xml')!.async('string');
  assert.doesNotMatch(doc, /SAMPLE COVER TEXT/);
  assert.match(doc, /<w:pgSz w:w="11906" w:h="16838"\/>/, 'the template page size (A4)');
  assert.match(doc, /Branded runbook/);
  assert.match(await z.file('word/header1.xml')!.async('string'), /ACME Corp \| Branded runbook/);
  assert.match(await z.file('word/header1.xml')!.async('string'), /<w:drawing>/);
  assert.match(await z.file('word/footer1.xml')!.async('string'), /instrText[^>]*> PAGE </);
  assert.match(await z.file('[Content_Types].xml')!.async('string'), /wordprocessingml\.document\.main\+xml/);
  assert.equal(JSON.stringify(Object.keys(z.files).filter((n) => /vba|macro/i.test(n))), '[]');
});

test('a chosen template wins over the default; a template that cannot be applied falls back with a warning; a deleted one is reported', async () => {
  const alt = await templateUp('Alt.docx', 'Alt', await makeWordTemplate({ sparse: true }));
  const altId = alt.data.template.id;
  assert.equal(alt.data.template.is_default, false);
  const c = await f.admin.post(base(), { type: 'user-guide', repoIds: [repoId], title: 'Alt guide', templateId: altId });
  assert.equal(c.document.template.requested_name, 'Alt');
  const d = (await settled(c.document.id)).document;
  assert.equal(d.template.used, 'Alt');
  assert.match(d.warnings.join('\n'), /Template "Alt": The template has no style for Title; the built-in look was used for it\./);
  assert.equal(d.has_word, true);

  // A Word file Word could open but this builder cannot use (unusual namespace prefixes): the document is still made.
  const odd = new JSZip();
  odd.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  odd.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  odd.file('word/document.xml', '<doc:document xmlns:doc="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><doc:body/></doc:document>');
  const oddUp = await templateUp('Odd.docx', 'Odd', Buffer.from(await odd.generateAsync({ type: 'uint8array' })));
  assert.equal(oddUp.status, 200, JSON.stringify(oddUp.data));
  const oddId = oddUp.data.template.id;
  const f2 = await f.admin.post(base(), { type: 'overview', repoIds: [repoId], title: 'Odd template doc', templateId: oddId });
  const fd = (await settled(f2.document.id)).document;
  assert.equal(fd.status, 'ready');
  assert.equal(fd.has_word, true, 'the Word file is still produced');
  assert.equal(fd.template.used, null);
  assert.match(fd.warnings.join('\n'), /Odd\.docx|template "Odd\.docx"|namespace prefixes/i);
  assert.match(fd.warnings.join('\n'), /could not be applied/);
  assert.match(fd.warnings.join('\n'), /The template "Odd" was not applied to this document\./);
  const z = await unzip((await f.admin.req('GET', `${base()}/${fd.id}/download`)).buf!);
  assert.doesNotMatch(await z.file('word/styles.xml')!.async('string'), /Georgia/, 'the built-in look');

  // Deleting a chosen template: the next version says so and uses the project default.
  assert.equal((await f.admin.req('DELETE', `/api/projects/${f.pid}/templates/${altId}`)).status, 200);
  const re = await f.admin.post(`${base()}/${d.id}/regenerate`, {});
  assert.equal(re.document.template.requested_name, 'Alt');
  const rd = (await settled(d.id)).document;
  assert.equal(rd.version, 2);
  assert.match(rd.warnings.join('\n'), /template "Alt" no longer exists/);
  assert.equal(rd.template.used, 'Brand');
  // Clearing the choice on regenerate.
  await f.admin.post(`${base()}/${d.id}/regenerate`, { templateId: null });
  const cd = (await settled(d.id)).document;
  assert.equal(cd.version, 3);
  assert.equal(cd.template.requested_id, null);
  assert.deepEqual(cd.warnings, []);
  for (const id of [oddId]) await f.admin.req('DELETE', `/api/projects/${f.pid}/templates/${id}`);
  await f.admin.del(`${base()}/${d.id}`);
  await f.admin.del(`${base()}/${fd.id}`);
});

/* ------------------------------------------------------------------ */
/* Stale tracking and regenerating                                     */
/* ------------------------------------------------------------------ */

test('a document is flagged stale when a repository moves on; regenerating appends a version and older ones stay retrievable', async () => {
  for (const d of (await f.admin.get(base())).documents) if (d.id !== docA) await f.admin.del(`${base()}/${d.id}`);
  const before = (await f.admin.get(`${base()}/${docA}`)).document;
  assert.equal(before.stale, false);
  const v1Md = before.markdown;
  const v1Commit = before.current.sources.repos[0].commit;

  const newHead = commitUpstream('billing.py');
  await syncRepo();
  const stale = (await f.admin.get(`${base()}/${docA}`)).document;
  assert.equal(stale.stale, true);
  assert.match(stale.stale_reasons.join(' '), /Repository "payments" has new commits/);
  assert.equal((await f.admin.get(base())).documents.find((d: any) => d.id === docA).stale, true, 'the list says so too');

  const re = await f.admin.post(`${base()}/${docA}/regenerate`, { audience: 'Auditors' });
  assert.equal(re.document.generating, true);
  assert.equal(re.document.audience, 'Auditors');
  assert.match(re.workflow.goal, /for Auditors\./);
  const done = (await settled(docA)).document;
  assert.equal(done.version, 2);
  assert.equal(done.stale, false);
  assert.deepEqual(done.stale_reasons, []);
  assert.equal(done.current.sources.repos[0].commit, newHead);
  assert.match(done.markdown, /billing\.py/, 'the new version sees the new file');
  assert.deepEqual(done.versions.map((v: any) => v.version), [2, 1]);

  const v1 = await f.admin.get(`${base()}/${docA}/versions/1`);
  assert.equal(v1.current, false);
  assert.equal(v1.version.markdown, v1Md);
  assert.equal(v1.version.sources.repos[0].commit, v1Commit);
  const dlV1 = await f.admin.req('GET', `${base()}/${docA}/download?version=1`);
  assert.equal(dlV1.status, 200);
  assert.match(dlV1.headers.get('content-disposition') ?? '', /-v1\.docx/);
  assert.equal((await f.admin.req('GET', `${base()}/${docA}/versions/9`)).status, 404);
  assert.equal((await f.admin.req('GET', `${base()}/${docA}/download?format=pdf`)).status, 400);
});

test('knowledge documents, the decisions log and diagram versions also make a document stale', async () => {
  assert.equal((await f.admin.get(`${base()}/${docA}`)).document.stale, false);
  await upload('Payments policy.md', '# Payments policy\n\n## Limits\n\nPayments above 9000 need approval.\n');
  const k = (await f.admin.get(`${base()}/${docA}`)).document;
  assert.equal(k.stale, true);
  assert.match(k.stale_reasons.join(' '), /Knowledge document changed: "Payments policy"/);

  await f.admin.req('POST', `/api/projects/${f.pid}/diagrams/${diagramId}/refresh`, {});
  await waitFor(async () => ((await f.admin.get(`/api/projects/${f.pid}/diagrams/${diagramId}`)).diagram.version === 2 ? true : null), 'the diagram to get a second version');
  const g = (await f.admin.get(`${base()}/${docA}`)).document;
  assert.match(g.stale_reasons.join(' '), /Diagram "Payments components" has a newer version \(v2, the document uses v1\)/);
  assert.equal(g.diagrams[0].current_version, 2);

  // The refresh-stale route rewrites it.
  const r = await f.admin.post(`${base()}/refresh-stale`, {});
  assert.equal(r.stale, 1);
  assert.equal(r.started.length, 1);
  assert.equal(r.started[0].docId, docA);
  assert.equal(r.workflows.length, 1);
  const done = (await settled(docA)).document;
  assert.equal(done.version, 3);
  assert.equal(done.stale, false);
  assert.deepEqual(done.diagrams.map((x: any) => x.used_version), [2]);
  const again = await f.admin.post(`${base()}/refresh-stale`, {});
  assert.equal(again.stale, 0);
  assert.equal(again.started.length, 0);
});

test('a loop spec can refresh stale documents (action refresh_docs); with none stale it starts nothing', async () => {
  const bad = await f.admin.req('POST', `/api/projects/${f.pid}/loop-specs`, { name: 'bad', triggerKind: 'manual', triggerConfig: { action: 'format_disk' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Action must be refresh_diagrams or refresh_docs/);

  const { spec } = await f.admin.post(`/api/projects/${f.pid}/loop-specs`, { name: 'Keep docs current', triggerKind: 'manual', triggerConfig: { action: 'refresh_docs', maxPerHour: 0 } });
  assert.equal(spec.trigger_config.action, 'refresh_docs');
  const idle = await f.admin.post(`/api/projects/${f.pid}/loop-specs/${spec.id}/run`, {});
  assert.equal(idle.workflow.id, null);
  assert.equal(idle.workflow.refreshed.stale, 0);
  assert.equal(idle.workflow.refreshed.started.length, 0);

  const newHead = commitUpstream('ledger.py');
  await syncRepo();
  assert.equal((await f.admin.get(`${base()}/${docA}`)).document.stale, true);
  const ran = await f.admin.post(`/api/projects/${f.pid}/loop-specs/${spec.id}/run`, {});
  assert.equal(ran.workflow.refreshed.stale >= 1, true);
  assert.equal(ran.workflow.refreshed.started.some((s: any) => s.docId === docA), true);
  assert.equal(ran.workflow.loop_spec_id, spec.id);
  const done = (await settled(docA)).document;
  assert.equal(done.version, 4);
  assert.equal(done.stale, false);
  assert.equal(done.current.sources.repos[0].commit, newHead);
});

/* ------------------------------------------------------------------ */
/* Access, budget and housekeeping                                     */
/* ------------------------------------------------------------------ */

test('viewers read, list and download; only editors generate, regenerate, refresh and delete; outsiders see nothing', async () => {
  const ok = [
    base(),
    `${base()}/${docA}`,
    `${base()}/${docA}/versions/1`,
    `${base()}/${docA}/download`,
    `${base()}/${docA}/download?format=md`,
  ];
  for (const url of ok) assert.equal((await f.viewer.req('GET', url)).status, 200, url);
  for (const [method, url] of [
    ['POST', base()],
    ['POST', `${base()}/refresh-stale`],
    ['POST', `${base()}/${docA}/regenerate`],
    ['DELETE', `${base()}/${docA}`],
  ] as const) {
    const r = await f.viewer.req(method, url, method === 'POST' ? { type: 'overview', repoIds: [repoId] } : undefined);
    assert.equal(r.status, 403, `${method} ${url}`);
  }
  for (const url of [base(), `${base()}/${docA}`, `${base()}/${docA}/download`]) assert.equal((await f.outsider.req('GET', url)).status, 404, url);
  assert.equal((await f.outsider.req('POST', base(), { type: 'overview', repoIds: [repoId] })).status, 404);
  const other = (await f.admin.post('/api/projects', { name: 'Elsewhere 2', description: 'd' })).project.id;
  assert.equal((await f.admin.req('GET', `/api/projects/${other}/generated-docs/${docA}`)).status, 404, 'a document belongs to its project');
  const anon = await fetch(`${f.srv.base}${base()}`);
  assert.equal(anon.status, 401);
});

test('the budget and concurrency checks of any session apply: a busy user is queued', async () => {
  const { updateSettings } = await import('../server/settings.ts');
  const { run: dbRun } = await import('../server/db.ts');
  const me = (await f.admin.get('/api/auth/me')).user;
  const caps = (perUserMax: number) => ({ controlPlane: { perUserMax, globalMax: 0, perProjectMax: 0, approvalSlaMinutes: 30, worktreeTtlDays: 30, drainTimeoutSeconds: 60 } });
  updateSettings(caps(1));
  const wid = `w_busy_${Date.now()}`;
  dbRun(
    "INSERT INTO workflows (id, project_id, title, goal, status, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'busy', 'goal', 'running', '', 'sonnet', 5, 8, '', '', 0, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
    wid, f.pid, me.id,
  );
  try {
    const q = await f.admin.post(base(), { type: 'overview', repoIds: [repoId], title: 'Has to wait' });
    assert.equal(q.workflow.status, 'queued');
    assert.equal(q.document.queued, true);
    assert.equal(q.document.generating, true);
    assert.equal((await f.admin.req('DELETE', `${base()}/${q.document.id}`)).status, 400, 'a document that is being written cannot be deleted');
    const again = await f.admin.req('POST', `${base()}/${q.document.id}/regenerate`, {});
    assert.equal(again.status, 400);
    assert.match(again.data.error, /already being written/);
  } finally {
    dbRun('DELETE FROM workflows WHERE id = ?', wid);
    updateSettings(caps(5));
  }
});

test('delete removes the document, its versions and Word files; actions are audited', async () => {
  const dir = path.join(f.srv.dataDir, 'generated-docs', f.pid);
  const names = fs.readdirSync(dir).filter((n) => n.startsWith(`${docA}-v`));
  assert.ok(names.length >= 4, `Word files of every version are kept: ${names}`);
  assert.equal((await f.admin.del(`${base()}/${docA}`)).ok, true);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith(`${docA}-v`)).length, 0);
  assert.equal((await f.admin.req('GET', `${base()}/${docA}`)).status, 404);
  const { all, one } = await import('../server/db.ts');
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM generated_doc_versions WHERE doc_id = ?', docA)?.n, 0);
  const actions = all<{ action: string }>("SELECT DISTINCT action FROM audit_log WHERE action LIKE 'gendoc.%'").map((r) => r.action);
  for (const a of ['gendoc.create', 'gendoc.regenerate', 'gendoc.version', 'gendoc.download', 'gendoc.delete']) assert.ok(actions.includes(a), `${a} audited: ${actions.join(',')}`);
  const { entries } = await f.admin.get('/api/admin/audit-log?action=gendoc.version&limit=100');
  assert.ok(entries.some((e: any) => /"ok":false/.test(typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail))), 'failed attempts are recorded too');
  void brandId;
  void projectDir;
});
