/**
 * Word documents that follow an uploaded template (D-13, NEW-6).
 *
 * The `docx` library cannot open a file, so a template cannot be passed to it. Technique (the same idea as the PowerPoint
 * writer, pptx-template.ts): the document is first written by `docx` as usual, with paragraph, run and table styles
 * chosen by NAME from the template (`Heading 1`, `Title`, `List Bullet`, `Table Grid`, ...), and then its body is
 * transplanted into the template package:
 *
 *   kept from the template   styles, theme, fonts, numbering, settings, page setup (the last section properties), headers,
 *                            footers (with their logos and page-number fields), document properties
 *   replaced                 the body (sample text, cover text, placeholders) with the generated content
 *   merged                   pictures (copied under new names), hyperlinks (new relationships), list numbering (appended with
 *                            new ids so every numbered list restarts at 1), and any style the document needs that the template
 *                            lacks (copied from the built-in definition, with a warning for headings and the title)
 *
 * Trade-offs: a template's own body content (a cover page, a table of contents, content controls, extra sections) is not
 * kept, only its last section's page setup and headers. Numbered lists use the portal's numbering definitions (so each list
 * restarts at 1) with the template's paragraph style; bullet lists use the template's own bullet style when it has one.
 * `{{title}}` and `{{date}}` typed in a header or footer are filled in. Macros are refused at upload and never copied.
 */
import { CT, OoxmlPackage, REL, child, childrenNamed, elements, findDeep, local, resolveTarget, serializeXml, xmlEscape, type XNode } from './ooxml.ts';

/** Style ids (from the template) the document builder should use; a missing entry means "use the built-in look". */
export interface WordLook {
  title?: string;
  heading: (string | undefined)[];
  /** Bullet styles by nesting level; only styles that carry their own bullet are listed. */
  bullet: (string | undefined)[];
  /** Paragraph look for numbered lists (the numbering itself is the portal's). */
  number: (string | undefined)[];
  code?: string;
  caption?: string;
  table?: string;
  hyperlink?: string;
  /** Width and height of the text area in inches. */
  textWidthIn: number;
  textHeightIn: number;
}

export class WordTemplateError extends Error {}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NUMBERING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';
const REL_STYLES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';
const REL_HEADER = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header';
const REL_FOOTER = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer';
const REL_HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const CT_NUMBERING = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';
const CT_STYLES = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const IMAGE_CT: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml' };

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Attributes from Word 2010+ extension namespaces; dropped from copied definitions so they need no extra declarations. */
const stripExt = (xml: string): string => xml.replace(/\sw1[0-9][a-z0-9]*:[\w]+="[^"]*"/g, '');

interface StyleDef {
  id: string;
  name: string;
  type: string;
  hasNumbering: boolean;
}

function readStyles(root: XNode): StyleDef[] {
  return childrenNamed(root, 'style').map((s) => ({
    id: s.attrs['w:styleId'] ?? '',
    name: child(s, 'name')?.attrs['w:val'] ?? s.attrs['w:styleId'] ?? '',
    type: s.attrs['w:type'] ?? 'paragraph',
    hasNumbering: Boolean(findDeep(child(s, 'pPr'), 'numPr')),
  }));
}

function sectionSize(sect: XNode | undefined): { w: number; h: number; textW: number; textH: number } {
  const sz = child(sect, 'pgSz')?.attrs ?? {};
  const mar = child(sect, 'pgMar')?.attrs ?? {};
  const n = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);
  const w = n(sz['w:w'], 12240);
  const h = n(sz['w:h'], 15840);
  const textW = Math.max(2880, w - n(mar['w:left'], 1440) - n(mar['w:right'], 1440));
  const textH = Math.max(2880, h - n(mar['w:top'], 1440) - n(mar['w:bottom'], 1440));
  return { w: w / 1440, h: h / 1440, textW: textW / 1440, textH: textH / 1440 };
}

function lastSection(docRoot: XNode): XNode | undefined {
  const body = child(docRoot, 'body');
  const last = elements(body).at(-1);
  return last && local(last.name) === 'sectPr' ? last : undefined;
}

/** How each role is played by the template's styles (null when the template has no style for it). */
function resolveRoles(styles: StyleDef[]): { look: Omit<WordLook, 'textWidthIn' | 'textHeightIn'>; mapping: Record<string, string | null> } {
  const find = (type: string, ...names: string[]): StyleDef | undefined => {
    for (const n of names) {
      const hit = styles.find((s) => s.type === type && (norm(s.name) === norm(n) || norm(s.id) === norm(n)));
      if (hit) return hit;
    }
    return undefined;
  };
  const mapping: Record<string, string | null> = {};
  const note = (role: string, s: StyleDef | undefined) => {
    mapping[role] = s?.name ?? null;
    return s?.id;
  };
  const title = note('title', find('paragraph', 'Title'));
  const heading = [1, 2, 3, 4, 5, 6].map((n) => note(`heading${n}`, find('paragraph', `Heading ${n}`)));
  const bullet: (string | undefined)[] = [];
  const number: (string | undefined)[] = [];
  for (let l = 0; l < 5; l++) {
    const suffix = l === 0 ? '' : ` ${l + 1}`;
    const b = find('paragraph', `List Bullet${suffix}`);
    bullet.push(b?.hasNumbering ? b.id : undefined);
    if (l === 0) mapping.bullets = b ? b.name : null;
    const nn = find('paragraph', `List Number${suffix}`);
    number.push(nn?.id);
    if (l === 0) mapping.numbered = nn ? nn.name : null;
  }
  const code = note('code', find('paragraph', 'Code', 'Source Code', 'Code Block', 'HTML Preformatted', 'Macro Text', 'Plain Text'));
  const caption = note('caption', find('paragraph', 'Caption'));
  const table = note('table', find('table', 'Grid Table 4 Accent 1', 'Grid Table 4', 'List Table 3 Accent 1', 'Table Grid'));
  const hyperlink = note('hyperlink', find('character', 'Hyperlink'));
  return { look: { title, heading, bullet, number, code, caption, table, hyperlink }, mapping };
}

function themeFonts(theme: string | null): { major: string; minor: string } | undefined {
  if (!theme) return undefined;
  const pick = (tag: string) => new RegExp(`<a:${tag}>\\s*<a:latin typeface="([^"]*)"`).exec(theme)?.[1] ?? '';
  const major = pick('majorFont');
  const minor = pick('minorFont');
  return major || minor ? { major, minor } : undefined;
}

export interface WordTemplateInfo {
  pageWidthIn: number;
  pageHeightIn: number;
  fonts?: { major: string; minor: string };
  mapping: Record<string, string | null>;
  header: boolean;
  footer: boolean;
  warnings: string[];
}

/** Describe an uploaded Word template: page, fonts, which styles play which role, and whether it has a header and footer. */
export async function analyzeWordTemplate(pkg: OoxmlPackage): Promise<WordTemplateInfo> {
  const main = await pkg.mainPart();
  const doc = await pkg.xml(main);
  const sect = sectionSize(lastSection(doc));
  const warnings: string[] = [];
  let mapping: Record<string, string | null> = {};
  if (pkg.has('word/styles.xml')) {
    const r = resolveRoles(readStyles(await pkg.xml('word/styles.xml')));
    mapping = r.mapping;
    const missing = ['title', 'heading1', 'heading2', 'heading3'].filter((k) => !mapping[k]);
    if (missing.length) warnings.push(`The template has no style for: ${missing.map((k) => k.replace('heading', 'Heading ').replace('title', 'Title')).join(', ')}. The built-in look is used for those.`);
    if (!mapping.table) warnings.push('The template has no table style (such as "Table Grid"); tables use the built-in look.');
  }
  const rels = await pkg.rels(main);
  const hasPart = (t: string) => rels.some((r) => r.type === t && pkg.has(r.path));
  const theme = pkg.has('word/theme/theme1.xml') ? await pkg.text('word/theme/theme1.xml') : null;
  return { pageWidthIn: Math.round(sect.w * 100) / 100, pageHeightIn: Math.round(sect.h * 100) / 100, fonts: themeFonts(theme), mapping, header: hasPart(REL_HEADER), footer: hasPart(REL_FOOTER), warnings };
}

/* ------------------------------------------------------------------ */
/* Applying a template                                                 */
/* ------------------------------------------------------------------ */

export interface WordTemplate {
  look: WordLook;
  info: WordTemplateInfo;
  /** Move the body of a document written by `docx` into a copy of the template. */
  apply(generated: Buffer, meta: { title?: string }): Promise<{ buffer: Buffer; warnings: string[] }>;
}

/** Open a template. Throws WordTemplateError when it cannot serve as one (damaged, not Word, unusual structure). */
export async function openWordTemplate(buf: Buffer): Promise<WordTemplate> {
  let pkg: OoxmlPackage;
  let main: string;
  let docRoot: XNode;
  try {
    pkg = await OoxmlPackage.open(buf);
    main = await pkg.mainPart();
    docRoot = await pkg.xml(main);
  } catch (e: any) {
    throw new WordTemplateError(String(e?.message ?? e));
  }
  if (local(docRoot.name) !== 'document' || docRoot.name !== 'w:document' || docRoot.attrs['xmlns:w'] !== W_NS) throw new WordTemplateError('the main part is not a standard Word document (unusual namespace prefixes are not supported)');
  if (!child(docRoot, 'body')) throw new WordTemplateError('the template has no document body');
  const info = await analyzeWordTemplate(pkg);
  const roles = pkg.has('word/styles.xml') ? resolveRoles(readStyles(await pkg.xml('word/styles.xml'))).look : { heading: [], bullet: [], number: [] };
  const sect = sectionSize(lastSection(docRoot));
  const look: WordLook = { ...roles, textWidthIn: sect.textW, textHeightIn: sect.textH };
  return { look, info, apply: (generated, meta) => transplant(buf, generated, meta) };
}

function nsDecls(tag: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of tag.matchAll(/\s(xmlns:[\w.-]+)="([^"]*)"/g)) m.set(a[1], a[2]);
  return m;
}

function replaceAttrIds(inner: string, map: Map<string, string>): string {
  return inner.replace(/\b(r:(?:embed|id|link))="([^"]+)"/g, (all, attr: string, id: string) => (map.has(id) ? `${attr}="${map.get(id)}"` : all));
}

async function transplant(templateBuf: Buffer, generatedBuf: Buffer, meta: { title?: string }): Promise<{ buffer: Buffer; warnings: string[] }> {
  const warnings: string[] = [];
  const tpl = await OoxmlPackage.open(templateBuf);
  const gen = await OoxmlPackage.open(generatedBuf);
  const main = await tpl.mainPart();
  const genMain = await gen.mainPart();

  // ---- the generated body, without its own section properties ----
  const genXml = await gen.text(genMain);
  const gOpen = /<w:body\b[^>]*>/.exec(genXml);
  const gClose = genXml.lastIndexOf('</w:body>');
  if (!gOpen || gClose < 0) throw new WordTemplateError('the generated document has no body');
  let inner = genXml.slice(gOpen.index + gOpen[0].length, gClose);
  const gSect = inner.lastIndexOf('<w:sectPr');
  if (gSect >= 0) inner = inner.slice(0, gSect);

  // ---- relationships: pictures and links get new ids and new part names ----
  const tplRels = (await tpl.rels(main)).map((r) => ({ id: r.id, type: r.type, target: r.target, external: r.external }));
  const used = new Set(tplRels.map((r) => r.id));
  let counter = 0;
  const freshId = () => {
    let id: string;
    do id = `rIdG${++counter}`;
    while (used.has(id));
    used.add(id);
    return id;
  };
  const idMap = new Map<string, string>();
  const ct = await tpl.contentTypes();
  const genCt = await gen.contentTypes();
  for (const r of await gen.rels(genMain)) {
    if (r.type === REL.image && !r.external && gen.has(r.path)) {
      const base = r.path.split('/').pop()!;
      const ext = base.split('.').pop()!.toLowerCase();
      const name = `word/media/gen_${base}`;
      tpl.set(name, await gen.bytes(r.path));
      if (!ct.defaults.has(ext)) ct.defaults.set(ext, genCt.defaults.get(ext) ?? IMAGE_CT[ext] ?? 'application/octet-stream');
      const id = freshId();
      idMap.set(r.id, id);
      tplRels.push({ id, type: REL.image, target: `media/gen_${base}`, external: false });
    } else if (r.type === REL_HYPERLINK && r.external) {
      const id = freshId();
      idMap.set(r.id, id);
      tplRels.push({ id, type: REL_HYPERLINK, target: r.target, external: true });
    }
  }
  inner = replaceAttrIds(inner, idMap);

  // ---- numbering: append the portal's definitions with new ids ----
  const genNumRel = (await gen.rels(genMain)).find((r) => r.type === REL_NUMBERING && gen.has(r.path));
  if (genNumRel && /<w:numId\b/.test(inner)) {
    const genNum = await gen.text(genNumRel.path);
    const abstracts = [...genNum.matchAll(/<w:abstractNum\b[\s\S]*?<\/w:abstractNum>/g)].map((m) => m[0]);
    const nums = [...genNum.matchAll(/<w:num\b[\s\S]*?<\/w:num>/g)].map((m) => m[0]);
    const tplNumRel = tplRels.find((r) => r.type === REL_NUMBERING && !r.external);
    let numPath = tplNumRel ? resolveTarget(main, tplNumRel.target) : 'word/numbering.xml';
    let numXml: string;
    if (tplNumRel && tpl.has(numPath)) numXml = await tpl.text(numPath);
    else {
      numPath = 'word/numbering.xml';
      numXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="${W_NS}"></w:numbering>`;
      tplRels.push({ id: freshId(), type: REL_NUMBERING, target: 'numbering.xml', external: false });
      ct.overrides.set(numPath, CT_NUMBERING);
    }
    const maxOf = (re: RegExp) => Math.max(0, ...[...numXml.matchAll(re)].map((m) => Number(m[1])));
    const absOffset = maxOf(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"/g) + 1;
    const numOffset = maxOf(/<w:num\b[^>]*w:numId="(\d+)"/g);
    const absOut = abstracts.map((a) => stripExt(a).replace(/(<w:abstractNum\b[^>]*w:abstractNumId=")(\d+)"/, (_m, p: string, n: string) => `${p}${Number(n) + absOffset}"`).replace(/\sw:nsid="[^"]*"/, '').replace(/\sw:tmpl="[^"]*"/, ''));
    const numOut = nums.map((n) =>
      stripExt(n)
        .replace(/(<w:num\b[^>]*w:numId=")(\d+)"/, (_m, p: string, v: string) => `${p}${Number(v) + numOffset}"`)
        .replace(/(<w:abstractNumId\b[^>]*w:val=")(\d+)"/, (_m, p: string, v: string) => `${p}${Number(v) + absOffset}"`),
    );
    inner = inner.replace(/(<w:numId\b[^>]*w:val=")(\d+)"/g, (_m, p: string, v: string) => `${p}${Number(v) + numOffset}"`);
    const firstNum = numXml.search(/<w:num\b/);
    const closeAt = numXml.lastIndexOf('</w:numbering>');
    if (closeAt < 0) throw new WordTemplateError('the numbering part is not usable');
    const tail = numXml.slice(closeAt);
    let head = numXml.slice(0, closeAt);
    const macro = head.search(/<w:numIdMacAtCleanup\b/);
    const macroPart = macro >= 0 ? head.slice(macro) : '';
    if (macro >= 0) head = head.slice(0, macro);
    head = firstNum >= 0 && firstNum < head.length ? head.slice(0, firstNum) + absOut.join('') + head.slice(firstNum) : head + absOut.join('');
    tpl.set(numPath, head + numOut.join('') + macroPart + tail);
  }

  // ---- styles the document needs and the template lacks ----
  const genStylesXml = gen.has('word/styles.xml') ? await gen.text('word/styles.xml') : '';
  const usedStyles = new Set([...inner.matchAll(/<w:(?:pStyle|rStyle|tblStyle)\b[^>]*w:val="([^"]+)"/g)].map((m) => m[1]));
  const tplStylesRel = tplRels.find((r) => r.type === REL_STYLES && !r.external);
  if (!tplStylesRel || !tpl.has('word/styles.xml')) {
    if (genStylesXml) {
      tpl.set('word/styles.xml', genStylesXml);
      if (!tplStylesRel) tplRels.push({ id: freshId(), type: REL_STYLES, target: 'styles.xml', external: false });
      ct.overrides.set('word/styles.xml', CT_STYLES);
      warnings.push('The template has no styles part, so the built-in styles were used.');
    }
  } else if (usedStyles.size) {
    let stylesXml = await tpl.text('word/styles.xml');
    const have = new Set([...stylesXml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"/g)].map((m) => m[1]));
    const copied: string[] = [];
    const queue = [...usedStyles];
    while (queue.length) {
      const id = queue.shift()!;
      if (have.has(id)) continue;
      const rawDef = new RegExp(`<w:style\\b[^>]*w:styleId="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?</w:style>`).exec(genStylesXml)?.[0];
      if (!rawDef) continue;
      const def = stripExt(rawDef);
      have.add(id);
      copied.push(id);
      for (const dep of def.matchAll(/<w:(?:basedOn|link|next)\b[^>]*w:val="([^"]+)"/g)) queue.push(dep[1]);
      const at = stylesXml.lastIndexOf('</w:styles>');
      if (at < 0) throw new WordTemplateError('the styles part is not usable');
      stylesXml = stylesXml.slice(0, at) + def + stylesXml.slice(at);
    }
    if (copied.length) {
      tpl.set('word/styles.xml', stylesXml);
      const named = copied.filter((id) => /^(Heading[1-6]|Title)$/.test(id)).map((id) => id.replace(/^Heading/, 'Heading '));
      if (named.length) warnings.push(`The template has no style for ${named.join(', ')}; the built-in look was used for ${named.length === 1 ? 'it' : 'them'}.`);
    }
  }

  // ---- tables follow the template's table style, including its header-row look ----
  inner = inner.replace(/<w:tblPr>([\s\S]*?)<\/w:tblPr>/g, (all, body: string) =>
    /<w:tblStyle\b/.test(body) && !/<w:tblLook\b/.test(body) ? `<w:tblPr>${body}<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>` : all,
  );

  // ---- the new document part: the template's root and final section, the generated body ----
  const tplXml = await tpl.text(main);
  const tOpen = /<w:body\b[^>]*>/.exec(tplXml);
  const tClose = tplXml.lastIndexOf('</w:body>');
  const rootTag = /<w:document\b[^>]*>/.exec(tplXml);
  if (!tOpen || tClose < 0 || !rootTag) throw new WordTemplateError('the template body could not be located');
  const docRoot = await tpl.xml(main);
  const sect = lastSection(docRoot);
  const sectXml = sect ? serializeXml(sect, false) : '';
  if (!sect) warnings.push('The template has no section properties at the end of its body, so Word defaults apply to the page setup.');
  const have = nsDecls(rootTag[0]);
  const add = [...nsDecls(/<w:document\b[^>]*>/.exec(genXml)?.[0] ?? '')].filter(([k]) => !have.has(k));
  const newRoot = add.length ? rootTag[0].replace(/>$/, add.map(([k, v]) => ` ${k}="${v}"`).join('') + '>') : rootTag[0];
  tpl.set(main, tplXml.slice(0, rootTag.index) + newRoot + tplXml.slice(rootTag.index + rootTag[0].length, tOpen.index + tOpen[0].length) + inner + sectXml + tplXml.slice(tClose));

  // ---- relationships and content types ----
  await tpl.writeRels(main, tplRels);
  ct.overrides.set(main, CT.docxMain);
  await tpl.writeContentTypes(ct);

  // ---- header and footer text, document properties ----
  const date = new Date().toISOString().slice(0, 10);
  const title = (meta.title ?? '').trim();
  for (const r of tplRels) {
    if ((r.type !== REL_HEADER && r.type !== REL_FOOTER) || r.external) continue;
    const path = resolveTarget(main, r.target);
    if (!tpl.has(path)) continue;
    const text = await tpl.text(path);
    if (!/\{\{(title|date)\}\}/.test(text)) continue;
    tpl.set(path, text.replace(/\{\{title\}\}/g, xmlEscape(title)).replace(/\{\{date\}\}/g, date));
  }
  if (title && tpl.has('docProps/core.xml')) {
    const core = await tpl.text('docProps/core.xml');
    if (/<dc:title>[\s\S]*?<\/dc:title>|<dc:title\/>/.test(core)) tpl.set('docProps/core.xml', core.replace(/<dc:title>[\s\S]*?<\/dc:title>|<dc:title\/>/, `<dc:title>${xmlEscape(title)}</dc:title>`));
  }
  return { buffer: await tpl.toBuffer(), warnings };
}
