/**
 * A user guide as a bundle: the shot board (which screenshots are placed in the text, which are not, which the text
 * names but are missing) and a single-page HTML guide (index.html next to its screenshots/ folder).
 *
 * Input is what a guide document already is: Markdown that shows pictures as ![caption](screenshots/NN-name.png), the
 * picture files, and optionally a screenshots/manifest.jsonl (one JSON object per line: file, role, page, title,
 * notes, boxes, missing) that says where each picture came from. The manifest is optional: without it the board
 * still works from the files and the text.
 *
 * Pure (no files, no database); generated-docs.ts reads the files and calls these.
 */

import { Marked } from 'marked';

export interface ShotBox { n: number; label: string }

export interface ShotEntry {
  /** Path under the document folder, such as screenshots/12-checker-list.png. */
  file: string;
  role: string;
  page: string;
  title: string;
  notes: string;
  boxes: ShotBox[];
  /** The manifest says this picture could not be taken (the screen or control does not exist for that role). */
  missing: boolean;
}

export type ShotStatus = 'placed' | 'unplaced' | 'missing-file' | 'not-captured';

export interface ShotRow extends ShotEntry {
  status: ShotStatus;
  /** True when the manifest has an entry for the file. */
  inManifest: boolean;
}

const IMAGE_REF = /^screenshots\/[A-Za-z0-9_./ -]+\.(png|jpe?g)$/i;
const IGNORED_NOTE = /do not use|superseded/i;

/** A manifest file name as a path under the document folder: "12-a.png" and "screenshots/12-a.png" are the same. */
export function shotPath(file: string): string {
  const f = String(file ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return f.startsWith('screenshots/') ? f : `screenshots/${f}`;
}

/** A picture path as the Markdown writes it: it must already be under screenshots/ (a manifest may leave that off, the text may not). */
function textRef(href: string): string | null {
  const f = String(href ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return f.startsWith('screenshots/') && IMAGE_REF.test(f) && !f.includes('..') ? f : null;
}

/** Reads manifest.jsonl. Lines that are not JSON, retired pictures (tmp-, "DO NOT USE", "superseded") are left out. */
export function parseManifest(text: string): { shots: ShotEntry[]; skipped: number } {
  const shots: ShotEntry[] = [];
  let skipped = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let j: Record<string, unknown>;
    try { j = JSON.parse(line) as Record<string, unknown>; } catch { skipped += 1; continue; }
    const file = typeof j.file === 'string' ? shotPath(j.file) : '';
    if (!file || !IMAGE_REF.test(file) || file.includes('..')) { skipped += 1; continue; }
    const base = file.slice('screenshots/'.length);
    const notes = typeof j.notes === 'string' ? j.notes : '';
    const title = typeof j.title === 'string' ? j.title : '';
    if (base.startsWith('tmp-') || IGNORED_NOTE.test(notes) || IGNORED_NOTE.test(title)) { skipped += 1; continue; }
    const boxes: ShotBox[] = Array.isArray(j.boxes)
      ? (j.boxes as Array<Record<string, unknown>>)
        .filter((b) => b && typeof b === 'object' && Number.isFinite(Number(b.n)))
        .map((b) => ({ n: Number(b.n), label: String(b.label ?? '').slice(0, 200) }))
        .slice(0, 20)
      : [];
    shots.push({
      file,
      role: typeof j.role === 'string' ? j.role.slice(0, 80) : '',
      page: typeof j.page === 'string' ? j.page.slice(0, 200) : '',
      title: title.slice(0, 300),
      notes: notes.slice(0, 1000),
      boxes,
      missing: j.missing === true,
    });
  }
  return { shots, skipped };
}

const IMAGE_MD = /!\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g;

/** The picture files the Markdown shows, in order of appearance. */
export function referencedShots(md: string): string[] {
  return [...referencedCaptions(md).keys()];
}

/** Each picture the Markdown shows with the caption (alt text) of its first appearance. */
export function referencedCaptions(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of String(md ?? '').matchAll(IMAGE_MD)) {
    const p = textRef(m[2]);
    if (p && !out.has(p)) out.set(p, m[1].trim().slice(0, 300));
  }
  return out;
}

/**
 * One row per picture: placed (the text shows it), unplaced (the file exists but no text shows it), missing-file (the text
 * shows it but the file is not there), not-captured (the manifest says it could not be taken).
 */
export function shotBoard(md: string, files: string[], manifestShots: ShotEntry[]): ShotRow[] {
  const byFile = new Map(manifestShots.map((s) => [s.file, s]));
  const onDisk = new Set(files.map(shotPath));
  const captions = referencedCaptions(md);
  const refs = [...captions.keys()];
  const rows: ShotRow[] = [];
  const blank = (file: string): ShotEntry => ({ file, role: '', page: '', title: '', notes: '', boxes: [], missing: false });
  const seen = new Set<string>();
  const add = (file: string, status: ShotStatus): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const m = byFile.get(file);
    const row = { ...(m ?? blank(file)), status, inManifest: Boolean(m) };
    // A manifest written during capture knows the role and the page; the caption in the text says what the picture shows.
    if (!row.title) row.title = captions.get(file) ?? '';
    rows.push(row);
  };
  for (const f of refs) add(f, onDisk.has(f) ? 'placed' : 'missing-file');
  for (const f of [...onDisk].sort()) add(f, 'unplaced');
  for (const s of manifestShots) if (s.missing && !onDisk.has(s.file)) add(s.file, 'not-captured');
  return rows;
}

export function boardCounts(rows: ShotRow[]): Record<ShotStatus, number> & { total: number } {
  const c = { placed: 0, unplaced: 0, 'missing-file': 0, 'not-captured': 0, total: rows.length };
  for (const r of rows) c[r.status] += 1;
  return c;
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function slug(text: string): string {
  const s = text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 60) || 'section';
}

/** A link target the guide may carry: web addresses, mail and in-page anchors. Anything else (javascript:, data:) is dropped. */
function safeHref(href: string): string | null {
  const h = String(href ?? '').trim();
  return /^(https?:\/\/|mailto:|#)/i.test(h) ? h : null;
}

export interface GuideHtmlInput {
  title: string;
  md: string;
  rows: ShotRow[];
  /** ISO date shown in the footer. */
  generatedAt: string;
}

/** The guide as one HTML page. Pictures are linked as screenshots/<file>: ship the page with that folder. */
export function buildGuideHtml(input: GuideHtmlInput): string {
  const byFile = new Map(input.rows.map((r) => [r.file, r]));
  const toc: Array<{ depth: number; id: string; text: string }> = [];
  const usedIds = new Set<string>();

  const marked = new Marked({
    gfm: true,
    renderer: {
      // Raw HTML in the Markdown is shown as text: a guide is written by an agent from untrusted sources.
      html({ text }) { return esc(text); },
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        let id = slug(inner);
        for (let i = 2; usedIds.has(id); i += 1) id = `${slug(inner)}-${i}`;
        usedIds.add(id);
        if (depth <= 3) toc.push({ depth, id, text: inner.replace(/<[^>]*>/g, '') });
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
      link({ href, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const safe = safeHref(href);
        return safe ? `<a href="${esc(safe)}"${safe.startsWith('#') ? '' : ' target="_blank" rel="noopener noreferrer"'}>${inner}</a>` : inner;
      },
      image({ href, text }) {
        const p = textRef(href);
        return p ? figure(p, text) : esc(text);
      },
    },
  });

  function figure(file: string, caption: string): string {
    const row = byFile.get(file);
    const legend = row && row.boxes.length
      ? `<ol class="legend">${row.boxes.map((b) => `<li value="${b.n}">${esc(b.label)}</li>`).join('')}</ol>`
      : '';
    return `<figure><img loading="lazy" src="${esc(file)}" alt="${esc(caption)}"><figcaption>${esc(caption)}</figcaption>${legend}</figure>`;
  }

  const body = marked.parse(input.md) as string;

  const unplaced = input.rows.filter((r) => r.status === 'unplaced');
  const missingFile = input.rows.filter((r) => r.status === 'missing-file');
  const notCaptured = input.rows.filter((r) => r.status === 'not-captured');
  const extra: string[] = [];
  if (unplaced.length) {
    extra.push(`<h2 id="more-screenshots">More screenshots</h2><p>Pictures taken for this guide that no section shows yet.</p>${unplaced.map((r) => figure(r.file, r.title || r.file.slice('screenshots/'.length))).join('')}`);
    toc.push({ depth: 2, id: 'more-screenshots', text: 'More screenshots' });
  }
  if (missingFile.length || notCaptured.length) {
    const li = (r: ShotRow, why: string): string => `<li><code>${esc(r.file.slice('screenshots/'.length))}</code>${r.title ? ` ${esc(r.title)}` : ''} <em>${why}</em>${r.notes ? `: ${esc(r.notes)}` : ''}</li>`;
    extra.push(`<h2 id="screenshots-to-be-added">Screenshots to be added</h2><ul>${[
      ...missingFile.map((r) => li(r, 'the text shows it but the file is missing')),
      ...notCaptured.map((r) => li(r, 'could not be taken')),
    ].join('')}</ul>`);
    toc.push({ depth: 2, id: 'screenshots-to-be-added', text: 'Screenshots to be added' });
  }

  const nav = toc.map((t) => `<a class="d${t.depth}" href="#${t.id}">${t.text}</a>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(input.title)}</title>
<style>
:root{--bg:#fff;--ink:#1b1f24;--muted:#5b6670;--line:#d8dee4;--accent:#0b5fff;--panel:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0f1318;--ink:#e6eaee;--muted:#9aa5b0;--line:#2a323b;--accent:#6ea0ff;--panel:#161c23}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}
nav{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;padding:20px 16px;border-right:1px solid var(--line);background:var(--panel);font-size:14px}
nav strong{display:block;margin-bottom:12px}nav a{display:block;padding:3px 0;color:var(--ink);text-decoration:none}nav a:hover{color:var(--accent)}nav a.d3{padding-left:14px;color:var(--muted)}
main{padding:32px clamp(16px,4vw,56px);max-width:960px}h1,h2,h3{line-height:1.25}h2{margin-top:2.2em;padding-top:.6em;border-top:1px solid var(--line)}
table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--panel)}
code{background:var(--panel);padding:1px 5px;border-radius:4px;font-size:.9em}pre{background:var(--panel);padding:12px;overflow:auto;border-radius:6px}pre code{padding:0}
figure{margin:20px 0;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}figure img{max-width:100%;height:auto;display:block;border-radius:4px}
figcaption{margin-top:8px;font-size:14px;color:var(--muted)}.legend{margin:8px 0 0;padding-left:22px;font-size:13px;color:var(--muted)}
footer{margin-top:3em;padding-top:1em;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
@media (max-width:800px){.wrap{display:block}nav{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}}
@media print{nav{display:none}.wrap{display:block}figure{break-inside:avoid}}
</style></head><body><div class="wrap">
<nav aria-label="Contents"><strong>${esc(input.title)}</strong>${nav}</nav>
<main>${body}${extra.join('')}<footer>Generated ${esc(input.generatedAt.slice(0, 10))}</footer></main>
</div></body></html>
`;
}

// ── Large guides: one document per role, merged ───────────────────────────────

export interface GuideSetTag { id: string; name: string }

/** The tag that groups the documents of a large guide (kept in a document's sources), or null when absent or malformed. */
export function guideSetFromSources(sources: Record<string, unknown> | null | undefined): GuideSetTag | null {
  const g = sources?.guideSet as Record<string, unknown> | undefined;
  if (!g || typeof g !== 'object') return null;
  const id = typeof g.id === 'string' ? g.id.trim() : '';
  const name = typeof g.name === 'string' ? g.name.trim() : '';
  if (!/^[A-Za-z0-9_-]{6,60}$/.test(id) || !name || name.length > 120) return null;
  return { id, name };
}

export interface GuidePart {
  /** The chapter title (the role). */
  label: string;
  /** Names the part's screenshots folder in the merged guide: screenshots/<slug>/. */
  slug: string;
  md: string;
  /** Picture files of the part, as screenshots/<file>. */
  files: string[];
  manifest: ShotEntry[];
}

/** Raises every heading one level (a document's # becomes the chapter's ##), leaving fenced code alone; drops the first # line. */
function demoteHeadings(md: string): string {
  let fenced = false;
  let droppedTitle = false;
  const out: string[] = [];
  for (const line of String(md ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; out.push(line); continue; }
    const h = !fenced && /^(#{1,6})\s+(.*)$/.exec(line);
    if (!h) { out.push(line); continue; }
    if (h[1].length === 1 && !droppedTitle) { droppedTitle = true; continue; }
    out.push(`${'#'.repeat(Math.min(6, h[1].length + 1))} ${h[2]}`);
  }
  return out.join('\n');
}

/**
 * Puts the documents of a large guide into one: a chapter per document (its headings one level lower), its pictures under
 * screenshots/<slug>/ so two documents can use the same file name, and one shot board across all of them.
 * `files` says which file of which part goes where in the bundle.
 */
export function mergeGuides(title: string, parts: GuidePart[]): { md: string; rows: ShotRow[]; files: Array<{ part: number; from: string; to: string }> } {
  const chunks: string[] = [`# ${title}`];
  const rows: ShotRow[] = [];
  const files: Array<{ part: number; from: string; to: string }> = [];
  parts.forEach((p, i) => {
    const rel = (f: string): string => `screenshots/${p.slug}/${shotPath(f).slice('screenshots/'.length)}`;
    const md = demoteHeadings(p.md).replace(IMAGE_MD, (whole, alt: string, href: string, t: string) => {
      const r = textRef(href);
      return r ? `![${alt}](${rel(r)}${t})` : whole;
    });
    chunks.push(`## ${p.label}\n\n${md.trim()}`);
    const own = p.files.map(shotPath);
    rows.push(...shotBoard(md, own.map(rel), p.manifest.map((m) => ({ ...m, file: rel(m.file) }))));
    for (const f of own) files.push({ part: i, from: f, to: rel(f) });
  });
  return { md: chunks.join('\n\n'), rows, files };
}
