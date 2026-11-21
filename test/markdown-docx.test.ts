/**
 * Markdown to Word (server/markdown-docx.ts): structure, numbered lists that restart, tables, and pictures read only from the
 * document's own folder.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { markdownToDocx, parseBlocks, parseInline, imageInfo, readImage } from '../server/markdown-docx.ts';
import { buildDocx, buildDocxReport } from '../server/docgen.ts';

/** A valid PNG of the given size (solid colour). */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 200)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

async function parts(buf: Buffer): Promise<{ xml: string; media: string[] }> {
  const zip = await JSZip.loadAsync(buf);
  return { xml: await zip.file('word/document.xml')!.async('string'), media: Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !n.endsWith('/')) };
}

describe('markdown reading', () => {
  it('reads inline formatting', () => {
    assert.deepEqual(parseInline('a **b** c *d* `e` [f](https://x.test) g'), [
      { text: 'a ' }, { text: 'b', bold: true }, { text: ' c ' }, { text: 'd', italic: true }, { text: ' ' }, { text: 'e', code: true }, { text: ' ' }, { text: 'f', link: 'https://x.test' }, { text: ' g' },
    ]);
    assert.deepEqual(parseInline('snake_case_name and 2*3*4'), [{ text: 'snake_case_name and 2' }, { text: '3', italic: true }, { text: '4' }]);
  });

  it('reads blocks: headings, joined paragraph lines, lists that restart, tables, code, images', () => {
    const blocks = parseBlocks([
      '# Title', '', 'one', 'two', '', '1. First', '2. Second', '   - nested', '', 'Between', '', '1. Again', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', '```', 'code | line', '```', '', '![Login](screenshots/01.png)',
    ].join('\n'));
    assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'para', 'list', 'list', 'list', 'para', 'list', 'table', 'code', 'image']);
    assert.equal((blocks[1] as { text: string }).text, 'one two');
    assert.deepEqual(blocks.filter((b) => b.kind === 'list').map((b) => (b as { restart: boolean }).restart), [true, false, false, true]);
    assert.deepEqual((blocks[7] as { rows: string[][] }).rows, [['A', 'B'], ['1', '2']]);
  });

  it('knows PNG and JPEG sizes from their bytes, and nothing else', () => {
    assert.deepEqual(imageInfo(png(30, 20)), { type: 'png', width: 30, height: 20 });
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x14, 0x00, 0x1e, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(imageInfo(jpg), { type: 'jpg', width: 30, height: 20 });
    assert.equal(imageInfo(Buffer.from('GIF89a......................')), null);
  });
});

describe('Word file', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mddocx-')); fs.mkdirSync(path.join(dir, 'screenshots')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('builds headings, bold text, bullets, a numbered list, a table and code', async () => {
    const { buffer, warnings } = await markdownToDocx('# User guide\n\nUse **Save** now.\n\n- one\n- two\n\n1. Open it\n2. Click Save\n\n| Field | Meaning |\n|---|---|\n| Name | Who |\n\n```\nnpm start\n```\n');
    const { xml } = await parts(buffer);
    assert.deepEqual(warnings, []);
    assert.match(xml, /<w:pStyle w:val="Heading1"\/>/);
    assert.match(xml, /<w:b\/>[\s\S]*?Save/);
    assert.match(xml, /<w:numPr>/);
    assert.match(xml, /<w:tbl>/);
    assert.match(xml, /Consolas/);
    for (const t of ['User guide', 'Open it', 'Click Save', 'Meaning', 'npm start']) assert.ok(xml.includes(t), t);
  });

  it('restarts numbering for each numbered list', async () => {
    const { xml } = await parts((await markdownToDocx('1. a\n2. b\n\ntext\n\n1. c\n2. d\n')).buffer);
    const ids = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
    assert.equal(ids.length, 4);
    assert.equal(ids[0], ids[1]);
    assert.equal(ids[2], ids[3]);
    assert.notEqual(ids[0], ids[2], 'the second list is a new list, so it starts at 1 again');
  });

  it('embeds a picture from the document folder, scaled to the page, with its caption', async () => {
    fs.writeFileSync(path.join(dir, 'screenshots', '01-login.png'), png(1280, 720));
    const { buffer, warnings } = await buildDocxReport('## Sign in\n\n1. Type your email (1)\n\n![Step 1: the sign-in page](screenshots/01-login.png)\n', undefined, { baseDir: dir });
    const { xml, media } = await parts(buffer);
    assert.deepEqual(warnings, []);
    assert.equal(media.length, 1);
    assert.match(xml, /<wp:inline/);
    const cx = Number(/<wp:extent cx="(\d+)"/.exec(xml)![1]);
    assert.equal(cx, 576 * 9525, '6 inches wide at most');
    assert.ok(xml.includes('Step 1: the sign-in page'), 'the caption');
  });

  it('puts a picture written inside a list item after the item text', async () => {
    fs.writeFileSync(path.join(dir, 'screenshots', 'a.png'), png(100, 50));
    const { xml, media } = await parts(await buildDocx('1. Click Save ![The form](screenshots/a.png)\n', undefined, { baseDir: dir }));
    assert.equal(media.length, 1);
    assert.ok(xml.indexOf('Click Save') < xml.indexOf('<w:drawing>'));
  });

  it('shows a visible line and a warning for a picture that cannot be used, and never reads outside the folder', async () => {
    fs.writeFileSync(path.join(dir, '..', `outside-${path.basename(dir)}.png`), png(10, 10));
    const outside = `../outside-${path.basename(dir)}.png`;
    const { buffer, warnings } = await buildDocxReport(`![a](screenshots/missing.png)\n\n![b](${outside})\n\n![c](/etc/passwd.png)\n\n![d](https://x.test/p.png)\n\n![e](screenshots/notes.txt)\n`, undefined, { baseDir: dir });
    const { xml, media } = await parts(buffer);
    assert.equal(media.length, 0);
    assert.equal(warnings.length, 5);
    assert.match(xml, /Image not included: screenshots\/missing\.png/);
    assert.match(warnings.join('\n'), /outside the document folder|only pictures in the document folder/);
    fs.rmSync(path.join(dir, '..', `outside-${path.basename(dir)}.png`), { force: true });
  });

  it('refuses a picture whose bytes are not an image, and a link that points out of the folder', () => {
    fs.writeFileSync(path.join(dir, 'screenshots', 'fake.png'), Buffer.from('not an image at all'));
    assert.deepEqual(readImage(dir, 'screenshots/fake.png'), { error: 'the file is not a PNG or JPEG picture' });
    fs.writeFileSync(path.join(dir, 'real.png'), png(5, 5));
    try {
      fs.symlinkSync(path.join(dir, 'real.png'), path.join(dir, 'screenshots', 'link.png'));
      assert.ok(!('error' in readImage(dir, 'screenshots/link.png')), 'a link that stays inside is fine');
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'mddocx-else-'));
      fs.writeFileSync(path.join(elsewhere, 'x.png'), png(5, 5));
      fs.symlinkSync(path.join(elsewhere, 'x.png'), path.join(dir, 'screenshots', 'escape.png'));
      assert.deepEqual(readImage(dir, 'screenshots/escape.png'), { error: 'the picture is outside the document folder' });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e; /* no symlinks without privileges on Windows */ }
  });

  it('builds an empty document from empty text', async () => {
    assert.ok((await markdownToDocx('')).buffer.length > 500);
  });
});
