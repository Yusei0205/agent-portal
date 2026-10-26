import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import JSZip from 'jszip';
import { badRequest, slugify, sha256 } from './util.ts';
import { requirePdfCapability } from './docs-pack.ts';

const execFileP = promisify(execFile);

export const SUPPORTED = ['.md', '.markdown', '.txt', '.pdf', '.docx', '.xlsx', '.pptx', '.html', '.htm', '.csv', '.json', '.yaml', '.yml', '.odt', '.rtf', '.epub'];

export interface Section {
  heading: string;
  level: number;
  anchor: string;
  content: string;
  hash: string;
}

/* ------------------------------------------------------------------ */
/* XML helpers                                                         */
/* ------------------------------------------------------------------ */

export function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Find the index just past the close tag that matches the open tag at `start`, honouring nesting. */
function matchClose(xml: string, tag: string, start: number): number {
  const openRe = new RegExp(`<${tag}(?=[\\s>/])`, 'g');
  const closeTag = `</${tag}>`;
  // self-closing open tag
  const firstGt = xml.indexOf('>', start);
  if (firstGt > 0 && xml[firstGt - 1] === '/') return firstGt + 1;
  let depth = 1;
  let pos = firstGt + 1;
  while (depth > 0) {
    openRe.lastIndex = pos;
    const nextOpen = openRe.exec(xml);
    const nextClose = xml.indexOf(closeTag, pos);
    if (nextClose < 0) return xml.length;
    if (nextOpen && nextOpen.index < nextClose) {
      const gt = xml.indexOf('>', nextOpen.index);
      if (xml[gt - 1] !== '/') depth++;
      pos = gt + 1;
    } else {
      depth--;
      pos = nextClose + closeTag.length;
    }
  }
  return pos;
}

/** Top-level child elements with one of `tags`, in document order. */
function children(xml: string, tags: string[]): { tag: string; xml: string }[] {
  const out: { tag: string; xml: string }[] = [];
  const re = new RegExp(`<(${tags.map((t) => t.replace(':', '\\:')).join('|')})(?=[\\s>/])`, 'g');
  let m: RegExpExecArray | null;
  let pos = 0;
  while ((re.lastIndex = pos), (m = re.exec(xml))) {
    const end = matchClose(xml, m[1], m.index);
    out.push({ tag: m[1], xml: xml.slice(m.index, end) });
    pos = end;
  }
  return out;
}

function attr(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`${name.replace(':', '\\:')}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
}

/* ------------------------------------------------------------------ */
/* DOCX                                                                */
/* ------------------------------------------------------------------ */

function docxStyleLevels(stylesXml: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of children(stylesXml, ['w:style'])) {
    const id = attr(s.xml, 'w:styleId');
    const name = s.xml.match(/<w:name w:val="([^"]+)"/)?.[1]?.toLowerCase() ?? '';
    if (!id) continue;
    const h = name.match(/^heading (\d)$/);
    if (h) map.set(id, Number(h[1]));
    else if (name === 'title') map.set(id, 1);
    else {
      const lvl = s.xml.match(/<w:outlineLvl w:val="(\d)"/);
      if (lvl) map.set(id, Number(lvl[1]) + 1);
    }
  }
  return map;
}

function docxRunsText(pXml: string): string {
  let text = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:br [^>]*\/>|<w:cr\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pXml))) {
    if (m[1] !== undefined) text += decodeXml(m[1]);
    else if (m[0].startsWith('<w:tab')) text += '\t';
    else text += '\n';
  }
  return text;
}

function docxParagraph(pXml: string, styles: Map<string, number>): string {
  const text = docxRunsText(pXml).replace(/[ \t]+$/g, '');
  if (!text.trim()) return '';
  const styleId = pXml.match(/<w:pStyle w:val="([^"]+)"/)?.[1];
  let level = styleId ? styles.get(styleId) ?? 0 : 0;
  if (!level && styleId) {
    const h = styleId.match(/^(?:Heading|heading|berschrift|Titre|Kop)(\d)$/);
    if (h) level = Number(h[1]);
    else if (/^Title$/i.test(styleId)) level = 1;
  }
  const outline = pXml.match(/<w:pPr>[\s\S]*?<w:outlineLvl w:val="(\d)"/);
  if (!level && outline) level = Number(outline[1]) + 1;
  if (level) return `${'#'.repeat(Math.min(level, 6))} ${text.replace(/\s+/g, ' ').trim()}`;
  if (/<w:numPr>/.test(pXml)) {
    const ilvl = Number(pXml.match(/<w:ilvl w:val="(\d)"/)?.[1] ?? 0);
    return `${'  '.repeat(ilvl)}- ${text.trim()}`;
  }
  return text.trim();
}

function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n+/g, '<br>').trim();
}

function mdTable(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length));
  if (!width) return '';
  const norm = rows.map((r) => [...r, ...Array(width - r.length).fill('')].map(mdCell));
  const [head, ...body] = norm;
  return [
    `| ${head.map((h, i) => h || `Column ${i + 1}`).join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function docxBlocks(xml: string, styles: Map<string, number>): string[] {
  const out: string[] = [];
  for (const b of children(xml, ['w:p', 'w:tbl', 'w:sdt'])) {
    if (b.tag === 'w:p') {
      const p = docxParagraph(b.xml, styles);
      if (p) out.push(p);
    } else if (b.tag === 'w:sdt') {
      const content = b.xml.match(/<w:sdtContent>([\s\S]*)<\/w:sdtContent>/);
      if (content) out.push(...docxBlocks(content[1], styles));
    } else {
      const rows = children(b.xml.slice(b.xml.indexOf('>') + 1), ['w:tr']).map((tr) =>
        children(tr.xml.slice(tr.xml.indexOf('>') + 1), ['w:tc']).map((tc) =>
          docxBlocks(tc.xml.slice(tc.xml.indexOf('>') + 1), styles)
            .map((s) => s.replace(/^#+\s+/, ''))
            .join('\n'),
        ),
      );
      if (rows.length) out.push(mdTable(rows));
    }
  }
  return out;
}

export async function docxToMarkdown(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const doc = await zip.file('word/document.xml')?.async('string');
  if (!doc) throw badRequest('This .docx file has no document body');
  const stylesXml = (await zip.file('word/styles.xml')?.async('string')) ?? '';
  const styles = docxStyleLevels(stylesXml);
  const body = doc.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? doc;
  return docxBlocks(body, styles).join('\n\n');
}

/* ------------------------------------------------------------------ */
/* XLSX                                                                */
/* ------------------------------------------------------------------ */

function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function xlsxToMarkdown(buf: Buffer, maxRows = 500, maxCols = 30): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const wb = await zip.file('xl/workbook.xml')?.async('string');
  if (!wb) throw badRequest('This .xlsx file has no workbook');
  const rels = (await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) ?? '';
  const relMap = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) relMap.set(id, target.replace(/^\/?xl\//, ''));
  }
  const shared: string[] = [];
  const sst = await zip.file('xl/sharedStrings.xml')?.async('string');
  if (sst) {
    for (const si of children(sst, ['si'])) {
      shared.push([...si.xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join(''));
    }
  }
  const parts: string[] = [];
  for (const sheet of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attr(sheet[0], 'name') ?? 'Sheet';
    const rid = attr(sheet[0], 'r:id');
    const target = rid ? relMap.get(rid) : undefined;
    const xml = target ? await zip.file('xl/' + target)?.async('string') : undefined;
    if (!xml) continue;
    const grid: string[][] = [];
    let truncated = false;
    for (const row of children(xml, ['row'])) {
      if (grid.length >= maxRows) {
        truncated = true;
        break;
      }
      const cells: string[] = [];
      for (const c of children(row.xml.slice(row.xml.indexOf('>') + 1), ['c'])) {
        const ref = attr(c.xml.slice(0, c.xml.indexOf('>') + 1), 'r') ?? '';
        const t = attr(c.xml.slice(0, c.xml.indexOf('>') + 1), 't');
        const v = c.xml.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = '';
        if (t === 's' && v !== undefined) value = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') value = [...c.xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');
        else if (v !== undefined) value = decodeXml(v);
        const idx = ref ? colIndex(ref) : cells.length;
        if (idx < maxCols) cells[idx] = value;
      }
      grid.push(Array.from(cells, (x) => x ?? ''));
    }
    const rows = grid.filter((r) => r.some((c) => c.trim()));
    parts.push(`## ${name}\n\n${rows.length ? mdTable(rows) : '_Empty sheet._'}${truncated ? `\n\n_Only the first ${maxRows} rows are included._` : ''}`);
  }
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* PPTX                                                                */
/* ------------------------------------------------------------------ */

export async function pptxToMarkdown(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  const parts: string[] = [];
  for (const [i, f] of slides.entries()) {
    const xml = await zip.file(f)!.async('string');
    const paras = children(xml, ['a:p'])
      .map((p) => [...p.xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1])).join('').trim())
      .filter(Boolean);
    const title = paras.shift() ?? '';
    parts.push(`## Slide ${i + 1}${title ? `: ${title}` : ''}\n\n${paras.map((p) => `- ${p}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

const PDFJS = 'pdfjs-dist/legacy/build/pdf.mjs';

export async function pdfToMarkdown(buf: Buffer): Promise<string> {
  requirePdfCapability();
  const pdfjs: any = await import(PDFJS);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const lines: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    let line = '';
    let lastY: number | null = null;
    const flush = () => {
      const t = line.replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
      line = '';
    };
    for (const item of tc.items as any[]) {
      if (typeof item.str !== 'string') continue;
      const y = item.transform?.[5] ?? null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && line) flush();
      line += item.str;
      if (item.hasEOL) flush();
      lastY = y;
    }
    flush();
    lines.push('');
    page.cleanup?.();
  }
  await doc.destroy?.();
  // Promote numbered headings ("2.1 Payment rules") so sections survive.
  return lines
    .map((l) => {
      const m = l.match(/^(\d+(?:\.\d+){0,3})\.?\s+([A-Z][^.!?]{2,80})$/);
      if (m) return `\n${'#'.repeat(Math.min(m[1].split('.').length + 1, 4))} ${m[1]} ${m[2]}\n`;
      return l;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* HTML                                                                */
/* ------------------------------------------------------------------ */

export function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, l, t) => `\n\n${'#'.repeat(Number(l))} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote|pre)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '_$2_')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<[^>]+>/g, '');
  s = decodeXml(s.replace(/&nbsp;/g, ' '));
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

async function hasPandoc(): Promise<boolean> {
  try {
    await execFileP('pandoc', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function viaPandoc(buf: Buffer, ext: string): Promise<string> {
  if (!(await hasPandoc())) {
    throw badRequest(`${ext} files need pandoc installed on the server. Convert to .docx, .pdf or .md and upload again.`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-conv-'));
  const file = path.join(dir, 'input' + ext);
  try {
    fs.writeFileSync(file, buf);
    const { stdout } = await execFileP('pandoc', [file, '-t', 'gfm', '--wrap=none'], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function toMarkdown(filename: string, buf: Buffer): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  const text = () => buf.toString('utf8').replace(/^﻿/, '');
  switch (ext) {
    case '.md':
    case '.markdown':
      return text();
    case '.txt':
      return text();
    case '.csv': {
      const rows = text()
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(0, 1000)
        .map((l) => l.split(','));
      return mdTable(rows);
    }
    case '.json':
      return '```json\n' + text() + '\n```';
    case '.yaml':
    case '.yml':
      return '```yaml\n' + text() + '\n```';
    case '.html':
    case '.htm':
      return htmlToMarkdown(text());
    case '.docx':
      return docxToMarkdown(buf);
    case '.xlsx':
      return xlsxToMarkdown(buf);
    case '.pptx':
      return pptxToMarkdown(buf);
    case '.pdf':
      return pdfToMarkdown(buf);
    case '.odt':
    case '.rtf':
    case '.epub':
      return viaPandoc(buf, ext);
    default:
      throw badRequest(`Files of type ${ext || '(none)'} are not supported. Use: ${SUPPORTED.join(', ')}`);
  }
}

/* ------------------------------------------------------------------ */
/* Sectioning                                                          */
/* ------------------------------------------------------------------ */

const MAX_SECTION_CHARS = 12_000;

export function sectionize(md: string, docTitle: string): Section[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const raw: { heading: string; level: number; body: string[] }[] = [];
  let cur = { heading: docTitle, level: 1, body: [] as string[] };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (h) {
      if (cur.body.join('').trim()) raw.push(cur);
      cur = { heading: h[2].trim(), level: h[1].length, body: [] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.body.join('').trim() || !raw.length) raw.push(cur);

  // Split long sections, and chunk heading-less documents into parts.
  const out: { heading: string; level: number; content: string }[] = [];
  for (const s of raw) {
    const content = s.body.join('\n').trim();
    if (content.length <= MAX_SECTION_CHARS) {
      out.push({ heading: s.heading, level: s.level, content });
      continue;
    }
    const paras = content.split(/\n{2,}/);
    let buf = '';
    let part = 1;
    for (const p of paras) {
      if (buf && buf.length + p.length > MAX_SECTION_CHARS * 0.6) {
        out.push({ heading: part === 1 ? s.heading : `${s.heading} (part ${part})`, level: s.level, content: buf.trim() });
        part++;
        buf = '';
      }
      buf += p + '\n\n';
    }
    if (buf.trim()) out.push({ heading: part === 1 ? s.heading : `${s.heading} (part ${part})`, level: s.level, content: buf.trim() });
  }

  const used = new Set<string>();
  return out.map((s) => {
    let anchor = slugify(s.heading, 60);
    let i = 2;
    while (used.has(anchor)) anchor = `${slugify(s.heading, 56)}-${i++}`;
    used.add(anchor);
    return { ...s, anchor, hash: sha256(s.heading + '\n' + s.content) };
  });
}
