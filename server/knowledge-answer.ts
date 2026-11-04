/**
 * Knowledge: finding the passage that answers a question, and the prompt a model answers it from.
 *
 * The keyword index finds which documents mention the question's words. This module reads those documents,
 * cuts them into passages (a heading and the paragraphs under it) and ranks the passages by the same words,
 * so Search can show the matching lines and Ask can give a model only the passages that matter, with numbers
 * to cite. Nothing here touches the database or the file system.
 */

export interface Passage {
  docId: string;
  docName: string;
  /** The nearest heading above the passage, or ''. */
  heading: string;
  text: string;
}

const STOP = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'that', 'this', 'from', 'have', 'has', 'had', 'what', 'when', 'where',
  'which', 'who', 'how', 'why', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'you', 'your', 'our', 'their',
  'about', 'into', 'than', 'then', 'there', 'here', 'not', 'but', 'any', 'all', 'its', 'it', 'is', 'in', 'on', 'of', 'to', 'a', 'an', 'be', 'by', 'as', 'at', 'or',
]);

export function queryTerms(q: string): string[] {
  const out = new Set<string>();
  for (const t of q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (t.length >= 2 && t.length <= 60 && !STOP.has(t)) out.add(t);
  }
  return [...out].slice(0, 24);
}

const PASSAGE_CHARS = 900;

/** Cut Markdown into passages of about 900 characters, each remembering the heading it sits under. */
export function splitPassages(docId: string, docName: string, markdown: string): Passage[] {
  const out: Passage[] = [];
  let heading = '';
  let buf: string[] = [];
  let len = 0;
  const flush = (): void => {
    const text = buf.join('\n').trim();
    if (text) out.push({ docId, docName, heading, text });
    buf = [];
    len = 0;
  };
  for (const block of markdown.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    const h = /^#{1,6}\s+(.+)$/m.exec(b.split('\n')[0]);
    if (h) {
      flush();
      heading = h[1].trim().slice(0, 120);
      const rest = b.split('\n').slice(1).join('\n').trim();
      if (rest) { buf.push(rest); len += rest.length; }
      continue;
    }
    if (len + b.length > PASSAGE_CHARS && len > 0) flush();
    buf.push(b);
    len += b.length;
    if (len >= PASSAGE_CHARS) flush();
  }
  flush();
  return out.map((p) => (p.text.length > PASSAGE_CHARS * 2 ? { ...p, text: `${p.text.slice(0, PASSAGE_CHARS * 2)}…` } : p));
}

/** The passages that use the question's words most, best first. Passages with no match are left out. */
export function rankPassages(passages: Passage[], question: string, limit: number): Passage[] {
  const terms = queryTerms(question);
  if (!terms.length) return [];
  const scored = passages.map((p) => {
    const hay = p.text.toLowerCase();
    const head = p.heading.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
      const n = (hay.match(re) ?? []).length;
      if (n) score += 1 + Math.min(n - 1, 2) * 0.4;
      if (head && head.includes(t)) score += 1.5;
    }
    return { p, score };
  });
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.p);
}

/** A short excerpt of a passage around the first question word in it (for Search results). */
export function excerptAround(text: string, question: string, chars = 280): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const hay = flat.toLowerCase();
  let at = -1;
  for (const t of queryTerms(question)) {
    const i = hay.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at < 0 ? 0 : at - 80);
  const cut = flat.slice(start, start + chars);
  return `${start > 0 ? '…' : ''}${cut}${start + chars < flat.length ? '…' : ''}`;
}

export const ASK_SYSTEM = [
  'You answer questions about a project from its documents.',
  'Use only the numbered passages you are given. Do not use outside knowledge and do not guess.',
  'Cite the passage behind every statement with its number in square brackets, like [1] or [2][3].',
  'If the passages do not answer the question, say so plainly and name what is missing. Never invent names, figures, dates or steps.',
  'Be short and direct: answer first, then the supporting detail. Plain text or a short list, no headings.',
].join('\n');

export function buildAskUser(question: string, passages: Passage[]): string {
  const blocks = passages.map((p, i) => `[${i + 1}] ${p.docName}${p.heading ? ` › ${p.heading}` : ''}\n${p.text}`);
  return `Passages:\n\n${blocks.join('\n\n')}\n\nQuestion: ${question}\n\nAnswer using only the passages, with citations.`;
}

/** The numbers a model cited, in order of first use, keeping only numbers that exist. */
export function citedNumbers(answer: string, count: number): number[] {
  const seen: number[] = [];
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= count && !seen.includes(n)) seen.push(n);
  }
  return seen;
}
