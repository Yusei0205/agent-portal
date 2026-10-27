/**
 * Small helpers for Office Open XML and draw.io XML: a forgiving XML reader and writer.
 * Used by drawio.ts to validate and re-serialise draw.io (mxGraph) XML.
 */

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
