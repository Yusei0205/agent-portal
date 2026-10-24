/**
 * Slide previews without PowerPoint (NEW-7).
 *
 * Reads a .pptx (any, not only the ones make-doc writes) and draws every slide as an SVG: background, the master's and
 * layout's artwork (logo, bars), then the slide's own text, pictures, tables and shapes, positioned from the file with
 * placeholders resolved through layout and master and colours and fonts taken from the theme. Text is wrapped with an
 * estimated character width, so lines can break a little differently from PowerPoint: this is a preview to check
 * content and layout, not a pixel-exact render. SVG needs no browser; when a headless browser is installed the caller can
 * turn the same SVG into a PNG (docimage.ts).
 */
import {
  OoxmlPackage,
  REL,
  child,
  childrenNamed,
  dig,
  elements,
  findDeep,
  local,
  textOf,
  xmlEscape,
  type Rel,
  type XNode,
} from './ooxml.ts';

const PT = 12700;
const MAX_SHAPES = 600;
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

export interface SlideOutline {
  index: number;
  title: string;
  layout: string;
  notes: string;
  bullets: number;
  hasPicture: boolean;
  hasTable: boolean;
}

export interface DeckModel {
  widthPt: number;
  heightPt: number;
  slides: LoadedSlide[];
}

interface LoadedSlide {
  path: string;
  xml: XNode;
  rels: Rel[];
  layoutPath: string;
  layoutXml: XNode;
  layoutRels: Rel[];
  masterPath: string;
  masterXml: XNode;
  masterRels: Rel[];
  notes: string;
}

export interface DeckTheme {
  colors: Record<string, string>;
  clrMap: Record<string, string>;
  major: string;
  minor: string;
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

async function loadDeck(pkg: OoxmlPackage): Promise<{ deck: DeckModel; theme: DeckTheme; pkg: OoxmlPackage }> {
  const presPath = await pkg.mainPart();
  const pres = await pkg.xml(presPath);
  const sz = child(pres, 'sldSz');
  const widthPt = Number(sz?.attrs.cx) / PT;
  const heightPt = Number(sz?.attrs.cy) / PT;
  if (!(widthPt > 0 && heightPt > 0)) throw new Error('The presentation has no slide size');
  const presRels = await pkg.rels(presPath);
  const ids = childrenNamed(dig(pres, 'sldIdLst'), 'sldId').map((e) => Object.entries(e.attrs).find(([k]) => local(k) === 'id' && k !== 'id')?.[1] ?? '');
  const slides: LoadedSlide[] = [];
  let theme: DeckTheme | null = null;
  for (const id of ids) {
    const rel = presRels.find((r) => r.id === id && r.type === REL.slide);
    if (!rel || !pkg.has(rel.path)) continue;
    const xml = await pkg.xml(rel.path);
    const rels = await pkg.rels(rel.path);
    const lrel = rels.find((r) => r.type === REL.slideLayout);
    if (!lrel || !pkg.has(lrel.path)) throw new Error(`${rel.path} has no layout`);
    const layoutXml = await pkg.xml(lrel.path);
    const layoutRels = await pkg.rels(lrel.path);
    const mrel = layoutRels.find((r) => r.type === REL.slideMaster);
    if (!mrel || !pkg.has(mrel.path)) throw new Error(`${lrel.path} has no master`);
    const masterXml = await pkg.xml(mrel.path);
    const masterRels = await pkg.rels(mrel.path);
    if (!theme) theme = await readTheme(pkg, masterXml, masterRels);
    let notes = '';
    const nrel = rels.find((r) => r.type === REL.notesSlide);
    if (nrel && pkg.has(nrel.path)) {
      const nx = await pkg.xml(nrel.path);
      for (const sp of childrenNamed(dig(nx, 'cSld', 'spTree'), 'sp')) {
        const ph = dig(sp, 'nvSpPr', 'nvPr', 'ph');
        if (ph?.attrs.type === 'body') notes = paragraphTexts(dig(sp, 'txBody')).join('\n');
      }
    }
    slides.push({ path: rel.path, xml, rels, layoutPath: lrel.path, layoutXml, layoutRels, masterPath: mrel.path, masterXml, masterRels, notes });
  }
  if (!theme) {
    const m = presRels.find((r) => r.type === REL.slideMaster && pkg.has(r.path));
    if (m) {
      const mx = await pkg.xml(m.path);
      theme = await readTheme(pkg, mx, await pkg.rels(m.path));
    }
  }
  return { deck: { widthPt, heightPt, slides }, theme: theme ?? { colors: {}, clrMap: {}, major: 'Calibri', minor: 'Calibri' }, pkg };
}

async function readTheme(pkg: OoxmlPackage, master: XNode, masterRels: Rel[]): Promise<DeckTheme> {
  const colors: Record<string, string> = {};
  let major = 'Calibri';
  let minor = 'Calibri';
  const tr = masterRels.find((r) => r.type === REL.theme && pkg.has(r.path));
  if (tr) {
    const theme = await pkg.xml(tr.path);
    for (const c of elements(dig(theme, 'themeElements', 'clrScheme'))) {
      const v = elements(c)[0];
      const hex = v?.attrs.val && /^[0-9a-fA-F]{6}$/.test(v.attrs.val) ? v.attrs.val : v?.attrs.lastClr;
      if (hex && /^[0-9a-fA-F]{6}$/.test(hex)) colors[local(c.name)] = hex.toUpperCase();
    }
    const fs = dig(theme, 'themeElements', 'fontScheme');
    major = dig(fs, 'majorFont', 'latin')?.attrs.typeface || major;
    minor = dig(fs, 'minorFont', 'latin')?.attrs.typeface || minor;
  }
  const clrMap = { ...(child(master, 'clrMap')?.attrs ?? {}) };
  return { colors, clrMap, major, minor };
}

function paragraphTexts(txBody: XNode | undefined): string[] {
  return childrenNamed(txBody, 'p').map((p) =>
    elements(p)
      .map((n) => (['r', 'fld'].includes(local(n.name)) ? textOf(child(n, 't')) : local(n.name) === 'br' ? '\n' : ''))
      .join(''),
  );
}

/* ------------------------------------------------------------------ */
/* Outline                                                             */
/* ------------------------------------------------------------------ */

export async function deckOutline(buf: Buffer): Promise<SlideOutline[]> {
  const pkg = await OoxmlPackage.open(buf);
  const { deck } = await loadDeck(pkg);
  return deck.slides.map((s, i) => {
    const sps = childrenNamed(dig(s.xml, 'cSld', 'spTree'), 'sp');
    const titleSp = sps.find((sp) => ['title', 'ctrTitle'].includes(dig(sp, 'nvSpPr', 'nvPr', 'ph')?.attrs.type ?? ''));
    const first = sps.find((sp) => paragraphTexts(dig(sp, 'txBody')).join('').trim());
    const title = paragraphTexts(dig(titleSp ?? first, 'txBody')).join(' ').replace(/\s+/g, ' ').trim();
    const body = sps.find((sp) => {
      const t = dig(sp, 'nvSpPr', 'nvPr', 'ph')?.attrs.type ?? '';
      return sp !== titleSp && ['', 'body', 'obj'].includes(t) && dig(sp, 'nvSpPr', 'nvPr', 'ph');
    });
    return {
      index: i + 1,
      title,
      layout: dig(s.layoutXml, 'cSld')?.attrs.name ?? '',
      notes: s.notes.trim(),
      bullets: body ? paragraphTexts(dig(body, 'txBody')).filter((t) => t.trim()).length : 0,
      hasPicture: Boolean(findDeep(dig(s.xml, 'cSld', 'spTree'), 'pic')),
      hasTable: Boolean(findDeep(dig(s.xml, 'cSld', 'spTree'), 'tbl')),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Colours                                                             */
/* ------------------------------------------------------------------ */

function hsl(hex: string): [number, number, number] {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const f = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) r = g = b = l;
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    [r, g, b] = [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)];
  }
  return [r, g, b].map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** The colour a `solidFill`-like element names, with its luminance modifiers applied. Null when it names none. */
function colorOf(fill: XNode | undefined, theme: DeckTheme): string | null {
  const c = elements(fill)[0];
  if (!c) return null;
  let hex: string | null = null;
  const name = local(c.name);
  if (name === 'srgbClr') hex = /^[0-9a-fA-F]{6}$/.test(c.attrs.val ?? '') ? c.attrs.val.toUpperCase() : null;
  else if (name === 'sysClr') hex = (c.attrs.lastClr ?? '000000').toUpperCase();
  else if (name === 'prstClr') hex = ({ black: '000000', white: 'FFFFFF', red: 'FF0000', green: '00FF00', blue: '0000FF' } as Record<string, string>)[c.attrs.val ?? ''] ?? '000000';
  else if (name === 'schemeClr') {
    const v = c.attrs.val ?? '';
    const mapped = theme.clrMap[v] ?? v;
    hex = theme.colors[mapped] ?? theme.colors[v] ?? (v === 'phClr' ? theme.colors.accent1 : null) ?? null;
  }
  if (!hex) return null;
  for (const m of elements(c)) {
    const val = Number(m.attrs.val) / 100000;
    const k = local(m.name);
    if (k === 'lumMod' || k === 'lumOff') {
      const [h, s, l] = hsl(hex);
      hex = fromHsl(h, s, k === 'lumMod' ? Math.min(1, l * val) : Math.min(1, l + val));
    } else if (k === 'tint') hex = mix(hex, 'FFFFFF', 1 - val);
    else if (k === 'shade') hex = mix(hex, '000000', 1 - val);
  }
  return hex;
}

function mix(a: string, b: string, t: number): string {
  return [0, 2, 4]
    .map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Geometry and text styles                                            */
/* ------------------------------------------------------------------ */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A transform from a group's child coordinates to the slide's, in points. */
interface Xf {
  ox: number;
  oy: number;
  sx: number;
  sy: number;
}

const ID_XF: Xf = { ox: 0, oy: 0, sx: 1, sy: 1 };

function xfrmBox(spPr: XNode | undefined, xf: Xf, tag = 'xfrm'): Box | null {
  const x = child(spPr, tag);
  const off = child(x, 'off');
  const ext = child(x, 'ext');
  if (!off || !ext) return null;
  const n = [off.attrs.x, off.attrs.y, ext.attrs.cx, ext.attrs.cy].map(Number);
  if (!n.every(Number.isFinite)) return null;
  return { x: xf.ox + (n[0] / PT) * xf.sx, y: xf.oy + (n[1] / PT) * xf.sy, w: (n[2] / PT) * xf.sx, h: (n[3] / PT) * xf.sy };
}

const normType = (t: string | undefined): string => (t === 'ctrTitle' ? 'title' : !t || t === 'obj' ? 'body' : t);

/** The shape in a layout or master tree that a slide placeholder inherits from: same idx and type, else same type. */
function findPlaceholder(tree: XNode | undefined, ph: XNode, useIdx: boolean): XNode | undefined {
  const type = normType(ph.attrs.type);
  const sps = childrenNamed(tree, 'sp').filter((sp) => {
    const p = dig(sp, 'nvSpPr', 'nvPr', 'ph');
    return p && normType(p.attrs.type) === type;
  });
  return (useIdx && ph.attrs.idx !== undefined ? sps.find((sp) => dig(sp, 'nvSpPr', 'nvPr', 'ph')?.attrs.idx === ph.attrs.idx) : undefined) ?? sps[0];
}

const schemeHex = (theme: DeckTheme, name: string): string => theme.colors[theme.clrMap[name] ?? name] ?? theme.colors[name] ?? '000000';

interface ParaStyle {
  algn?: string;
  marL?: number;
  indent?: number;
  bullet?: string | null;
  sz?: number;
  b?: boolean;
  i?: boolean;
  color?: string | null;
  font?: string;
}

/** Merge the level's paragraph style over a chain of list-style nodes (most specific first). */
function styleAt(chain: (XNode | undefined)[], lvl: number, theme: DeckTheme): ParaStyle {
  const out: ParaStyle = {};
  for (const ls of chain) {
    const p = child(ls, `lvl${lvl + 1}pPr`);
    if (!p) continue;
    if (out.algn === undefined && p.attrs.algn) out.algn = p.attrs.algn;
    if (out.marL === undefined && p.attrs.marL !== undefined) out.marL = Number(p.attrs.marL) / PT;
    if (out.indent === undefined && p.attrs.indent !== undefined) out.indent = Number(p.attrs.indent) / PT;
    if (out.bullet === undefined) {
      if (child(p, 'buNone')) out.bullet = null;
      else if (child(p, 'buChar')) out.bullet = child(p, 'buChar')!.attrs.char || '•';
      else if (child(p, 'buAutoNum')) out.bullet = '1.';
    }
    const d = child(p, 'defRPr');
    if (d) {
      if (out.sz === undefined && d.attrs.sz) out.sz = Number(d.attrs.sz) / 100;
      if (out.b === undefined && d.attrs.b !== undefined) out.b = d.attrs.b === '1';
      if (out.i === undefined && d.attrs.i !== undefined) out.i = d.attrs.i === '1';
      if (out.color === undefined) {
        const c = colorOf(child(d, 'solidFill'), theme);
        if (c) out.color = c;
      }
      if (out.font === undefined) {
        const t = child(d, 'latin')?.attrs.typeface;
        if (t) out.font = t;
      }
    }
  }
  return out;
}

const fontName = (t: string | undefined, theme: DeckTheme): string => (!t ? theme.minor : t === '+mj-lt' ? theme.major : t === '+mn-lt' ? theme.minor : t);

function charWidth(ch: string, size: number, bold: boolean): number {
  if (/[⺀-鿿＀-￯]/.test(ch)) return size;
  if (/[iljtfI.,:;'|! ]/.test(ch)) return size * 0.3;
  if (/[mwMW@]/.test(ch)) return size * 0.8;
  if (/[A-Z]/.test(ch)) return size * (bold ? 0.66 : 0.62);
  return size * (bold ? 0.54 : 0.5);
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

interface Ctx {
  pkg: OoxmlPackage;
  theme: DeckTheme;
  slideNo: number;
  slide: LoadedSlide;
  out: string[];
  shapes: number;
  masterStyles: XNode | undefined;
  imageCache: Map<string, string | null>;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml' };

async function imageUri(ctx: Ctx, rels: Rel[], rid: string | undefined): Promise<string | null> {
  const r = rels.find((x) => x.id === rid && x.type === REL.image);
  if (!r || r.external || !ctx.pkg.has(r.path)) return null;
  if (ctx.imageCache.has(r.path)) return ctx.imageCache.get(r.path) ?? null;
  const mime = MIME[r.path.split('.').pop()!.toLowerCase()];
  let uri: string | null = null;
  if (mime) {
    const bytes = await ctx.pkg.bytes(r.path);
    if (bytes.length <= MAX_IMAGE_BYTES) uri = `data:${mime};base64,${bytes.toString('base64')}`;
  }
  ctx.imageCache.set(r.path, uri);
  return uri;
}

const rid = (n: XNode | undefined): string | undefined => (n ? Object.entries(n.attrs).find(([k]) => local(k) === 'embed')?.[1] : undefined);

function fillOf(spPr: XNode | undefined, theme: DeckTheme): string | null | undefined {
  if (!spPr) return undefined;
  if (child(spPr, 'noFill')) return null;
  const sf = child(spPr, 'solidFill');
  if (sf) return colorOf(sf, theme);
  const gf = child(spPr, 'gradFill');
  if (gf) return colorOf(dig(gf, 'gsLst', 'gs'), theme);
  return undefined;
}

function lineOf(spPr: XNode | undefined, theme: DeckTheme): { color: string; w: number } | null {
  const ln = child(spPr, 'ln');
  if (!ln || child(ln, 'noFill')) return null;
  const c = colorOf(child(ln, 'solidFill'), theme);
  return c ? { color: c, w: Math.max(0.5, Number(ln.attrs.w ?? 12700) / PT) } : null;
}

interface TextSource {
  txBody: XNode | undefined;
  /** Style chain, most specific first. */
  chain: (XNode | undefined)[];
  bodyPrs: (XNode | undefined)[];
  box: Box;
  /** Default size and colour when no list style names one. */
  defaultSize: number;
  defaultAlign?: string;
}

function drawText(ctx: Ctx, t: TextSource): void {
  const paras = childrenNamed(t.txBody, 'p');
  if (!paras.length) return;
  const bp = t.bodyPrs.find((b) => b);
  const attr = (name: string): string | undefined => t.bodyPrs.find((b) => b?.attrs[name] !== undefined)?.attrs[name];
  const ins = {
    l: Number(attr('lIns') ?? 91440) / PT,
    r: Number(attr('rIns') ?? 91440) / PT,
    t: Number(attr('tIns') ?? 45720) / PT,
    b: Number(attr('bIns') ?? 45720) / PT,
  };
  const fit = findDeep(bp, 'normAutofit');
  const scale = fit?.attrs.fontScale ? Number(fit.attrs.fontScale) / 100000 : 1;
  const anchor = attr('anchor') ?? 't';
  const width = Math.max(10, t.box.w - ins.l - ins.r);

  interface Line {
    runs: { text: string; size: number; b: boolean; i: boolean; color: string; font: string }[];
    x: number;
    align: string;
    height: number;
    gapBefore: number;
    bullet?: { char: string; x: number; size: number; color: string; font: string };
  }
  const lines: Line[] = [];

  for (const p of paras) {
    const pPr = child(p, 'pPr');
    const lvl = Math.min(8, Number(pPr?.attrs.lvl ?? 0) || 0);
    const st = styleAt(t.chain, lvl, ctx.theme);
    const bulletOff = child(pPr, 'buNone');
    const bulletChar = child(pPr, 'buChar')?.attrs.char;
    let bullet: string | null | undefined = bulletOff ? null : bulletChar ?? st.bullet;
    if (bullet === undefined) bullet = null;
    const marLRaw = pPr?.attrs.marL !== undefined ? Number(pPr.attrs.marL) / PT : st.marL;
    const indentRaw = pPr?.attrs.indent !== undefined ? Number(pPr.attrs.indent) / PT : st.indent;
    const marL = marLRaw ?? (bullet ? 27 : 0);
    const indent = indentRaw ?? (bullet ? -27 : 0);
    const algn = pPr?.attrs.algn ?? st.algn ?? t.defaultAlign ?? 'l';

    const words: { text: string; size: number; b: boolean; i: boolean; color: string; font: string }[] = [];
    let firstSize = 0;
    for (const n of elements(p)) {
      const k = local(n.name);
      if (k === 'br') {
        words.push({ text: '\n', size: firstSize || st.sz || t.defaultSize, b: false, i: false, color: '000000', font: ctx.theme.minor });
        continue;
      }
      if (k !== 'r' && k !== 'fld') continue;
      const rPr = child(n, 'rPr');
      const size = ((rPr?.attrs.sz ? Number(rPr.attrs.sz) / 100 : (st.sz ?? t.defaultSize)) * scale) || 18;
      firstSize ||= size;
      const color = colorOf(child(rPr, 'solidFill'), ctx.theme) ?? st.color ?? schemeHex(ctx.theme, 'tx1');
      const font = fontName(child(rPr, 'latin')?.attrs.typeface ?? st.font, ctx.theme);
      let text = textOf(child(n, 't'));
      if (k === 'fld' && n.attrs.type === 'slidenum') text = String(ctx.slideNo);
      words.push({ text, size, b: rPr?.attrs.b !== undefined ? rPr.attrs.b === '1' : (st.b ?? false), i: rPr?.attrs.i !== undefined ? rPr.attrs.i === '1' : (st.i ?? false), color, font });
    }
    const size = firstSize || (st.sz ?? t.defaultSize) * scale;
    const gap = size * 0.25;
    if (!words.length) {
      lines.push({ runs: [], x: marL, align: algn, height: size * 1.2, gapBefore: gap });
      continue;
    }
    // Wrap: split runs into tokens, fill lines up to the available width.
    let cur: Line = { runs: [], x: bullet ? marL : marL + indent, align: algn, height: size * 1.2, gapBefore: gap };
    if (bullet) cur.bullet = { char: bullet.length > 2 ? '•' : bullet, x: marL + indent, size, color: words[0].color, font: words[0].font };
    let used = 0;
    const startLine = (): void => {
      lines.push(cur);
      cur = { runs: [], x: marL, align: algn, height: size * 1.2, gapBefore: 0 };
      used = 0;
    };
    for (const w of words) {
      if (w.text === '\n') {
        startLine();
        continue;
      }
      for (const tok of w.text.split(/(\s+)/).filter((s) => s !== '')) {
        const tw = [...tok].reduce((a, ch) => a + charWidth(ch, w.size, w.b), 0);
        const limit = width - marL;
        if (used + tw > limit && used > 0 && !/^\s+$/.test(tok)) startLine();
        if (used === 0 && /^\s+$/.test(tok) && cur.runs.length === 0 && lines.length && lines[lines.length - 1] !== cur) continue;
        const prev = cur.runs[cur.runs.length - 1];
        if (prev && prev.size === w.size && prev.b === w.b && prev.i === w.i && prev.color === w.color && prev.font === w.font) prev.text += tok;
        else cur.runs.push({ ...w, text: tok });
        cur.height = Math.max(cur.height, w.size * 1.2);
        used += tw;
      }
    }
    lines.push(cur);
  }

  const total = lines.reduce((a, l) => a + l.height + l.gapBefore, 0) - (lines[0]?.gapBefore ?? 0);
  const inner = t.box.h - ins.t - ins.b;
  let y = t.box.y + ins.t + (total >= inner ? 0 : anchor === 'ctr' ? (inner - total) / 2 : anchor === 'b' ? inner - total : 0);
  const body: string[] = [];
  lines.forEach((l, idx) => {
    if (idx) y += l.gapBefore;
    const base = y + l.height * 0.82;
    y += l.height;
    if (!l.runs.length && !l.bullet) return;
    const left = t.box.x + ins.l + l.x;
    const right = t.box.x + t.box.w - ins.r;
    const [tx, anchorAttr] = l.align === 'ctr' ? [(left + right) / 2, 'middle'] : l.align === 'r' ? [right, 'end'] : [left, 'start'];
    if (l.bullet) body.push(`<text x="${(t.box.x + ins.l + l.bullet.x).toFixed(1)}" y="${base.toFixed(1)}" font-size="${l.bullet.size.toFixed(1)}" fill="#${l.bullet.color}" font-family="${xmlEscape(l.bullet.font)}">${xmlEscape(l.bullet.char)}</text>`);
    if (l.runs.length) {
      const spans = l.runs
        .map((r) => `<tspan font-size="${r.size.toFixed(1)}" fill="#${r.color}" font-family="${xmlEscape(r.font)}, Arial, sans-serif"${r.b ? ' font-weight="bold"' : ''}${r.i ? ' font-style="italic"' : ''}>${xmlEscape(r.text)}</tspan>`)
        .join('');
      body.push(`<text x="${tx.toFixed(1)}" y="${base.toFixed(1)}" text-anchor="${anchorAttr}" xml:space="preserve">${spans}</text>`);
    }
  });
  ctx.out.push(`<g>${body.join('')}</g>`);
}

async function drawTree(ctx: Ctx, tree: XNode | undefined, xf: Xf, source: 'slide' | 'layout' | 'master'): Promise<void> {
  for (const n of elements(tree)) {
    if (ctx.shapes++ > MAX_SHAPES) return;
    const k = local(n.name);
    if (k === 'grpSp') {
      const gp = child(n, 'grpSpPr');
      const x = child(gp, 'xfrm');
      const off = child(x, 'off');
      const ext = child(x, 'ext');
      const choff = child(x, 'chOff');
      const chext = child(x, 'chExt');
      let g = xf;
      if (off && ext && choff && chext && Number(chext.attrs.cx) > 0 && Number(chext.attrs.cy) > 0) {
        const sx = (Number(ext.attrs.cx) / Number(chext.attrs.cx)) * xf.sx;
        const sy = (Number(ext.attrs.cy) / Number(chext.attrs.cy)) * xf.sy;
        g = { sx, sy, ox: xf.ox + (Number(off.attrs.x) / PT) * xf.sx - (Number(choff.attrs.x) / PT) * sx, oy: xf.oy + (Number(off.attrs.y) / PT) * xf.sy - (Number(choff.attrs.y) / PT) * sy };
      }
      await drawTree(ctx, n, g, source);
      continue;
    }
    if (k === 'sp') await drawShape(ctx, n, xf, source);
    else if (k === 'pic') await drawPicture(ctx, n, xf, source);
    else if (k === 'graphicFrame') drawTable(ctx, n, xf);
  }
}

async function drawPicture(ctx: Ctx, pic: XNode, xf: Xf, source: 'slide' | 'layout' | 'master'): Promise<void> {
  const box = xfrmBox(child(pic, 'spPr'), xf);
  if (!box) return;
  const rels = source === 'slide' ? ctx.slide.rels : source === 'layout' ? ctx.slide.layoutRels : ctx.slide.masterRels;
  const uri = await imageUri(ctx, rels, rid(dig(pic, 'blipFill', 'blip')));
  if (uri) ctx.out.push(`<image href="${uri}" x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${box.w.toFixed(1)}" height="${box.h.toFixed(1)}" preserveAspectRatio="none"/>`);
  else ctx.out.push(`<rect x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${box.w.toFixed(1)}" height="${box.h.toFixed(1)}" fill="#E5E7EB" stroke="#9CA3AF" stroke-width="0.5"/>`);
}

async function drawShape(ctx: Ctx, sp: XNode, xf: Xf, source: 'slide' | 'layout' | 'master'): Promise<void> {
  const ph = dig(sp, 'nvSpPr', 'nvPr', 'ph');
  // The artwork of masters and layouts is drawn; their placeholders are only prompts.
  if (ph && source !== 'slide') return;
  const spPr = child(sp, 'spPr');
  let box = xfrmBox(spPr, xf);
  const chain: (XNode | undefined)[] = [dig(sp, 'txBody', 'lstStyle')];
  const bodyPrs: (XNode | undefined)[] = [dig(sp, 'txBody', 'bodyPr')];
  let defaultSize = 18;
  let defaultAlign: string | undefined;
  let styleGroup = 'otherStyle';
  let inheritedFill: string | null | undefined;
  if (ph) {
    const lsp = findPlaceholder(dig(ctx.slide.layoutXml, 'cSld', 'spTree'), ph, true);
    const msp = findPlaceholder(dig(ctx.slide.masterXml, 'cSld', 'spTree'), ph, false);
    box = box ?? xfrmBox(child(lsp, 'spPr'), ID_XF) ?? xfrmBox(child(msp, 'spPr'), ID_XF);
    chain.push(dig(lsp, 'txBody', 'lstStyle'), dig(msp, 'txBody', 'lstStyle'));
    bodyPrs.push(dig(lsp, 'txBody', 'bodyPr'), dig(msp, 'txBody', 'bodyPr'));
    const type = normType(ph.attrs.type);
    styleGroup = type === 'title' ? 'titleStyle' : ['body', 'subTitle'].includes(type) ? 'bodyStyle' : 'otherStyle';
    defaultSize = type === 'title' ? (ph.attrs.type === 'ctrTitle' ? 44 : 36) : type === 'sldNum' || type === 'dt' || type === 'ftr' ? 12 : type === 'subTitle' ? 24 : 20;
    if (ph.attrs.type === 'ctrTitle' || type === 'subTitle') defaultAlign = 'ctr';
    inheritedFill = fillOf(child(lsp, 'spPr'), ctx.theme) ?? fillOf(child(msp, 'spPr'), ctx.theme);
  }
  chain.push(child(ctx.masterStyles, styleGroup));
  if (!box || box.w <= 0 || box.h <= 0) return;
  const fill = fillOf(spPr, ctx.theme) ?? inheritedFill;
  const line = lineOf(spPr, ctx.theme);
  const geom = dig(spPr, 'prstGeom')?.attrs.prst ?? 'rect';
  if (fill || line) {
    const f = fill ? `fill="#${fill}"` : 'fill="none"';
    const s = line ? `stroke="#${line.color}" stroke-width="${line.w.toFixed(1)}"` : '';
    if (geom === 'ellipse') ctx.out.push(`<ellipse cx="${(box.x + box.w / 2).toFixed(1)}" cy="${(box.y + box.h / 2).toFixed(1)}" rx="${(box.w / 2).toFixed(1)}" ry="${(box.h / 2).toFixed(1)}" ${f} ${s}/>`);
    else ctx.out.push(`<rect x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${box.w.toFixed(1)}" height="${box.h.toFixed(1)}"${geom === 'roundRect' ? ` rx="${(Math.min(box.w, box.h) * 0.1).toFixed(1)}"` : ''} ${f} ${s}/>`);
  }
  const txBody = child(sp, 'txBody');
  if (txBody) drawText(ctx, { txBody, chain, bodyPrs, box, defaultSize, defaultAlign });
}

function drawTable(ctx: Ctx, gf: XNode, xf: Xf): void {
  const tbl = findDeep(gf, 'tbl');
  const box = xfrmBox(gf, xf, 'xfrm');
  if (!tbl || !box) return;
  const cols = childrenNamed(child(tbl, 'tblGrid'), 'gridCol').map((c) => Number(c.attrs.w));
  const totalW = cols.reduce((a, b) => a + b, 0) || 1;
  const rows = childrenNamed(tbl, 'tr');
  const firstRow = child(tbl, 'tblPr')?.attrs.firstRow === '1';
  const accent = ctx.theme.colors.accent1 ?? '4472C4';
  let y = box.y;
  rows.forEach((r, ri) => {
    const h = Math.max(14, (Number(r.attrs.h) / PT) * xf.sy);
    let x = box.x;
    childrenNamed(r, 'tc').forEach((c, ci) => {
      const w = ((cols[ci] ?? totalW / cols.length) / totalW) * box.w;
      const head = firstRow && ri === 0;
      const fill = head ? accent : ri % 2 ? 'FFFFFF' : mix(accent, 'FFFFFF', 0.88);
      ctx.out.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#${fill}" stroke="#D1D5DB" stroke-width="0.5"/>`);
      const txBody = child(c, 'txBody');
      const probe = elements(txBody).flatMap((p) => elements(p)).flatMap((r2) => (local(r2.name) === 'r' ? [child(r2, 'rPr')] : []))[0];
      const size = probe?.attrs.sz ? Number(probe.attrs.sz) / 100 : 18;
      const color = head ? 'FFFFFF' : schemeHex(ctx.theme, 'tx1');
      const cell: TextSource = {
        txBody,
        chain: [{ name: 'lstStyle', attrs: {}, children: [{ name: 'a:lvl1pPr', attrs: {}, children: [{ name: 'a:defRPr', attrs: { sz: String(size * 100), b: head ? '1' : '0' }, children: [{ name: 'a:solidFill', attrs: {}, children: [{ name: 'a:srgbClr', attrs: { val: color }, children: [] }] }] }] }] }],
        bodyPrs: [],
        box: { x, y, w, h },
        defaultSize: size,
      };
      drawText(ctx, cell);
      x += w;
    });
    y += h;
  });
}

async function backgroundOf(ctx: Ctx): Promise<string> {
  const s = ctx.slide;
  for (const [xml, rels] of [[s.xml, s.rels], [s.layoutXml, s.layoutRels], [s.masterXml, s.masterRels]] as [XNode, Rel[]][]) {
    const bg = dig(xml, 'cSld', 'bg');
    if (!bg) continue;
    const bgPr = child(bg, 'bgPr');
    if (bgPr) {
      const c = fillOf(bgPr, ctx.theme);
      if (c) return `<rect width="100%" height="100%" fill="#${c}"/>`;
      const blip = dig(bgPr, 'blipFill', 'blip');
      if (blip) {
        const uri = await imageUri(ctx, rels, rid(blip));
        if (uri) return `<image href="${uri}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none"/>`;
      }
    }
    const ref = child(bg, 'bgRef');
    if (ref) {
      const c = colorOf(ref, ctx.theme);
      if (c) return `<rect width="100%" height="100%" fill="#${c}"/>`;
    }
  }
  return '<rect width="100%" height="100%" fill="#FFFFFF"/>';
}

/** One SVG per slide, 960 px wide. */
export async function renderDeckSvgs(buf: Buffer, opts: { only?: number } = {}): Promise<{ svgs: string[]; width: number; height: number }> {
  const pkg = await OoxmlPackage.open(buf);
  const { deck, theme } = await loadDeck(pkg);
  const svgs: string[] = [];
  const cache = new Map<string, string | null>();
  for (let i = 0; i < deck.slides.length; i++) {
    if (opts.only !== undefined && opts.only !== i + 1) {
      svgs.push('');
      continue;
    }
    const slide = deck.slides[i];
    const ctx: Ctx = { pkg, theme, slideNo: i + 1, slide, out: [], shapes: 0, masterStyles: child(slide.masterXml, 'txStyles'), imageCache: cache };
    ctx.out.push(await backgroundOf(ctx));
    const hideAll = slide.xml.attrs.showMasterSp === '0';
    const hideMaster = slide.layoutXml.attrs.showMasterSp === '0';
    if (!hideAll && !hideMaster) await drawTree(ctx, dig(slide.masterXml, 'cSld', 'spTree'), ID_XF, 'master');
    if (!hideAll) await drawTree(ctx, dig(slide.layoutXml, 'cSld', 'spTree'), ID_XF, 'layout');
    await drawTree(ctx, dig(slide.xml, 'cSld', 'spTree'), ID_XF, 'slide');
    const w = 960;
    const h = Math.round((w * deck.heightPt) / deck.widthPt);
    svgs.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${deck.widthPt.toFixed(1)} ${deck.heightPt.toFixed(1)}" font-family="${xmlEscape(theme.minor)}, Arial, sans-serif"><clipPath id="c"><rect width="${deck.widthPt.toFixed(1)}" height="${deck.heightPt.toFixed(1)}"/></clipPath><g clip-path="url(#c)">${ctx.out.join('')}</g></svg>`,
    );
  }
  return { svgs, width: 960, height: Math.round((960 * deck.heightPt) / deck.widthPt) };
}
