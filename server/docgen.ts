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
  ImageRun,
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
import { checkMermaidSource, IMAGE_LIMITS, ImageError, loadImageFile, renderToPng, safeInputPath, type Raster, type RenderItem } from './docimage.ts';
import { buildFromTemplate, type PreparedSlide, type PreparedVisual } from './pptx-template.ts';

export type Cell = string | number | boolean | null | { formula: string };

/** Size and caption options shared by images and diagrams. Width and height are in inches. */
export interface VisualOptions {
  width?: number;
  height?: number;
  alt?: string;
  caption?: string;
  align?: 'left' | 'center' | 'right';
}

export type Block =
  | ({ type: 'image'; path: string } & VisualOptions)
  | ({ type: 'mermaid'; source: string } & VisualOptions)
  | { type: 'heading'; level?: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'numbered'; items: string[] }
  | { type: 'table'; header?: string[]; rows: string[][] }
  | { type: 'code'; text: string }
  | { type: 'pagebreak' };

export interface Slide {
  layout?: 'title' | 'bullets' | 'text' | 'table' | 'section' | 'image';
  title?: string;
  subtitle?: string;
  bullets?: string[];
  text?: string;
  table?: { header?: string[]; rows: string[][] };
  /** A picture from a file inside the run folder. With bullets or text it sits on the right. */
  image?: { path: string } & VisualOptions;
  /** A Mermaid diagram, drawn on the server. Use either "image" or "mermaid" on a slide, not both. */
  mermaid?: { source: string } & VisualOptions;
  notes?: string;
}

export type DocSpec =
  | { type: 'docx'; output: string; title?: string; markdown?: string; blocks?: Block[] }
  | { type: 'xlsx'; output: string; sheets: { name?: string; header?: string[]; rows: Cell[][]; widths?: number[] }[] }
  | { type: 'csv'; output: string; header?: string[]; rows: Cell[][]; bom?: boolean }
  | { type: 'pptx'; output: string; title?: string; author?: string; slides: Slide[]; template?: string | false };

export interface DocResult {
  type: string;
  output: string;
  bytes: number;
  summary: string;
  /** Things that did not go to plan, for example a diagram that could not be drawn and was written as a code block. */
  warnings?: string[];
  /** PowerPoint only: the template the deck follows (its name or file), or absent when the built-in look was used. */
  template?: string;
}

/** Where the portal leaves the templates a run should follow (written by doc-templates.ts, read here). */
export const TEMPLATE_DIR = '.portal/templates';
export const TEMPLATE_DEFAULTS = `${TEMPLATE_DIR}/defaults.json`;
export const TEMPLATE_MAX_BYTES = 25 * 1024 * 1024;

const LIMITS = { rows: 100_000, cols: 200, slides: 200, blocks: 5000, text: 200_000 };

/* ------------------------------------------------------------------ */
/* Images and diagrams                                                 */
/* ------------------------------------------------------------------ */

type VisualReq = ({ kind: 'image'; path: string } | { kind: 'mermaid'; source: string }) & VisualOptions;
type Resolved = { ok: true; image: Raster } | { ok: false; reason: string };

function visualOptions(o: any, at: string): VisualOptions {
  const num = (v: unknown, name: string): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    if (!(n >= 0.2 && n <= 20)) fail(`${at}.${name} must be a number of inches between 0.2 and 20`);
    return n;
  };
  if (o.align !== undefined && !['left', 'center', 'right'].includes(o.align)) fail(`${at}.align must be left, center or right`);
  return {
    width: num(o.width, 'width'),
    height: num(o.height, 'height'),
    alt: o.alt === undefined ? undefined : str(o.alt, `${at}.alt`, 500),
    caption: o.caption === undefined ? undefined : str(o.caption, `${at}.caption`, 500),
    align: o.align,
  };
}

function visualReq(o: any, kind: 'image' | 'mermaid', at: string): VisualReq {
  try {
    if (kind === 'image') {
      if (typeof o?.path !== 'string' || !o.path.trim()) fail(`${at}.path must be a file path`);
      return { kind, path: o.path, ...visualOptions(o, at) };
    }
    return { kind, source: checkMermaidSource(o?.source, `${at}.source`), ...visualOptions(o, at) };
  } catch (e) {
    if (e instanceof ImageError) throw new DocError(e.message);
    throw e;
  }
}

/** Validate and load every picture, then draw all SVG and Mermaid items in one browser run. Failures to draw come back as reasons, not errors. */
async function resolveVisuals(reqs: VisualReq[], baseDir: string, warnings: string[]): Promise<Resolved[]> {
  if (reqs.length > IMAGE_LIMITS.imagesPerDoc) fail(`Too many images and diagrams (max ${IMAGE_LIMITS.imagesPerDoc})`);
  if (reqs.filter((r) => r.kind === 'mermaid').length > IMAGE_LIMITS.mermaidPerDoc) fail(`Too many Mermaid diagrams (max ${IMAGE_LIMITS.mermaidPerDoc})`);
  const out: Resolved[] = new Array(reqs.length);
  const toRender: { at: number; item: RenderItem }[] = [];
  reqs.forEach((r, i) => {
    try {
      if (r.kind === 'mermaid') {
        toRender.push({ at: i, item: { kind: 'mermaid', source: r.source } });
        return;
      }
      const loaded = loadImageFile(baseDir, r.path, `image "${r.path}"`);
      if (loaded.kind === 'raster') out[i] = { ok: true, image: loaded.image };
      else toRender.push({ at: i, item: { kind: 'svg', source: loaded.text } });
    } catch (e) {
      if (e instanceof ImageError) throw new DocError(e.message);
      throw e;
    }
  });
  if (toRender.length) {
    const rendered = await renderToPng(toRender.map((t) => t.item));
    rendered.forEach((res, k) => {
      const i = toRender[k].at;
      out[i] = res;
      if (!res.ok) {
        const r = reqs[i];
        warnings.push(`${r.kind === 'mermaid' ? 'Mermaid diagram' : `SVG image "${r.path}"`} not drawn: ${res.reason}`);
      }
    });
  }
  return out;
}

/** Display size in inches: given width/height, else natural size (up to 2x natural when asked to fill), scaled down to fit the box. */
function fitSize(img: Raster, o: VisualOptions, maxW: number, maxH: number, fill: boolean): { w: number; h: number } {
  const natW = img.pxW / img.density / 96;
  const natH = img.pxH / img.density / 96;
  let w = natW;
  let h = natH;
  if (o.width && o.height) {
    w = o.width;
    h = o.height;
  } else if (o.width) {
    w = o.width;
    h = (o.width * natH) / natW;
  } else if (o.height) {
    h = o.height;
    w = (o.height * natW) / natH;
  } else if (fill) {
    const k = Math.min(2, maxW / natW, maxH / natH);
    w = natW * k;
    h = natH * k;
  }
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: w * k, h: h * k };
}

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
  | { type: 'visual'; req: VisualReq }
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
    else if (t.type === 'paragraph') {
      const only = t.tokens?.length === 1 && t.tokens[0].type === 'image' ? t.tokens[0] : null;
      if (only && !/^[a-z][a-z0-9+.-]*:/i.test(only.href)) {
        out.push({ type: 'visual', req: { kind: 'image', path: decodeURI(only.href), alt: only.text || undefined, caption: only.title || undefined } });
      } else out.push({ type: 'paragraph', text: t.text });
    }
    else if (t.type === 'blockquote') out.push({ type: 'paragraph', text: String(t.text ?? '').replace(/^>\s?/gm, '') });
    else if (t.type === 'list') {
      const items: ListItem[] = [];
      flattenList(t, 0, items);
      out.push({ type: 'list', ordered: Boolean(t.ordered), items });
    } else if (t.type === 'table') {
      out.push({ type: 'table', header: t.header.map((c: any) => c.text), rows: t.rows.map((r: any[]) => r.map((c) => c.text)) });
    } else if (t.type === 'code' && String(t.lang ?? '').trim().split(/\s/)[0] === 'mermaid') {
      out.push({ type: 'visual', req: visualReq({ source: t.text }, 'mermaid', 'mermaid block') });
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
      case 'image':
        return { type: 'visual', req: visualReq(b, 'image', at) };
      case 'mermaid':
        return { type: 'visual', req: visualReq(b, 'mermaid', at) };
      default:
        return fail(`${at}.type must be heading, paragraph, bullets, numbered, table, code, image, mermaid or pagebreak`);
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

const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT };

function codeParagraphs(text: string): Paragraph[] {
  return text.split('\n').map(
    (line) =>
      new Paragraph({
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' },
        children: [new TextRun({ text: line, font: 'Consolas', size: 19 })],
      }),
  );
}

async function buildDocx(spec: Extract<DocSpec, { type: 'docx' }>, baseDir: string, warnings: string[]): Promise<Buffer> {
  if (spec.markdown === undefined && spec.blocks === undefined) fail('A Word document needs "markdown" or "blocks"');
  const blocks = spec.markdown !== undefined ? markdownToBlocks(str(spec.markdown, 'markdown')) : blocksFromSpec(spec.blocks!);
  const visuals = blocks.flatMap((b) => (b.type === 'visual' ? [b] : []));
  const resolved = await resolveVisuals(visuals.map((v) => v.req), baseDir, warnings);
  const visualAt = new Map(visuals.map((v, i) => [v, resolved[i]]));
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
      children.push(...codeParagraphs(b.text));
    } else if (b.type === 'visual') {
      const r = visualAt.get(b)!;
      const o = b.req;
      const label = o.alt || o.caption || (o.kind === 'image' ? o.path : 'Diagram');
      if (r.ok) {
        // Page text width is 6.5 in (Letter, 1 in margins); keep the picture on one page.
        const { w, h } = fitSize(r.image, o, 6.5, 8.5, false);
        children.push(
          new Paragraph({
            alignment: ALIGN[o.align ?? 'center'],
            keepNext: Boolean(o.caption),
            spacing: { before: 120, after: o.caption ? 40 : 160 },
            children: [
              new ImageRun({
                type: r.image.type,
                data: r.image.data,
                transformation: { width: Math.round(w * 96), height: Math.round(h * 96) },
                altText: { name: label.slice(0, 100), title: label.slice(0, 100), description: label },
              }),
            ],
          }),
        );
      } else if (o.kind === 'mermaid') {
        children.push(...codeParagraphs(o.source));
        children.push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: `Diagram not drawn (${r.reason}). The Mermaid source is shown instead.`, italics: true, color: '6B7280', size: 18 })] }));
      } else {
        children.push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: `[Image not embedded: ${o.path} (${r.reason})]`, italics: true, color: '6B7280', size: 18 })] }));
      }
      if (o.caption) {
        children.push(new Paragraph({ alignment: ALIGN[o.align ?? 'center'], spacing: { after: 160 }, children: [new TextRun({ text: plain(o.caption), italics: true, color: '4B5563', size: 20 })] }));
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

/** Put a picture, or the Mermaid source as a code box when it could not be drawn, in the content area of a slide. */
function placeVisual(_pptx: any, slide: any, req: VisualReq, res: Resolved, area: { x: number; w: number }): void {
  const top = 1.5;
  const capH = req.caption ? 0.5 : 0;
  const boxH = 5.4 - capH;
  const label = req.alt || req.caption || (req.kind === 'image' ? req.path : 'Diagram');
  if (res.ok) {
    const { w, h } = fitSize(res.image, req, area.w, boxH, true);
    const x = area.x + (req.align === 'left' ? 0 : req.align === 'right' ? area.w - w : (area.w - w) / 2);
    slide.addImage({ data: `image/${res.image.type === 'png' ? 'png' : 'jpeg'};base64,${res.image.data.toString('base64')}`, x, y: top + (boxH - h) / 2, w, h, altText: label });
  } else if (req.kind === 'mermaid') {
    slide.addText(req.source, { x: area.x, y: top, w: area.w, h: boxH - 0.5, fontFace: 'Consolas', fontSize: 12, color: THEME.ink, fill: { color: 'F3F4F6' }, valign: 'top', fit: 'shrink' });
    slide.addText(`Diagram not drawn (${res.reason}). The Mermaid source is shown instead.`, { x: area.x, y: top + boxH - 0.5, w: area.w, h: 0.5, fontFace: THEME.font, fontSize: 11, italic: true, color: THEME.muted, valign: 'middle', fit: 'shrink' });
  } else {
    slide.addText(`[Image not embedded: ${req.path} (${res.reason})]`, { x: area.x, y: top, w: area.w, h: 0.8, fontFace: THEME.font, fontSize: 14, italic: true, color: THEME.muted, valign: 'top', fit: 'shrink' });
  }
  if (req.caption) slide.addText(plain(req.caption), { x: area.x, y: top + boxH, w: area.w, h: capH, fontFace: THEME.font, fontSize: 14, italic: true, color: THEME.muted, align: 'center', valign: 'middle', fit: 'shrink' });
}

const THEME = { ink: '1F2937', muted: '6B7280', accent: '0F766E', wash: 'E6F0EF', font: 'Calibri' };

type PptxResult = { buffer: Buffer; template?: string };

interface PlannedSlide {
  s: Slide;
  req: VisualReq | null;
  visual: Resolved | null;
  layout: NonNullable<Slide['layout']>;
}

/** The template a deck should follow: the spec's `template` path, or the portal's default for this project. */
function pickTemplate(spec: Extract<DocSpec, { type: 'pptx' }>, baseDir: string, warnings: string[]): { buf: Buffer; label: string } | null {
  const t = (spec as any).template;
  if (t === false || t === 'none') return null;
  if (t !== undefined && t !== null && typeof t !== 'string') fail('"template" must be a file path inside the project folder, or false for the built-in look');
  let rel: string | undefined = typeof t === 'string' ? t : undefined;
  let label = rel ?? '';
  const defFile = path.join(baseDir, TEMPLATE_DEFAULTS);
  let defaults: any = null;
  if (fs.existsSync(defFile)) {
    try {
      defaults = JSON.parse(fs.readFileSync(defFile, 'utf8'));
    } catch {
      if (rel === undefined) warnings.push('The default template list could not be read; the built-in look was used.');
    }
  }
  if (rel === undefined) {
    const entry = defaults?.pptx;
    if (!entry || typeof entry.path !== 'string') return null;
    rel = entry.path;
    label = typeof entry.name === 'string' && entry.name ? entry.name : entry.path;
  } else {
    // A template chosen by path shows under the name it was uploaded with, when the portal knows it.
    const named = defaults?.named?.[rel.replace(/^\.\//, '')];
    if (typeof named === 'string' && named) label = named;
  }
  try {
    if (!/\.(pptx|potx)$/i.test(rel!)) throw new ImageError('a template must be a .pptx or .potx file');
    const abs = safeInputPath(baseDir, rel, 'template');
    if (fs.statSync(abs).size > TEMPLATE_MAX_BYTES) throw new ImageError(`the template is larger than ${TEMPLATE_MAX_BYTES / 1024 / 1024} MB`);
    return { buf: fs.readFileSync(abs), label };
  } catch (e: any) {
    warnings.push(`The template "${label}" could not be used (${e?.message ?? e}); the built-in look was used.`);
    return null;
  }
}

function preparedVisual(req: VisualReq, res: Resolved): PreparedVisual {
  const caption = req.caption ? plain(req.caption) : undefined;
  const label = req.alt || req.caption || (req.kind === 'image' ? req.path : 'Diagram');
  if (res.ok) {
    const img = res.image;
    return { kind: 'picture', data: img.data, ext: img.type === 'png' ? 'png' : 'jpeg', alt: label, caption, align: req.align, fit: (maxW, maxH, fill) => fitSize(img, req, maxW, maxH, fill) };
  }
  if (req.kind === 'mermaid') return { kind: 'source', text: req.source, note: `Diagram not drawn (${res.reason}). The Mermaid source is shown instead.`, caption };
  return { kind: 'missing', text: `[Image not embedded: ${req.path} (${res.reason})]`, caption };
}

async function buildPptx(spec: Extract<DocSpec, { type: 'pptx' }>, baseDir: string, warnings: string[]): Promise<PptxResult> {
  if (!Array.isArray(spec.slides) || !spec.slides.length) fail('A presentation needs at least one slide in "slides"');
  if (spec.slides.length > LIMITS.slides) fail(`Too many slides (max ${LIMITS.slides})`);

  const reqs: (VisualReq | null)[] = spec.slides.map((s, i) => {
    if (s?.image && s?.mermaid) fail(`slides[${i}] has both "image" and "mermaid"; use one`);
    if (s?.image) return visualReq(s.image, 'image', `slides[${i}].image`);
    if (s?.mermaid) return visualReq(s.mermaid, 'mermaid', `slides[${i}].mermaid`);
    return null;
  });
  const wanted = reqs.flatMap((r) => (r ? [r] : []));
  const resolvedList = await resolveVisuals(wanted, baseDir, warnings);
  let nextVisual = 0;
  const plan: PlannedSlide[] = spec.slides.map((s, i) => {
    const req = reqs[i];
    const visual = req ? resolvedList[nextVisual++] : null;
    const layout =
      s.layout ?? (req && !s.bullets && !s.text && !s.table ? 'image' : i === 0 && !s.bullets && !s.table && !s.text ? 'title' : s.table ? 'table' : s.text && !s.bullets ? 'text' : 'bullets');
    if (!['title', 'section', 'bullets', 'text', 'table', 'image'].includes(layout)) fail(`slides[${i}].layout must be title, section, bullets, text, table or image`);
    if (layout === 'table' && (!s.table || !Array.isArray(s.table.rows))) fail(`slides[${i}] has layout "table" but no "table" with rows`);
    if (layout === 'image' && !req) fail(`slides[${i}] has layout "image" but no "image" or "mermaid"`);
    return { s, req, visual, layout };
  });

  const tpl = pickTemplate(spec, baseDir, warnings);
  if (tpl) {
    try {
      const prepared: PreparedSlide[] = plan.map(({ s, req, visual, layout }) => ({
        layout,
        title: plain(String(s.title ?? '')),
        subtitle: s.subtitle ? plain(s.subtitle) : undefined,
        bullets: (s.bullets ?? []).map((b) => plain(String(b))),
        text: s.text !== undefined ? plain(String(s.text)) : undefined,
        table: s.table ? { header: s.table.header?.map((c) => plain(String(c))), rows: s.table.rows.map((r) => r.map((c) => plain(String(c ?? '')))) } : undefined,
        visual: req && visual ? preparedVisual(req, visual) : undefined,
        notes: s.notes ? plain(String(s.notes)) : undefined,
      }));
      const built = await buildFromTemplate(tpl.buf, prepared, { title: spec.title, author: spec.author ?? 'Agent Portal' });
      warnings.push(...built.warnings.map((w) => `Template "${tpl.label}": ${w}`));
      return { buffer: built.buffer, template: tpl.label };
    } catch (e: any) {
      warnings.push(`The template "${tpl.label}" could not be applied (${String(e?.message ?? e).split('\n')[0].slice(0, 200)}); the built-in look was used.`);
    }
  }

  // pptxgenjs is CommonJS: depending on the loader the class is the default export or its .default.
  const Pptx: any = (PptxGenJS as any).default ?? PptxGenJS;
  const pptx: any = new Pptx();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.title = spec.title ?? '';
  pptx.author = spec.author ?? 'Agent Portal';

  for (const { s, req, visual, layout } of plan) {
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
      const side = Boolean(req) && (layout === 'bullets' || layout === 'text');
      const textW = side ? 5.6 : 12;
      if (layout === 'bullets') {
        const items = (s.bullets ?? []).map((b) => plain(String(b)));
        const size = items.length > 9 ? 16 : items.length > 6 ? 20 : 24;
        slide.addText(
          items.map((text) => ({ text, options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } })),
          { x: 0.7, y: 1.5, w: textW, h: 5.4, fontFace: THEME.font, fontSize: size, color: THEME.ink, valign: 'top', fit: 'shrink' },
        );
      } else if (layout === 'text') {
        slide.addText(plain(String(s.text ?? '')), { x: 0.7, y: 1.5, w: textW, h: 5.4, fontFace: THEME.font, fontSize: 22, color: THEME.ink, valign: 'top', fit: 'shrink' });
      } else if (layout === 'table') {
        const t = s.table!;
        const body = t.rows.map((r) => r.map((c) => ({ text: plain(String(c ?? '')), options: { fontFace: THEME.font, fontSize: 14, color: THEME.ink } })));
        const head = t.header ? [t.header.map((c) => ({ text: plain(String(c)), options: { bold: true, fontFace: THEME.font, fontSize: 14, color: 'FFFFFF', fill: { color: THEME.accent } } }))] : [];
        slide.addTable([...head, ...body], { x: 0.7, y: 1.5, w: 12, border: { type: 'solid', pt: 0.75, color: 'D1D5DB' }, autoPage: true, autoPageRepeatHeader: Boolean(t.header) });
      }
      if (req && visual && layout !== 'table') placeVisual(pptx, slide, req, visual, side ? { x: 6.6, w: 6.1 } : { x: 0.7, w: 12 });
    }
    if (s.notes) slide.addNotes(plain(String(s.notes)));
  }
  return { buffer: (await pptx.write({ outputType: 'nodebuffer' })) as Buffer };
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
  const baseDir = opts.baseDir ?? process.cwd();
  const abs = safeOutput(baseDir, spec.output, spec.type);
  const warnings: string[] = [];
  let buf: Buffer;
  let summary: string;
  let template: string | undefined;
  switch (spec.type) {
    case 'docx':
      buf = await buildDocx(spec, baseDir, warnings);
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
    case 'pptx': {
      const built = await buildPptx(spec, baseDir, warnings);
      buf = built.buffer;
      template = built.template;
      summary = `PowerPoint, ${spec.slides.length} slide${spec.slides.length === 1 ? '' : 's'}${template ? ` (template: ${template})` : ''}`;
      break;
    }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  if (spec.type === 'pptx') {
    // The portal reads this to tell the person which template a deck followed and what did not go to plan.
    try {
      fs.writeFileSync(`${abs}.report.json`, JSON.stringify({ template: template ?? null, slides: spec.slides.length, warnings, generatedAt: new Date().toISOString() }, null, 2));
    } catch {}
  }
  return { type: spec.type, output: abs, bytes: buf.length, summary, ...(template ? { template } : {}), ...(warnings.length ? { warnings } : {}) };
}
