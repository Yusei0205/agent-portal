import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { makeWordTemplate } from './docx-fixtures.ts';
import { PNG_1X1 } from './pptx-fixtures.ts';
import { generate, DocError, type DocSpec } from '../server/docgen.ts';
import { checkTemplateUpload, TemplateError } from '../server/template-check.ts';
import { parseXml } from '../server/ooxml.ts';
import { toMarkdown } from '../server/convert.ts';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wordtpl-test-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

const unzip = async (file: string) => JSZip.loadAsync(fs.readFileSync(file));
const text = async (z: JSZip, name: string) => z.file(name)!.async('string');

const MD = [
  '# Payments service',
  '',
  'Intro with **bold**, `code` and a [link](https://example.com/docs).',
  '',
  '## Components',
  '',
  '- First bullet',
  '- Second bullet',
  '  - Nested bullet',
  '',
  '1. Step one',
  '2. Step two',
  '',
  '### Detail',
  '',
  '| Role | Limit |',
  '|---|---|',
  '| Agent | 100 |',
  '',
  '```',
  'const x = 1;',
  '```',
  '',
  '![Logo](logo.png "Figure 1")',
  '',
  '## Next',
  '',
  '1. Again one',
  '2. Again two',
].join('\n');

const spec = (output: string, extra: Partial<Extract<DocSpec, { type: 'docx' }>> = {}): DocSpec => ({ type: 'docx', output, markdown: MD, titleFromHeading: true, ...extra });

function setup(): string {
  const dir = fs.mkdtempSync(path.join(work, 'w-'));
  fs.writeFileSync(path.join(dir, 'logo.png'), PNG_1X1);
  return dir;
}

test('upload check: a Word template is described, macros are refused, missing styles are reported', async () => {
  const c = await checkTemplateUpload(await makeWordTemplate({ dotx: true }), 'Brand.dotx');
  assert.equal(c.kind, 'docx');
  assert.equal(c.ext, '.dotx');
  assert.equal(c.info.pageWidthIn, 8.27);
  assert.equal(c.info.pageHeightIn, 11.69);
  assert.equal(c.info.header, true);
  assert.equal(c.info.footer, true);
  assert.equal(c.info.mapping?.title, 'Title');
  assert.equal(c.info.mapping?.heading1, 'heading 1');
  assert.equal(c.info.mapping?.bullets, 'List Bullet');
  assert.equal(c.info.mapping?.table, 'Table Grid');
  assert.deepEqual(c.info.warnings, []);

  const sparse = await checkTemplateUpload(await makeWordTemplate({ sparse: true }), 'Sparse.docx');
  assert.match(sparse.info.warnings.join(' '), /no style for: Title, Heading 3/);
  assert.match(sparse.info.warnings.join(' '), /no table style/);

  await assert.rejects(checkTemplateUpload(await makeWordTemplate({ macro: true }), 'Brand.docx'), (e) => e instanceof TemplateError && /macros or ActiveX/.test(e.message));
  await assert.rejects(checkTemplateUpload(await makeWordTemplate(), 'Brand.docm'), /not accepted/);
});

test('a .dotx template is applied: its styles, page setup, header and footer carry over, the body is the new content', async () => {
  const dir = setup();
  fs.writeFileSync(path.join(dir, 'brand.dotx'), await makeWordTemplate({ dotx: true }));
  const r = await generate(spec('out.docx', { template: 'brand.dotx' }), { baseDir: dir });
  assert.equal(r.template, 'brand.dotx');
  assert.deepEqual(r.warnings ?? [], []);
  assert.match(r.summary, /template: brand\.dotx/);

  const z = await unzip(r.output);
  // Every XML part is well formed.
  for (const n of Object.keys(z.files).filter((f) => /\.(xml|rels)$/.test(f))) parseXml(await text(z, n));

  // It is a document now, not a template.
  assert.match(await text(z, '[Content_Types].xml'), /PartName="\/word\/document\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document\.main\+xml"/);

  // Styles stay the template's: its fonts and colours, nothing from the built-in set.
  const styles = await text(z, 'word/styles.xml');
  assert.match(styles, /Georgia/);
  assert.match(styles, /C0392B/);

  const doc = await text(z, 'word/document.xml');
  assert.doesNotMatch(doc, /SAMPLE COVER TEXT/, 'the template body was replaced');
  assert.match(doc, /<w:pStyle w:val="Title"\/>[\s\S]*?Payments service/, 'the first heading became the title');
  assert.match(doc, /<w:pStyle w:val="Heading1"\/>[\s\S]*?Components/, 'the other headings moved up one level');
  assert.match(doc, /<w:pStyle w:val="Heading2"\/>[\s\S]*?Detail/);
  assert.match(doc, /<w:pStyle w:val="ListBullet"\/>/, 'bullets use the template list style');
  assert.match(doc, /<w:pStyle w:val="ListNumber"\/>/);
  assert.match(doc, /<w:tblStyle w:val="TableGrid"\/>/);
  assert.match(doc, /<w:tblLook /);
  assert.match(doc, /<w:pStyle w:val="Caption"\/>[\s\S]*?Figure 1/);
  assert.doesNotMatch(doc, /1155CC/, 'hyperlinks follow the template colour');
  assert.match(doc, /<w:rStyle w:val="Hyperlink"\/>/);
  // Page setup and header/footer references are the template's A4 section.
  assert.match(doc, /<w:sectPr>.*<w:headerReference w:type="default" r:id="rId10"\/>.*<w:pgSz w:w="11906" w:h="16838"\/>.*<\/w:sectPr><\/w:body>/s);

  // The header keeps its logo and fills in the title; the footer keeps the page number field and the date.
  const header = await text(z, 'word/header1.xml');
  assert.match(header, /ACME Corp \| Payments service/);
  assert.match(header, /<w:drawing>/);
  assert.ok(z.file('word/media/logo.png'), 'the header logo is still there');
  const footer = await text(z, 'word/footer1.xml');
  assert.match(footer, /instrText[^>]*> PAGE </);
  assert.match(footer, /\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(footer, /\{\{date\}\}/);
  assert.match(await text(z, 'docProps/core.xml'), /<dc:title>Payments service<\/dc:title>/);

  // The picture and the link were added with new ids, and nothing clashes with the template's own relationships.
  const rels = await text(z, 'word/_rels/document.xml.rels');
  assert.match(rels, /Id="rId10"[^>]*header1\.xml/);
  assert.match(rels, /media\/gen_[^"]+\.png/);
  assert.match(rels, /Target="https:\/\/example\.com\/docs" TargetMode="External"/);
  const ids = [...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'relationship ids are unique');
  for (const m of doc.matchAll(/r:(?:embed|id)="([^"]+)"/g)) if (!/^rId1[01]$/.test(m[1])) assert.ok(ids.includes(m[1]), `${m[1]} is defined`);
  assert.ok(Object.keys(z.files).some((f) => /^word\/media\/gen_.*\.png$/.test(f)));

  // Numbering: the template's bullet definition is untouched, the portal's were appended with new ids, each numbered list restarts.
  const num = await text(z, 'word/numbering.xml');
  assert.match(num, /<w:abstractNum w:abstractNumId="0">/);
  assert.match(num, /<w:num w:numId="1"><w:abstractNumId w:val="0"\/>/);
  const numIds = [...num.matchAll(/<w:num [^>]*w:numId="(\d+)"/g)].map((m) => m[1]);
  assert.ok(numIds.length >= 3 && new Set(numIds).size === numIds.length, `num ids: ${numIds}`);
  assert.ok(num.indexOf('</w:abstractNum><w:num ') > 0 && !/<w:num [\s\S]*<w:abstractNum /.test(num), 'abstract numbering comes before the numbers');
  const used = [...new Set([...doc.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]))];
  assert.ok(used.length >= 2, 'the two numbered lists use different numbering instances');
  for (const u of used) assert.ok(numIds.includes(u), `numId ${u} exists`);

  // It reads back as a document with the content in order.
  const md = await toMarkdown('out.docx', fs.readFileSync(r.output));
  assert.match(md, /Payments service/);
  assert.match(md, /Components/);
  assert.match(md, /Nested bullet/);
  assert.match(md, /Agent/);

  const report = JSON.parse(fs.readFileSync(`${r.output}.report.json`, 'utf8'));
  assert.equal(report.template, 'brand.dotx');
});

test('the project default is used without being named; template:false gives the built-in look', async () => {
  const dir = setup();
  fs.mkdirSync(path.join(dir, '.portal/templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.portal/templates/default-docx.docx'), await makeWordTemplate());
  fs.writeFileSync(path.join(dir, '.portal/templates/defaults.json'), JSON.stringify({ docx: { id: 'tp_1', name: 'Corporate', scope: 'portal', path: '.portal/templates/default-docx.docx' } }));
  const auto = await generate(spec('auto.docx'), { baseDir: dir });
  assert.equal(auto.template, 'Corporate');
  assert.match(await text(await unzip(auto.output), 'word/styles.xml'), /Georgia/);

  const plain = await generate(spec('plain.docx', { template: false }), { baseDir: dir });
  assert.equal(plain.template, undefined);
  assert.equal(plain.warnings, undefined);
  const z = await unzip(plain.output);
  assert.doesNotMatch(await text(z, 'word/styles.xml'), /Georgia/);
  assert.equal(z.file('word/header1.xml'), null);
  assert.equal(JSON.parse(fs.readFileSync(`${plain.output}.report.json`, 'utf8')).template, null);
});

test('a template without some styles still works: the built-in ones fill in, with warnings for headings and the title', async () => {
  const dir = setup();
  fs.writeFileSync(path.join(dir, 'sparse.docx'), await makeWordTemplate({ sparse: true, noNumbering: true }));
  const md = '# Doc title\n\n## One\n\n### Two\n\n#### Three\n\n- a\n- b\n\n1. x\n2. y\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
  const r = await generate({ type: 'docx', output: 's.docx', markdown: md, titleFromHeading: true, template: 'sparse.docx' }, { baseDir: dir });
  assert.equal(r.template, 'sparse.docx');
  const w = r.warnings?.join('\n') ?? '';
  assert.match(w, /Template "sparse\.docx": The template has no style for Title, Heading 3/);
  const z = await unzip(r.output);
  const styles = await text(z, 'word/styles.xml');
  for (const id of ['Title', 'Heading3']) assert.match(styles, new RegExp(`w:styleId="${id}"`), `${id} was copied in`);
  assert.match(styles, /Georgia/, 'the template styles are still there');
  const doc = await text(z, 'word/document.xml');
  assert.match(doc, /<w:pStyle w:val="Title"\/>/);
  assert.match(doc, /<w:pStyle w:val="Heading3"\/>/);
  assert.doesNotMatch(doc, /<w:tblStyle/, 'no table style in this template');
  assert.match(doc, /E6F0EF/, 'the built-in header shading is used');
  // The template had no numbering part; one was created and registered.
  assert.match(await text(z, 'word/numbering.xml'), /<w:abstractNum /);
  assert.match(await text(z, 'word/_rels/document.xml.rels'), /numbering\.xml/);
  assert.match(await text(z, '[Content_Types].xml'), /numbering\+xml/);
  for (const n of Object.keys(z.files).filter((f) => /\.(xml|rels)$/.test(f))) parseXml(await text(z, n));
});

test('a template that cannot be applied gives the built-in document and a warning that names it', async () => {
  const dir = setup();
  const odd = new JSZip();
  odd.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  odd.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  odd.file('word/document.xml', '<doc:document xmlns:doc="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><doc:body/></doc:document>');
  const cases: [string, Buffer, RegExp][] = [
    ['garbage.docx', Buffer.from('not a zip at all'), /could not be applied/],
    ['prefix.docx', Buffer.from(await odd.generateAsync({ type: 'uint8array' })), /could not be applied.*namespace prefixes/],
  ];
  for (const [name, buf, re] of cases) {
    fs.writeFileSync(path.join(dir, name), buf);
    const r = await generate(spec(`${name}.out.docx`, { template: name }), { baseDir: dir });
    assert.equal(r.template, undefined, name);
    assert.ok(r.warnings?.some((x) => re.test(x) && x.includes(name)), `${name}: ${JSON.stringify(r.warnings)}`);
    const z = await unzip(r.output);
    assert.match(await text(z, 'word/document.xml'), /Payments service/, `${name}: the document was still made`);
  }
  const missing = await generate(spec('m.docx', { template: 'nope.docx' }), { baseDir: dir });
  assert.match(missing.warnings?.join(' ') ?? '', /nope\.docx.*could not be used.*file not found/);
  const wrongExt = await generate(spec('e.docx', { template: 'garbage.txt' }), { baseDir: dir });
  assert.match(wrongExt.warnings?.join(' ') ?? '', /must be a \.docx or \.dotx/);
  const pptx = await generate(spec('p.docx', { template: 'deck.pptx' }), { baseDir: dir });
  assert.match(pptx.warnings?.join(' ') ?? '', /must be a \.docx or \.dotx/);
  const escape = await generate(spec('x.docx', { template: '../outside.docx' }), { baseDir: dir });
  assert.match(escape.warnings?.join(' ') ?? '', /must be inside/);
  await assert.rejects(generate(spec('y.docx', { template: 5 as any }), { baseDir: dir }), DocError);
});

test('pictures are fitted to the template page, and the title is taken from the heading only when asked', async () => {
  const dir = setup();
  fs.writeFileSync(path.join(dir, 'brand.docx'), await makeWordTemplate());
  const r = await generate({ type: 'docx', output: 'f.docx', template: 'brand.docx', markdown: '# Kept as heading\n\n![x](logo.png)\n' }, { baseDir: dir });
  const doc = await text(await unzip(r.output), 'word/document.xml');
  assert.match(doc, /<w:pStyle w:val="Heading1"\/>[\s\S]*?Kept as heading/, 'without titleFromHeading the heading stays a heading');
  assert.doesNotMatch(doc, /<w:pStyle w:val="Title"\/>/);
  const withTitle = await generate({ type: 'docx', output: 'g.docx', template: 'brand.docx', title: 'Given title', markdown: '# Kept as heading\n', titleFromHeading: true }, { baseDir: dir });
  const doc2 = await text(await unzip(withTitle.output), 'word/document.xml');
  assert.match(doc2, /<w:pStyle w:val="Title"\/>[\s\S]*?Given title/);
  assert.match(doc2, /<w:pStyle w:val="Heading1"\/>[\s\S]*?Kept as heading/, 'a given title wins, the heading stays');
});
