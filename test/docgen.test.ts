import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { DocError, generate, markdownToBlocks, plain } from '../server/docgen.ts';
import { toMarkdown } from '../server/convert.ts';

// The command runs in a temp folder, so give node the repo's tsx by absolute URL.
const TSX = import.meta.resolve('tsx');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const MD = `# Refund policy

Refunds above **500 USD** need a *Finance Manager* to approve. See [the FSD](https://example.com/fsd).

## Steps

1. Agent opens the case
2. Manager approves
   - checks the limit
   - checks the customer

- Plain bullet with \`code\`

| Role | Limit |
|---|---|
| Agent | 100 |
| Manager | 5000 |

\`\`\`
SELECT * FROM refunds;
\`\`\`
`;

test('docx from Markdown: headings, lists, table, code survive a round trip', async () => {
  const r = await generate({ type: 'docx', output: 'out/policy.docx', title: 'Refund Policy', markdown: MD }, { baseDir: dir });
  assert.equal(r.type, 'docx');
  assert.ok(r.bytes > 1000);
  const buf = fs.readFileSync(path.join(dir, 'out/policy.docx'));
  const back = await toMarkdown('policy.docx', buf);
  assert.match(back, /Refund Policy/);
  assert.match(back, /Refunds above/);
  assert.match(back, /Finance Manager/);
  assert.match(back, /Manager approves/);
  assert.match(back, /checks the limit/);
  assert.match(back, /Manager.*5000/s);
  assert.match(back, /SELECT \* FROM refunds/);
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string');
  assert.match(xml, /<w:b\/>/, 'bold run');
  assert.match(xml, /<w:i\/>/, 'italic run');
  assert.match(xml, /w:hyperlink/, 'link');
});

test('docx from blocks, with two numbered lists that each restart', async () => {
  await generate(
    {
      type: 'docx',
      output: 'blocks.docx',
      blocks: [
        { type: 'heading', level: 1, text: 'Plan' },
        { type: 'numbered', items: ['one', 'two'] },
        { type: 'paragraph', text: 'between' },
        { type: 'numbered', items: ['again one'] },
        { type: 'table', header: ['A', 'B'], rows: [['1', '2'], ['3']] },
        { type: 'pagebreak' },
        { type: 'bullets', items: ['last'] },
      ],
    },
    { baseDir: dir },
  );
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, 'blocks.docx')));
  const numbering = await zip.file('word/numbering.xml')!.async('string');
  const abstractCount = (numbering.match(/<w:abstractNum /g) ?? []).length;
  assert.ok(abstractCount >= 2, 'one numbering definition per numbered list');
  const md = await toMarkdown('blocks.docx', fs.readFileSync(path.join(dir, 'blocks.docx')));
  assert.match(md, /again one/);
  assert.match(md, /last/);
});

test('xlsx: sheets, header styling, formulas, unique and legal sheet names', async () => {
  const r = await generate(
    {
      type: 'xlsx',
      output: 'book.xlsx',
      sheets: [
        { name: 'Budget', header: ['Item', 'Cost'], rows: [['Servers', 100], ['Licences', 250.5], ['Total', { formula: 'SUM(B2:B3)' }]] },
        { name: 'Budget', rows: [['dup name']] },
        { name: 'Bad/Name:[x]?', rows: [[true, null, 'x']] },
      ],
    },
    { baseDir: dir },
  );
  assert.match(r.summary, /3 sheets/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(dir, 'book.xlsx'));
  const names = wb.worksheets.map((w) => w.name);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 3, 'names are unique');
  assert.ok(names.every((n) => !/[\[\]:*?/\\]/.test(n)), 'names are legal');
  const ws = wb.getWorksheet('Budget')!;
  assert.equal(ws.getCell('B3').value, 250.5);
  assert.deepEqual((ws.getCell('B4').value as any).formula, 'SUM(B2:B3)');
  assert.equal(ws.getRow(1).font?.bold, true);
  assert.equal(ws.views[0].state, 'frozen');
  const md = await toMarkdown('book.xlsx', fs.readFileSync(path.join(dir, 'book.xlsx')));
  assert.match(md, /Licences/);
});

test('csv: quoting, BOM, CRLF, and spreadsheet-formula injection is defused', async () => {
  await generate(
    {
      type: 'csv',
      output: 'data.csv',
      header: ['name', 'note'],
      rows: [
        ['Ann', 'says "hi", ok'],
        ['Bob', 'line1\nline2'],
        ['=cmd|calc', '+1+1'],
        ['neg', -5],
        ['text-dash', '-not a number'],
        ['empty', null],
      ],
    },
    { baseDir: dir },
  );
  const raw = fs.readFileSync(path.join(dir, 'data.csv'), 'utf8');
  assert.equal(raw.charCodeAt(0), 0xfeff, 'UTF-8 BOM for Excel');
  assert.match(raw, /\r\n/);
  assert.match(raw, /"says ""hi"", ok"/);
  assert.match(raw, /"line1\nline2"/);
  assert.match(raw, /'=cmd\|calc,'\+1\+1/);
  assert.match(raw, /neg,-5\r\n/, 'real numbers are not touched');
  assert.match(raw, /'-not a number/);
  await generate({ type: 'csv', output: 'nobom.csv', rows: [['a']], bom: false }, { baseDir: dir });
  assert.equal(fs.readFileSync(path.join(dir, 'nobom.csv'), 'utf8'), 'a\r\n');
});

test('pptx: every layout, table, notes and slide count', async () => {
  const r = await generate(
    {
      type: 'pptx',
      output: 'deck.pptx',
      title: 'Refund programme',
      slides: [
        { layout: 'title', title: 'Refund programme', subtitle: 'Q4 plan' },
        { layout: 'section', title: 'Why' },
        { title: 'Goals', bullets: ['Cut **handling** time', 'Fewer escalations', 'Audit trail'], notes: 'Say this slowly' },
        { layout: 'text', title: 'Context', text: 'Finance asked for tighter limits.' },
        { layout: 'table', title: 'Limits', table: { header: ['Role', 'Limit'], rows: [['Agent', '100'], ['Manager', '5000']] } },
      ],
    },
    { baseDir: dir },
  );
  assert.match(r.summary, /5 slides/);
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, 'deck.pptx')));
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  assert.equal(slides.length, 5);
  assert.ok(Object.keys(zip.files).some((f) => f.startsWith('ppt/notesSlides/')), 'speaker notes');
  const md = await toMarkdown('deck.pptx', fs.readFileSync(path.join(dir, 'deck.pptx')));
  assert.match(md, /Cut handling time/, 'inline Markdown markers are removed on slides');
  assert.match(md, /Manager/);
  assert.match(md, /Finance asked/);
});

test('safety: output stays inside the base folder and keeps the right extension', async () => {
  const bad = (spec: any, re: RegExp) => assert.rejects(generate(spec, { baseDir: dir }), (e: any) => e instanceof DocError && re.test(e.message));
  await bad({ type: 'csv', output: '../escape.csv', rows: [] }, /inside/);
  await bad({ type: 'csv', output: path.join(os.tmpdir(), 'abs-escape.csv'), rows: [] }, /inside/);
  await bad({ type: 'docx', output: 'x.exe', markdown: 'hi' }, /end in \.docx/);
  await bad({ type: 'xlsx', output: 'x.xlsx', sheets: [] }, /at least one sheet/);
  await bad({ type: 'pptx', output: 'x.pptx', slides: [{ layout: 'table', title: 't' }] }, /no "table"/);
  await bad({ type: 'docx', output: 'x.docx' }, /markdown" or "blocks/);
  await bad({ type: 'nope', output: 'x' }, /type/);
  await bad({ type: 'csv', output: 'x.csv', rows: [['a'], 'not a row'] }, /every row/);
  assert.ok(!fs.existsSync(path.join(dir, '..', 'escape.csv')));
});

test('markdown helpers', () => {
  assert.equal(plain('a **b** `c` [d](http://x)'), 'a b c d');
  const blocks = markdownToBlocks('# T\n\ntext\n\n- a\n  - b\n- c\n');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'list']);
  const list = blocks[2] as any;
  assert.deepEqual(list.items.map((i: any) => [i.text, i.level]), [['a', 0], ['b', 1], ['c', 0]]);
});

test('the make-doc command reads a spec file and prints JSON; errors exit 1 with JSON', () => {
  const cli = path.resolve('server/docgen-cli.ts');
  const spec = path.join(dir, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({ type: 'csv', output: 'cli.csv', rows: [['x', 1]] }));
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', TSX, cli, spec], { cwd: dir }).toString();
  const res = JSON.parse(out);
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'cli.csv')));
  fs.writeFileSync(spec, JSON.stringify({ type: 'csv', output: '../nope.csv', rows: [] }));
  let failed: any;
  try {
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', TSX, cli, spec], { cwd: dir, stdio: 'pipe' });
  } catch (e) {
    failed = e;
  }
  assert.equal(failed?.status, 1);
  assert.equal(JSON.parse(failed.stderr.toString()).ok, false);
});

test('every JSON example in the make-documents skill is a valid spec', async () => {
  const { makeDocumentsSkill } = await import('../server/projects.ts');
  const skill = makeDocumentsSkill();
  assert.match(skill, /^---\nname: make-documents\ndescription: /);
  const examples = [...skill.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.deepEqual(examples.map((e) => e.type), ['docx', 'xlsx', 'csv', 'pptx']);
  for (const spec of examples) {
    const r = await generate(spec, { baseDir: dir });
    assert.ok(r.bytes > 0, `${spec.type} example produced a file`);
  }
});

test('the built make-doc command works the way an agent runs it, if the project has been built', async (t) => {
  const { DOC_TOOL } = await import('../server/projects.ts');
  if (!fs.existsSync(DOC_TOOL)) return t.skip('run "npm run build" first');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-project-'));
  try {
    fs.mkdirSync(path.join(project, 'work/r_1'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'work/r_1/deck.spec.json'),
      JSON.stringify({ type: 'pptx', output: 'work/r_1/deck.pptx', slides: [{ layout: 'title', title: 'Hello' }, { title: 'Two', bullets: ['a', 'b'] }] }),
    );
    // The exact shape the skill gives: node "<tool>" <spec>, run from the project folder.
    const out = execFileSync(process.execPath, [DOC_TOOL, 'work/r_1/deck.spec.json'], { cwd: project }).toString();
    const res = JSON.parse(out);
    assert.equal(res.ok, true);
    assert.equal(path.resolve(res.output), path.join(project, 'work/r_1/deck.pptx'));
    assert.match(await toMarkdown('deck.pptx', fs.readFileSync(res.output)), /Hello/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
