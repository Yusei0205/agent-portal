import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { Marked } from 'marked';
import { all, insert, one, run, update, type Row } from './db.ts';
import { del, get, patch, post, sendFile } from './http.ts';
import { commitProject, getProject, notifyProject, projectDir, requireProject, type Access, type Project } from './projects.ts';
import { resolveRefs, sectionsByIds, sectionsFor, sourceHash } from './knowledge.ts';
import { badRequest, escapeHtml, extractJson, forbidden, int, newId, notFound, now, parseJson, slugify, str, withLock } from './util.ts';
import { demoLearnDoc, demoQuiz, demoVerify, type QuizQuestion, type SourceSection } from './agent/heuristics.ts';
import { oneshot } from './agent/runner.ts';

type Ref = { docId: string; heading: string; anchor: string; docName: string };
const KINDS = ['overview', 'feature', 'glossary', 'faq'] as const;
const AUDIENCES = ['business', 'technical'] as const;
const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

function pick<T extends readonly string[]>(v: unknown, allowed: T, field: string): T[number] {
  if (!allowed.includes(v as string)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}`);
  return v as T[number];
}

function refsOf(sections: SourceSection[]): Ref[] {
  return sections.map((s) => ({ docId: s.docId, heading: s.heading, anchor: s.anchor, docName: s.docName }));
}

function hashOfRefs(refs: Ref[]): string | null {
  return sourceHash(resolveRefs(refs));
}

function numberedSources(sections: SourceSection[], perSection = 4000): string {
  return sections.map((s, i) => `[${i + 1}] ${s.docName} › ${s.heading}\n${s.content.slice(0, perSection)}`).join('\n\n---\n\n');
}

function canEdit(access: Access): boolean {
  return access === 'editor' || access === 'owner';
}

/* ------------------------------------------------------------------ */
/* Stale detection                                                     */
/* ------------------------------------------------------------------ */

export function refreshStaleFlags(projectId: string): void {
  let changed = false;
  for (const table of ['learn_docs', 'quizzes'] as const) {
    for (const r of all<Row>(`SELECT id, source_refs, source_hash, stale FROM ${table} WHERE project_id = ? AND status != 'generating'`, projectId)) {
      const refs = parseJson<Ref[]>(r.source_refs, []);
      if (!refs.length) continue;
      const stale = hashOfRefs(refs) !== r.source_hash ? 1 : 0;
      if (stale !== r.stale) {
        run(`UPDATE ${table} SET stale = ? WHERE id = ?`, stale, r.id);
        changed = true;
      }
    }
  }
  if (changed) notifyProject(projectId, 'learn.updated', {});
}

/* ------------------------------------------------------------------ */
/* Documents in two views                                              */
/* ------------------------------------------------------------------ */

const KIND_GUIDE: Record<string, string> = {
  overview: 'A system overview: what the system does, who uses it, the main flows, and how the parts fit together.',
  feature: 'A feature guide: what the user does step by step, the business rules, and how it is implemented.',
  glossary: 'A glossary: every important term, defined plainly (business view) and mapped to code, tables or APIs (technical view). Use tables.',
  faq: 'An FAQ: the questions newcomers ask most, each answered briefly. Business questions in the business view, implementation questions in the technical view.',
};

function docSystem(kind: string): string {
  return `You write project documentation for two audiences, using ONLY the numbered source sections provided.

Document type: ${KIND_GUIDE[kind]}

Business view (for non-technical readers):
- Short sentences and everyday words. No code, no file paths.
- Define each term the first time it appears; one analogy per concept at most, only if it helps.
- Start with what it does for people, then how it works step by step.
- At most one simple Mermaid diagram (\`\`\`mermaid).

Technical view (for engineers):
- Exact names: endpoints, classes, tables, fields, configuration.
- Mermaid sequence or component diagram where components interact.
- Error handling, limits and edge cases.
- End with "Sources" listing the source titles used, and "Open questions" if the sources leave important gaps.

Both views must describe the same facts and never contradict each other. Never add facts that are not in the sources.

Reply with JSON only:
{"business_md": "<markdown starting with # title>", "technical_md": "<markdown starting with # title>", "glossary": [{"term": "", "business": "", "technical": ""}]}`;
}

async function generateDoc(docId: string, userId: string): Promise<void> {
  const d = one<Row>('SELECT * FROM learn_docs WHERE id = ?', docId)!;
  try {
    const sections = sectionsFor(d.project_id, { docIds: parseJson<string[]>(d.doc_ids, []), focus: d.focus, maxChars: 80_000 });
    if (!sections.length) throw badRequest('No source text found. Upload documents in Knowledge, or change the selection.');
    const { text, runId } = await oneshot({
      projectId: d.project_id,
      userId,
      kind: 'learn',
      title: `Write ${d.kind}: ${d.title}`,
      system: docSystem(d.kind),
      prompt: `Title: ${d.title}\n${d.focus ? `Focus: ${d.focus}\n` : ''}\nSources:\n\n${numberedSources(sections)}`,
      model: 'sonnet',
      meta: { learnDocId: d.id },
      demoOutput: () => JSON.stringify(demoLearnDoc(d.title, d.kind, sections)),
    });
    const parsed = extractJson<any>(text);
    if (!parsed?.business_md || !parsed?.technical_md) throw new Error('The model did not return both views. Try again.');
    const refs = refsOf(sections);
    update('learn_docs', d.id, {
      business_md: String(parsed.business_md),
      technical_md: String(parsed.technical_md),
      glossary: JSON.stringify(Array.isArray(parsed.glossary) ? parsed.glossary.slice(0, 100) : []),
      source_refs: JSON.stringify(refs),
      source_hash: hashOfRefs(refs),
      status: 'draft',
      stale: 0,
      error: null,
      run_id: runId,
      updated_at: now(),
    });
  } catch (e: any) {
    update('learn_docs', d.id, { status: d.business_md ? 'draft' : 'error', error: String(e?.message ?? e), updated_at: now() });
  }
  notifyProject(d.project_id, 'learn.updated', { id: d.id });
}

function learnDocView(r: Row, withBody = true) {
  const base = {
    ...r,
    doc_ids: parseJson(r.doc_ids, []),
    source_refs: parseJson(r.source_refs, []),
    glossary: parseJson(r.glossary, []),
  };
  if (!withBody) {
    delete (base as any).business_md;
    delete (base as any).technical_md;
  }
  return base;
}

function getLearnDoc(id: string): Row {
  const r = one<Row>('SELECT * FROM learn_docs WHERE id = ?', id);
  if (!r) throw notFound('Document not found');
  return r;
}

/* ------------------------------------------------------------------ */
/* Quizzes                                                             */
/* ------------------------------------------------------------------ */

function quizSystem(audience: string, difficulty: string, count: number): string {
  return `Create ${count} quiz questions for a ${audience} audience at ${difficulty} difficulty, using ONLY the numbered sources.

${audience === 'business'
    ? 'Business audience: test understanding of rules, flows and outcomes with short scenarios ("A customer does X. What happens?"). Use "mcq" and "truefalse" only. No code.'
    : 'Technical audience: test API behaviour, data handling, edge cases and code reading. Use "mcq", "truefalse" and "short".'}
Difficulty: easy = direct facts; medium = applying a rule to a scenario; hard = edge cases and combinations of rules.

Rules:
- "mcq" has exactly 4 plausible options; "answer" must equal one option exactly.
- "truefalse" has options ["True","False"] and answer "True" or "False".
- "short" answers are at most 8 words.
- "explanation" is one sentence quoting or closely paraphrasing the source.
- "source" is the source number the answer comes from.
- No trivia (exact wording, page numbers). No questions the sources cannot answer.

Reply with JSON only: {"questions": [{"type": "mcq", "question": "", "options": ["", "", "", ""], "answer": "", "explanation": "", "source": 1}]}`;
}

const VERIFY_SYSTEM = `You check quiz questions against their cited source text.
A question passes only if the source clearly supports the stated answer, and for multiple choice the other options are clearly wrong.
Reply with JSON only: {"results": [{"id": "q1", "ok": true, "reason": "<short>"}]}`;

async function generateQuiz(quizId: string, userId: string): Promise<void> {
  const q = one<Row>('SELECT * FROM quizzes WHERE id = ?', quizId)!;
  const meta = { count: parseJson<any>(q.questions, {})?.count ?? 8 };
  try {
    let sections: SourceSection[];
    if (q.learn_doc_id) {
      const doc = getLearnDoc(q.learn_doc_id);
      const refs = parseJson<Ref[]>(doc.source_refs, []);
      const ids = resolveRefs(refs);
      sections = sectionsByIds(ids);
      if (!sections.length) sections = sectionsFor(q.project_id, { docIds: parseJson(doc.doc_ids, []), focus: doc.focus });
    } else {
      sections = sectionsFor(q.project_id, { docIds: parseJson<string[]>(q.doc_ids, []), focus: '', maxChars: 50_000 });
    }
    if (!sections.length) throw badRequest('No source text found. Upload documents in Knowledge first.');
    const count = meta.count;
    const seed = `${q.id}`;
    const gen = await oneshot({
      projectId: q.project_id,
      userId,
      kind: 'quiz',
      title: `Write quiz: ${q.title}`,
      system: quizSystem(q.audience, q.difficulty, count),
      prompt: `Quiz title: ${q.title}\n\nSources:\n\n${numberedSources(sections, 3000)}`,
      model: 'haiku',
      meta: { quizId: q.id },
      demoOutput: () =>
        JSON.stringify({
          questions: demoQuiz(sections, q.audience, q.difficulty, count, seed).map((x) => ({
            ...x,
            source: sections.findIndex((s) => s.sectionId === x.source.sectionId) + 1,
          })),
        }),
    });
    const raw = extractJson<any>(gen.text)?.questions;
    if (!Array.isArray(raw) || !raw.length) throw new Error('The model did not return any questions. Try again.');
    let questions: QuizQuestion[] = raw
      .map((x: any, i: number): QuizQuestion | null => {
        const s = sections[Number(x.source) - 1] ?? sections[0];
        const type = ['mcq', 'truefalse', 'short'].includes(x.type) ? x.type : 'mcq';
        const options = type === 'truefalse' ? ['True', 'False'] : Array.isArray(x.options) ? x.options.map(String).slice(0, 6) : undefined;
        const answer = String(x.answer ?? '');
        if (!x.question || !answer) return null;
        if (type === 'mcq' && (!options || options.length < 2 || !options.includes(answer))) return null;
        if (type === 'short' && q.audience === 'business') return null;
        return {
          id: `q${i + 1}`,
          type,
          question: String(x.question),
          options,
          answer,
          explanation: String(x.explanation ?? ''),
          source: { docId: s.docId, sectionId: s.sectionId, heading: s.heading, docName: s.docName, anchor: s.anchor },
        };
      })
      .filter((x: QuizQuestion | null): x is QuizQuestion => Boolean(x))
      .map((x: QuizQuestion, i: number) => ({ ...x, id: `q${i + 1}` }));

    // Second, cheaper pass: drop anything the cited source does not support.
    const bySection = new Map(sections.map((s) => [s.sectionId, s]));
    const ver = await oneshot({
      projectId: q.project_id,
      userId,
      kind: 'verify',
      title: `Check quiz: ${q.title}`,
      system: VERIFY_SYSTEM,
      prompt: questions
        .map(
          (x) =>
            `${x.id}: ${x.question}\nOptions: ${(x.options ?? []).join(' | ') || '(short answer)'}\nStated answer: ${x.answer}\nSource text:\n${bySection.get(x.source.sectionId)?.content.slice(0, 2500) ?? ''}`,
        )
        .join('\n\n---\n\n'),
      model: 'haiku',
      meta: { quizId: q.id },
      demoOutput: () =>
        JSON.stringify({ results: demoVerify(questions, sections).map((x) => ({ id: x.id, ok: x.verified, reason: x.verified ? 'Supported by the source' : 'Not found in the source' })) }),
    });
    const results = extractJson<any>(ver.text)?.results;
    const okIds = new Set(Array.isArray(results) ? results.filter((r: any) => r.ok).map((r: any) => String(r.id)) : questions.map((x) => x.id));
    const before = questions.length;
    questions = questions.filter((x) => okIds.has(x.id)).map((x, i) => ({ ...x, id: `q${i + 1}`, verified: true }));
    if (!questions.length) throw new Error('No question passed the accuracy check. Try different sources or regenerate.');
    const refs = refsOf(sections);
    update('quizzes', q.id, {
      questions: JSON.stringify(questions),
      dropped: before - questions.length,
      source_refs: JSON.stringify(refs),
      source_hash: hashOfRefs(refs),
      status: 'draft',
      stale: 0,
      error: null,
      run_id: gen.runId,
      updated_at: now(),
    });
  } catch (e: any) {
    update('quizzes', q.id, { status: 'error', error: String(e?.message ?? e), updated_at: now(), questions: '[]' });
  }
  notifyProject(q.project_id, 'learn.updated', { id: q.id });
}

function getQuiz(id: string): Row {
  const r = one<Row>('SELECT * FROM quizzes WHERE id = ?', id);
  if (!r) throw notFound('Quiz not found');
  return r;
}

function quizView(r: Row, reveal: boolean) {
  const questions = parseJson<QuizQuestion[]>(r.questions, []);
  return {
    ...r,
    doc_ids: parseJson(r.doc_ids, []),
    source_refs: parseJson(r.source_refs, []),
    questions: Array.isArray(questions)
      ? questions.map((q) => (reveal ? q : { id: q.id, type: q.type, question: q.question, options: q.options, source: { heading: q.source.heading, docName: q.source.docName } }))
      : [],
  };
}

function normWords(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
}

export function gradeAnswer(q: QuizQuestion, given: unknown): boolean {
  const g = String(given ?? '').trim();
  if (!g) return false;
  if (q.type !== 'short') return g.toLowerCase() === q.answer.trim().toLowerCase();
  const a = normWords(q.answer);
  const b = new Set(normWords(g));
  if (!a.length) return false;
  const hit = a.filter((w) => b.has(w)).length;
  return hit / a.length >= 0.6;
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

const md = new Marked({
  gfm: true,
  renderer: {
    html(token: any) {
      return escapeHtml(token.text ?? token.raw ?? '');
    },
    code(token: any) {
      if (token.lang === 'mermaid') return `<pre class="mermaid">${escapeHtml(token.text)}</pre>`;
      return `<pre><code>${escapeHtml(token.text)}</code></pre>`;
    },
  },
});

function exportHtml(title: string, business: string, technical: string): string {
  const b = md.parse(business) as string;
  const t = md.parse(technical) as string;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--ink:#1d2433;--muted:#5b6475;--line:#d9dee7;--accent:#0f7c80;--bg:#fbfcfd}
body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg);margin:0}
main{max-width:46rem;margin:0 auto;padding:2rem 1.25rem 4rem}
nav{display:flex;gap:.5rem;margin:0 0 1.5rem}
nav button{font:inherit;padding:.4rem .9rem;border:1px solid var(--line);background:#fff;border-radius:999px;cursor:pointer}
nav button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
h1{font-size:1.9rem;line-height:1.2}h2{margin-top:2rem}
table{border-collapse:collapse;width:100%;font-size:.95rem}td,th{border:1px solid var(--line);padding:.4rem .6rem;text-align:left;vertical-align:top}
pre{background:#f1f3f6;padding:.8rem;overflow:auto;border-radius:6px}code{font-size:.9em}
.view[hidden]{display:none}
@media print{nav{display:none}.view[hidden]{display:block}.view+.view{page-break-before:always}}
</style></head><body><main>
<nav><button data-v="business" aria-pressed="true">For everyone</button><button data-v="technical" aria-pressed="false">For engineers</button></nav>
<section class="view" id="business">${b}</section>
<section class="view" id="technical" hidden>${t}</section>
</main>
<script type="module">
document.querySelectorAll('nav button').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('nav button').forEach(x=>x.setAttribute('aria-pressed',String(x===btn)));
  document.querySelectorAll('.view').forEach(v=>v.hidden=v.id!==btn.dataset.v);
}));
if(document.querySelector('.mermaid')){import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs').then(m=>{m.default.initialize({startOnLoad:false,securityLevel:'strict'});m.default.run();}).catch(()=>{});}
</script></body></html>`;
}

function quizMarkdown(q: Row): string {
  const questions = parseJson<QuizQuestion[]>(q.questions, []);
  return `# ${q.title}\n\nAudience: ${q.audience}. Difficulty: ${q.difficulty}.\n\n${questions
    .map((x, i) => `${i + 1}. ${x.question}\n${(x.options ?? []).map((o) => `   - ${o}`).join('\n')}`)
    .join('\n\n')}\n\n## Answer key\n\n${questions.map((x, i) => `${i + 1}. **${x.answer}**: ${x.explanation} _(${x.source.docName} › ${x.source.heading})_`).join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* Learning paths                                                      */
/* ------------------------------------------------------------------ */

interface Step {
  type: 'doc' | 'quiz';
  id: string;
}

function checkSteps(projectId: string, steps: unknown): Step[] {
  if (!Array.isArray(steps)) throw badRequest('Steps must be a list');
  return steps.slice(0, 50).map((s: any) => {
    if (s?.type === 'doc') {
      if (!one('SELECT 1 FROM learn_docs WHERE id = ? AND project_id = ?', s.id, projectId)) throw badRequest('A step points to a missing document');
      return { type: 'doc', id: String(s.id) };
    }
    if (s?.type === 'quiz') {
      if (!one('SELECT 1 FROM quizzes WHERE id = ? AND project_id = ?', s.id, projectId)) throw badRequest('A step points to a missing quiz');
      return { type: 'quiz', id: String(s.id) };
    }
    throw badRequest('Each step must be a doc or a quiz');
  });
}

const PASS = 0.7;

function stepDone(userId: string, s: Step): boolean {
  if (s.type === 'doc') return Boolean(one('SELECT 1 FROM doc_reads WHERE user_id = ? AND learn_doc_id = ?', userId, s.id));
  const best = one<{ r: number }>('SELECT MAX(CAST(score AS REAL) / total) AS r FROM quiz_attempts WHERE user_id = ? AND quiz_id = ? AND total > 0', userId, s.id);
  return (best?.r ?? 0) >= PASS;
}

function pathView(r: Row, userId: string) {
  const steps = parseJson<Step[]>(r.steps, []).map((s) => {
    const item =
      s.type === 'doc'
        ? one('SELECT id, title, kind, status, stale FROM learn_docs WHERE id = ?', s.id)
        : one('SELECT id, title, audience, difficulty, status, stale FROM quizzes WHERE id = ?', s.id);
    return { ...s, item, done: item ? stepDone(userId, s) : false };
  });
  const live = steps.filter((s) => s.item);
  return { ...r, steps, progress: live.length ? Math.round((100 * live.filter((s) => s.done).length) / live.length) : 0 };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function registerLearnRoutes(): void {
  // ---- Docs ----
  get('/api/projects/:pid/learn/docs', (ctx) => {
    const { project, access } = requireProject(ctx, ctx.params.pid);
    const rows = all(
      `SELECT l.*, u.name AS created_by_name, a.name AS approved_by_name,
              EXISTS (SELECT 1 FROM doc_reads r WHERE r.learn_doc_id = l.id AND r.user_id = ?) AS read
         FROM learn_docs l LEFT JOIN users u ON u.id = l.created_by LEFT JOIN users a ON a.id = l.approved_by
        WHERE l.project_id = ? ${canEdit(access) ? '' : "AND l.status = 'published'"}
        ORDER BY l.updated_at DESC`,
      ctx.user!.id,
      project.id,
    );
    return { docs: rows.map((r) => learnDocView(r, false)) };
  });

  post('/api/projects/:pid/learn/docs', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const title = str(body.title, 'Title', { max: 200 }).trim();
    const kind = pick(body.kind ?? 'overview', KINDS, 'Type');
    const docIds = (Array.isArray(body.docIds) ? body.docIds : []).map(String).filter((id: string) => one('SELECT 1 FROM documents WHERE id = ? AND project_id = ?', id, project.id));
    const id = newId('l_');
    insert('learn_docs', {
      id,
      project_id: project.id,
      title,
      slug: slugify(title),
      kind,
      focus: str(body.focus, 'Focus', { max: 500, optional: true }),
      doc_ids: JSON.stringify(docIds),
      status: 'generating',
      created_by: ctx.user!.id,
      created_at: now(),
      updated_at: now(),
    });
    notifyProject(project.id, 'learn.updated', { id });
    void generateDoc(id, ctx.user!.id);
    return { doc: learnDocView(getLearnDoc(id)) };
  });

  get('/api/learn/docs/:id', (ctx) => {
    const d = getLearnDoc(ctx.params.id);
    const { access } = requireProject(ctx, d.project_id);
    if (d.status !== 'published' && !canEdit(access)) throw notFound('Document not found');
    const read = Boolean(one('SELECT 1 FROM doc_reads WHERE user_id = ? AND learn_doc_id = ?', ctx.user!.id, d.id));
    return { doc: { ...learnDocView(d), read }, quizzes: all('SELECT id, title, audience, difficulty, status FROM quizzes WHERE learn_doc_id = ?', d.id) };
  });

  patch('/api/learn/docs/:id', async (ctx) => {
    const d = getLearnDoc(ctx.params.id);
    requireProject(ctx, d.project_id, 'editor');
    const body = await ctx.json();
    const p: Record<string, any> = { updated_at: now() };
    if (body.title !== undefined) p.title = str(body.title, 'Title', { max: 200 }).trim();
    if (body.business_md !== undefined) p.business_md = str(body.business_md, 'Business view', { max: 300_000, optional: true });
    if (body.technical_md !== undefined) p.technical_md = str(body.technical_md, 'Technical view', { max: 300_000, optional: true });
    if (d.status === 'published' && (p.business_md !== undefined || p.technical_md !== undefined)) p.status = 'draft';
    update('learn_docs', d.id, p);
    notifyProject(d.project_id, 'learn.updated', { id: d.id });
    return { doc: learnDocView(getLearnDoc(d.id)) };
  });

  post('/api/learn/docs/:id/regenerate', async (ctx) => {
    const d = getLearnDoc(ctx.params.id);
    requireProject(ctx, d.project_id, 'editor');
    if (d.status === 'generating') throw badRequest('Already generating');
    update('learn_docs', d.id, { status: 'generating', error: null, updated_at: now() });
    notifyProject(d.project_id, 'learn.updated', { id: d.id });
    void generateDoc(d.id, ctx.user!.id);
    return { ok: true };
  });

  post('/api/learn/docs/:id/publish', async (ctx) => {
    const d = getLearnDoc(ctx.params.id);
    const { project } = requireProject(ctx, d.project_id, 'editor');
    if (d.status === 'generating' || d.status === 'error') throw badRequest('Only a finished draft can be published');
    const dir = path.join(projectDir(project), 'docs', 'generated');
    await withLock(`git:${projectDir(project)}`, async () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${d.slug}.business.md`), d.business_md);
      fs.writeFileSync(path.join(dir, `${d.slug}.technical.md`), d.technical_md);
    });
    await commitProject(project.id, `Publish ${d.title}`, ['docs/generated']).catch(() => undefined);
    update('learn_docs', d.id, { status: 'published', approved_by: ctx.user!.id, published_at: now(), updated_at: now() });
    notifyProject(d.project_id, 'learn.updated', { id: d.id });
    return { doc: learnDocView(getLearnDoc(d.id)) };
  });

  post('/api/learn/docs/:id/unpublish', (ctx) => {
    const d = getLearnDoc(ctx.params.id);
    requireProject(ctx, d.project_id, 'editor');
    update('learn_docs', d.id, { status: 'draft', updated_at: now() });
    notifyProject(d.project_id, 'learn.updated', { id: d.id });
    return { ok: true };
  });

  post('/api/learn/docs/:id/read', (ctx) => {
    const d = getLearnDoc(ctx.params.id);
    requireProject(ctx, d.project_id);
    run('INSERT OR REPLACE INTO doc_reads (user_id, learn_doc_id, read_at) VALUES (?, ?, ?)', ctx.user!.id, d.id, now());
    return { ok: true };
  });

  del('/api/learn/docs/:id', (ctx) => {
    const d = getLearnDoc(ctx.params.id);
    requireProject(ctx, d.project_id, 'editor');
    run('DELETE FROM learn_docs WHERE id = ?', d.id);
    run('UPDATE quizzes SET learn_doc_id = NULL WHERE learn_doc_id = ?', d.id);
    notifyProject(d.project_id, 'learn.updated', { id: d.id });
    return { ok: true };
  });

  get('/api/learn/docs/:id/export', (ctx) => {
    const d = getLearnDoc(ctx.params.id);
    const { access } = requireProject(ctx, d.project_id);
    if (d.status !== 'published' && !canEdit(access)) throw notFound();
    const format = ctx.query.get('format') || 'html';
    if (format === 'md') {
      const view = ctx.query.get('view') === 'technical' ? 'technical' : 'business';
      return sendFile(ctx.res, view === 'technical' ? d.technical_md : d.business_md, 'text/markdown; charset=utf-8', `${d.slug}.${view}.md`);
    }
    return sendFile(ctx.res, exportHtml(d.title, d.business_md, d.technical_md), 'text/html; charset=utf-8', `${d.slug}.html`);
  });

  // ---- Quizzes ----
  get('/api/projects/:pid/learn/quizzes', (ctx) => {
    const { project, access } = requireProject(ctx, ctx.params.pid);
    const rows = all(
      `SELECT q.id, q.title, q.audience, q.difficulty, q.status, q.stale, q.error, q.dropped, q.learn_doc_id, q.updated_at, q.published_at,
              json_array_length(q.questions) AS question_count,
              (SELECT MAX(CAST(a.score AS REAL) / a.total) FROM quiz_attempts a WHERE a.quiz_id = q.id AND a.user_id = ? AND a.total > 0) AS my_best
         FROM quizzes q WHERE q.project_id = ? ${canEdit(access) ? '' : "AND q.status = 'published'"}
        ORDER BY q.updated_at DESC`,
      ctx.user!.id,
      project.id,
    );
    return { quizzes: rows };
  });

  post('/api/projects/:pid/learn/quizzes', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const title = str(body.title, 'Title', { max: 200 }).trim();
    const audience = pick(body.audience ?? 'business', AUDIENCES, 'Audience');
    const difficulty = pick(body.difficulty ?? 'medium', DIFFICULTIES, 'Difficulty');
    const count = int(body.count, 'Number of questions', 8, 3, 25);
    const learnDocId = body.learnDocId ? String(body.learnDocId) : null;
    if (learnDocId && !one('SELECT 1 FROM learn_docs WHERE id = ? AND project_id = ?', learnDocId, project.id)) throw badRequest('That document is not in this project');
    const docIds = (Array.isArray(body.docIds) ? body.docIds : []).map(String).filter((id: string) => one('SELECT 1 FROM documents WHERE id = ? AND project_id = ?', id, project.id));
    const id = newId('q_');
    insert('quizzes', {
      id,
      project_id: project.id,
      title,
      audience,
      difficulty,
      learn_doc_id: learnDocId,
      doc_ids: JSON.stringify(docIds),
      questions: JSON.stringify({ count }),
      status: 'generating',
      created_by: ctx.user!.id,
      created_at: now(),
      updated_at: now(),
    });
    notifyProject(project.id, 'learn.updated', { id });
    void generateQuiz(id, ctx.user!.id);
    return { quiz: { id, title, status: 'generating' } };
  });

  get('/api/learn/quizzes/:id', (ctx) => {
    const q = getQuiz(ctx.params.id);
    const { access } = requireProject(ctx, q.project_id);
    if (q.status !== 'published' && !canEdit(access)) throw notFound('Quiz not found');
    const reveal = canEdit(access) && ctx.query.get('mode') !== 'take';
    return { quiz: quizView(q, reveal) };
  });

  patch('/api/learn/quizzes/:id', async (ctx) => {
    const q = getQuiz(ctx.params.id);
    requireProject(ctx, q.project_id, 'editor');
    const body = await ctx.json();
    const p: Record<string, any> = { updated_at: now() };
    if (body.title !== undefined) p.title = str(body.title, 'Title', { max: 200 }).trim();
    if (body.questions !== undefined) {
      const existing = parseJson<QuizQuestion[]>(q.questions, []);
      const byId = new Map(existing.map((x) => [x.id, x]));
      if (!Array.isArray(body.questions)) throw badRequest('Questions must be a list');
      const next = body.questions.map((x: any, i: number) => {
        const prev = byId.get(String(x.id));
        if (!prev) throw badRequest('Unknown question');
        const updated: QuizQuestion = {
          ...prev,
          question: str(x.question ?? prev.question, 'Question', { max: 2000 }),
          answer: str(x.answer ?? prev.answer, 'Answer', { max: 500 }),
          explanation: str(x.explanation ?? prev.explanation, 'Explanation', { max: 2000, optional: true }),
          options: prev.type === 'mcq' && Array.isArray(x.options) ? x.options.map((o: unknown) => String(o).slice(0, 300)).slice(0, 6) : prev.options,
          id: `q${i + 1}`,
        };
        if (updated.type === 'mcq' && !updated.options?.includes(updated.answer)) throw badRequest(`Question ${i + 1}: the answer must be one of the options`);
        return updated;
      });
      if (!next.length) throw badRequest('A quiz needs at least one question');
      p.questions = JSON.stringify(next);
      if (q.status === 'published') p.status = 'draft';
    }
    update('quizzes', q.id, p);
    notifyProject(q.project_id, 'learn.updated', { id: q.id });
    return { quiz: quizView(getQuiz(q.id), true) };
  });

  post('/api/learn/quizzes/:id/regenerate', (ctx) => {
    const q = getQuiz(ctx.params.id);
    requireProject(ctx, q.project_id, 'editor');
    if (q.status === 'generating') throw badRequest('Already generating');
    const count = Math.max(3, parseJson<any[]>(q.questions, []).length || 8);
    update('quizzes', q.id, { status: 'generating', error: null, questions: JSON.stringify({ count }), updated_at: now() });
    notifyProject(q.project_id, 'learn.updated', { id: q.id });
    void generateQuiz(q.id, ctx.user!.id);
    return { ok: true };
  });

  post('/api/learn/quizzes/:id/publish', (ctx) => {
    const q = getQuiz(ctx.params.id);
    requireProject(ctx, q.project_id, 'editor');
    if (q.status !== 'draft' && q.status !== 'published') throw badRequest('Only a finished draft can be published');
    update('quizzes', q.id, { status: 'published', approved_by: ctx.user!.id, published_at: now(), updated_at: now() });
    notifyProject(q.project_id, 'learn.updated', { id: q.id });
    return { ok: true };
  });

  post('/api/learn/quizzes/:id/unpublish', (ctx) => {
    const q = getQuiz(ctx.params.id);
    requireProject(ctx, q.project_id, 'editor');
    update('quizzes', q.id, { status: 'draft', updated_at: now() });
    notifyProject(q.project_id, 'learn.updated', { id: q.id });
    return { ok: true };
  });

  del('/api/learn/quizzes/:id', (ctx) => {
    const q = getQuiz(ctx.params.id);
    requireProject(ctx, q.project_id, 'editor');
    run('DELETE FROM quizzes WHERE id = ?', q.id);
    notifyProject(q.project_id, 'learn.updated', { id: q.id });
    return { ok: true };
  });

  post('/api/learn/quizzes/:id/attempts', async (ctx) => {
    const q = getQuiz(ctx.params.id);
    const { access } = requireProject(ctx, q.project_id);
    if (q.status !== 'published' && !canEdit(access)) throw forbidden('This quiz is not published yet');
    const body = await ctx.json();
    const answers = (body.answers ?? {}) as Record<string, unknown>;
    const questions = parseJson<QuizQuestion[]>(q.questions, []);
    const results = questions.map((x) => ({
      id: x.id,
      given: String(answers[x.id] ?? ''),
      correct: gradeAnswer(x, answers[x.id]),
      answer: x.answer,
      explanation: x.explanation,
      source: x.source,
    }));
    const score = results.filter((r) => r.correct).length;
    const id = newId('a_');
    insert('quiz_attempts', {
      id,
      quiz_id: q.id,
      user_id: ctx.user!.id,
      answers: JSON.stringify(answers),
      results: JSON.stringify(results),
      score,
      total: questions.length,
      created_at: now(),
    });
    notifyProject(q.project_id, 'learn.progress', { userId: ctx.user!.id });
    return { attempt: { id, score, total: questions.length, passed: questions.length > 0 && score / questions.length >= PASS, results } };
  });

  get('/api/learn/quizzes/:id/attempts', (ctx) => {
    const q = getQuiz(ctx.params.id);
    const { access } = requireProject(ctx, q.project_id);
    const rows = canEdit(access)
      ? all('SELECT a.id, a.score, a.total, a.created_at, u.name FROM quiz_attempts a JOIN users u ON u.id = a.user_id WHERE a.quiz_id = ? ORDER BY a.created_at DESC LIMIT 200', q.id)
      : all('SELECT a.id, a.score, a.total, a.created_at FROM quiz_attempts a WHERE a.quiz_id = ? AND a.user_id = ? ORDER BY a.created_at DESC', q.id, ctx.user!.id);
    return { attempts: rows };
  });

  // ---- Paths ----
  get('/api/projects/:pid/learn/paths', (ctx) => {
    const { project, access } = requireProject(ctx, ctx.params.pid);
    const rows = all(`SELECT * FROM paths WHERE project_id = ? ${canEdit(access) ? '' : "AND status = 'published'"} ORDER BY title`, project.id);
    return { paths: rows.map((r) => pathView(r, ctx.user!.id)) };
  });

  post('/api/projects/:pid/learn/paths', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const id = newId('t_');
    insert('paths', {
      id,
      project_id: project.id,
      title: str(body.title, 'Title', { max: 200 }).trim(),
      audience: pick(body.audience ?? 'business', AUDIENCES, 'Audience'),
      description: str(body.description, 'Description', { max: 2000, optional: true }),
      steps: JSON.stringify(checkSteps(project.id, body.steps ?? [])),
      status: body.publish ? 'published' : 'draft',
      created_by: ctx.user!.id,
      created_at: now(),
      updated_at: now(),
    });
    notifyProject(project.id, 'learn.updated', { id });
    return { path: pathView(one('SELECT * FROM paths WHERE id = ?', id)!, ctx.user!.id) };
  });

  post('/api/projects/:pid/learn/paths/auto', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const audience = pick(body.audience ?? 'business', AUDIENCES, 'Audience');
    const order = ['overview', 'feature', 'glossary', 'faq'];
    const docs = all<Row>("SELECT id, kind, title FROM learn_docs WHERE project_id = ? AND status = 'published'", project.id).sort(
      (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.title.localeCompare(b.title),
    );
    const steps: Step[] = [];
    for (const d of docs) {
      steps.push({ type: 'doc', id: d.id });
      const quiz = one<Row>("SELECT id FROM quizzes WHERE learn_doc_id = ? AND status = 'published' AND audience = ? ORDER BY updated_at DESC", d.id, audience);
      if (quiz) steps.push({ type: 'quiz', id: quiz.id });
    }
    for (const q of all<Row>("SELECT id FROM quizzes WHERE project_id = ? AND status = 'published' AND audience = ? AND learn_doc_id IS NULL", project.id, audience)) {
      steps.push({ type: 'quiz', id: q.id });
    }
    if (!steps.length) throw badRequest('Publish at least one document or quiz first');
    const id = newId('t_');
    insert('paths', {
      id,
      project_id: project.id,
      title: str(body.title, 'Title', { max: 200, optional: true }) || (audience === 'business' ? 'Onboarding for everyone' : 'Onboarding for engineers'),
      audience,
      description: audience === 'business' ? 'Plain-language overview, then the main flows, with a short quiz after each part.' : 'Technical overview, interfaces and edge cases, with checks along the way.',
      steps: JSON.stringify(steps),
      status: 'draft',
      created_by: ctx.user!.id,
      created_at: now(),
      updated_at: now(),
    });
    notifyProject(project.id, 'learn.updated', { id });
    return { path: pathView(one('SELECT * FROM paths WHERE id = ?', id)!, ctx.user!.id) };
  });

  patch('/api/learn/paths/:id', async (ctx) => {
    const r = one<Row>('SELECT * FROM paths WHERE id = ?', ctx.params.id);
    if (!r) throw notFound('Path not found');
    requireProject(ctx, r.project_id, 'editor');
    const body = await ctx.json();
    const p: Record<string, any> = { updated_at: now() };
    if (body.title !== undefined) p.title = str(body.title, 'Title', { max: 200 }).trim();
    if (body.description !== undefined) p.description = str(body.description, 'Description', { max: 2000, optional: true });
    if (body.audience !== undefined) p.audience = pick(body.audience, AUDIENCES, 'Audience');
    if (body.steps !== undefined) p.steps = JSON.stringify(checkSteps(r.project_id, body.steps));
    if (body.status !== undefined) p.status = body.status === 'published' ? 'published' : 'draft';
    update('paths', r.id, p);
    notifyProject(r.project_id, 'learn.updated', { id: r.id });
    return { path: pathView(one('SELECT * FROM paths WHERE id = ?', r.id)!, ctx.user!.id) };
  });

  del('/api/learn/paths/:id', (ctx) => {
    const r = one<Row>('SELECT * FROM paths WHERE id = ?', ctx.params.id);
    if (!r) throw notFound('Path not found');
    requireProject(ctx, r.project_id, 'editor');
    run('DELETE FROM paths WHERE id = ?', r.id);
    notifyProject(r.project_id, 'learn.updated', { id: r.id });
    return { ok: true };
  });

  get('/api/projects/:pid/learn/progress', (ctx) => {
    const { project, access } = requireProject(ctx, ctx.params.pid);
    if (!canEdit(access)) throw forbidden('Only editors can see team progress');
    const members = all<Row>('SELECT u.id, u.name, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name', project.id);
    const paths = all<Row>("SELECT * FROM paths WHERE project_id = ? AND status = 'published' ORDER BY title", project.id);
    return {
      paths: paths.map((p) => ({ id: p.id, title: p.title, audience: p.audience })),
      members: members.map((m) => ({
        ...m,
        progress: Object.fromEntries(paths.map((p) => [p.id, pathView(p, m.id).progress])),
        quizzesPassed: one<{ n: number }>(
          'SELECT COUNT(DISTINCT quiz_id) AS n FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id WHERE a.user_id = ? AND q.project_id = ? AND a.total > 0 AND CAST(a.score AS REAL) / a.total >= ?',
          m.id,
          project.id,
          PASS,
        )!.n,
      })),
    };
  });

  // ---- Export everything that is published ----
  get('/api/projects/:pid/learn/export.zip', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const zip = new JSZip();
    const docs = all<Row>("SELECT * FROM learn_docs WHERE project_id = ? AND status = 'published' ORDER BY title", project.id);
    const quizzes = all<Row>("SELECT * FROM quizzes WHERE project_id = ? AND status = 'published' ORDER BY title", project.id);
    for (const d of docs) {
      zip.file(`docs/${d.slug}.html`, exportHtml(d.title, d.business_md, d.technical_md));
      zip.file(`docs/${d.slug}.business.md`, d.business_md);
      zip.file(`docs/${d.slug}.technical.md`, d.technical_md);
    }
    for (const q of quizzes) zip.file(`quizzes/${slugify(q.title)}.md`, quizMarkdown(q));
    zip.file(
      'index.html',
      `<!doctype html><meta charset="utf-8"><title>${escapeHtml(project.name)} learning</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}</style><h1>${escapeHtml(project.name)}</h1><h2>Documents</h2><ul>${docs
        .map((d) => `<li><a href="docs/${d.slug}.html">${escapeHtml(d.title)}</a></li>`)
        .join('')}</ul><h2>Quizzes</h2><ul>${quizzes.map((q) => `<li><a href="quizzes/${slugify(q.title)}.md">${escapeHtml(q.title)}</a></li>`).join('')}</ul>`,
    );
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return sendFile(ctx.res, buf, 'application/zip', `${project.slug}-learning.zip`);
  });
}

export { getProject, type Project };
