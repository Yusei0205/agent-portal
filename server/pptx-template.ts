/**
 * Fill a PowerPoint template's own layouts (D-13, NEW-7).
 *
 * pptxgenjs cannot open an existing file, so a deck that must follow a company template is written here instead: the
 * template package is opened with jszip, its sample slides are dropped, and every new slide is written as OOXML that
 * points at one of the template's slide layouts and fills that layout's placeholders (title, body, subtitle, slide
 * number). Because the slides carry no fonts, colours or positions of their own, they inherit them from the layout, the
 * master and the theme: the template's fonts and colours, slide size, logo and background all apply. Tables, pictures
 * and notes are added as ordinary shapes inside the layout's content area.
 *
 * Trade-off: this is a second PowerPoint writer next to the pptxgenjs one, so only the slide elements make-doc offers
 * (title, section, bullets, text, table, image, notes) are supported in template mode, and a template that is unusual
 * (no title layout, damaged parts) is refused with a reason so the caller can fall back to the built-in look.
 */
import {
  CT,
  OoxmlPackage,
  PackageError,
  REL,
  child,
  childrenNamed,
  dig,
  elements,
  findDeep,
  local,
  serializeXml,
  xmlEscape,
  type Rel,
  type XNode,
} from './ooxml.ts';

const EMU = 914400;
const inch = (n: number): number => Math.round(n * EMU);

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutPh {
  /** The ph type as written ('' for the default, which PowerPoint treats as a content placeholder). */
  type: string;
  idx: number | null;
  box: Box | null;
}

export interface LayoutInfo {
  path: string;
  name: string;
  /** The layout's type attribute ('cust' when absent). */
  type: string;
  phs: LayoutPh[];
}

export type SlideLayout = 'title' | 'bullets' | 'text' | 'table' | 'section' | 'image';

export type PreparedVisual =
  | { kind: 'picture'; data: Buffer; ext: 'png' | 'jpeg'; alt: string; caption?: string; align?: 'left' | 'center' | 'right'; fit: (maxW: number, maxH: number, fill: boolean) => { w: number; h: number } }
  | { kind: 'source'; text: string; note: string; caption?: string }
  | { kind: 'missing'; text: string; caption?: string };

export interface PreparedSlide {
  layout: SlideLayout;
  title: string;
  subtitle?: string;
  bullets?: string[];
  text?: string;
  table?: { header?: string[]; rows: string[][] };
  visual?: PreparedVisual;
  notes?: string;
}

export interface TemplateAnalysis {
  slideWidth: number;
  slideHeight: number;
  layouts: LayoutInfo[];
  masterCount: number;
  fonts: { major: string; minor: string };
  colors: Record<string, string>;
  mapping: LayoutMapping;
}

export interface LayoutMapping {
  title: LayoutInfo | null;
  section: LayoutInfo | null;
  content: LayoutInfo | null;
  titleOnly: LayoutInfo | null;
  side: LayoutInfo | null;
}

/* ------------------------------------------------------------------ */
/* Reading a template                                                  */
/* ------------------------------------------------------------------ */

const isTitlePh = (p: LayoutPh) => p.type === 'title' || p.type === 'ctrTitle';
const isSubPh = (p: LayoutPh) => p.type === 'subTitle';
const isBodyPh = (p: LayoutPh) => p.type === '' || p.type === 'body' || p.type === 'obj';
const isPicPh = (p: LayoutPh) => p.type === 'pic';
const isMetaPh = (p: LayoutPh) => ['dt', 'ftr', 'sldNum', 'hdr'].includes(p.type);

function boxOf(sp: XNode): Box | null {
  const x = dig(sp, 'spPr', 'xfrm');
  const off = child(x, 'off');
  const ext = child(x, 'ext');
  if (!off || !ext) return null;
  const n = [off.attrs.x, off.attrs.y, ext.attrs.cx, ext.attrs.cy].map(Number);
  return n.every(Number.isFinite) && n[2] > 0 && n[3] > 0 ? { x: n[0], y: n[1], w: n[2], h: n[3] } : null;
}

function placeholders(tree: XNode | undefined): LayoutPh[] {
  const out: LayoutPh[] = [];
  for (const sp of childrenNamed(tree, 'sp')) {
    const ph = dig(sp, 'nvSpPr', 'nvPr', 'ph');
    if (!ph) continue;
    const idx = ph.attrs.idx === undefined ? null : Number(ph.attrs.idx);
    out.push({ type: ph.attrs.type ?? '', idx: Number.isFinite(idx as number) ? idx : null, box: boxOf(sp) });
  }
  return out;
}

/** The slide master's placeholder that a layout placeholder inherits its position from. */
function masterBox(masterPhs: LayoutPh[], p: LayoutPh): Box | null {
  const want = isTitlePh(p) ? ['title'] : isSubPh(p) || isBodyPh(p) || isPicPh(p) || ['tbl', 'chart', 'media'].includes(p.type) ? ['body'] : [p.type];
  return masterPhs.find((m) => want.includes(m.type) && m.box)?.box ?? null;
}

export async function analyzeTemplate(pkg: OoxmlPackage): Promise<TemplateAnalysis> {
  const presPath = await pkg.mainPart();
  const pres = await pkg.xml(presPath);
  const sz = child(pres, 'sldSz');
  const slideWidth = Number(sz?.attrs.cx);
  const slideHeight = Number(sz?.attrs.cy);
  if (!(slideWidth > 0 && slideHeight > 0)) throw new PackageError('The presentation has no slide size');
  const presRels = await pkg.rels(presPath);
  const masters = presRels.filter((r) => r.type === REL.slideMaster && pkg.has(r.path));
  if (!masters.length) throw new PackageError('The presentation has no slide master');

  const layouts: LayoutInfo[] = [];
  let fonts = { major: '', minor: '' };
  const colors: Record<string, string> = {};
  for (let mi = 0; mi < masters.length; mi++) {
    const mPath = masters[mi].path;
    const master = await pkg.xml(mPath);
    const mRels = await pkg.rels(mPath);
    const masterPhs = placeholders(dig(master, 'cSld', 'spTree'));
    const order = childrenNamed(dig(master, 'sldLayoutIdLst'), 'sldLayoutId').map((e) => e.attrs['r:id'] ?? Object.entries(e.attrs).find(([k]) => local(k) === 'id' && k !== 'id')?.[1]);
    const layoutRels = mRels.filter((r) => r.type === REL.slideLayout && pkg.has(r.path));
    const sorted = order.length ? order.map((id) => layoutRels.find((r) => r.id === id)).filter((r): r is Rel => Boolean(r)) : layoutRels;
    for (const lr of sorted.length ? sorted : layoutRels) {
      const lay = await pkg.xml(lr.path);
      const phs = placeholders(dig(lay, 'cSld', 'spTree')).map((p) => ({ ...p, box: p.box ?? masterBox(masterPhs, p) }));
      layouts.push({ path: lr.path, name: dig(lay, 'cSld')?.attrs.name ?? '', type: lay.attrs.type ?? 'cust', phs });
    }
    if (mi === 0) {
      const tr = mRels.find((r) => r.type === REL.theme && pkg.has(r.path));
      if (tr) {
        const theme = await pkg.xml(tr.path);
        const fs = dig(theme, 'themeElements', 'fontScheme');
        fonts = { major: dig(fs, 'majorFont', 'latin')?.attrs.typeface ?? '', minor: dig(fs, 'minorFont', 'latin')?.attrs.typeface ?? '' };
        for (const c of elements(dig(theme, 'themeElements', 'clrScheme'))) {
          const v = elements(c)[0];
          const hex = v?.attrs.val && /^[0-9a-fA-F]{6}$/.test(v.attrs.val) ? v.attrs.val : v?.attrs.lastClr;
          if (hex && /^[0-9a-fA-F]{6}$/.test(hex)) colors[local(c.name)] = hex.toUpperCase();
        }
      }
    }
  }
  if (!layouts.length) throw new PackageError('The presentation has no slide layouts');
  return { slideWidth, slideHeight, layouts, masterCount: masters.length, fonts, colors, mapping: mapLayouts(layouts) };
}

/** Which of the template's layouts plays each role: by layout type first, then by name, then by placeholder structure. */
export function mapLayouts(layouts: LayoutInfo[]): LayoutMapping {
  const byType = (...types: string[]) => layouts.find((l) => types.includes(l.type)) ?? null;
  const byName = (re: RegExp) => layouts.find((l) => re.test(l.name)) ?? null;
  const bodies = (l: LayoutInfo) => l.phs.filter(isBodyPh);
  const hasTitle = (l: LayoutInfo) => l.phs.some(isTitlePh);
  const plain = (l: LayoutInfo) => !['title', 'secHead', 'twoObj', 'twoTxTwoObj', 'titleOnly', 'blank', 'objOnly', 'picTx', 'tbl', 'chart', 'dgm', 'media'].includes(l.type);

  const title =
    byType('title') ??
    layouts.find((l) => l.phs.some((p) => p.type === 'ctrTitle')) ??
    byName(/title slide|cover|^title$/i) ??
    layouts.find((l) => hasTitle(l) && l.phs.some(isSubPh)) ??
    null;
  const section = byType('secHead') ?? byName(/section|divider|chapter|agenda/i) ?? null;
  const content =
    byType('obj', 'tx') ??
    layouts.find((l) => l !== title && l !== section && plain(l) && hasTitle(l) && bodies(l).length === 1 && !l.phs.some(isSubPh) && /content|bullet|text|body/i.test(l.name)) ??
    layouts.find((l) => l !== title && l !== section && plain(l) && hasTitle(l) && bodies(l).length === 1 && !l.phs.some(isSubPh) && !l.phs.some(isPicPh)) ??
    byName(/title and content|content|bullet/i) ??
    null;
  const titleOnly =
    byType('titleOnly') ??
    byName(/title only/i) ??
    layouts.find((l) => l !== title && l !== section && hasTitle(l) && !l.phs.some((p) => isBodyPh(p) || isSubPh(p) || isPicPh(p))) ??
    null;
  const side =
    byType('twoObj', 'objAndTx', 'txAndObj', 'objAndTwoObj') ??
    byName(/two content|content with|two column|two-column|picture with|text and (picture|image)/i) ??
    layouts.find((l) => l !== title && l !== section && hasTitle(l) && bodies(l).length + l.phs.filter(isPicPh).length >= 2 && !l.phs.some(isSubPh)) ??
    null;
  return { title, section, content, titleOnly, side: side && side !== content && side.phs.filter((p) => isBodyPh(p) || isPicPh(p)).length >= 2 ? side : null };
}

/* ------------------------------------------------------------------ */
/* Building slides                                                     */
/* ------------------------------------------------------------------ */

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const TREE_HEAD = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const DEFAULT_TABLE_STYLE = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}';
const ROWS_PER_SLIDE = 12;

const xfrm = (b: Box) => `<a:xfrm><a:off x="${Math.round(b.x)}" y="${Math.round(b.y)}"/><a:ext cx="${Math.round(b.w)}" cy="${Math.round(b.h)}"/></a:xfrm>`;

function paragraphs(text: string, pPr = '', rPr = ''): string {
  const lines = text.split(/\r?\n/);
  return lines.map((l) => (l ? `<a:p>${pPr}<a:r><a:rPr lang="en-US" dirty="0"${rPr}/><a:t>${xmlEscape(l)}</a:t></a:r></a:p>` : `<a:p>${pPr}<a:endParaRPr lang="en-US"/></a:p>`)).join('');
}

function codeParagraphs(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => `<a:p><a:r><a:rPr lang="en-US" sz="1200" dirty="0"><a:latin typeface="Consolas"/></a:rPr><a:t>${xmlEscape(l)}</a:t></a:r></a:p>`)
    .join('');
}

function phAttrs(p: LayoutPh): string {
  return `${p.type ? ` type="${xmlEscape(p.type)}"` : ''}${p.idx !== null ? ` idx="${p.idx}"` : ''}`;
}

class SlideBuilder {
  private id = 1;
  shapes: string[] = [];
  rels: { id: string; type: string; target: string }[] = [];
  media: { name: string; data: Buffer; ext: string }[] = [];
  constructor(
    readonly n: number,
    private mediaStart: number,
  ) {}
  nextId(): number {
    return ++this.id;
  }
  addRel(type: string, target: string): string {
    const id = `rId${this.rels.length + 1}`;
    this.rels.push({ id, type, target });
    return id;
  }
  addImage(data: Buffer, ext: 'png' | 'jpeg'): string {
    const name = `image-p${this.mediaStart + this.media.length + 1}.${ext === 'jpeg' ? 'jpg' : 'png'}`;
    this.media.push({ name, data, ext });
    return this.addRel(REL.image, `../media/${name}`);
  }

  placeholder(ph: LayoutPh, label: string, body: string, opts: { box?: Box; bodyPr?: string } = {}): void {
    const id = this.nextId();
    this.shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(label)} ${id - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${phAttrs(ph)}/></p:nvPr></p:nvSpPr>${opts.box ? `<p:spPr>${xfrm(opts.box)}</p:spPr>` : '<p:spPr/>'}<p:txBody>${opts.bodyPr ?? '<a:bodyPr/>'}<a:lstStyle/>${body}</p:txBody></p:sp>`,
    );
  }

  textBox(box: Box, body: string, opts: { fill?: boolean; autofit?: string } = {}): void {
    const id = this.nextId();
    this.shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id - 1}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${opts.fill ? '<a:solidFill><a:schemeClr val="bg2"/></a:solidFill>' : '<a:noFill/>'}</p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0">${opts.autofit ?? '<a:normAutofit/>'}</a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`,
    );
  }

  picture(box: Box, rId: string, alt: string): void {
    const id = this.nextId();
    this.shapes.push(
      `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id - 1}" descr="${xmlEscape(alt)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
    );
  }

  table(box: Box, header: string[] | undefined, rows: string[][], tableStyleId: string): void {
    const id = this.nextId();
    const cols = Math.max(header?.length ?? 0, ...rows.map((r) => r.length), 1);
    const all = [...(header ? [header] : []), ...rows];
    const weights = Array.from({ length: cols }, (_, c) => Math.min(40, Math.max(6, ...all.map((r) => (r[c] ?? '').length))));
    const sum = weights.reduce((a, b) => a + b, 0);
    let used = 0;
    const widths = weights.map((w, i) => {
      const cw = i === cols - 1 ? Math.round(box.w) - used : Math.round((box.w * w) / sum);
      used += cw;
      return cw;
    });
    const sz = cols > 5 ? 1100 : all.length > 9 ? 1200 : 1400;
    const rowH = Math.round((sz / 100) * 12700 * 1.2 + 91440);
    const cell = (t: string) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paragraphs(String(t ?? ''), '', ` sz="${sz}"`)}</a:txBody><a:tcPr/></a:tc>`;
    const tr = all.map((r) => `<a:tr h="${rowH}">${Array.from({ length: cols }, (_, c) => cell(r[c] ?? '')).join('')}</a:tr>`).join('');
    this.shapes.push(
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id - 1}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(box.w)}" cy="${rowH * all.length}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="${header ? 1 : 0}" bandRow="1"><a:tableStyleId>${xmlEscape(tableStyleId)}</a:tableStyleId></a:tblPr><a:tblGrid>${widths.map((w) => `<a:gridCol w="${w}"/>`).join('')}</a:tblGrid>${tr}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
    );
  }

  xml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${NS}><p:cSld><p:spTree>${TREE_HEAD}${this.shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  }
}

function notesXml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notes ${NS}><p:cSld><p:spTree>${TREE_HEAD}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs(text)}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

function notesMasterXml(): string {
  const lvl = (n: number) => `<a:lvl${n}pPr marL="${(n - 1) * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${TREE_HEAD}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(lvl).join('')}</p:notesStyle></p:notesMaster>`;
}

const GUID = () => '{' + 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16).toUpperCase()) + '}';

/** Strip the markers PowerPoint would show as literal text. */
const oneLine = (s: string) => s.replace(/\s*\n+\s*/g, ' ').trim();

export interface TemplateBuild {
  buffer: Buffer;
  warnings: string[];
  /** The template layout used by each slide, by name. */
  layoutsUsed: string[];
  analysis: TemplateAnalysis;
}

export async function buildFromTemplate(template: Buffer, slides: PreparedSlide[], meta: { title?: string; author?: string } = {}): Promise<TemplateBuild> {
  const pkg = await OoxmlPackage.open(template);
  const ct0 = await pkg.contentTypes();
  const presPath = await pkg.mainPart();
  const mainType = ct0.overrides.get(presPath) ?? '';
  if (/macroEnabled/i.test(mainType)) throw new PackageError('The template is macro-enabled; macros are not allowed');
  if (mainType !== CT.pptxMain && mainType !== CT.potxMain) throw new PackageError('The file is not a PowerPoint presentation or template');
  const analysis = await analyzeTemplate(pkg);
  const { mapping, slideWidth: SW, slideHeight: SH } = analysis;
  if (!mapping.title && !mapping.content && !mapping.titleOnly) throw new PackageError('The template has no usable title or content layout');

  // Drop the template's own sample slides, notes and everything only they used.
  const pres = await pkg.xml(presPath);
  let presRels = await pkg.rels(presPath);
  presRels = presRels.filter((r) => r.type !== REL.slide);
  const rootRels = (await pkg.rels('')).filter((r) => r.type !== REL.thumbnail && !/extended-properties$/.test(r.type));
  await pkg.writeRels('', rootRels.map((r) => ({ id: r.id, type: r.type, target: r.target, external: r.external })));
  await pkg.writeRels(presPath, presRels.map((r) => ({ id: r.id, type: r.type, target: r.target, external: r.external })));
  await pkg.pruneUnreachable();

  const ct = await pkg.contentTypes();
  const nextRid = () => `rId${presRels.reduce((m, r) => Math.max(m, Number(/^rId(\d+)$/.exec(r.id)?.[1] ?? 0)), 0) + 1}`;

  // Notes master: reuse the template's, or add a minimal one that uses a copy of the template theme.
  let notesMaster = presRels.find((r) => r.type === REL.notesMaster && pkg.has(r.path));
  let notesMasterRid = notesMaster?.id ?? '';
  if (!notesMaster) {
    const themes = pkg.names().filter((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n));
    const themeNo = themes.reduce((m, n) => Math.max(m, Number(/theme(\d+)\.xml$/.exec(n)![1])), 0) + 1;
    const src = themes.sort()[0];
    if (!src) throw new PackageError('The template has no theme');
    const themePath = `ppt/theme/theme${themeNo}.xml`;
    pkg.set(themePath, await pkg.bytes(src));
    ct.overrides.set(themePath, CT.theme);
    pkg.set('ppt/notesMasters/notesMaster1.xml', notesMasterXml());
    ct.overrides.set('ppt/notesMasters/notesMaster1.xml', CT.notesMaster);
    await pkg.writeRels('ppt/notesMasters/notesMaster1.xml', [{ id: 'rId1', type: REL.theme, target: `../theme/theme${themeNo}.xml` }]);
    notesMasterRid = nextRid();
    presRels.push({ id: notesMasterRid, type: REL.notesMaster, target: 'notesMasters/notesMaster1.xml', external: false, path: 'ppt/notesMasters/notesMaster1.xml' });
    notesMaster = presRels[presRels.length - 1];
  }

  // Table style: the template's default if it names one, else PowerPoint's built-in Medium Style 2 - Accent 1.
  let tableStyle = DEFAULT_TABLE_STYLE;
  if (pkg.has('ppt/tableStyles.xml')) {
    const def = (await pkg.xml('ppt/tableStyles.xml')).attrs.def;
    if (def && /^\{[0-9A-Fa-f-]{36}\}$/.test(def)) tableStyle = def;
  }

  const warnings: string[] = [];
  const warned = new Set<string>();
  const warnOnce = (msg: string) => {
    if (!warned.has(msg)) {
      warned.add(msg);
      warnings.push(msg);
    }
  };
  const fallbackOrder = (...ls: (LayoutInfo | null)[]) => ls.find((l): l is LayoutInfo => Boolean(l)) ?? analysis.layouts[0];

  const R = (l: LayoutInfo | null): Box => {
    const body = l?.phs.find((p) => isBodyPh(p) && p.box)?.box ?? mapping.content?.phs.find((p) => isBodyPh(p) && p.box)?.box;
    if (body) return body;
    const titleBox = (mapping.titleOnly ?? mapping.content)?.phs.find((p) => isTitlePh(p) && p.box)?.box;
    const top = titleBox ? titleBox.y + titleBox.h + inch(0.2) : inch(1.5);
    return { x: inch(0.6), y: top, w: SW - inch(1.2), h: SH - top - inch(0.7) };
  };

  const built: { n: number; layout: LayoutInfo; sb: SlideBuilder; notes?: string }[] = [];
  let mediaCount = 0;
  const addSlide = (layout: LayoutInfo, notes?: string): SlideBuilder => {
    const sb = new SlideBuilder(built.length + 1, mediaCount);
    sb.addRel(REL.slideLayout, `../slideLayouts/${layout.path.split('/').pop()}`);
    built.push({ n: sb.n, layout, sb, notes });
    return sb;
  };
  const finishSlide = (sb: SlideBuilder, layout: LayoutInfo) => {
    mediaCount += sb.media.length;
    const num = layout.phs.find((p) => p.type === 'sldNum');
    if (num && layout !== mapping.title) {
      sb.placeholder(num, 'Slide Number Placeholder', `<a:p><a:fld id="${GUID()}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p>`);
    }
  };

  const titleText = (sb: SlideBuilder, layout: LayoutInfo, text: string) => {
    const ph = layout.phs.find(isTitlePh);
    if (ph) sb.placeholder(ph, 'Title', paragraphs(oneLine(text)));
    else sb.textBox({ x: inch(0.6), y: inch(0.35), w: SW - inch(1.2), h: inch(1), }, paragraphs(oneLine(text), '', ' sz="3000" b="1"'));
  };

  const fitBody = (count: number, chars: number): string => {
    const scale = count > 11 || chars > 900 ? { f: 70000, l: 20000 } : count > 8 || chars > 600 ? { f: 85000, l: 10000 } : null;
    return scale ? `<a:bodyPr><a:normAutofit fontScale="${scale.f}" lnSpcReduction="${scale.l}"/></a:bodyPr>` : '<a:bodyPr/>';
  };

  const placeVisual = (sb: SlideBuilder, v: PreparedVisual, area: Box) => {
    const capH = v.caption ? inch(0.5) : 0;
    const boxH = area.h - capH;
    if (v.kind === 'picture') {
      const { w, h } = v.fit(area.w / EMU, boxH / EMU, true);
      const wE = inch(w);
      const hE = inch(h);
      const x = area.x + (v.align === 'left' ? 0 : v.align === 'right' ? area.w - wE : (area.w - wE) / 2);
      sb.picture({ x, y: area.y + (boxH - hE) / 2, w: wE, h: hE }, sb.addImage(v.data, v.ext), v.alt);
    } else if (v.kind === 'source') {
      sb.textBox({ x: area.x, y: area.y, w: area.w, h: boxH - inch(0.5) }, codeParagraphs(v.text), { fill: true });
      sb.textBox({ x: area.x, y: area.y + boxH - inch(0.5), w: area.w, h: inch(0.5) }, paragraphs(v.note, '', ' sz="1100" i="1"'));
    } else {
      sb.textBox({ x: area.x, y: area.y, w: area.w, h: inch(0.8) }, paragraphs(v.text, '', ' sz="1400" i="1"'));
    }
    if (v.caption) sb.textBox({ x: area.x, y: area.y + boxH, w: area.w, h: capH }, paragraphs(v.caption, '<a:pPr algn="ctr"/>', ' sz="1400" i="1"'));
  };

  for (const s of slides) {
    const title = oneLine(s.title || meta.title || '');
    if (s.layout === 'title' || s.layout === 'section') {
      const wanted = s.layout === 'title' ? mapping.title : mapping.section;
      if (!wanted) warnOnce(s.layout === 'title' ? 'The template has no title layout; a content layout was used for title slides.' : 'The template has no section layout; the title layout was used for section slides.');
      const layout = wanted ?? fallbackOrder(s.layout === 'section' ? mapping.title : null, mapping.content, mapping.titleOnly);
      const sb = addSlide(layout, s.notes);
      titleText(sb, layout, title);
      if (s.subtitle) {
        const subPh = layout.phs.find(isSubPh) ?? layout.phs.find(isBodyPh);
        const sub = oneLine(s.subtitle);
        if (subPh) sb.placeholder(subPh, 'Subtitle', paragraphs(sub, layout.phs.find(isSubPh) ? '' : '<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>'));
        else sb.textBox({ x: inch(0.6), y: inch(3.2), w: SW - inch(1.2), h: inch(1) }, paragraphs(sub, '', ' sz="2000"'));
      }
      finishSlide(sb, layout);
      continue;
    }

    if (s.layout === 'table') {
      const layout = mapping.titleOnly ?? mapping.content ?? fallbackOrder(mapping.title);
      if (!mapping.titleOnly) warnOnce(`The template has no "title only" layout; "${layout.name}" was used for tables and pictures.`);
      const rows = s.table?.rows ?? [];
      const chunks: string[][][] = [];
      for (let i = 0; i < Math.max(rows.length, 1); i += ROWS_PER_SLIDE) chunks.push(rows.slice(i, i + ROWS_PER_SLIDE));
      chunks.forEach((chunk, ci) => {
        const sb = addSlide(layout, s.notes);
        titleText(sb, layout, ci ? `${title} (cont.)` : title);
        sb.table(R(layout === mapping.titleOnly ? null : layout), s.table?.header, chunk, tableStyle);
        finishSlide(sb, layout);
      });
      continue;
    }

    const v = s.visual;
    const hasText = s.layout === 'bullets' || s.layout === 'text';
    if (s.layout === 'image' || (!hasText && v)) {
      const layout = mapping.titleOnly ?? mapping.content ?? fallbackOrder(mapping.title);
      if (!mapping.titleOnly) warnOnce(`The template has no "title only" layout; "${layout.name}" was used for tables and pictures.`);
      const sb = addSlide(layout, s.notes);
      titleText(sb, layout, title);
      const area = R(layout === mapping.titleOnly ? null : layout);
      if (v) placeVisual(sb, v, area);
      finishSlide(sb, layout);
      continue;
    }

    // Bullets or text, with an optional picture beside them.
    const side = v ? mapping.side : null;
    const layout = side ?? mapping.content ?? fallbackOrder(mapping.titleOnly, mapping.title);
    if (!side && !mapping.content) warnOnce(`The template has no "title and content" layout; "${layout.name}" was used for text slides.`);
    const sb = addSlide(layout, s.notes);
    titleText(sb, layout, title);
    const bodyPhs = layout.phs.filter((p) => isBodyPh(p) || isPicPh(p)).sort((a, b) => (a.box?.x ?? 0) - (b.box?.x ?? 0) || (a.idx ?? 0) - (b.idx ?? 0));
    const textPh = bodyPhs.find(isBodyPh) ?? null;
    const area = R(layout);
    let textBox: Box | undefined;
    let picArea: Box | undefined;
    if (v) {
      if (side && bodyPhs.length >= 2) {
        const right = bodyPhs.find((p) => p !== textPh && p.box) ?? null;
        textBox = textPh?.box ?? undefined;
        picArea = right?.box ?? undefined;
      }
      if (!picArea || !textBox) {
        const gap = inch(0.3);
        const tw = Math.round((area.w - gap) * 0.5);
        textBox = { x: area.x, y: area.y, w: tw, h: area.h };
        picArea = { x: area.x + tw + gap, y: area.y, w: area.w - tw - gap, h: area.h };
      }
    }
    const items = s.layout === 'bullets' ? (s.bullets ?? []).map(oneLine) : [];
    const chars = items.length ? items.join('').length : (s.text ?? '').length;
    const bodyXml = s.layout === 'bullets' ? items.map((t) => paragraphs(t)).join('') : paragraphs(s.text ?? '', '<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>');
    if (textPh) sb.placeholder(textPh, 'Content', bodyXml || paragraphs(''), { box: textBox, bodyPr: fitBody(items.length, chars) });
    else sb.textBox(textBox ?? area, bodyXml || paragraphs(''));
    if (v && picArea) placeVisual(sb, v, picArea);
    finishSlide(sb, layout);
  }

  // Write the slides, their notes and pictures.
  const newRels: Rel[] = [];
  const mediaExt = new Set<string>();
  for (const b of built) {
    const slidePath = `ppt/slides/slide${b.n}.xml`;
    pkg.set(slidePath, b.sb.xml());
    ct.overrides.set(slidePath, CT.slide);
    const rels = [...b.sb.rels];
    for (const m of b.sb.media) {
      pkg.set(`ppt/media/${m.name}`, m.data);
      mediaExt.add(m.ext === 'jpeg' ? 'jpg' : 'png');
    }
    if (b.notes) {
      const notesPath = `ppt/notesSlides/notesSlide${b.n}.xml`;
      pkg.set(notesPath, notesXml(b.notes));
      ct.overrides.set(notesPath, CT.notesSlide);
      await pkg.writeRels(notesPath, [
        { id: 'rId1', type: REL.notesMaster, target: `../notesMasters/${notesMaster!.path.split('/').pop()}` },
        { id: 'rId2', type: REL.slide, target: `../slides/slide${b.n}.xml` },
      ]);
      rels.push({ id: `rId${rels.length + 1}`, type: REL.notesSlide, target: `../notesSlides/notesSlide${b.n}.xml` });
    }
    await pkg.writeRels(slidePath, rels);
    const id = nextRid();
    const rel = { id, type: REL.slide, target: `slides/slide${b.n}.xml`, external: false, path: slidePath };
    presRels.push(rel);
    newRels.push(rel);
  }
  if (mediaExt.has('png')) ct.defaults.set('png', 'image/png');
  if (mediaExt.has('jpg')) {
    if (!ct.defaults.has('jpg')) ct.defaults.set('jpg', 'image/jpeg');
  }
  ct.overrides.set(presPath, CT.pptxMain);
  await pkg.writeContentTypes(ct);
  await pkg.writeRels(presPath, presRels.map((r) => ({ id: r.id, type: r.type, target: r.target, external: r.external })));

  // presentation.xml: the new slide list, the notes master, no sections or custom shows from the sample slides.
  const rPrefix = Object.entries(pres.attrs).find(([k, v]) => k.startsWith('xmlns:') && v === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')?.[0].slice(6) ?? 'r';
  if (rPrefix === 'r' && !pres.attrs['xmlns:r']) pres.attrs['xmlns:r'] = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const pPrefix = pres.name.includes(':') ? pres.name.slice(0, pres.name.indexOf(':') + 1) : '';
  pres.children = pres.children.filter((c) => !['sldIdLst', 'custShowLst', 'notesMasterIdLst'].includes(local(c.name)));
  for (const ext of childrenNamed(pres, 'extLst')) ext.children = ext.children.filter((e) => !findDeep(e, 'sectionLst'));
  const mk = (name: string, attrs: Record<string, string> = {}, children: XNode[] = []): XNode => ({ name: pPrefix + name, attrs, children });
  const insertAt = (() => {
    const i = pres.children.findIndex((c) => ['sldSz', 'notesSz'].includes(local(c.name)));
    return i < 0 ? pres.children.length : i;
  })();
  const handout = pres.children.findIndex((c) => local(c.name) === 'handoutMasterIdLst');
  const afterMasters = pres.children.findIndex((c) => local(c.name) === 'sldMasterIdLst') + 1;
  const notesAt = handout >= 0 ? handout : afterMasters > 0 ? afterMasters : insertAt;
  pres.children.splice(notesAt, 0, mk('notesMasterIdLst', {}, [mk('notesMasterId', { [`${rPrefix}:id`]: notesMasterRid })]));
  const sldAt = pres.children.findIndex((c) => ['sldSz', 'notesSz'].includes(local(c.name)));
  pres.children.splice(sldAt < 0 ? pres.children.length : sldAt, 0, mk('sldIdLst', {}, newRels.map((r, i) => mk('sldId', { id: String(256 + i), [`${rPrefix}:id`]: r.id }))));
  pkg.set(presPath, serializeXml(pres));

  if (pkg.has('docProps/core.xml') && (meta.title || meta.author)) {
    let core = await pkg.text('docProps/core.xml');
    const put = (tag: string, value: string) => {
      const re = new RegExp(`(<${tag}[^>]*>)[\\s\\S]*?(</${tag}>)`);
      if (re.test(core)) core = core.replace(re, (_m, a: string, b: string) => `${a}${xmlEscape(value)}${b}`);
    };
    if (meta.title) put('dc:title', meta.title);
    if (meta.author) put('dc:creator', meta.author);
    pkg.set('docProps/core.xml', core);
  }

  const buffer = await pkg.toBuffer();
  return { buffer, warnings, layoutsUsed: built.map((b) => b.layout.name), analysis };
}
