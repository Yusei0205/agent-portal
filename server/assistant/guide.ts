/**
 * User guide passages for the cat assistant: split the bundled guide by heading, rank passages for a question
 * by simple keyword overlap. Pure apart from loadGuide, which reads the guide file once.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

export type GuidePassage = { heading: string; text: string };

const MAX_PASSAGE = 1500;

/** Cut text longer than MAX_PASSAGE at paragraph boundaries (hard cut for a single oversize paragraph). */
function chunk(text: string): string[] {
  if (text.length <= MAX_PASSAGE) return [text];
  const out: string[] = [];
  let cur = '';
  const push = (): void => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const para of text.split(/\n\s*\n/)) {
    let p = para.trim();
    if (!p) continue;
    while (p.length > MAX_PASSAGE) {
      push();
      out.push(p.slice(0, MAX_PASSAGE));
      p = p.slice(MAX_PASSAGE).trim();
    }
    if (!p) continue;
    if (cur && cur.length + 2 + p.length > MAX_PASSAGE) push();
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  push();
  return out;
}

export function splitGuide(markdown: string): GuidePassage[] {
  const out: GuidePassage[] = [];
  let heading = '';
  let buf: string[] = [];
  const flush = (): void => {
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return;
    for (const c of chunk(text)) out.push({ heading, text: c });
  };
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^#{1,3}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) { flush(); heading = m[1]!; } else buf.push(line);
  }
  flush();
  return out;
}

const STOP = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out', 'how', 'what', 'when', 'where', 'why', 'who', 'does', 'did', 'has', 'have', 'had', 'with', 'this', 'that', 'from', 'your', 'about', 'into', 'than', 'then', 'they', 'them', 'there', 'will', 'would', 'could', 'should', 'its', 'any', 'get', 'use', 'turn']);

// Short names people type for words the guide spells out.
const ALIAS: Record<string, string> = { repo: 'repository', repos: 'repositories', doc: 'document', docs: 'documents', config: 'configuration', creds: 'credentials', env: 'environment', pr: 'pull', prs: 'pull' };

/** A rough stem so word forms meet: the first five letters (generate / generating / generated, repository / repositories). */
function stem(w: string): string {
  const full = ALIAS[w] ?? w;
  return full.length > 5 ? full.slice(0, 5) : full;
}

function words(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => (w.length >= 3 || ALIAS[w]) && !STOP.has(w)).map(stem);
}

export function rankGuide(passages: GuidePassage[], question: string, limit: number): GuidePassage[] {
  const q = new Set(words(question));
  if (q.size === 0 || limit <= 0) return [];
  const scored = passages.map((p, i) => {
    let score = 0;
    for (const w of new Set(words(p.text))) if (q.has(w)) score += 1;
    for (const w of new Set(words(p.heading))) if (q.has(w)) score += 2;
    return { p, i, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.p);
}

let pathOverride: string | null = null;
let cache: GuidePassage[] | null = null;

export function setGuidePathForTest(p: string | null): void {
  pathOverride = p;
  cache = null;
}

function candidates(): string[] {
  if (pathOverride) return [pathOverride];
  let root = process.cwd();
  try { root = config.root; } catch { /* config not loaded */ }
  return [path.join(root, 'docs', 'user-guide.md'), path.join(root, 'dist', 'assistant', 'user-guide.md')];
}

export function loadGuide(): GuidePassage[] {
  if (cache) return cache;
  for (const f of candidates()) {
    try {
      cache = splitGuide(fs.readFileSync(f, 'utf8'));
      return cache;
    } catch { /* try next */ }
  }
  return [];
}
