/**
 * Jira's rich text is Atlassian Document Format (ADF), a JSON tree. These two helpers turn it into Markdown (what the
 * agents read) and Markdown back into ADF (what a comment posted to Jira must be).
 */
import { marked } from 'marked';

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: { type: string; attrs?: Record<string, any> }[];
  content?: AdfNode[];
}

const MAX_DEPTH = 30;

/* ------------------------------------------------------------------ */
/* ADF -> Markdown                                                     */
/* ------------------------------------------------------------------ */

function inlineText(n: AdfNode): string {
  if (n.type === 'text') {
    let t = n.text ?? '';
    const marks = n.marks ?? [];
    if (marks.some((m) => m.type === 'code')) return '`' + t.replace(/`/g, "'") + '`';
    if (marks.some((m) => m.type === 'strong')) t = `**${t}**`;
    if (marks.some((m) => m.type === 'em')) t = `*${t}*`;
    if (marks.some((m) => m.type === 'strike')) t = `~~${t}~~`;
    const link = marks.find((m) => m.type === 'link');
    if (link?.attrs?.href) t = `[${t}](${link.attrs.href})`;
    return t;
  }
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'mention') return n.attrs?.text ?? '@user';
  if (n.type === 'emoji') return n.attrs?.text ?? n.attrs?.shortName ?? '';
  if (n.type === 'inlineCard') return n.attrs?.url ?? '';
  if (n.type === 'status') return `[${n.attrs?.text ?? ''}]`;
  if (n.type === 'date') return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : '';
  if (n.type === 'media' || n.type === 'mediaInline') return `[attachment${n.attrs?.alt ? ': ' + n.attrs.alt : ''}]`;
  return (n.content ?? []).map(inlineText).join('');
}

function inline(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map(inlineText).join('');
}

function block(n: AdfNode, depth: number, indent = ''): string {
  if (depth > MAX_DEPTH) return '';
  switch (n.type) {
    case 'paragraph':
      return indent + inline(n.content);
    case 'heading':
      return `${'#'.repeat(Math.min(6, Math.max(1, Number(n.attrs?.level) || 1)))} ${inline(n.content)}`;
    case 'bulletList':
    case 'orderedList': {
      const ordered = n.type === 'orderedList';
      return (n.content ?? [])
        .map((item, i) => {
          const parts = (item.content ?? []).map((c) => (c.type === 'bulletList' || c.type === 'orderedList' ? block(c, depth + 1, indent + '  ') : block(c, depth + 1)));
          const [first, ...rest] = parts;
          return `${indent}${ordered ? `${i + 1}.` : '-'} ${(first ?? '').replace(/^\s+/, '')}${rest.length ? '\n' + rest.join('\n') : ''}`;
        })
        .join('\n');
    }
    case 'codeBlock':
      return '```' + (n.attrs?.language ?? '') + '\n' + (n.content ?? []).map((c) => c.text ?? '').join('') + '\n```';
    case 'blockquote':
      return (n.content ?? []).map((c) => block(c, depth + 1)).join('\n\n').split('\n').map((l) => `> ${l}`).join('\n');
    case 'rule':
      return '---';
    case 'panel':
      return (n.content ?? []).map((c) => block(c, depth + 1)).join('\n\n').split('\n').map((l) => `> ${l}`).join('\n');
    case 'table': {
      const rows = (n.content ?? []).map((r) => (r.content ?? []).map((cell) => (cell.content ?? []).map((c) => block(c, depth + 1)).join(' ').replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const pad = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
      return [pad(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(pad)].join('\n');
    }
    case 'mediaSingle':
    case 'mediaGroup':
      return (n.content ?? []).map(inlineText).join(' ');
    case 'text':
    case 'hardBreak':
    case 'mention':
    case 'emoji':
    case 'inlineCard':
    case 'status':
    case 'date':
      return inlineText(n);
    default:
      return (n.content ?? []).map((c) => block(c, depth + 1)).join('\n\n');
  }
}

/** Convert an ADF document (or a plain string, which older Jira fields still use) to Markdown. */
export function adfToMarkdown(doc: unknown): string {
  if (doc == null) return '';
  if (typeof doc === 'string') return doc;
  const node = doc as AdfNode;
  if (!node.type) return '';
  const body = node.type === 'doc' ? (node.content ?? []).map((c) => block(c, 0)).join('\n\n') : block(node, 0);
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------------ */
/* Markdown -> ADF                                                     */
/* ------------------------------------------------------------------ */

type Mark = { type: string; attrs?: Record<string, any> };

function inlineToAdf(tokens: any[] | undefined, marks: Mark[] = []): AdfNode[] {
  const out: AdfNode[] = [];
  for (const t of tokens ?? []) {
    if (t.type === 'strong') out.push(...inlineToAdf(t.tokens, [...marks, { type: 'strong' }]));
    else if (t.type === 'em') out.push(...inlineToAdf(t.tokens, [...marks, { type: 'em' }]));
    else if (t.type === 'del') out.push(...inlineToAdf(t.tokens, [...marks, { type: 'strike' }]));
    else if (t.type === 'link' && /^https?:\/\//i.test(t.href)) out.push(...inlineToAdf(t.tokens, [...marks, { type: 'link', attrs: { href: t.href } }]));
    else if (t.type === 'codespan') {
      if (t.text) out.push({ type: 'text', text: t.text, marks: [{ type: 'code' }] }); // code cannot be combined with bold or italic in ADF
    } else if (t.type === 'br') out.push({ type: 'hardBreak' });
    else if (t.tokens) out.push(...inlineToAdf(t.tokens, marks));
    else {
      const text = t.type === 'escape' ? t.text : (t.text ?? t.raw ?? '');
      if (text) out.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
    }
  }
  return out;
}

const paragraph = (tokens: any[] | undefined): AdfNode => ({ type: 'paragraph', content: inlineToAdf(tokens) });

function listToAdf(t: any): AdfNode {
  return {
    type: t.ordered ? 'orderedList' : 'bulletList',
    content: (t.items ?? []).map((item: any) => {
      const kids: AdfNode[] = [];
      for (const c of item.tokens ?? []) {
        if (c.type === 'text' || c.type === 'paragraph') kids.push(paragraph(c.tokens ?? [{ type: 'text', text: c.text }]));
        else if (c.type === 'list') kids.push(listToAdf(c));
        else if (c.type === 'code') kids.push(codeToAdf(c));
      }
      return { type: 'listItem', content: kids.length ? kids : [{ type: 'paragraph', content: [] }] };
    }),
  };
}

function codeToAdf(t: any): AdfNode {
  return { type: 'codeBlock', ...(t.lang ? { attrs: { language: String(t.lang).split(/\s/)[0] } } : {}), content: t.text ? [{ type: 'text', text: t.text }] : [] };
}

/** Convert Markdown to an ADF document that Jira accepts as a comment body. */
export function markdownToAdf(md: string): AdfNode {
  const content: AdfNode[] = [];
  for (const t of marked.lexer(md) as any[]) {
    if (t.type === 'heading') content.push({ type: 'heading', attrs: { level: Math.min(6, t.depth) }, content: inlineToAdf(t.tokens) });
    else if (t.type === 'paragraph') content.push(paragraph(t.tokens));
    else if (t.type === 'list') content.push(listToAdf(t));
    else if (t.type === 'code') content.push(codeToAdf(t));
    else if (t.type === 'hr') content.push({ type: 'rule' });
    else if (t.type === 'blockquote') content.push({ type: 'blockquote', content: [paragraph(inlineLex(String(t.text ?? '').replace(/^>\s?/gm, '')))] });
    else if (t.type === 'table') {
      const cell = (type: string, c: any) => ({ type, content: [paragraph(c.tokens)] });
      content.push({
        type: 'table',
        attrs: { isNumberColumnEnabled: false, layout: 'default' },
        content: [
          { type: 'tableRow', content: t.header.map((c: any) => cell('tableHeader', c)) },
          ...t.rows.map((r: any[]) => ({ type: 'tableRow', content: r.map((c) => cell('tableCell', c)) })),
        ],
      });
    }
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }] } as AdfNode & { version?: number };
}

function inlineLex(text: string): any[] {
  const first = (marked.lexer(text) as any[]).find((t) => t.tokens);
  return first?.tokens ?? [{ type: 'text', text }];
}

/** The full document Jira expects: ADF version 1. */
export function adfComment(md: string): { version: 1; type: 'doc'; content: AdfNode[] } {
  const d = markdownToAdf(md);
  return { version: 1, type: 'doc', content: d.content ?? [] };
}
