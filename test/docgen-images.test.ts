import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { DocError, generate } from '../server/docgen.ts';
import { rendererProblem } from '../server/docimage.ts';

const TSX = import.meta.resolve('tsx');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-img-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** A solid-colour PNG, built by hand so the tests need no image library. */
function makePng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const PNG = makePng(320, 160);
fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
fs.writeFileSync(path.join(dir, 'work/pic.png'), PNG);
const FLOW = 'flowchart LR\n  A[Request] --> B{Valid?}\n  B -->|yes| C[Approve]\n  B -->|no| D[Reject]';

async function media(file: string): Promise<{ names: string[]; zip: JSZip }> {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, file)));
  return { names: Object.keys(zip.files).filter((n) => /\/media\/[^/]+$/.test(n)), zip };
}

async function withoutBrowser<T>(fn: () => Promise<T>): Promise<T> {
  const old = process.env.DOC_BROWSER;
  process.env.DOC_BROWSER = path.join(dir, 'no-such-browser');
  try {
    return await fn();
  } finally {
    if (old === undefined) delete process.env.DOC_BROWSER;
    else process.env.DOC_BROWSER = old;
  }
}

test('docx: an image block embeds the PNG file, with a caption and alt text', async () => {
  const r = await generate(
    { type: 'docx', output: 'img.docx', blocks: [{ type: 'paragraph', text: 'Before' }, { type: 'image', path: 'work/pic.png', width: 3, caption: 'Figure 1: a picture', alt: 'grey box' }] },
    { baseDir: dir },
  );
  assert.equal(r.warnings, undefined);
  const { names, zip } = await media('img.docx');
  assert.equal(names.length, 1);
  assert.deepEqual(await zip.file(names[0])!.async('nodebuffer'), PNG);
  const xml = await zip.file('word/document.xml')!.async('string');
  assert.match(xml, /<w:drawing>/);
  assert.match(xml, /Figure 1: a picture/);
  assert.match(xml, /descr="grey box"/);
  assert.match(xml, /<wp:extent cx="2743200" cy="1371600"/, '3 in wide, aspect ratio kept');
});

test('pptx: an image on a slide embeds the PNG, alone or beside bullets', async () => {
  await generate(
    {
      type: 'pptx',
      output: 'img.pptx',
      slides: [
        { layout: 'title', title: 'Pictures' },
        { title: 'Full', image: { path: 'work/pic.png', caption: 'The picture' } },
        { title: 'Beside', bullets: ['one', 'two'], image: { path: 'work/pic.png', alt: 'grey' } },
      ],
    },
    { baseDir: dir },
  );
  const { names, zip } = await media('img.pptx');
  assert.ok(names.length >= 1);
  assert.deepEqual(await zip.file(names[0])!.async('nodebuffer'), PNG);
  const s2 = await zip.file('ppt/slides/slide2.xml')!.async('string');
  const s3 = await zip.file('ppt/slides/slide3.xml')!.async('string');
  assert.match(s2, /<p:pic>/);
  assert.match(s2, /The picture/);
  assert.match(s3, /<p:pic>/);
  assert.match(s3, /one/);
});

test('markdown: a local image and a mermaid fence become embedded visuals', async () => {
  const md = '# Doc\n\n![the box](work/pic.png "Caption here")\n\n```mermaid\n' + FLOW + '\n```\n';
  const r = await generate({ type: 'docx', output: 'md.docx', markdown: md }, { baseDir: dir });
  const { names } = await media('md.docx');
  if (rendererProblem()) {
    assert.equal(names.length, 1, 'the picture only');
    assert.equal(r.warnings?.length, 1);
  } else {
    assert.equal(names.length, 2, 'picture and diagram');
    assert.equal(r.warnings, undefined);
  }
});

test('mermaid: docx and pptx embed a rendered PNG diagram', async (t) => {
  const problem = rendererProblem();
  if (problem) return t.skip(`no renderer here: ${problem}`);
  const d = await generate({ type: 'docx', output: 'mm.docx', blocks: [{ type: 'mermaid', source: FLOW, caption: 'Approval flow' }] }, { baseDir: dir });
  assert.equal(d.warnings, undefined);
  const dm = await media('mm.docx');
  assert.equal(dm.names.length, 1);
  const png = await dm.zip.file(dm.names[0])!.async('nodebuffer');
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.ok(png.length > 3000, 'a drawn diagram, not an empty image');

  const p = await generate(
    { type: 'pptx', output: 'mm.pptx', slides: [{ layout: 'title', title: 'Flow' }, { title: 'Approval', mermaid: { source: FLOW, caption: 'Approval flow' } }, { title: 'Beside', bullets: ['a'], mermaid: { source: 'sequenceDiagram\n  A->>B: hello' } }] },
    { baseDir: dir },
  );
  assert.equal(p.warnings, undefined);
  const pm = await media('mm.pptx');
  assert.ok(pm.names.length >= 2);
  assert.match(await pm.zip.file('ppt/slides/slide2.xml')!.async('string'), /<p:pic>/);
});

test('mermaid: a bad diagram degrades to a code block and a warning, not a failure', async (t) => {
  if (rendererProblem()) return t.skip('no renderer here');
  const r = await generate({ type: 'docx', output: 'bad.docx', blocks: [{ type: 'mermaid', source: 'this is not a diagram (((' }] }, { baseDir: dir });
  assert.equal(r.warnings?.length, 1);
  assert.match(r.warnings![0], /Mermaid diagram not drawn/);
  assert.equal((await media('bad.docx')).names.length, 0);
});

test('graceful degradation: with no browser the diagram is a styled code block with a note, and the CLI reports it', async () => {
  await withoutBrowser(async () => {
    assert.match(rendererProblem()!, /no headless browser/);
    const d = await generate({ type: 'docx', output: 'nb.docx', blocks: [{ type: 'heading', text: 'Flow' }, { type: 'mermaid', source: FLOW, caption: 'Cap' }, { type: 'image', path: 'work/pic.png' }] }, { baseDir: dir });
    assert.equal(d.warnings?.length, 1);
    assert.match(d.warnings![0], /no headless browser/);
    const { names, zip } = await media('nb.docx');
    assert.equal(names.length, 1, 'the PNG file still embeds; only the diagram degrades');
    const xml = await zip.file('word/document.xml')!.async('string');
    assert.match(xml, /flowchart LR/);
    assert.match(xml, /Consolas/);
    assert.match(xml, /Diagram not drawn/);
    assert.match(xml, /F3F4F6/, 'code block shading');

    const p = await generate({ type: 'pptx', output: 'nb.pptx', slides: [{ title: 'Flow', mermaid: { source: FLOW } }] }, { baseDir: dir });
    assert.equal(p.warnings?.length, 1);
    const slide = await (await JSZip.loadAsync(fs.readFileSync(path.join(dir, 'nb.pptx')))).file('ppt/slides/slide1.xml')!.async('string');
    assert.match(slide, /flowchart LR/);
    assert.match(slide, /Diagram not drawn/);
    assert.doesNotMatch(slide, /<p:pic>/);

    fs.writeFileSync(path.join(dir, 'nb.spec.json'), JSON.stringify({ type: 'docx', output: 'nb-cli.docx', blocks: [{ type: 'mermaid', source: FLOW }] }));
    const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', TSX, path.resolve('server/docgen-cli.ts'), 'nb.spec.json'], { cwd: dir, env: { ...process.env, DOC_BROWSER: path.join(dir, 'no-such-browser') } }).toString();
    const res = JSON.parse(out);
    assert.equal(res.ok, true);
    assert.match(res.warnings[0], /not drawn/);
  });
});

test('SVG files are drawn to PNG when a browser exists, and degrade to a note when not', async (t) => {
  fs.writeFileSync(path.join(dir, 'work/box.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#0f766e"/><script>alert(1)</script></svg>');
  const spec = { type: 'docx' as const, output: 'svg.docx', blocks: [{ type: 'image' as const, path: 'work/box.svg' }] };
  const none = await withoutBrowser(() => generate(spec, { baseDir: dir }));
  assert.match(none.warnings![0], /SVG image/);
  assert.match(await (await JSZip.loadAsync(fs.readFileSync(path.join(dir, 'svg.docx')))).file('word/document.xml')!.async('string'), /Image not embedded/);
  if (rendererProblem()) return t.skip('no renderer here for the drawn half');
  const ok = await generate(spec, { baseDir: dir });
  assert.equal(ok.warnings, undefined);
  assert.equal((await media('svg.docx')).names.length, 1);
});

test('input checks: paths stay inside the folder, files must really be images, sources are size-limited', async () => {
  const bad = async (blocks: any[], re: RegExp) => assert.rejects(() => generate({ type: 'docx', output: 'x.docx', blocks }, { baseDir: dir }), (e: any) => e instanceof DocError && re.test(e.message));
  fs.writeFileSync(path.join(dir, 'outside.png'), PNG);
  const inner = path.join(dir, 'inner');
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(inner, 'fake.png'), 'not an image at all');
  fs.writeFileSync(path.join(inner, 'notes.txt'), 'hello');
  const run = (blocks: any[]) => generate({ type: 'docx', output: 'x.docx', blocks }, { baseDir: inner });
  await assert.rejects(() => run([{ type: 'image', path: '../outside.png' }]), /must be inside/);
  await assert.rejects(() => run([{ type: 'image', path: path.join(dir, 'outside.png') }]), /must be inside/);
  await assert.rejects(() => run([{ type: 'image', path: 'fake.png' }]), /not a valid PNG or JPEG/);
  await assert.rejects(() => run([{ type: 'image', path: 'notes.txt' }]), /only .png/);
  await assert.rejects(() => run([{ type: 'image', path: 'missing.png' }]), /not found/);
  await assert.rejects(() => run([{ type: 'image' }]), /path must be/);
  await assert.rejects(() => run([{ type: 'image', path: '../outside.png', width: 99 }]), /inches/);
  await bad([{ type: 'mermaid', source: 'a'.repeat(20_001) }], /too long/);
  await bad([{ type: 'mermaid', source: '  ' }], /Mermaid text/);
  await bad(Array.from({ length: 41 }, () => ({ type: 'mermaid', source: 'graph TD;A-->B' })), /Too many Mermaid/);
  await assert.rejects(() => generate({ type: 'pptx', output: 'x.pptx', slides: [{ title: 'x', image: { path: 'work/pic.png' }, mermaid: { source: 'graph TD;A-->B' } }] } as any, { baseDir: dir }), /use one/);
  await assert.rejects(() => generate({ type: 'pptx', output: 'x.pptx', slides: [{ layout: 'image', title: 'x' }] }, { baseDir: dir }), /no "image" or "mermaid"/);
});

test('input checks: a symlink that points out of the folder is refused', async (t) => {
  const inner = path.join(dir, 'inner2');
  fs.mkdirSync(inner, { recursive: true });
  try {
    fs.symlinkSync(path.join(dir, 'work/pic.png'), path.join(inner, 'link.png'));
  } catch {
    return t.skip('cannot create symlinks here');
  }
  await assert.rejects(() => generate({ type: 'docx', output: 'x.docx', blocks: [{ type: 'image', path: 'link.png' }] }, { baseDir: inner }), /must be inside/);
});
