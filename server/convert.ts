/**
 * Document format conversion to Markdown.
 *
 * All conversions are implemented with zero extra packages beyond those already
 * in package.json (jszip, pdfjs-dist, docx, exceljs, pptxgenjs).  The pptx
 * conversion reads the Open-XML archive directly with JSZip so it never needs
 * pptxgenjs at runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { requirePdfCapability } from './docs-pack.ts';
import { badRequest } from './util.ts';

// ── XML helpers (shared by DOCX / XLSX / PPTX parsers) ───────────────────────

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Find all top-level child elements matching any of `tags` in `xml`. */
function children(xml: string, tags: string[]): { tag: string; xml: string }[] {
  const out: { tag: string; xml: string }[] = [];
  const re = new RegExp(`<(${tags.map((t) => t.replace(':', '\\:')).join('|')})(?=[\\s>/])`, 'g');
  let m: RegExpExecArray | null;
  let pos = 0;

  const matchClose = (tag: string, start: number): number => {
    const openRe = new RegExp(`<${tag.replace(':', '\\:')}(?=[\\s>/])`, 'g');
    const closeTag = `</${tag}>`;
    const firstGt = xml.indexOf('>', start);
    if (firstGt > 0 && xml[firstGt - 1] === '/') return firstGt + 1;
    let depth = 1;
    let p2 = firstGt + 1;
    while (depth > 0) {
      openRe.lastIndex = p2;
      const nxtOpen = openRe.exec(xml);
      const nxtClose = xml.indexOf(closeTag, p2);
      if (nxtClose < 0) return xml.length;
      if (nxtOpen && nxtOpen.index < nxtClose) {
        const gt = xml.indexOf('>', nxtOpen.index);
        if (xml[gt - 1] !== '/') depth++;
        p2 = gt + 1;
      } else {
        depth--;
        p2 = nxtClose + closeTag.length;
      }
    }
    return p2;
  };

  while ((re.lastIndex = pos), (m = re.exec(xml))) {
    const end = matchClose(m[1], m.index);
    out.push({ tag: m[1], xml: xml.slice(m.index, end) });
    pos = end;
  }
  return out;
}

function attr(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`${name.replace(':', '\\:')}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
}

function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n+/g, '<br>').trim();
}

function mdTable(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length));
  if (!width) return '';
  const norm = rows.map((r) =>
    [...r, ...Array(Math.max(0, width - r.length)).fill('')].map(mdCell),
  );
  const [head, ...body] = norm;
  if (!head) return '';
  return [
    `| ${head.map((h, i) => h || `Column ${i + 1}`).join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

// ── DOCX ──────────────────────────────────────────────────────────────────────

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
  const re = /<w:t(?:\s[^>]*)?>([^\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:br [^>]*\/>|<w:cr\/>/g;
  // Use a non-greedy dot-all match:
  const re2 = /<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g;
  let m: RegExpExecArray | null;
  // Extract all <w:t> content
  while ((m = re2.exec(pXml))) {
    const inner = m[0].replace(/<w:t(?:\s[^>]*)?>/, '').replace(/<\/w:t>$/, '');
    text += decodeXml(inner);
  }
  return text;
}

function docxParagraph(pXml: string, styles: Map<string, number>): string {
  const text = docxRunsText(pXml).replace(/[ \t]+$/g, '');
  if (!text.trim()) return '';
  const styleId = pXml.match(/<w:pStyle w:val="([^"]+)"/)?.[1];
  let level = styleId ? (styles.get(styleId) ?? 0) : 0;
  if (!level && styleId) {
    const h = styleId.match(/^(?:Heading|heading|berschrift|Titre|Kop)(\d)$/);
    if (h) level = Number(h[1]);
    else if (/^Title$/i.test(styleId)) level = 1;
  }
  const outline = pXml.match(/<w:pPr>[\s\S]*?<w:outlineLvl w:val="(\d)"/);
  if (!level && outline) level = Number(outline[1]) + 1;
  if (level) return `${'#'.repeat(Math.min(level, 6))} ${text.replace(/\s+/g, ' ').trim()}`;
  if (/<w:numPr>/.test(pXml)) {
    const ilvl = Number(pXml.match(/<w:ilvl w:val="(\d)">/)?.[1] ?? 0);
    return `${'  '.repeat(ilvl)}- ${text.trim()}`;
  }
  return text.trim();
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
      // table
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

export async function docxToMarkdown(filePath: string): Promise<string> {
  const buf = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);
  const doc = await zip.file('word/document.xml')?.async('string');
  if (!doc) throw badRequest('This .docx file has no document body');
  const stylesXml = (await zip.file('word/styles.xml')?.async('string')) ?? '';
  const styles = docxStyleLevels(stylesXml);
  const body = doc.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? doc;
  return docxBlocks(body, styles).join('\n\n');
}

// ── XLSX ──────────────────────────────────────────────────────────────────────

function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function xlsxToMarkdown(filePath: string): Promise<string> {
  const buf = fs.readFileSync(filePath);
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
      shared.push(
        [...si.xml.matchAll(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g)]
          .map((m2) => decodeXml(m2[0].replace(/<t(?:\s[^>]*)?>/, '').replace(/<\/t>$/, '')))
          .join(''),
      );
    }
  }

  const parts: string[] = [];
  const MAX_ROWS = 500;
  const MAX_COLS = 30;

  for (const sheet of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attr(sheet[0], 'name') ?? 'Sheet';
    const rid = attr(sheet[0], 'r:id');
    const target = rid ? relMap.get(rid) : undefined;
    const xml = target ? await zip.file('xl/' + target)?.async('string') : undefined;
    if (!xml) continue;

    const grid: string[][] = [];
    let truncated = false;

    for (const row of children(xml, ['row'])) {
      if (grid.length >= MAX_ROWS) { truncated = true; break; }
      const cells: string[] = [];
      for (const c of children(row.xml.slice(row.xml.indexOf('>') + 1), ['c'])) {
        const firstTag = c.xml.slice(0, c.xml.indexOf('>') + 1);
        const ref = attr(firstTag, 'r') ?? '';
        const t = attr(firstTag, 't');
        const v = c.xml.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = '';
        if (t === 's' && v !== undefined) value = shared[Number(v)] ?? '';
        else if (t === 'inlineStr')
          value = [...c.xml.matchAll(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g)]
            .map((m2) => decodeXml(m2[0].replace(/<t(?:\s[^>]*)?>/, '').replace(/<\/t>$/, '')))
            .join('');
        else if (v !== undefined) value = decodeXml(v);
        const idx = ref ? colIndex(ref) : cells.length;
        if (idx < MAX_COLS) cells[idx] = value;
      }
      grid.push(Array.from(cells, (x) => x ?? ''));
    }

    const rows = grid.filter((r) => r.some((c) => c.trim()));
    parts.push(
      `## ${name}\n\n${rows.length ? mdTable(rows) : '_Empty sheet._'}${truncated ? `\n\n_Only the first ${MAX_ROWS} rows are included._` : ''}`,
    );
  }
  return parts.join('\n\n');
}

// ── PPTX ──────────────────────────────────────────────────────────────────────

export async function pptxToMarkdown(filePath: string): Promise<string> {
  const buf = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);

  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort(
      (a, b) =>
        Number(a.match(/(\d+)\.xml$/)?.[1]) - Number(b.match(/(\d+)\.xml$/)?.[1]),
    );

  const parts: string[] = [];
  for (const [i, f] of slides.entries()) {
    const xml = await zip.file(f)!.async('string');
    const paras = children(xml, ['a:p'])
      .map((p) =>
        [...p.xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
          .map((m) => decodeXml(m[1]))
          .join('')
          .trim(),
      )
      .filter(Boolean);
    const title = paras.shift() ?? '';
    parts.push(
      `## Slide ${i + 1}${title ? `: ${title}` : ''}\n\n${paras.map((p) => `- ${p}`).join('\n')}`,
    );
  }
  return parts.join('\n\n');
}

/** Extract slide text from a PPTX buffer — used by the preview endpoint. */
export async function pptxSlides(
  filePath: string,
): Promise<{ index: number; title: string; text: string }[]> {
  const buf = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);

  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort(
      (a, b) =>
        Number(a.match(/(\d+)\.xml$/)?.[1]) - Number(b.match(/(\d+)\.xml$/)?.[1]),
    );

  const result: { index: number; title: string; text: string }[] = [];
  for (const [i, f] of slideFiles.entries()) {
    const xml = await zip.file(f)!.async('string');
    const paras = children(xml, ['a:p'])
      .map((p) =>
        [...p.xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
          .map((m) => decodeXml(m[1]))
          .join('')
          .trim(),
      )
      .filter(Boolean);
    const title = paras.shift() ?? '';
    result.push({ index: i + 1, title, text: paras.join('\n') });
  }
  return result;
}

// ── PDF ───────────────────────────────────────────────────────────────────────

export async function pdfToMarkdown(filePath: string): Promise<string> {
  requirePdfCapability();
  const buf = fs.readFileSync(filePath);
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs
    .getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    })
    .promise;

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
      const y: number | null = item.transform?.[5] ?? null;
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

// ── HTML ──────────────────────────────────────────────────────────────────────

export function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, '')
    .replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_m, l: string, t: string) =>
        `\n\n${'#'.repeat(Number(l))} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`,
    )
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote|pre)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '_$2_')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<[^>]+>/g, '');

  s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

const EXT_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
};

export async function convertToMarkdown(filePath: string, mimeType: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const effectiveMime = mimeType || EXT_MIME[ext] || '';

  // Plain text passthrough
  if (
    effectiveMime.includes('text/plain') ||
    effectiveMime.includes('text/markdown') ||
    ext === '.txt' ||
    ext === '.md'
  ) {
    return fs.readFileSync(filePath, 'utf8');
  }

  // CSV — return as fenced code block
  if (effectiveMime.includes('text/csv') || ext === '.csv') {
    return '```csv\n' + fs.readFileSync(filePath, 'utf8') + '\n```';
  }

  // HTML
  if (effectiveMime.includes('text/html') || ext === '.html' || ext === '.htm') {
    return htmlToMarkdown(fs.readFileSync(filePath, 'utf8'));
  }

  // PDF
  if (effectiveMime.includes('application/pdf') || ext === '.pdf') {
    return pdfToMarkdown(filePath);
  }

  // DOCX
  if (effectiveMime.includes('wordprocessingml') || ext === '.docx') {
    return docxToMarkdown(filePath);
  }

  // XLSX
  if (effectiveMime.includes('spreadsheetml') || ext === '.xlsx') {
    return xlsxToMarkdown(filePath);
  }

  // PPTX
  if (effectiveMime.includes('presentationml') || ext === '.pptx') {
    return pptxToMarkdown(filePath);
  }

  throw badRequest(
    `Files of type ${ext || mimeType || '(unknown)'} are not supported for text extraction. ` +
      `Supported formats: PDF, DOCX, XLSX, PPTX, HTML, TXT, MD, CSV.`,
  );
}
