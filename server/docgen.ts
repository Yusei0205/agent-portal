/**
 * Create Word, Excel, CSV and PowerPoint files from a small JSON description.
 *
 * Runs wherever the portal runs (no desktop app, no network): used by the agents' "make-documents"
 * skill through the `make-doc` command (docgen-cli.ts), and importable for tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';

export type Cell = string | number | boolean | null | { formula: string };

export type Block =
  | { type: 'heading'; level?: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'numbered'; items: string[] }
  | { type: 'table'; header?: string[]; rows: string[][] }
  | { type: 'code'; text: string }
  | { type: 'pagebreak' };

export interface Slide {
  layout?: 'title' | 'bullets' | 'text' | 'table' | 'section';
  title?: string;
  subtitle?: string;
  bullets?: string[];
  text?: string;
  table?: { header?: string[]; rows: string[][] };
  notes?: string;
}

export type DocSpec =
  | { type: 'docx'; output: string; title?: string; markdown?: string; blocks?: Block[] }
  | { type: 'xlsx'; output: string; sheets: { name?: string; header?: string[]; rows: Cell[][]; widths?: number[] }[] }
  | { type: 'csv'; output: string; header?: string[]; rows: Cell[][]; bom?: boolean }
  | { type: 'pptx'; output: string; title?: string; author?: string; slides: Slide[] };

export interface DocResult {
  type: string;
  output: string;
  bytes: number;
  summary: string;
}

const LIMITS = { rows: 100_000, cols: 200, slides: 200, blocks: 5000, text: 200_000 };

export class DocError extends Error {}

function fail(msg: string): never {
  throw new DocError(msg);
}

function str(v: unknown, what: string, max = LIMITS.text): string {
  if (typeof v !== 'string') fail(`${what} must be text`);
  if (v.length > max) fail(`${what} is too long`);
  return v;
}

/* ------------------------------------------------------------------ */
/* Markdown → blocks                                                   */
/* ------------------------------------------------------------------ */

interface ListItem {
  text: string;
  level: number;
}
type MdBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'table'; header?: string[]; rows: string[][] }
  | { type: 'code'; text: string }
  | { type: 'pagebreak' };

function flattenList(token: any, level: number, out: ListItem[]): void {
  for (const item of token.items ?? []) {
    const own = (item.tokens ?? []).filter((t: any) => t.type !== 'list');
    const text = own.map((t: any) => t.raw ?? t.text ?? '').join('').trim().replace(/\n+/g, ' ');
    out.push({ text, level });
    for (const sub of (item.tokens ?? []).filter((t: any) => t.type === 'list')) flattenList(sub, level + 1, out);
  }
}

export function markdownToBlocks(md: string): MdBlock[] {
  const out: MdBlock[] = [];
  for (const t of marked.lexer(md) as any[]) {
    if (t.type === 'heading') out.push({ type: 'heading', level: t.depth, text: t.text });
    else if (t.type === 'paragraph') out.push({ type: 'paragraph', text: t.text });
    else if (t.type === 'blockquote') out.push({ type: 'paragraph', text: String(t.text ?? '').replace(/^>\s?/gm, '') });
    else if (t.type === 'list') {
      const items: ListItem[] = [];
      flattenList(t, 0, items);
      out.push({ type: 'list', ordered: Boolean(t.ordered), items });
    } else if (t.type === 'table') {
      out.push({ type: 'table', header: t.header.map((c: any) => c.text), rows: t.rows.map((r: any[]) => r.map((c) => c.text)) });
    } else if (t.type === 'code') out.push({ type: 'code', text: t.text });
    else if (t.type === 'hr') out.push({ type: 'pagebreak' });
  }
  return out;
}

function blocksFromSpec(blocks: Block[]): MdBlock[] {
  if (!Array.isArray(blocks)) fail('"blocks" must be a list');
  if (blocks.length > LIMITS.blocks) fail(`Too many blocks (max ${LIMITS.blocks})`);
  return blocks.map((b, i): MdBlock => {
    const at = `blocks[${i}]`;
    switch (b?.type) {
      case 'heading':
        return { type: 'heading', level: Math.min(6, Math.max(1, Number(b.level) || 1)), text: str(b.text, `${at}.text`) };
      case 'paragraph':
        return { type: 'paragraph', text: str(b.text, `${at}.text`) };
      case 'bullets':
      case 'numbered':
        if (!Array.isArray(b.items)) fail(`${at}.items must be a list`);
        return { type: 'list', ordered: b.type === 'numbered', items: b.items.map((x, j) => ({ text: str(x, `${at}.items[${j}]`), level: 0 })) };
      case 'table':
        if (!Array.isArray(b.rows)) fail(`${at}.rows must be a list`);
        return { type: 'table', header: b.header?.map((x) => String(x)), rows: b.rows.map((r) => r.map((x) => String(x ?? ''))) };
      case 'code':
        return { type: 'code', text: str(b.text, `${at}.text`) };
      case 'pagebreak':
        return { type: 'pagebreak' };
      default:
        return fail(`${at}.type must be heading, paragraph, bullets, numbered, table, code or pagebreak`);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Inline Markdown (bold, italic, code, links)                         */
/* ------------------------------------------------------------------ */

function inlineTokens(text: string): any[] {
  const first = (marked.lexer(text) as any[]).find((t) => t.tokens);
  return first?.tokens ?? [{ type: 'text', text }];
}

/** Remove Markdown markers, for places that cannot show formatting (slides, cells). */
export function plain(text: string): string {
  const walk = (toks: any[]): string =>
    toks
      .map((t) => (t.type === 'br' ? '\n' : t.tokens ? walk(t.tokens) : t.type === 'escape' ? t.text : (t.text ?? t.raw ?? '')))
      .join('');
  return walk(inlineTokens(text));
}

function runs(text: string, base: { bold?: boolean; italics?: boolean; font?: string; size?: number; color?: string } = {}): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  const walk = (toks: any[], style: typeof base) => {
    for (const t of toks) {
      if (t.type === 'strong') walk(t.tokens ?? [], { ...style, bold: true });
      else if (t.type === 'em') walk(t.tokens ?? [], { ...style, italics: true });
      else if (t.type === 'codespan') out.push(new TextRun({ text: t.text, ...style, font: 'Consolas' }));
      else if (t.type === 'br') out.push(new TextRun({ text: '', break: 1 }));
      else if (t.type === 'link' && /^https?:\/\//i.test(t.href)) {
        out.push(new ExternalHyperlink({ link: t.href, children: [new TextRun({ text: plain(t.text) || t.href, ...style, color: '1155CC', underline: {} })] }));
      } else if (t.tokens) walk(t.tokens, style);
      else out.push(new TextRun({ text: t.type === 'escape' ? t.text : (t.text ?? t.raw ?? ''), ...style }));
    }
  };
  walk(inlineTokens(text), base);
  return out.length ? out : [new TextRun({ text: '', ...base })];
}

/* ------------------------------------------------------------------ */
/* Word                                                                */
/* ------------------------------------------------------------------ */

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

async function buildDocx(spec: Extract<DocSpec, { type: 'docx' }>): Promise<Buffer> {
  if (spec.markdown === undefined && spec.blocks === undefined) fail('A Word document needs "markdown" or "blocks"');
  const blocks = spec.markdown !== undefined ? markdownToBlocks(str(spec.markdown, 'markdown')) : blocksFromSpec(spec.blocks!);
  const children: (Paragraph | Table)[] = [];
  const numberings: string[] = [];
  if (spec.title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: runs(str(spec.title, 'title', 300)) }));

  for (const b of blocks) {
    if (b.type === 'heading') {
      children.push(new Paragraph({ heading: HEADINGS[b.level - 1], children: runs(b.text) }));
    } else if (b.type === 'paragraph') {
      children.push(new Paragraph({ spacing: { after: 120 }, children: runs(b.text) }));
    } else if (b.type === 'list') {
      // A fresh numbering reference per numbered list so each list starts again at 1.
      const ref = b.ordered ? `num-${numberings.push('x')}` : '';
      for (const it of b.items) {
        const level = Math.min(it.level, 5);
        children.push(
          b.ordered
            ? new Paragraph({ numbering: { reference: ref, level }, children: runs(it.text) })
            : new Paragraph({ bullet: { level }, children: runs(it.text) }),
        );
      }
    } else if (b.type === 'table') {
      const cols = Math.max(b.header?.length ?? 0, ...b.rows.map((r) => r.length), 1);
      const cell = (text: string, header: boolean) =>
        new TableCell({
          shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E6F0EF' } : undefined,
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          children: [new Paragraph({ children: runs(text, header ? { bold: true } : {}) })],
        });
      const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? '');
      const rows: TableRow[] = [];
      if (b.header) rows.push(new TableRow({ tableHeader: true, children: pad(b.header).map((c) => cell(c, true)) }));
      for (const r of b.rows) rows.push(new TableRow({ children: pad(r).map((c) => cell(c, false)) }));
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
      children.push(new Paragraph({ children: [] }));
    } else if (b.type === 'code') {
      for (const line of b.text.split('\n')) {
        children.push(
          new Paragraph({
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' },
            children: [new TextRun({ text: line, font: 'Consolas', size: 19 })],
          }),
        );
      }
    } else if (b.type === 'pagebreak') {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }

  const levelsFor = () =>
    Array.from({ length: 6 }, (_, level) => ({
      level,
      format: LevelFormat.DECIMAL,
      text: `%${level + 1}.`,
      alignment: AlignmentType.START,
      style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
    }));
  const doc = new Document({
    title: spec.title,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: { config: numberings.map((_, i) => ({ reference: `num-${i + 1}`, levels: levelsFor() })) },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

/* ------------------------------------------------------------------ */
/* Excel and CSV                                                       */
/* ------------------------------------------------------------------ */

function checkGrid(rows: unknown, header: unknown, what: string): void {
  if (!Array.isArray(rows)) fail(`${what} "rows" must be a list of rows`);
  if (rows.length > LIMITS.rows) fail(`Too many rows (max ${LIMITS.rows})`);
  const width = Math.max(Array.isArray(header) ? header.length : 0, ...rows.map((r) => (Array.isArray(r) ? r.length : fail(`${what}: every row must be a list`))), 0);
  if (width > LIMITS.cols) fail(`Too many columns (max ${LIMITS.cols})`);
}

function cellText(c: Cell | undefined): string {
  if (c === null || c === undefined) return '';
  if (typeof c === 'object') return `=${c.formula}`;
  return String(c);
}

async function buildXlsx(spec: Extract<DocSpec, { type: 'xlsx' }>): Promise<Buffer> {
  if (!Array.isArray(spec.sheets) || !spec.sheets.length) fail('An Excel file needs at least one sheet in "sheets"');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Agent Portal';
  const used = new Set<string>();
  spec.sheets.forEach((s, i) => {
    checkGrid(s.rows, s.header, `Sheet ${i + 1}`);
    // Excel sheet names: max 31 characters, none of []:*?/\ and unique.
    let name = (s.name ?? `Sheet${i + 1}`).replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${name.slice(0, 28)} ${n}`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name);
    const all: Cell[][] = [];
    if (s.header?.length) all.push(s.header);
    all.push(...s.rows);
    for (const r of all) {
      ws.addRow(r.map((c) => (c !== null && typeof c === 'object' ? { formula: String(c.formula).replace(/^=/, '') } : c)));
    }
    if (s.header?.length) {
      const head = ws.getRow(1);
      head.font = { bold: true };
      head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F0EF' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.header.length } };
    }
    const cols = Math.max(...all.map((r) => r.length), 0);
    for (let c = 1; c <= cols; c++) {
      const given = s.widths?.[c - 1];
      const longest = Math.max(...all.slice(0, 500).map((r) => cellText(r[c - 1]).length), 0);
      ws.getColumn(c).width = given ? Math.min(100, Math.max(4, given)) : Math.min(60, Math.max(8, longest + 2));
    }
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Quote per RFC 4180, and defuse spreadsheet formulas in text cells (CSV injection). */
function csvField(c: Cell | undefined): string {
  let t = cellText(c);
  if (typeof c === 'string' && /^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = `'${t}`;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

function buildCsv(spec: Extract<DocSpec, { type: 'csv' }>): Buffer {
  checkGrid(spec.rows, spec.header, 'CSV');
  const lines = [...(spec.header?.length ? [spec.header] : []), ...spec.rows].map((r) => r.map(csvField).join(','));
  // The BOM makes Excel open UTF-8 text correctly; turn it off with "bom": false.
  return Buffer.from((spec.bom === false ? '' : '﻿') + lines.join('\r\n') + '\r\n', 'utf8');
}

/* ------------------------------------------------------------------ */
/* PowerPoint                                                          */
/* ------------------------------------------------------------------ */

const THEME = { ink: '1F2937', muted: '6B7280', accent: '0F766E', wash: 'E6F0EF', font: 'Calibri' };

async function buildPptx(spec: Extract<DocSpec, { type: 'pptx' }>): Promise<Buffer> {
  if (!Array.isArray(spec.slides) || !spec.slides.length) fail('A presentation needs at least one slide in "slides"');
  if (spec.slides.length > LIMITS.slides) fail(`Too many slides (max ${LIMITS.slides})`);
  // pptxgenjs is CommonJS: depending on the loader the class is the default export or its .default.
  const Pptx: any = (PptxGenJS as any).default ?? PptxGenJS;
  const pptx: any = new Pptx();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.title = spec.title ?? '';
  pptx.author = spec.author ?? 'Agent Portal';

  spec.slides.forEach((s, i) => {
    const layout = s.layout ?? (i === 0 && !s.bullets && !s.table && !s.text ? 'title' : s.table ? 'table' : s.text && !s.bullets ? 'text' : 'bullets');
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    const title = plain(String(s.title ?? ''));
    if (layout === 'title' || layout === 'section') {
      slide.background = { color: layout === 'title' ? THEME.accent : THEME.wash };
      const fg = layout === 'title' ? 'FFFFFF' : THEME.ink;
      slide.addText(title || spec.title || '', { x: 0.8, y: 2.3, w: 11.7, h: 1.4, fontFace: THEME.font, fontSize: 40, bold: true, color: fg, valign: 'bottom' });
      if (s.subtitle) slide.addText(plain(s.subtitle), { x: 0.8, y: 3.8, w: 11.7, h: 1, fontFace: THEME.font, fontSize: 20, color: fg, valign: 'top' });
    } else {
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: THEME.accent }, line: { color: THEME.accent } });
      slide.addText(title, { x: 0.7, y: 0.4, w: 12, h: 0.9, fontFace: THEME.font, fontSize: 30, bold: true, color: THEME.ink, valign: 'middle' });
      if (layout === 'bullets') {
        const items = (s.bullets ?? []).map((b) => plain(String(b)));
        const size = items.length > 9 ? 16 : items.length > 6 ? 20 : 24;
        slide.addText(
          items.map((text) => ({ text, options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } })),
          { x: 0.7, y: 1.5, w: 12, h: 5.4, fontFace: THEME.font, fontSize: size, color: THEME.ink, valign: 'top', fit: 'shrink' },
        );
      } else if (layout === 'text') {
        slide.addText(plain(String(s.text ?? '')), { x: 0.7, y: 1.5, w: 12, h: 5.4, fontFace: THEME.font, fontSize: 22, color: THEME.ink, valign: 'top', fit: 'shrink' });
      } else if (layout === 'table') {
        const t = s.table;
        if (!t || !Array.isArray(t.rows)) fail(`slides[${i}] has layout "table" but no "table" with rows`);
        const body = t.rows.map((r) => r.map((c) => ({ text: plain(String(c ?? '')), options: { fontFace: THEME.font, fontSize: 14, color: THEME.ink } })));
        const head = t.header ? [t.header.map((c) => ({ text: plain(String(c)), options: { bold: true, fontFace: THEME.font, fontSize: 14, color: 'FFFFFF', fill: { color: THEME.accent } } }))] : [];
        slide.addTable([...head, ...body], { x: 0.7, y: 1.5, w: 12, border: { type: 'solid', pt: 0.75, color: 'D1D5DB' }, autoPage: true, autoPageRepeatHeader: Boolean(t.header) });
      } else {
        fail(`slides[${i}].layout must be title, section, bullets, text or table`);
      }
    }
    if (s.notes) slide.addNotes(plain(String(s.notes)));
  });
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

const EXT: Record<string, string> = { docx: '.docx', xlsx: '.xlsx', csv: '.csv', pptx: '.pptx' };

/** Resolve `output` inside baseDir only, with the extension that matches the type. */
export function safeOutput(baseDir: string, output: unknown, type: string): string {
  if (typeof output !== 'string' || !output.trim()) fail('"output" must be a file path');
  const abs = path.resolve(baseDir, output);
  const root = path.resolve(baseDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) fail(`"output" must be inside ${root}`);
  if (path.extname(abs).toLowerCase() !== EXT[type]) fail(`"output" must end in ${EXT[type]} for type "${type}"`);
  return abs;
}

export async function generate(spec: DocSpec, opts: { baseDir?: string } = {}): Promise<DocResult> {
  if (!spec || typeof spec !== 'object' || !(spec.type in EXT)) fail('"type" must be docx, xlsx, csv or pptx');
  const abs = safeOutput(opts.baseDir ?? process.cwd(), spec.output, spec.type);
  let buf: Buffer;
  let summary: string;
  switch (spec.type) {
    case 'docx':
      buf = await buildDocx(spec);
      summary = 'Word document';
      break;
    case 'xlsx':
      buf = await buildXlsx(spec);
      summary = `Excel workbook, ${spec.sheets.length} sheet${spec.sheets.length === 1 ? '' : 's'}`;
      break;
    case 'csv':
      buf = buildCsv(spec);
      summary = `CSV, ${spec.rows.length} row${spec.rows.length === 1 ? '' : 's'}`;
      break;
    case 'pptx':
      buf = await buildPptx(spec);
      summary = `PowerPoint, ${spec.slides.length} slide${spec.slides.length === 1 ? '' : 's'}`;
      break;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return { type: spec.type, output: abs, bytes: buf.length, summary };
}
