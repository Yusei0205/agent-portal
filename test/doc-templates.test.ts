import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { makeTemplate, PNG_1X1 } from './pptx-fixtures.ts';
import { generate, DocError } from '../server/docgen.ts';
import { checkTemplateUpload, TemplateError } from '../server/template-check.ts';
import { deckOutline } from '../server/pptx-preview.ts';
import { toMarkdown } from '../server/convert.ts';
import { bootWorkflowFixture, type WorkflowFixture } from './workflows-fixture.ts';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-test-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

const unzip = async (file: string) => JSZip.loadAsync(fs.readFileSync(file));
const text = async (z: JSZip, name: string) => z.file(name)!.async('string');

/* ------------------------------------------------------------------ */
/* Upload checks                                                       */
/* ------------------------------------------------------------------ */

test('upload check: accepts .pptx and .potx and describes the template', async () => {
  for (const [ext, potx] of [['.pptx', false], ['.potx', true]] as const) {
    const c = await checkTemplateUpload(await makeTemplate({ potx }), `Brand deck${ext}`);
    assert.equal(c.kind, 'pptx');
    assert.equal(c.ext, ext);
    assert.equal(c.info.slideWidthIn, 10);
    assert.equal(c.info.slideHeightIn, 7.5);
    assert.deepEqual(c.info.fonts, { major: 'Georgia', minor: 'Verdana' });
    assert.equal(c.info.colors?.accent1, 'C0392B');
    assert.deepEqual(c.info.layouts?.map((l) => l.name), ['Title Slide', 'Title and Content', 'Title Only', 'Section Header']);
    assert.deepEqual(c.info.mapping, { title: 'Title Slide', section: 'Section Header', content: 'Title and Content', titleOnly: 'Title Only', side: null });
    assert.deepEqual(c.info.warnings, []);
  }
});

test('upload check: refuses macros, old formats, non-OOXML files, wrong kinds and oversize files', async () => {
  const bad = async (buf: Buffer, name: string, re: RegExp) => {
    await assert.rejects(checkTemplateUpload(buf, name), (e: any) => e instanceof TemplateError && re.test(e.message), `${name}: ${re}`);
  };
  const good = await makeTemplate();
  await bad(good, 'brand.pptm', /not accepted.*macro/i);
  await bad(good, 'brand.potm', /not accepted/i);
  await bad(good, 'brand.docm', /not accepted/i);
  await bad(good, 'brand.ppt', /not accepted/i);
  await bad(good, 'brand.txt', /Only Word/i);
  await bad(good, 'brand', /needs a name that ends in/i);
  await bad(await makeTemplate({ macro: true }), 'brand.pptx', /macros or ActiveX/i);
  await bad(Buffer.from('this is plain text, not an Office file'), 'brand.pptx', /not a real Office file/i);
  await bad(Buffer.alloc(0), 'brand.pptx', /empty/i);

  // A zip that is not an Office package.
  const z = new JSZip();
  z.file('hello.txt', 'hi');
  await bad(Buffer.from(await z.generateAsync({ type: 'uint8array' })), 'brand.pptx', /Content_Types/);

  // A Word file with a PowerPoint name, and the reverse.
  const word = new JSZip();
  word.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  word.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  word.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>');
  const wordBuf = Buffer.from(await word.generateAsync({ type: 'uint8array' }));
  await bad(wordBuf, 'brand.pptx', /not a PowerPoint/i);
  await bad(good, 'brand.docx', /not a Word/i);
  const okWord = await checkTemplateUpload(wordBuf, 'letter.dotx');
  assert.equal(okWord.kind, 'docx');

  // A Word file that carries a macro project is refused even with a clean name.
  word.file('word/vbaProject.bin', 'x');
  await bad(Buffer.from(await word.generateAsync({ type: 'uint8array' })), 'letter.docx', /macros or ActiveX/i);

  // Only unusable layouts.
  await bad(await makeTemplate({ layouts: ['secHead'] }), 'brand.pptx', /no usable layouts/i);

  // A zip bomb: tiny on disk, far too large expanded.
  const bomb = new JSZip();
  bomb.file('ppt/huge.bin', Buffer.alloc(120 * 1024 * 1024));
  await bad(Buffer.from(await bomb.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })), 'brand.pptx', /too large/);

  // Size cap (25 MB): a zip signature is enough to get that far.
  const big = Buffer.alloc(26 * 1024 * 1024);
  big.writeUInt32LE(0x04034b50, 0);
  await bad(big, 'brand.pptx', /larger than 25 MB/);
});

test('upload check: a template without a title layout is accepted with a warning', async () => {
  const c = await checkTemplateUpload(await makeTemplate({ layouts: ['obj', 'titleOnly'] }), 'plain.pptx');
  assert.equal(c.info.mapping?.title, null);
  assert.match(c.info.warnings.join(' '), /No title-slide layout/);
});

/* ------------------------------------------------------------------ */
/* Filling a template with make-doc                                    */
/* ------------------------------------------------------------------ */

const SLIDES = [
  { layout: 'title' as const, title: 'Refund programme', subtitle: 'Finance, Q4', notes: 'Welcome everyone.' },
  { title: 'Goals', bullets: ['Cut handling time', 'Fewer escalations & rework'], notes: 'Say this slowly.' },
  { layout: 'section' as const, title: 'Controls', subtitle: 'How approvals work' },
  { layout: 'table' as const, title: 'Limits', table: { header: ['Role', 'Limit'], rows: [['Agent', '100'], ['Manager', '5000']] } },
];

test('a deck made from a template keeps its theme, slide size, master, layouts and logo', async () => {
  const dir = fs.mkdtempSync(path.join(work, 'a-'));
  const tpl = await makeTemplate({ potx: true });
  fs.writeFileSync(path.join(dir, 'brand.potx'), tpl);
  const r = await generate({ type: 'pptx', output: 'out/deck.pptx', title: 'Refund deck', template: 'brand.potx', slides: SLIDES }, { baseDir: dir });
  assert.equal(r.template, 'brand.potx');
  assert.equal(r.warnings, undefined, JSON.stringify(r.warnings));
  assert.match(r.summary, /template: brand\.potx/);

  const src = await JSZip.loadAsync(tpl);
  const z = await unzip(r.output);
  const pres = await text(z, 'ppt/presentation.xml');
  assert.match(pres, /<p:sldSz cx="9144000" cy="6858000"/, 'the template slide size (4:3) is kept, not 16:9');
  assert.equal(pres.match(/<p:sldId /g)?.length, 4);

  for (const part of ['ppt/theme/theme1.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/slideLayouts/slideLayout2.xml', 'ppt/slideLayouts/slideLayout3.xml', 'ppt/slideLayouts/slideLayout4.xml', 'ppt/media/logo.png']) {
    assert.deepEqual(await z.file(part)!.async('uint8array'), await src.file(part)!.async('uint8array'), `${part} is untouched`);
  }
  assert.match(await text(z, 'ppt/theme/theme1.xml'), /Georgia/);

  // The template's sample slide and what only it used are gone; the main part is a presentation, not a template.
  const names = Object.keys(z.files);
  assert.ok(!names.includes('ppt/media/sample-only.png'));
  assert.ok(!names.includes('docProps/thumbnail.jpeg'));
  for (const n of names.filter((x) => x.endsWith('.xml'))) assert.doesNotMatch(await text(z, n), /SAMPLE SLIDE TO DROP/);
  const ct = await text(z, '[Content_Types].xml');
  assert.match(ct, /presentation\.main\+xml/);
  assert.doesNotMatch(ct, /template\.main\+xml/);
  assert.match(await text(z, 'docProps/core.xml'), /<dc:title>Refund deck<\/dc:title>/);

  // Each slide points at the template layout for its role.
  const layoutOf = async (n: number) => /slideLayout(\d+)\.xml/.exec(await text(z, `ppt/slides/_rels/slide${n}.xml.rels`))![1];
  assert.equal(await layoutOf(1), '1', 'title slide -> Title Slide');
  assert.equal(await layoutOf(2), '2', 'bullets -> Title and Content');
  assert.equal(await layoutOf(3), '4', 'section -> Section Header');
  assert.equal(await layoutOf(4), '3', 'table -> Title Only');

  // Slides inherit fonts and colours: they name placeholders, not typefaces or colours.
  const s2 = await text(z, 'ppt/slides/slide2.xml');
  assert.match(s2, /<p:ph type="title"\/>/);
  assert.match(s2, /<p:ph idx="1"\/>/);
  assert.match(s2, /Fewer escalations &amp; rework/);
  assert.match(s2, /type="sldNum"/, 'the layout slide number is carried over');
  for (const n of [1, 2, 3]) {
    const s = await text(z, `ppt/slides/slide${n}.xml`);
    assert.doesNotMatch(s, /typeface=|srgbClr|latin/, `slide ${n} sets no fonts or colours`);
  }
  assert.match(await text(z, 'ppt/slides/slide1.xml'), /<p:ph type="ctrTitle"\/>/);
  assert.match(await text(z, 'ppt/slides/slide1.xml'), /<p:ph type="subTitle" idx="1"\/>/);
  assert.match(await text(z, 'ppt/slides/slide4.xml'), /<a:tbl>.*Manager.*5000/s);

  // Notes: a notes master was added and the notes slides carry the text.
  assert.ok(names.includes('ppt/notesMasters/notesMaster1.xml'));
  assert.match(await text(z, 'ppt/notesSlides/notesSlide1.xml'), /Welcome everyone\./);
  assert.ok(!names.includes('ppt/notesSlides/notesSlide3.xml'), 'no notes, no notes slide');

  // It reads back as a deck, and the portal's own reader sees titles and notes.
  const outline = await deckOutline(fs.readFileSync(r.output));
  assert.deepEqual(outline.map((o) => o.title), ['Refund programme', 'Goals', 'Controls', 'Limits']);
  assert.deepEqual(outline.map((o) => o.layout), ['Title Slide', 'Title and Content', 'Section Header', 'Title Only']);
  assert.equal(outline[1].notes, 'Say this slowly.');
  assert.equal(outline[3].hasTable, true);
  const md = await toMarkdown('deck.pptx', fs.readFileSync(r.output));
  assert.match(md, /Goals/);
});

test('make-doc follows the project default template without being told, and false turns it off', async () => {
  const dir = fs.mkdtempSync(path.join(work, 'b-'));
  fs.mkdirSync(path.join(dir, '.portal/templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.portal/templates/default-pptx.pptx'), await makeTemplate());
  fs.writeFileSync(path.join(dir, '.portal/templates/defaults.json'), JSON.stringify({ pptx: { id: 'tp_1', name: 'Corporate', scope: 'project', path: '.portal/templates/default-pptx.pptx' } }));
  const auto = await generate({ type: 'pptx', output: 'auto.pptx', slides: SLIDES }, { baseDir: dir });
  assert.equal(auto.template, 'Corporate');
  assert.match(await text(await unzip(auto.output), 'ppt/presentation.xml'), /cx="9144000"/);

  const plain = await generate({ type: 'pptx', output: 'plain.pptx', template: false, slides: SLIDES }, { baseDir: dir });
  assert.equal(plain.template, undefined);
  assert.equal(plain.warnings, undefined);
  assert.match(await text(await unzip(plain.output), 'ppt/presentation.xml'), /cx="12192000"/, 'the built-in look is 16:9');

  const report = JSON.parse(fs.readFileSync(`${auto.output}.report.json`, 'utf8'));
  assert.equal(report.template, 'Corporate');
  assert.equal(JSON.parse(fs.readFileSync(`${plain.output}.report.json`, 'utf8')).template, null);
});

test('a template that cannot be applied falls back to the built-in look with a warning', async () => {
  const dir = fs.mkdtempSync(path.join(work, 'c-'));
  const cases: [string, Buffer, RegExp][] = [
    ['garbage.pptx', Buffer.from('not a zip at all'), /could not be applied/],
    ['nolayouts.pptx', await makeTemplate({ layouts: ['secHead'] }), /could not be applied.*no usable title or content layout/],
  ];
  for (const [name, buf, re] of cases) {
    fs.writeFileSync(path.join(dir, name), buf);
    const r = await generate({ type: 'pptx', output: `${name}.out.pptx`, template: name, slides: SLIDES }, { baseDir: dir });
    assert.equal(r.template, undefined, name);
    assert.ok(r.warnings?.some((w) => re.test(w) && w.includes(name)), `${name}: ${JSON.stringify(r.warnings)}`);
    assert.match(await text(await unzip(r.output), 'ppt/presentation.xml'), /cx="12192000"/, `${name}: the deck was still made`);
  }
  const missing = await generate({ type: 'pptx', output: 'missing.out.pptx', template: 'nope.pptx', slides: SLIDES }, { baseDir: dir });
  assert.match(missing.warnings?.join(' ') ?? '', /nope\.pptx.*could not be used.*file not found/);
  const wrongExt = await generate({ type: 'pptx', output: 'ext.out.pptx', template: 'garbage.txt', slides: SLIDES }, { baseDir: dir });
  assert.match(wrongExt.warnings?.join(' ') ?? '', /must be a \.pptx or \.potx/);
  const escape = await generate({ type: 'pptx', output: 'esc.out.pptx', template: '../outside.pptx', slides: SLIDES }, { baseDir: dir });
  assert.match(escape.warnings?.join(' ') ?? '', /must be inside/);
  await assert.rejects(generate({ type: 'pptx', output: 'x.pptx', template: 5 as any, slides: SLIDES }, { baseDir: dir }), DocError);
});

test('layouts are mapped with fallbacks, and the fallbacks are reported', async () => {
  const dir = fs.mkdtempSync(path.join(work, 'd-'));
  fs.writeFileSync(path.join(dir, 'min.pptx'), await makeTemplate({ layouts: ['obj'] }));
  const r = await generate({ type: 'pptx', output: 'min.out.pptx', template: 'min.pptx', slides: SLIDES }, { baseDir: dir });
  assert.equal(r.template, 'min.pptx');
  const w = r.warnings?.join('\n') ?? '';
  assert.match(w, /no title layout/);
  assert.match(w, /no section layout/);
  assert.match(w, /no "title only" layout/);
  const z = await unzip(r.output);
  for (const n of [1, 2, 3, 4]) assert.match(await text(z, `ppt/slides/_rels/slide${n}.xml.rels`), /slideLayout1\.xml/, 'everything uses the one layout');
});

test('tables continue over extra slides, and pictures and diagrams are placed inside the layout', async () => {
  const dir = fs.mkdtempSync(path.join(work, 'e-'));
  fs.writeFileSync(path.join(dir, 'brand.pptx'), await makeTemplate());
  fs.writeFileSync(path.join(dir, 'logo.png'), PNG_1X1);
  const rows = Array.from({ length: 30 }, (_, i) => [`Row ${i + 1}`, String(i)]);
  const r = await generate(
    {
      type: 'pptx',
      output: 'mix.pptx',
      template: 'brand.pptx',
      slides: [
        { layout: 'table', title: 'Big table', table: { header: ['Name', 'Value'], rows }, notes: 'n' },
        { layout: 'image', title: 'A picture', image: { path: 'logo.png', alt: 'The logo', caption: 'Figure 1' } },
        { title: 'Beside', bullets: ['One', 'Two'], image: { path: 'logo.png', alt: 'Side picture' } },
        { title: 'Diagram', mermaid: { source: 'flowchart LR\n A --> B', caption: 'Flow' } },
      ],
    },
    { baseDir: dir },
  );
  const z = await unzip(r.output);
  const outline = await deckOutline(fs.readFileSync(r.output));
  assert.deepEqual(outline.slice(0, 3).map((o) => o.title), ['Big table', 'Big table (cont.)', 'Big table (cont.)']);
  assert.equal(outline[0].notes, 'n');
  assert.equal(outline[1].notes, 'n', 'a continued slide keeps the notes');
  for (const n of [1, 2, 3]) assert.match(await text(z, `ppt/slides/slide${n}.xml`), /<a:tc>.*Name/s, 'the header repeats');
  assert.equal((await text(z, 'ppt/slides/slide1.xml')).match(/<a:tr /g)?.length, 13, 'header plus 12 rows');

  const pic = await text(z, 'ppt/slides/slide4.xml');
  assert.match(pic, /<p:pic>.*descr="The logo"/s);
  assert.match(pic, /Figure 1/);
  assert.ok(Object.keys(z.files).some((n) => /^ppt\/media\/image-p\d+\.png$/.test(n)));
  assert.match(await text(z, '[Content_Types].xml'), /Extension="png"/);

  const side = await text(z, 'ppt/slides/slide5.xml');
  assert.match(side, /<p:ph idx="1"\/>/);
  assert.match(side, /<p:spPr><a:xfrm>/, 'the text placeholder is narrowed to make room for the picture');
  assert.match(side, /<p:pic>.*Side picture/s);

  // The diagram: drawn when a headless browser exists, else its source is shown with a warning.
  const diagram = await text(z, 'ppt/slides/slide6.xml');
  assert.ok(/<p:pic>/.test(diagram) || (/flowchart LR/.test(diagram) && /Diagram not drawn/.test(diagram) && r.warnings?.some((x) => /Mermaid diagram not drawn/.test(x))));
});

test('CLI flags: --template picks a template and --no-template turns the default off', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(work, 'f-'));
  fs.writeFileSync(path.join(dir, 'brand.pptx'), await makeTemplate());
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ type: 'pptx', output: 'cli.pptx', slides: SLIDES }));
  const tsx = import.meta.resolve('tsx');
  const cli = path.resolve(import.meta.dirname, '../server/docgen-cli.ts');
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['--import', tsx, cli, 'spec.json', ...args], { cwd: dir, encoding: 'utf8' }));
  assert.equal(run('--template', 'brand.pptx').template, 'brand.pptx');
  assert.equal(run('--no-template').template, undefined);
  assert.throws(() => execFileSync(process.execPath, ['--import', tsx, cli, 'spec.json', '--template'], { cwd: dir, stdio: 'pipe' }), /--template needs/);
});

/* ------------------------------------------------------------------ */
/* The template store (API)                                            */
/* ------------------------------------------------------------------ */

let f: WorkflowFixture;
let projectDir: string;
before(async () => {
  f = await bootWorkflowFixture();
  const { project } = await f.admin.get(`/api/projects/${f.pid}`);
  projectDir = path.join(f.srv.dataDir, 'projects', project.slug);
});
after(async () => {
  await f.srv.close();
});

const base = () => `/api/projects/${f.pid}/templates`;
const upload = (url: string, buf: Buffer, filename: string, extra = '') => f.admin.req('POST', `${url}?filename=${encodeURIComponent(filename)}${extra}`, undefined, { raw: buf });

test('store: an editor uploads a project template; it is the default and nothing leaks its location', async () => {
  const empty = await f.admin.get(base());
  assert.deepEqual(empty.templates, []);
  assert.deepEqual(empty.effective, { pptx: null, docx: null });
  assert.equal(empty.limits.bytes, 25 * 1024 * 1024);

  const r = await upload(base(), await makeTemplate({ potx: true }), 'Brand 2026.potx', '&name=Brand%202026');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const t = r.data.template;
  assert.equal(t.kind, 'pptx');
  assert.equal(t.scope, 'project');
  assert.equal(t.name, 'Brand 2026');
  assert.equal(t.filename, 'Brand 2026.potx');
  assert.equal(t.is_default, true, 'the first template of a kind becomes the default');
  assert.equal(t.effective, true);
  assert.equal(t.uploaded_by_name, 'Ann');
  assert.equal(t.info.mapping.title, 'Title Slide');
  assert.equal(r.data.effective.pptx.id, t.id);

  const json = JSON.stringify(r.data);
  assert.ok(!json.includes(f.srv.dataDir) && !json.includes('sha256') && !json.includes('stored'), 'no path, hash or stored name in the view');
  assert.deepEqual(Object.keys(t).filter((k) => /path|file$|stored|sha/.test(k)), []);
});

test('store: refused uploads say why and leave nothing behind', async () => {
  const before = (await f.admin.get(base())).templates.length;
  const cases: [Buffer, string, RegExp][] = [
    [await makeTemplate({ macro: true }), 'x.pptx', /macros or ActiveX/],
    [await makeTemplate(), 'x.pptm', /not accepted/],
    [Buffer.from('plain text'), 'x.pptx', /not a real Office file/],
    [Buffer.alloc(0), 'x.pptx', /empty/],
  ];
  for (const [buf, name, re] of cases) {
    const r = await upload(base(), buf, name);
    assert.equal(r.status, 400, name);
    assert.match(r.data.error, re);
  }
  const noName = await f.admin.req('POST', base(), undefined, { raw: await makeTemplate() });
  assert.equal(noName.status, 400);
  assert.equal((await f.admin.get(base())).templates.length, before);
});

test('store: viewers read and download, only editors change, outsiders see nothing', async () => {
  const list = await f.viewer.get(base());
  assert.equal(list.templates.length, 1);
  const id = list.templates[0].id;
  const dl = await f.viewer.req('GET', `${base()}/${id}/download`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition') ?? '', /Brand 2026\.potx/);
  assert.equal(dl.buf![0], 0x50);
  assert.equal((await upload(base(), await makeTemplate(), 'v.pptx')).status, 200, 'admin is an owner');
  const viewerUpload = await f.viewer.req('POST', `${base()}?filename=v.pptx`, undefined, { raw: await makeTemplate() });
  assert.equal(viewerUpload.status, 403);
  assert.equal((await f.viewer.req('PATCH', `${base()}/${id}`, { name: 'x' })).status, 403);
  assert.equal((await f.viewer.req('DELETE', `${base()}/${id}`)).status, 403);
  assert.equal((await f.outsider.req('GET', base())).status, 404);
  assert.equal((await f.outsider.req('GET', `${base()}/${id}/download`)).status, 404);
  // Clean up the second upload.
  const all = (await f.admin.get(base())).templates;
  await f.admin.del(`${base()}/${all.find((t: any) => t.id !== id).id}`);
});

test('resolution: project default, else portal default, else none', async () => {
  const { resolveTemplate } = await import('../server/doc-templates.ts');
  const projectTpl = (await f.admin.get(base())).templates[0];
  assert.equal(resolveTemplate(f.pid, 'pptx')!.id, projectTpl.id, 'project wins');
  assert.equal(resolveTemplate(f.pid, 'docx'), null, 'nothing for Word yet');

  // Only admins manage the portal default.
  const portalBuf = await makeTemplate({ layouts: ['title', 'obj', 'titleOnly'] });
  assert.equal((await f.viewer.req('POST', '/api/templates?filename=p.pptx', undefined, { raw: portalBuf })).status, 403);
  const made = await upload('/api/templates', portalBuf, 'Portal look.pptx', '&name=Portal%20look');
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const portal = made.data.template;
  assert.equal(portal.scope, 'portal');
  assert.equal(portal.is_default, true);
  assert.equal(resolveTemplate(f.pid, 'pptx')!.id, projectTpl.id, 'the project template still wins');

  // The project sees both and which one applies.
  const seen = await f.viewer.get(base());
  assert.deepEqual(seen.templates.map((t: any) => [t.scope, t.effective]).sort(), [['portal', false], ['project', true]]);
  assert.equal(seen.effective.pptx.scope, 'project');

  // A portal template cannot be changed from a project.
  assert.equal((await f.admin.req('PATCH', `${base()}/${portal.id}`, { name: 'x' })).status, 403);
  assert.equal((await f.admin.req('DELETE', `${base()}/${portal.id}`)).status, 403);

  // Take the project default away: the portal default applies.
  await f.admin.patch(`${base()}/${projectTpl.id}`, { isDefault: false });
  assert.equal(resolveTemplate(f.pid, 'pptx')!.id, portal.id);
  assert.equal((await f.viewer.get(base())).effective.pptx.scope, 'portal');
  // Another project with no templates of its own gets the portal default too.
  const other = (await f.admin.post('/api/projects', { name: 'Other', description: 'd' })).project.id;
  assert.equal(resolveTemplate(other, 'pptx')!.id, portal.id);
  assert.equal((await f.admin.get(`/api/projects/${other}/templates`)).effective.pptx.id, portal.id);

  // Put it back; one default per kind and scope.
  await f.admin.patch(`${base()}/${projectTpl.id}`, { isDefault: true });
  const second = (await upload(base(), await makeTemplate(), 'Second.pptx', '&default=1')).data.template;
  const list = (await f.admin.get(base())).templates.filter((t: any) => t.scope === 'project');
  assert.deepEqual(list.map((t: any) => [t.name, t.is_default]).sort(), [['Brand 2026', false], ['Second', true]]);
  assert.equal(resolveTemplate(f.pid, 'pptx')!.id, second.id);

  // Delete the project templates: portal again; delete the portal one: none.
  for (const t of list) await f.admin.del(`${base()}/${t.id}`);
  assert.equal(resolveTemplate(f.pid, 'pptx')!.id, portal.id);
  assert.equal((await f.viewer.req('DELETE', `/api/templates/${portal.id}`)).status, 403);
  await f.admin.del(`/api/templates/${portal.id}`);
  assert.equal(resolveTemplate(f.pid, 'pptx'), null);
  assert.deepEqual((await f.admin.get(base())).effective, { pptx: null, docx: null });
});

test('the portal list is readable by anyone signed in, and its files are downloadable', async () => {
  const made = (await upload('/api/templates', await makeTemplate(), 'Shared.pptx')).data.template;
  const list = await f.outsider.get('/api/templates');
  assert.deepEqual(list.templates.map((t: any) => t.name), ['Shared']);
  const dl = await f.outsider.req('GET', `/api/templates/${made.id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.buf!.length, made.size);
  await f.admin.patch(`/api/templates/${made.id}`, { name: 'Shared look' });
  assert.equal((await f.outsider.get('/api/templates')).templates[0].name, 'Shared look');
  await f.admin.del(`/api/templates/${made.id}`);
});

test('runs get the templates that apply: copied into the project folder for make-doc, never into git', async () => {
  const dir = path.join(projectDir, '.portal/templates');
  const t = (await upload(base(), await makeTemplate({ potx: true }), 'Run look.potx', '&name=Run%20look')).data.template;
  const defaults = JSON.parse(fs.readFileSync(path.join(dir, 'defaults.json'), 'utf8'));
  assert.equal(defaults.pptx.name, 'Run look');
  assert.equal(defaults.pptx.scope, 'project');
  assert.equal(defaults.pptx.path, '.portal/templates/default-pptx.potx');
  assert.ok(fs.existsSync(path.join(projectDir, defaults.pptx.path)));
  assert.match(fs.readFileSync(path.join(projectDir, '.git/info/exclude'), 'utf8'), /\.portal\//);

  // make-doc, run in the project folder with no flags, follows it.
  const r = await generate({ type: 'pptx', output: 'work/deck.pptx', slides: SLIDES }, { baseDir: projectDir });
  assert.equal(r.template, 'Run look');
  assert.match(await text(await unzip(r.output), 'ppt/presentation.xml'), /cx="9144000"/);

  await f.admin.del(`${base()}/${t.id}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'defaults.json'), 'utf8')), {});
  assert.ok(!fs.existsSync(path.join(projectDir, defaults.pptx.path)), 'the copy goes with the template');
  const after = await generate({ type: 'pptx', output: 'work/deck2.pptx', slides: SLIDES }, { baseDir: projectDir });
  assert.equal(after.template, undefined, 'no template: the built-in look');
});

test('template actions are audited', async () => {
  const rows = (await import('../server/db.ts')).all<{ action: string }>("SELECT DISTINCT action FROM audit_log WHERE action LIKE 'template.%'");
  const actions = rows.map((r) => r.action);
  for (const a of ['template.create', 'template.update', 'template.delete', 'template.download']) assert.ok(actions.includes(a), `${a} audited: ${actions.join(',')}`);
});
