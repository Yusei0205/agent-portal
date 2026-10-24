/**
 * Small helpers for Office Open XML packages (.docx, .pptx and their template forms): a forgiving XML reader and
 * writer, and a zip package wrapper that knows relationships and content types. Used to check uploaded templates
 * (doc-templates.ts), to fill a PowerPoint template's own layouts (pptx-template.ts) and to draw slide previews
 * (pptx-preview.ts). No dependency beyond jszip, which the portal already ships.
 */
import JSZip from 'jszip';

/* ------------------------------------------------------------------ */
/* XML                                                                 */
/* ------------------------------------------------------------------ */

export interface XNode {
  /** Qualified name as written ("p:sp"), or "#text". */
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Only for "#text" nodes. */
  text?: string;
}

export function xmlUnescape(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-fA-F]+|#\d+);/g, (_m, e: string) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e === 'amp') return '&';
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  });
}

/** Escape text for XML, dropping characters XML 1.0 cannot carry. */
export function xmlEscape(s: string): string {
  return String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class XmlError extends Error {}

/** Parse one XML document into a tree. Handles declarations, comments, CDATA, entities and self-closing tags. */
export function parseXml(xml: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [] };
  const stack: XNode[] = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(xml))) {
    if (m.index !== last) throw new XmlError('The XML is not well formed');
    last = re.lastIndex;
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.children.push({ name: '#text', attrs: {}, children: [], text: m[1] });
    else if (m[2] !== undefined) {
      if (stack.length < 2 || top.name !== m[2]) throw new XmlError('The XML is not well formed (mismatched tags)');
      stack.pop();
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      const ar = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = ar.exec(m[4] || ''))) attrs[a[1]] = xmlUnescape(a[2] ?? a[3] ?? '');
      const node: XNode = { name: m[3], attrs, children: [] };
      top.children.push(node);
      if (m[5] !== '/') stack.push(node);
      if (stack.length > 200) throw new XmlError('The XML is nested too deeply');
    } else if (m[6] !== undefined) {
      if (top.name !== '#root') top.children.push({ name: '#text', attrs: {}, children: [], text: xmlUnescape(m[6]) });
    }
  }
  if (last !== xml.length) throw new XmlError('The XML is not well formed');
  if (stack.length !== 1) throw new XmlError('The XML is not well formed (unclosed tag)');
  const el = root.children.find((c) => c.name !== '#text');
  if (!el) throw new XmlError('The XML has no content');
  return el;
}

export function serializeXml(n: XNode, declaration = true): string {
  const body = (x: XNode): string => {
    if (x.name === '#text') return xmlEscape(x.text ?? '');
    const attrs = Object.entries(x.attrs)
      .map(([k, v]) => ` ${k}="${xmlEscape(v)}"`)
      .join('');
    return x.children.length ? `<${x.name}${attrs}>${x.children.map(body).join('')}</${x.name}>` : `<${x.name}${attrs}/>`;
  };
  return (declaration ? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' : '') + body(n);
}

/** The part of a qualified name after the colon. */
export const local = (name: string): string => name.slice(name.indexOf(':') + 1);

export const elements = (n: XNode | undefined): XNode[] => (n ? n.children.filter((c) => c.name !== '#text') : []);

/** First direct child with this local name. */
export function child(n: XNode | undefined, name: string): XNode | undefined {
  return n?.children.find((c) => c.name !== '#text' && local(c.name) === name);
}

/** All direct children with this local name. */
export function childrenNamed(n: XNode | undefined, name: string): XNode[] {
  return n ? n.children.filter((c) => c.name !== '#text' && local(c.name) === name) : [];
}

/** Follow a path of local names from a node. */
export function dig(n: XNode | undefined, ...names: string[]): XNode | undefined {
  let cur = n;
  for (const name of names) cur = child(cur, name);
  return cur;
}

/** First descendant (depth first) with this local name. */
export function findDeep(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const c of n.children) {
    if (c.name === '#text') continue;
    if (local(c.name) === name) return c;
    const f = findDeep(c, name);
    if (f) return f;
  }
  return undefined;
}

/** The text of all "#text" descendants. */
export function textOf(n: XNode | undefined): string {
  if (!n) return '';
  if (n.name === '#text') return n.text ?? '';
  return n.children.map(textOf).join('');
}

/* ------------------------------------------------------------------ */
/* Package                                                             */
/* ------------------------------------------------------------------ */

export const REL = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  notesSlide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  notesMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  thumbnail: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail',
} as const;

export const CT = {
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  notesSlide: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
  notesMaster: 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  pptxMain: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  potxMain: 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
  docxMain: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  dotxMain: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
} as const;

export interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
  /** Absolute part name inside the package ("ppt/slides/slide1.xml"); empty for external targets. */
  path: string;
}

/** Package limits that guard against zip bombs. */
export const PACKAGE_LIMITS = { entries: 5000, uncompressedBytes: 400 * 1024 * 1024, partBytes: 100 * 1024 * 1024 };

export class PackageError extends Error {}

export function relsPathOf(part: string): string {
  const i = part.lastIndexOf('/');
  return `${i < 0 ? '' : part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

/** Resolve a relationship target against the part that owns it. */
export function resolveTarget(owner: string, target: string): string {
  const base = target.startsWith('/') ? [] : owner.split('/').slice(0, -1);
  for (const seg of target.replace(/^\//, '').split('/')) {
    if (seg === '..') base.pop();
    else if (seg !== '.' && seg !== '') base.push(seg);
  }
  return base.join('/');
}

export class OoxmlPackage {
  readonly zip: JSZip;

  private constructor(zip: JSZip) {
    this.zip = zip;
  }

  /** Open a package and refuse archives that are too large, too many files or have unsafe names. */
  static async open(buf: Buffer): Promise<OoxmlPackage> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buf);
    } catch {
      throw new PackageError('The file is not a valid Office file (it is not a zip archive)');
    }
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    if (names.length > PACKAGE_LIMITS.entries) throw new PackageError(`The file has too many parts (max ${PACKAGE_LIMITS.entries})`);
    let total = 0;
    for (const n of names) {
      if (n.includes('\0') || n.startsWith('/') || n.split('/').includes('..') || n.includes('\\')) throw new PackageError('The file has an unsafe part name');
      const size = Number((zip.files[n] as any)._data?.uncompressedSize ?? 0);
      if (size > PACKAGE_LIMITS.partBytes) throw new PackageError('A part of the file is too large');
      total += size;
    }
    if (total > PACKAGE_LIMITS.uncompressedBytes) throw new PackageError('The file expands to more than the allowed size');
    return new OoxmlPackage(zip);
  }

  names(): string[] {
    return Object.keys(this.zip.files).filter((n) => !this.zip.files[n].dir);
  }

  has(part: string): boolean {
    return Boolean(this.zip.files[part] && !this.zip.files[part].dir);
  }

  async bytes(part: string): Promise<Buffer> {
    const f = this.zip.files[part];
    if (!f || f.dir) throw new PackageError(`The file has no part ${part}`);
    return Buffer.from(await f.async('uint8array'));
  }

  async text(part: string): Promise<string> {
    return (await this.bytes(part)).toString('utf8');
  }

  async xml(part: string): Promise<XNode> {
    try {
      return parseXml((await this.text(part)).replace(/^﻿/, ''));
    } catch (e) {
      if (e instanceof XmlError) throw new PackageError(`${part}: ${e.message}`);
      throw e;
    }
  }

  set(part: string, data: string | Buffer): void {
    this.zip.file(part, data, { createFolders: false });
  }

  remove(part: string): void {
    this.zip.remove(part);
  }

  /** Relationships of a part ("" is the package itself). */
  async rels(part: string): Promise<Rel[]> {
    const rp = part === '' ? '_rels/.rels' : relsPathOf(part);
    if (!this.has(rp)) return [];
    const root = await this.xml(rp);
    return childrenNamed(root, 'Relationship').map((r) => {
      const external = r.attrs.TargetMode === 'External';
      return { id: r.attrs.Id ?? '', type: r.attrs.Type ?? '', target: r.attrs.Target ?? '', external, path: external ? '' : resolveTarget(part, r.attrs.Target ?? '') };
    });
  }

  async writeRels(part: string, rels: { id: string; type: string; target: string; external?: boolean }[]): Promise<void> {
    const rp = part === '' ? '_rels/.rels' : relsPathOf(part);
    const body = rels
      .map((r) => `<Relationship Id="${xmlEscape(r.id)}" Type="${xmlEscape(r.type)}" Target="${xmlEscape(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)
      .join('');
    this.set(rp, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`);
  }

  /** Content types: default extensions and per-part overrides. */
  async contentTypes(): Promise<{ defaults: Map<string, string>; overrides: Map<string, string> }> {
    const root = await this.xml('[Content_Types].xml');
    const defaults = new Map<string, string>();
    const overrides = new Map<string, string>();
    for (const d of childrenNamed(root, 'Default')) defaults.set((d.attrs.Extension ?? '').toLowerCase(), d.attrs.ContentType ?? '');
    for (const o of childrenNamed(root, 'Override')) overrides.set((o.attrs.PartName ?? '').replace(/^\//, ''), o.attrs.ContentType ?? '');
    return { defaults, overrides };
  }

  async writeContentTypes(ct: { defaults: Map<string, string>; overrides: Map<string, string> }): Promise<void> {
    const d = [...ct.defaults].map(([e, t]) => `<Default Extension="${xmlEscape(e)}" ContentType="${xmlEscape(t)}"/>`).join('');
    const o = [...ct.overrides].map(([p, t]) => `<Override PartName="/${xmlEscape(p)}" ContentType="${xmlEscape(t)}"/>`).join('');
    this.set('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${d}${o}</Types>`);
  }

  /** The main document part ("ppt/presentation.xml", "word/document.xml") named by the package relationships. */
  async mainPart(): Promise<string> {
    const r = (await this.rels('')).find((x) => x.type === REL.officeDocument);
    if (!r || !this.has(r.path)) throw new PackageError('The file has no main document part');
    return r.path;
  }

  /** Delete every part that cannot be reached through relationships from the package root. */
  async pruneUnreachable(): Promise<string[]> {
    const reached = new Set<string>(['[Content_Types].xml', '_rels/.rels']);
    const queue = [''];
    const seen = new Set<string>();
    while (queue.length) {
      const owner = queue.pop()!;
      if (seen.has(owner)) continue;
      seen.add(owner);
      const rp = owner === '' ? '_rels/.rels' : relsPathOf(owner);
      if (this.has(rp)) reached.add(rp);
      for (const r of await this.rels(owner)) {
        if (r.external || !r.path || !this.has(r.path)) continue;
        reached.add(r.path);
        if (/\.(xml|rels)$/i.test(r.path)) queue.push(r.path);
      }
    }
    const dropped: string[] = [];
    for (const n of this.names()) {
      if (!reached.has(n)) {
        this.remove(n);
        dropped.push(n);
      }
    }
    const ct = await this.contentTypes();
    for (const d of dropped) ct.overrides.delete(d);
    await this.writeContentTypes(ct);
    return dropped;
  }

  async toBuffer(): Promise<Buffer> {
    // Office packages list parts only, with [Content_Types].xml first; folder entries are left out.
    const out = new JSZip();
    const names = this.names().sort((x, y) => Number(y === '[Content_Types].xml') - Number(x === '[Content_Types].xml'));
    for (const n of names) out.file(n, await this.zip.files[n].async('uint8array'), { createFolders: false });
    return Buffer.from(await out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
  }
}
