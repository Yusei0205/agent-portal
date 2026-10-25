/**
 * Icon diagrams (draw.io, FR-DIAG-9): what a stored `.drawio` file must look like.
 *
 * An agent writes the diagram as draw.io (mxGraph) XML. It is an input from a model, so it is checked as strictly as
 * the Mermaid replies are, and what is stored is not the agent's text but the portal's own serialisation of the tree
 * it checked: only the elements and attributes listed here survive, so nothing the checks did not look at can ride
 * along. Nothing here touches the database or the file system.
 *
 * Refused: DOCTYPE, entities, CDATA and processing instructions; compressed pages (the agent must write plain XML);
 * more than one page; elements or attributes outside the draw.io model; links and URLs anywhere (http, https, ftp,
 * file, javascript, data), `link`/`href`/`url` style keys; images other than draw.io's own `img/lib/...` icon files;
 * labels with markup other than plain formatting tags (no script, iframe, img, a, style, event attributes); styles
 * with characters outside a short allow list; ids that do not resolve; parent loops; and more than the size limits.
 */
import { parseXml, serializeXml, XmlError, type XNode } from './ooxml.ts';

export const DIAGRAM_STYLES = ['mermaid', 'icon'] as const;
export type DiagramStyle = (typeof DIAGRAM_STYLES)[number];
export const STYLE_LABELS: Record<DiagramStyle, string> = { mermaid: 'Mermaid (text diagram)', icon: 'Icon diagram (draw.io, official cloud icons)' };

export const CLOUDS = ['aws', 'azure', 'gcp', 'kubernetes', 'generic'] as const;
export type Cloud = (typeof CLOUDS)[number];
export const CLOUD_LABELS: Record<Cloud, string> = { aws: 'AWS', azure: 'Azure', gcp: 'Google Cloud', kubernetes: 'Kubernetes', generic: 'Generic (no single cloud)' };
export const DEFAULT_CLOUD: Cloud = 'aws';

export const DRAWIO_LIMITS = {
  /** Bytes of the XML as the agent wrote it. A real 25-icon AWS diagram is about 30 KB. */
  bytes: 500_000,
  cells: 300,
  icons: 80,
  /** Maximum label length for icons, groups, edges and badges. */
  labelChars: 600,
  /** Maximum label length for text-box cells (style starts with "text;" or contains the bare "text" token). */
  textBoxChars: 2000,
  styleChars: 1500,
  nesting: 20,
  coordinate: 100_000,
  pageNameChars: 100,
};

/** Past this many icons (about) a diagram stops being readable; the prompt asks for at most 25, the UI warns. */
export const READABLE_ICONS = 25;

export class DrawioError extends Error {}

export interface DrawioInfo {
  /** The portal's own serialisation of the checked diagram (what is stored and exported). */
  xml: string;
  cells: number;
  vertices: number;
  edges: number;
  /** Cells drawn as an icon (a shape from a draw.io library or an `img/lib` image), not counting group boxes. */
  icons: number;
  groups: number;
  /** Icon image files the diagram uses (`img/lib/...`), which need the optional image library to be drawn. */
  images: string[];
}

const MODEL_ATTRS = ['dx', 'dy', 'grid', 'gridSize', 'guides', 'tooltips', 'connect', 'arrows', 'fold', 'page', 'pageScale', 'pageWidth', 'pageHeight', 'math', 'shadow', 'background'];
const CELL_ATTRS = ['id', 'value', 'style', 'parent', 'source', 'target', 'vertex', 'edge', 'connectable', 'collapsed', 'visible'];
const WRAPPERS = ['object', 'UserObject'];
const WRAPPER_ATTRS = ['id', 'label', 'tooltip', 'placeholders', 'tags'];
const GEOMETRY_ATTRS = ['x', 'y', 'width', 'height', 'relative', 'as'];
const POINT_ATTRS = ['x', 'y', 'as'];
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const SCHEME = /\b(?:https?|ftp|ftps|file|javascript|vbscript|blob):|\bdata:(?:image|text|application)\//i;

const HTML_TAGS = new Set(['b', 'i', 'u', 's', 'br', 'strong', 'em', 'span', 'div', 'font', 'p', 'sub', 'sup', 'hr', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'small', 'code']);
const HTML_ATTRS = new Set(['style', 'color', 'size', 'face', 'align']);
const FORBIDDEN_STYLE_KEYS = new Set(['link', 'href', 'url', 'src', 'imageurl', 'tooltip', 'onclick']);
const IMAGE_FILE = /^img\/lib\/[\w.-]+(?:\/[\w.-]+)+\.(?:svg|png)$/;
const STYLE_VALUE = /^[\w#.,%+\-[\] /]*$/;

const fail = (msg: string): never => {
  throw new DrawioError(msg);
};

function checkNumber(v: string | undefined, what: string): void {
  if (v === undefined) return;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > DRAWIO_LIMITS.coordinate) fail(`${what} must be a number between -${DRAWIO_LIMITS.coordinate} and ${DRAWIO_LIMITS.coordinate} (got "${v.slice(0, 20)}")`);
}

/** The attribute names of a node that are not in the list, if any. */
const stray = (n: XNode, allowed: string[]): string | undefined => Object.keys(n.attrs).find((k) => !allowed.includes(k));

const elements = (n: XNode): XNode[] => n.children.filter((c) => c.name !== '#text');

function noText(n: XNode, what: string): void {
  if (n.children.some((c) => c.name === '#text' && (c.text ?? '').trim())) fail(`${what} holds text, which a draw.io file does not have here. If the diagram page is compressed, write it as plain XML instead.`);
}

/**
 * Returns true when the style string indicates a text-box cell.
 * A text box is identified by the bare token "text" (no "=") appearing as the first token
 * in the style string or anywhere in it (draw.io writes it as "text;..." at the start).
 * This is distinct from shapes that happen to have "text" in their name or value.
 */
function isTextBox(style: string): boolean {
  for (const tok of style.split(';')) {
    const t = tok.trim();
    if (!t) continue;
    // A token with no "=" and value exactly "text" is the text-box style token
    if (t === 'text') return true;
    // Stop after the first token — if the first token is text= something else, it's not a text box
    break;
  }
  return false;
}

function checkLabel(value: string, what: string, maxChars = DRAWIO_LIMITS.labelChars): void {
  if (value.length > maxChars) {
    if (maxChars === DRAWIO_LIMITS.textBoxChars) {
      fail(`${what} is a text box with a label longer than ${maxChars} characters`);
    } else {
      fail(`${what} is longer than ${maxChars} characters`);
    }
  }
  if (SCHEME.test(value)) fail(`${what} contains a link or an external address, which is not allowed`);
  if (!value.includes('<')) return;
  const tag = /<\/?([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
  const rest = value.replace(tag, (_m, name: string, attrs: string) => {
    if (!HTML_TAGS.has(name.toLowerCase())) fail(`${what} uses the HTML tag <${name}>, which is not allowed (use plain text, b, i, u, br, span, div or font)`);
    for (const a of attrs.matchAll(/([A-Za-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (!HTML_ATTRS.has(a[1].toLowerCase())) fail(`${what} uses the attribute "${a[1]}" in a label, which is not allowed`);
      const v = a[2] ?? a[3] ?? '';
      if (!/^[\w#.,;:%\- ()]*$/.test(v) || /url|expression|import|javascript|binding|behavior/i.test(v)) fail(`${what} has a label style that is not allowed`);
    }
    return '';
  });
  if (rest.includes('<')) fail(`${what} contains markup that is not allowed (a "<" that is not a simple formatting tag)`);
}

/** Returns what the style says about the cell: whether it is an icon, a group, and which icon image file it uses. */
function checkStyle(style: string, what: string): { icon: boolean; group: boolean; image: string | null } {
  if (style.length > DRAWIO_LIMITS.styleChars) fail(`${what} has a style longer than ${DRAWIO_LIMITS.styleChars} characters`);
  if (/:\/\//.test(style) || SCHEME.test(style)) fail(`${what} has a style with a link or an external address, which is not allowed`);
  let shape = '';
  let image: string | null = null;
  let container = false;
  for (const tok of style.split(';')) {
    const t = tok.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    const key = eq < 0 ? t : t.slice(0, eq);
    const value = eq < 0 ? '' : t.slice(eq + 1);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) fail(`${what} has a style key that is not allowed ("${key.slice(0, 30)}")`);
    if (FORBIDDEN_STYLE_KEYS.has(key.toLowerCase())) fail(`${what} uses the style key "${key}", which is not allowed (no links)`);
    // light-dark(#fff,#000) colours are the one use of parentheses.
    const plain = value.replace(/light-dark\(\s*[#\w]+\s*,\s*[#\w]+\s*\)/g, 'x');
    if (!STYLE_VALUE.test(plain)) fail(`${what} has a style value with characters that are not allowed (${key}=${value.slice(0, 40)})`);
    if (key === 'image' && eq >= 0) {
      if (!IMAGE_FILE.test(value) || value.includes('..')) fail(`${what} uses an image ("${value.slice(0, 60)}"); only draw.io's own icon files (img/lib/...) are allowed, no other images`);
      image = value;
    }
    if (key === 'shape') shape = value;
    if (key === 'container' && value === '1') container = true;
  }
  const group = container || /^mxgraph\.[a-z0-9_]+\.(?:group|groupcenter)\w*$/i.test(shape) || /^mxgraph\.[a-z0-9_]+\.[A-Za-z0-9_]*group\w*$/i.test(shape);
  const icon = !group && (image !== null || /^mxgraph\./.test(shape));
  return { icon, group, image };
}

function checkGeometry(g: XNode, edge: boolean, what: string): void {
  if (stray(g, GEOMETRY_ATTRS)) fail(`${what} has a geometry attribute that is not allowed ("${stray(g, GEOMETRY_ATTRS)}")`);
  if (g.attrs.as !== 'geometry' && g.attrs.as !== 'alternateBounds') fail(`${what} has a geometry without as="geometry"`);
  for (const k of ['x', 'y', 'width', 'height']) checkNumber(g.attrs[k], `${what}: ${k}`);
  if (g.attrs.relative !== undefined && g.attrs.relative !== '0' && g.attrs.relative !== '1') fail(`${what}: relative must be 0 or 1`);
  noText(g, `${what}: geometry`);
  for (const c of elements(g)) {
    if (c.name === 'mxPoint') {
      if (stray(c, POINT_ATTRS)) fail(`${what}: a point has an attribute that is not allowed`);
      checkNumber(c.attrs.x, `${what}: point x`);
      checkNumber(c.attrs.y, `${what}: point y`);
      if (!['sourcePoint', 'targetPoint', 'offset'].includes(c.attrs.as ?? '')) fail(`${what}: a point needs as="sourcePoint", "targetPoint" or "offset"`);
    } else if (c.name === 'Array') {
      if (c.attrs.as !== 'points' || Object.keys(c.attrs).length !== 1) fail(`${what}: only <Array as="points"> is allowed inside a geometry`);
      if (!edge) fail(`${what}: a route (points) belongs to an edge`);
      const pts = elements(c);
      if (pts.length > 40) fail(`${what}: an edge has more than 40 route points`);
      for (const p of pts) {
        if (p.name !== 'mxPoint' || stray(p, ['x', 'y'])) fail(`${what}: a route may only hold <mxPoint x y/>`);
        checkNumber(p.attrs.x, `${what}: point x`);
        checkNumber(p.attrs.y, `${what}: point y`);
      }
    } else fail(`${what}: <${c.name}> is not allowed inside a geometry`);
  }
}

interface Cell {
  id: string;
  parent: string | null;
  source?: string;
  target?: string;
  node: XNode;
}

/**
 * Check the agent's draw.io XML and return the portal's own serialisation of it with some counts. Throws DrawioError with
 * a message fit for the person (and the agent, in the session) who asked for the diagram.
 */
export function validateDrawio(input: unknown): DrawioInfo {
  if (typeof input !== 'string' || !input.trim()) fail('The diagram file is empty');
  const raw = (input as string).replace(/^﻿/, '').trim();
  if (Buffer.byteLength(raw) > DRAWIO_LIMITS.bytes) fail(`The diagram file is too large (${Math.round(Buffer.byteLength(raw) / 1000)} KB, max ${Math.round(DRAWIO_LIMITS.bytes / 1000)} KB). Draw fewer icons or split it into several diagrams.`);
  if (raw.includes('\0')) fail('The diagram file contains invalid characters');
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(raw)) fail('The diagram file uses a DOCTYPE, entity or CDATA section, which is not allowed');
  if (/<\?(?!xml\s)/i.test(raw) || raw.indexOf('<?', 5) > 0) fail('The diagram file contains processing instructions, which are not allowed');
  let root: XNode;
  try {
    root = parseXml(raw);
  } catch (e) {
    if (e instanceof XmlError) return fail(`The diagram file is not well-formed XML (${e.message}). It must be a single <mxfile> with one <diagram> holding an <mxGraphModel>.`);
    throw e;
  }

  let model: XNode;
  let pageName = 'Page-1';
  if (root.name === 'mxGraphModel') model = root;
  else if (root.name === 'mxfile') {
    noText(root, 'The <mxfile>');
    const pages = elements(root);
    if (!pages.length || pages.some((p) => p.name !== 'diagram')) fail('An <mxfile> may hold only <diagram> pages');
    if (pages.length > 1) fail('The diagram file has more than one page. Put the whole picture on one page (or write several diagrams).');
    const page = pages[0];
    noText(page, 'The <diagram> page');
    const inner = elements(page);
    if (inner.length !== 1 || inner[0].name !== 'mxGraphModel') fail('The <diagram> page must hold exactly one <mxGraphModel> as plain XML (not compressed)');
    model = inner[0];
    if (page.attrs.name) pageName = page.attrs.name.replace(/[^\w .-]/g, '').slice(0, DRAWIO_LIMITS.pageNameChars) || pageName;
  } else return fail(`The diagram file must start with <mxfile> (found <${root.name}>)`);

  noText(model, 'The <mxGraphModel>');
  const rootEl = elements(model).filter((c) => c.name === 'root');
  if (rootEl.length !== 1 || elements(model).length !== 1) fail('The <mxGraphModel> must hold exactly one <root>');
  noText(rootEl[0], 'The <root>');

  const cells: Cell[] = [];
  const ids = new Set<string>();
  let vertices = 0;
  let edges = 0;
  let icons = 0;
  let groups = 0;
  const images = new Set<string>();

  for (const el of elements(rootEl[0])) {
    let cell = el;
    let label: string | undefined;
    let wrapperId: string | undefined;
    if (WRAPPERS.includes(el.name)) {
      const bad = stray(el, WRAPPER_ATTRS);
      if (bad) fail(`<${el.name}> has the attribute "${bad}", which is not allowed`);
      const inner = elements(el);
      if (inner.length !== 1 || inner[0].name !== 'mxCell') fail(`<${el.name}> must hold exactly one <mxCell>`);
      cell = inner[0];
      label = el.attrs.label;
      wrapperId = el.attrs.id;
    } else if (el.name !== 'mxCell') fail(`<${el.name}> is not allowed inside <root> (only <mxCell>)`);
    const bad = stray(cell, CELL_ATTRS);
    if (bad) fail(`An <mxCell> has the attribute "${bad}", which is not allowed`);
    const id = wrapperId ?? cell.attrs.id;
    if (!id || !ID_RE.test(id)) fail(`An <mxCell> has a missing or invalid id ("${String(id ?? '').slice(0, 30)}")`);
    if (ids.has(id)) fail(`The id "${id}" is used twice`);
    ids.add(id);
    const what = `Cell "${id}"`;
    noText(cell, what);
    const isVertex = cell.attrs.vertex === '1';
    const isEdge = cell.attrs.edge === '1';
    if (isVertex && isEdge) fail(`${what} is both a vertex and an edge`);
    for (const k of ['vertex', 'edge', 'connectable', 'collapsed', 'visible']) if (cell.attrs[k] !== undefined && cell.attrs[k] !== '0' && cell.attrs[k] !== '1') fail(`${what}: ${k} must be 0 or 1`);
    const value = label ?? cell.attrs.value ?? '';
    const style = cell.attrs.style ?? '';
    const s = checkStyle(style, what);
    // Text-box cells get a larger label allowance; icons, groups, edges and badges stay at the smaller limit.
    const labelLimit = isTextBox(style) && !s.icon && !s.group ? DRAWIO_LIMITS.textBoxChars : DRAWIO_LIMITS.labelChars;
    checkLabel(value, `${what}: the label`, labelLimit);
    const geoms = elements(cell);
    if (geoms.length > 1 || geoms.some((g) => g.name !== 'mxGeometry')) fail(`${what} may hold only one <mxGeometry>`);
    if (geoms[0]) checkGeometry(geoms[0], isEdge, what);
    if (isVertex) {
      if (!geoms[0]) fail(`${what} is a vertex without an <mxGeometry>, so it would not be drawn`);
      vertices++;
      if (s.icon) icons++;
      if (s.group) groups++;
      if (s.image) images.add(s.image);
    } else if (isEdge) edges++;
    else if (id !== '0' && cell.attrs.parent !== '0') fail(`${what} is neither a vertex nor an edge`);
    cells.push({ id, parent: cell.attrs.parent ?? null, source: cell.attrs.source, target: cell.attrs.target, node: cell });
    if (cells.length > DRAWIO_LIMITS.cells) fail(`The diagram has more than ${DRAWIO_LIMITS.cells} cells. Draw fewer things or split it into several diagrams.`);
  }
  if (!ids.has('0')) fail('The model has no root cell <mxCell id="0"/>');
  if (icons > DRAWIO_LIMITS.icons) fail(`The diagram has ${icons} icons (max ${DRAWIO_LIMITS.icons}). Split it into several diagrams.`);
  const byId = new Map(cells.map((c) => [c.id, c]));
  for (const c of cells) {
    if (c.id === '0') {
      if (c.parent) fail('The root cell "0" must not have a parent');
      continue;
    }
    if (!c.parent || !byId.has(c.parent)) fail(`Cell "${c.id}" has a parent that does not exist ("${c.parent ?? ''}")`);
    for (const ref of [c.source, c.target]) if (ref !== undefined && !byId.has(ref)) fail(`Edge "${c.id}" connects to "${ref}", which does not exist`);
    let depth = 0;
    for (let p: Cell | undefined = c; p && p.parent; p = byId.get(p.parent)) if (++depth > DRAWIO_LIMITS.nesting) fail(`Cell "${c.id}" is nested more than ${DRAWIO_LIMITS.nesting} levels deep, or its parents loop`);
  }
  if (!vertices) fail('The diagram has no shapes');

  const attrs: Record<string, string> = {};
  for (const k of MODEL_ATTRS) {
    const v = model.attrs[k];
    if (v !== undefined && /^[\w#.-]{0,20}$/.test(v)) attrs[k] = v;
  }
  const rebuilt: XNode[] = cells.map((c) => {
    const n = c.node;
    const a: Record<string, string> = {};
    for (const k of CELL_ATTRS) if (n.attrs[k] !== undefined) a[k] = n.attrs[k];
    a.id = c.id;
    const wrapped = elements(rootEl[0]).find((e) => WRAPPERS.includes(e.name) && e.attrs.id === c.id);
    if (wrapped?.attrs.label !== undefined) a.value = wrapped.attrs.label;
    const geo = elements(n)[0];
    const children: XNode[] = [];
    if (geo) {
      const g: XNode = { name: 'mxGeometry', attrs: Object.fromEntries(GEOMETRY_ATTRS.filter((k) => geo.attrs[k] !== undefined).map((k) => [k, geo.attrs[k]])), children: [] };
      for (const p of elements(geo)) {
        if (p.name === 'mxPoint') g.children.push({ name: 'mxPoint', attrs: Object.fromEntries(POINT_ATTRS.filter((k) => p.attrs[k] !== undefined).map((k) => [k, p.attrs[k]])), children: [] });
        else g.children.push({ name: 'Array', attrs: { as: 'points' }, children: elements(p).map((q) => ({ name: 'mxPoint', attrs: { x: q.attrs.x ?? '0', y: q.attrs.y ?? '0' }, children: [] })) });
      }
      children.push(g);
    }
    return { name: 'mxCell', attrs: Object.fromEntries(CELL_ATTRS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]])), children };
  });
  const tree: XNode = {
    name: 'mxfile',
    attrs: { host: 'agent-portal' },
    children: [{ name: 'diagram', attrs: { id: 'page-1', name: pageName }, children: [{ name: 'mxGraphModel', attrs, children: [{ name: 'root', attrs: {}, children: rebuilt }] }] }],
  };
  const xml = serializeXml(tree, false);
  if (Buffer.byteLength(xml) > DRAWIO_LIMITS.bytes * 2) fail('The diagram file is too large');
  return { xml, cells: cells.length, vertices, edges, icons, groups, images: [...images] };
}

export interface DrawioDensity {
  nodes: number;
  lines: number;
  icons: number;
  edges: number;
  /** Too big to read comfortably: the UI says so and suggests splitting it. */
  dense: boolean;
}

/** Size facts of a stored (already validated) diagram, for the "very dense" note. Never throws. */
export function drawioDensity(xml: string): DrawioDensity {
  const text = String(xml ?? '');
  const vertices = (text.match(/\bvertex="1"/g) ?? []).length;
  const edges = (text.match(/\bedge="1"/g) ?? []).length;
  const icons = (text.match(/\bstyle="[^"]*(?:shape=mxgraph\.[\w.]+|image=img\/lib\/[^";]+)/g) ?? []).filter((s) => !/mxgraph\.[a-z0-9_]+\.\w*group/i.test(s) && !/container=1/.test(s)).length;
  return { nodes: vertices, lines: vertices + edges, icons, edges, dense: icons > READABLE_ICONS + 10 || vertices > 120 || vertices + edges > 220 };
}

/** The label texts of a diagram, in order, for a plain-text summary or a search. Never throws. */
export function drawioLabels(xml: string, max = 60): string[] {
  const out: string[] = [];
  for (const m of String(xml ?? '').matchAll(/\bvalue="([^"]*)"/g)) {
    const t = m[1]
      .replace(/&lt;[^&]*?&gt;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    if (t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
