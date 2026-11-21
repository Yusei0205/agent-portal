/**
 * Markdown to a Word file, with pictures.
 *
 * Generated documents are written as Markdown by an agent and turned into .docx here. Supported: headings (# to ######), paragraphs
 * (consecutive lines join into one), bulleted and numbered lists (two spaces of indent per level, up to three levels; each new
 * numbered list starts again at 1), pipe tables, fenced code, block quotes, horizontal rules, **bold**, *italic*, `code`, links, and
 * images (`![caption](screenshots/01-login.png)`, PNG or JPEG, on a line of their own or inside a list item).
 *
 * An image is read only from inside `baseDir` (the folder of the Markdown file; links that leave it are refused), at most 15 MB, and
 * its type is checked from its bytes, not its name. One that cannot be used leaves a visible "[Image not included: ...]" line and a
 * warning instead of failing the whole file.
 */

import fs from 'node:fs';
import path from 'node:path';

export const MARKDOWN_DOCX_LIMITS = { imageBytes: 15 * 1024 * 1024, images: 200, maxWidthPx: 576, maxHeightPx: 720, listLevels: 3 };

export interface MarkdownDocxResult { buffer: Buffer; warnings: string[] }

// ── Pictures ────────────────────────────────────────────────────────────────────────────────────────────

/** Width and height of a PNG or JPEG, read from its bytes. Null for anything else. */
export function imageInfo(buf: Buffer): { type: 'png' | 'jpg'; width: number; height: number } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { type: 'png', width, height } : null;
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = buf.readUInt16BE(i + 5), width = buf.readUInt16BE(i + 7);
        return width > 0 && height > 0 ? { type: 'jpg', width, height } : null;
      }
      i += 2 + len;
    }
  }
  return null;
}

/** The picture a Markdown image points at, or why it cannot be used. */
export function readImage(baseDir: string | undefined, ref: string): { data: Buffer; type: 'png' | 'jpg'; width: number; height: number } | { error: string } {
  if (!baseDir) return { error: 'no folder to read pictures from' };
  let rel = ref.trim();
  try { rel = decodeURI(rel); } catch { /* keep as written */ }
  if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('/') || rel.includes('\\') || rel.split('/').some((s) => s === '..')) return { error: 'only pictures in the document folder can be used' };
  if (!/\.(png|jpe?g)$/i.test(rel)) return { error: 'only PNG and JPEG pictures can be used' };
  let root: string;
  let abs: string;
  try {
    root = fs.realpathSync(baseDir);
    abs = fs.realpathSync(path.resolve(root, ...rel.split('/')));
  } catch { return { error: 'the file was not found' }; }
  if (!abs.startsWith(root + path.sep)) return { error: 'the picture is outside the document folder' };
  const st = fs.statSync(abs);
  if (!st.isFile() || st.size === 0 || st.size > MARKDOWN_DOCX_LIMITS.imageBytes) return { error: 'the picture is empty or over 15 MB' };
  const data = fs.readFileSync(abs);
  const info = imageInfo(data);
  return info ? { data, ...info } : { error: 'the file is not a PNG or JPEG picture' };
}

// ── Reading the Markdown ────────────────────────────────────────────────────────────────────────────────

type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string };

/** Splits a line of text into runs: **bold**, *italic*, _italic_, `code` and [text](https://link). */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|(?<![A-Za-z0-9])_([^_\s][^_]*)_(?![A-Za-z0-9])|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    if (m[2] !== undefined || m[3] !== undefined) out.push({ text: m[2] ?? m[3], bold: true });
    else if (m[4] !== undefined || m[5] !== undefined) out.push({ text: m[4] ?? m[5], italic: true });
    else if (m[6] !== undefined) out.push({ text: m[6], code: true });
    else out.push({ text: m[7], link: m[8] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; ordered: boolean; level: number; text: string; restart: boolean }
  | { kind: 'image'; alt: string; ref: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' };

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const IMAGE_ANYWHERE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/** The blocks of a Markdown text. */
export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let afterList = false; // the previous block was a list item: the next numbered item continues the list
  const flush = (): void => { if (para.length) { blocks.push({ kind: 'para', text: para.join(' ') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush(); afterList = false;
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      blocks.push({ kind: 'code', lines: code });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { flush(); afterList = false; blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); afterList = false; blocks.push({ kind: 'rule' }); continue; }
    const image = IMAGE_LINE.exec(line.trim());
    if (image) { flush(); blocks.push({ kind: 'image', alt: image[1], ref: image[2] }); continue; }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush(); afterList = false;
      const rows = [tableCells(line)];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(tableCells(lines[i]));
      i--;
      blocks.push({ kind: 'table', rows });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { flush(); afterList = false; blocks.push({ kind: 'quote', text: quote[1] }); continue; }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const level = Math.min(MARKDOWN_DOCX_LIMITS.listLevels - 1, Math.floor(item[1].replace(/\t/g, '    ').length / 2));
      blocks.push({ kind: 'list', ordered, level, text: item[3], restart: ordered && level === 0 && !afterList });
      afterList = true;
      continue;
    }
    // A line that continues the previous list item (indented), or ordinary paragraph text.
    const prev = blocks[blocks.length - 1];
    if (!para.length && prev?.kind === 'list' && /^\s+\S/.test(line)) { prev.text += ` ${line.trim()}`; continue; }
    afterList = false;
    para.push(line.trim());
  }
  flush();
  return blocks;
}

// ── Building the Word file ──────────────────────────────────────────────────────────────────────────────

export async function markdownToDocx(md: string, opts: { baseDir?: string } = {}): Promise<MarkdownDocxResult> {
  const docx = await import('docx');
  const { Document, Paragraph, TextRun, HeadingLevel, Packer, Table, TableRow, TableCell, WidthType, ImageRun, ExternalHyperlink, AlignmentType, LevelFormat, BorderStyle, ShadingType } = docx;
  const warnings: string[] = [];
  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [];
  let images = 0;
  let numberedList = 0;

  const runs = (text: string, base: { bold?: boolean; italics?: boolean } = {}) => parseInline(text).map((r) => {
    const style = { bold: r.bold || base.bold, italics: r.italic || base.italics, ...(r.code ? { font: 'Consolas', shading: { type: ShadingType.CLEAR, fill: 'EEEEEE' } } : {}) };
    return r.link
      ? new ExternalHyperlink({ link: r.link, children: [new TextRun({ text: r.text, style: 'Hyperlink', ...style })] })
      : new TextRun({ text: r.text, ...style });
  });

  const picture = (alt: string, ref: string): Array<InstanceType<typeof Paragraph>> => {
    const img = images < MARKDOWN_DOCX_LIMITS.images ? readImage(opts.baseDir, ref) : { error: `more than ${MARKDOWN_DOCX_LIMITS.images} pictures` };
    if ('error' in img) {
      warnings.push(`Picture "${ref}" is not in the Word file: ${img.error}.`);
      return [new Paragraph({ children: [new TextRun({ text: `[Image not included: ${ref} (${img.error})]`, italics: true, color: '888888' })] })];
    }
    images++;
    const scale = Math.min(1, MARKDOWN_DOCX_LIMITS.maxWidthPx / img.width, MARKDOWN_DOCX_LIMITS.maxHeightPx / img.height);
    const out = [new Paragraph({
      alignment: AlignmentType.CENTER, keepNext: Boolean(alt), spacing: { before: 120, after: 60 },
      children: [new ImageRun({ type: img.type, data: img.data, transformation: { width: Math.max(1, Math.round(img.width * scale)), height: Math.max(1, Math.round(img.height * scale)) }, altText: { name: path.posix.basename(ref), title: alt || path.posix.basename(ref), description: alt || path.posix.basename(ref) } })],
    })];
    if (alt) out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: alt, italics: true, size: 20, color: '555555' })] }));
    return out;
  };

  // A picture written inside a paragraph or list item goes after its text, so the text stays readable.
  const split = (text: string): { text: string; pictures: Array<[string, string]> } => {
    const pictures: Array<[string, string]> = [];
    const clean = text.replace(IMAGE_ANYWHERE, (_m, alt: string, ref: string) => { pictures.push([alt, ref]); return ''; }).replace(/\s{2,}/g, ' ').trim();
    return { text: clean, pictures };
  };

  const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  for (const b of parseBlocks(md)) {
    if (b.kind === 'heading') children.push(new Paragraph({ heading: headings[b.level - 1], children: runs(b.text) }));
    else if (b.kind === 'para') {
      const { text, pictures } = split(b.text);
      if (text) children.push(new Paragraph({ spacing: { after: 120 }, children: runs(text) }));
      for (const [alt, ref] of pictures) children.push(...picture(alt, ref));
    } else if (b.kind === 'list') {
      if (b.restart) numberedList++;
      const { text, pictures } = split(b.text);
      children.push(new Paragraph({
        spacing: { after: 60 }, children: runs(text),
        numbering: b.ordered ? { reference: 'numbers', level: b.level, instance: numberedList } : { reference: 'bullets', level: b.level },
      }));
      for (const [alt, ref] of pictures) children.push(...picture(alt, ref));
    } else if (b.kind === 'image') children.push(...picture(b.alt, b.ref));
    else if (b.kind === 'code') {
      for (const line of b.lines.length ? b.lines : ['']) {
        children.push(new Paragraph({ spacing: { after: 0 }, shading: { type: ShadingType.CLEAR, fill: 'F3F3F3' }, children: [new TextRun({ text: line, font: 'Consolas', size: 19 })] }));
      }
      children.push(new Paragraph({ spacing: { after: 80 }, children: [] }));
    } else if (b.kind === 'quote') {
      children.push(new Paragraph({ indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'AAAAAA', space: 8 } }, children: runs(b.text, { italics: true }) }));
    } else if (b.kind === 'rule') {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 1 } }, children: [] }));
    } else if (b.kind === 'table') {
      const cols = Math.max(...b.rows.map((r) => r.length));
      const cell = (text: string, header: boolean) => new TableCell({
        shading: header ? { type: ShadingType.CLEAR, fill: 'E8EEF7' } : undefined,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new Paragraph({ children: runs(split(text).text, { bold: header }) })],
      });
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: b.rows.map((r, ri) => new TableRow({ tableHeader: ri === 0, children: Array.from({ length: cols }, (_x, ci) => cell(r[ci] ?? '', ri === 0)) })),
      }));
      children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
    }
  }

  const levels = (format: (typeof LevelFormat)[keyof typeof LevelFormat], text: (n: number) => string) => Array.from({ length: MARKDOWN_DOCX_LIMITS.listLevels }, (_x, level) => ({
    level, format, text: text(level), alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
  }));
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: [
        { reference: 'bullets', levels: levels(LevelFormat.BULLET, (l) => ['•', '◦', '▪'][l] ?? '•') },
        { reference: 'numbers', levels: levels(LevelFormat.DECIMAL, (l) => `%${l + 1}.`) },
      ],
    },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children: children.length ? children : [new Paragraph({ children: [] })] }],
  });
  return { buffer: await Packer.toBuffer(doc), warnings };
}
