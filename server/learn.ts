/**
 * Learn: learning docs, quizzes, onboarding paths.
 *
 * Routes:
 *   GET    /api/projects/:pid/learn/docs               — list docs
 *   POST   /api/projects/:pid/learn/docs               — create doc
 *   GET    /api/learn/docs/:id                         — get doc
 *   PATCH  /api/learn/docs/:id                         — update doc
 *   DELETE /api/learn/docs/:id                         — delete doc
 *   POST   /api/learn/docs/:id/publish                 — publish
 *   POST   /api/learn/docs/:id/unpublish               — unpublish
 *   POST   /api/learn/docs/:id/read                    — mark as read
 *
 *   GET    /api/projects/:pid/learn/quizzes             — list quizzes
 *   POST   /api/projects/:pid/learn/quizzes             — create quiz
 *   GET    /api/learn/quizzes/:id                       — get quiz
 *   PATCH  /api/learn/quizzes/:id                       — update quiz
 *   DELETE /api/learn/quizzes/:id                       — delete quiz
 *   POST   /api/learn/quizzes/:id/publish               — publish
 *   POST   /api/learn/quizzes/:id/unpublish             — unpublish
 *   POST   /api/learn/quizzes/:id/attempts              — submit attempt
 *   GET    /api/learn/quizzes/:id/attempts              — list attempts
 *
 *   GET    /api/projects/:pid/learn/paths               — list paths
 *   POST   /api/projects/:pid/learn/paths               — create path
 *   PATCH  /api/learn/paths/:id                         — update path
 *   DELETE /api/learn/paths/:id                         — delete path
 *
 *   GET    /api/projects/:pid/learn/progress            — team progress (editor+)
 */

import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, run as dbRun, insert, update } from './db.ts';
import type { Row } from './db.ts';
import { generateId, now, str, badRequest, notFound, parseJson } from './util.ts';
import type { SQLInputValue } from 'node:sqlite';
import { emit } from './events.ts';

// ── Type helpers ──────────────────────────────────────────────────────────────

/** Cast unknown Row value to string for use as DB parameter. */
const S = (v: unknown): string => String(v ?? '');
/** Cast unknown Row value to number. */
const N = (v: unknown): number => Number(v ?? 0);

// ── Constants ─────────────────────────────────────────────────────────────────

const DOC_TYPES = ['overview', 'feature-guide', 'glossary', 'faq'] as const;
const AUDIENCES = ['everyone', 'engineers'] as const;

function pick<T extends readonly string[]>(v: unknown, allowed: T, field: string): T[number] {
  if (!allowed.includes(v as string)) {
    throw badRequest(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return v as T[number];
}

// ── Access control ────────────────────────────────────────────────────────────

function requireProjectAccess(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
  level: 'viewer' | 'editor' = 'viewer',
): Row | null {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  // S1-TODO(projects): requireProjectAccess is a sync helper called from many sync route handlers
  // in learn.ts. Converting all callers to async in this batch would touch 20+ routes.
  // Leave on direct SQLite until the learn module gets its own async conversion pass.
  const project = one<Row>('SELECT * FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (req.user.is_admin) return project;
  const member = one<Row>(
    'SELECT * FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (level === 'editor' && !['editor', 'owner'].includes(S(member.role))) {
    sendJson(res, 403, { error: 'Editor access required' });
    return null;
  }
  return project;
}

function isEditorOf(req: PortalRequest, projectId: unknown): boolean {
  if (req.user?.is_admin) return true;
  // S1-TODO(projects): This membership check should use getProjectRepository().roleOf() once
  // isEditorOf is made async. Leave on direct SQLite until learn module is converted.
  return Boolean(
    one<Row>(
      "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND role IN ('editor','owner')",
      S(projectId), req.user!.id,
    ),
  );
}

function notifyLearn(projectId: string, detail: Record<string, unknown> = {}): void {
  try { emit(projectId, { type: 'learn.updated', ...detail }); } catch { /* non-fatal */ }
}

// ── Learn docs ────────────────────────────────────────────────────────────────

function getLearnDoc(id: string): Row {
  const r = one<Row>('SELECT * FROM learn_docs WHERE id = ?', id);
  if (!r) throw notFound('Document not found');
  return r;
}

function docView(r: Row): Record<string, unknown> {
  // M3 schema: kind=doc type, status=published/draft, no audience column
  return {
    id: r.id,
    project_id: r.project_id,
    // M3 uses "kind" for what spec calls "doc_type"
    doc_type: r.kind ?? r.doc_type ?? 'overview',
    kind: r.kind ?? r.doc_type ?? 'overview',
    audience: r.audience ?? 'everyone',
    title: r.title,
    // M3 has business_md/technical_md, expose as content for simplicity
    content: r.business_md ?? r.technical_md ?? r.content ?? null,
    business_md: r.business_md ?? null,
    technical_md: r.technical_md ?? null,
    // M3 uses status field; map 'published' → published=true
    published: r.status === 'published' || Boolean(r.published),
    status: r.status ?? 'draft',
    stale: Boolean(r.stale),
    error: r.error ?? null,
    run_id: r.run_id ?? null,
    created_by: r.created_by ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ── Quizzes ───────────────────────────────────────────────────────────────────

function getQuiz(id: string): Row {
  const r = one<Row>('SELECT * FROM quizzes WHERE id = ?', id);
  if (!r) throw notFound('Quiz not found');
  return r;
}

function quizView(r: Row, reveal = false): Record<string, unknown> {
  // M3 uses "questions" column; fall back gracefully
  const questions = parseJson<any[]>(S(r.questions ?? r.questions_json ?? '[]'), []);
  return {
    id: r.id,
    project_id: r.project_id,
    learn_doc_id: r.learn_doc_id ?? null,
    title: r.title,
    audience: r.audience,
    difficulty: r.difficulty,
    status: r.status,
    stale: Boolean(r.stale),
    error: r.error ?? null,
    dropped: r.dropped ?? 0,
    published_at: r.published_at ?? null,
    created_by: r.created_by ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    question_count: questions.length,
    questions: reveal
      ? questions
      : questions.map((q: any) => ({
          id: q.id,
          type: q.type,
          question: q.question,
          options: q.options ?? null,
        })),
  };
}

const PASS_RATE = 0.7;

function gradeAnswer(q: any, given: unknown): boolean {
  const g = String(given ?? '').trim();
  if (!g) return false;
  if (q.type !== 'short') return g.toLowerCase() === String(q.answer ?? '').trim().toLowerCase();
  const normWords = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const a = normWords(String(q.answer ?? ''));
  const b = new Set(normWords(g));
  if (!a.length) return false;
  return a.filter((w) => b.has(w)).length / a.length >= 0.6;
}

// ── Learning paths ────────────────────────────────────────────────────────────

interface Step { type: 'doc' | 'quiz'; id: string; }

function stepDone(userId: string, s: Step): boolean {
  if (s.type === 'doc') {
    return Boolean(one('SELECT 1 FROM doc_reads WHERE user_id = ? AND learn_doc_id = ?', userId, s.id));
  }
  const best = one<{ r: number }>(
    'SELECT MAX(CAST(score AS REAL) / total) AS r FROM quiz_attempts WHERE user_id = ? AND quiz_id = ? AND total > 0',
    userId, s.id,
  );
  return (best?.r ?? 0) >= PASS_RATE;
}

function pathView(r: Row, userId: string): Record<string, unknown> {
  const steps = parseJson<Step[]>(S(r.steps ?? '[]'), []).map((s) => {
    const item =
      s.type === 'doc'
        ? one('SELECT id, title, doc_type, published, stale FROM learn_docs WHERE id = ?', s.id)
        : one('SELECT id, title, audience, difficulty, status, stale FROM quizzes WHERE id = ?', s.id);
    return { ...s, item: item ?? null, done: item ? stepDone(userId, s) : false };
  });
  const live = steps.filter((s) => s.item);
  return {
    id: r.id,
    project_id: r.project_id,
    title: r.title,
    audience: r.audience,
    description: r.description ?? null,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    steps,
    progress: live.length ? Math.round((100 * live.filter((s) => s.done).length) / live.length) : 0,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerLearnRoutes(): void {
  // ── Learn Docs ──────────────────────────────────────────────────────────────

  router.get(
    '/api/projects/:pid/learn/docs',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const project = requireProjectAccess(req, res, req.params.pid);
      if (!project) return;

      const editor = isEditorOf(req, project.id);
      const rows = all<Row>(
        `SELECT l.*, u.name AS created_by_name,
                EXISTS(SELECT 1 FROM doc_reads r WHERE r.learn_doc_id = l.id AND r.user_id = ?) AS read_flag
         FROM learn_docs l
         LEFT JOIN users u ON u.id = l.created_by
         WHERE l.project_id = ? ${editor ? '' : "AND l.status = 'published'"}
         ORDER BY l.updated_at DESC`,
        req.user!.id,
        S(project.id),
      );
      sendJson(res, 200, { docs: rows.map(docView) });
    }),
  );

  router.post(
    '/api/projects/:pid/learn/docs',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const project = requireProjectAccess(req, res, req.params.pid, 'editor');
      if (!project) return;

      const body = req.body as Record<string, unknown>;
      const title = str(body.title, 'Title', { max: 200 }).trim();
      const doc_type = pick(body.doc_type ?? 'overview', DOC_TYPES, 'Type');
      const audience = pick(body.audience ?? 'everyone', AUDIENCES, 'Audience');

      const id = generateId();
      // M3 schema: kind (not doc_type), slug required, status (not published boolean)
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      insert('learn_docs', {
        id,
        project_id: S(project.id),
        title,
        slug,
        kind: doc_type,   // M3 column name
        focus: '',
        doc_ids: '[]',
        source_refs: '[]',
        business_md: '',
        technical_md: '',
        glossary: '[]',
        status: 'draft',
        stale: 0,
        created_by: req.user!.id,
        created_at: now(),
        updated_at: now(),
      });
      notifyLearn(S(project.id), { id });
      sendJson(res, 201, { doc: docView(getLearnDoc(id)) });
    }),
  );

  router.get(
    '/api/learn/docs/:id',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const d = getLearnDoc(req.params.id);
      const project = requireProjectAccess(req, res, S(d.project_id));
      if (!project) return;

      const editor = isEditorOf(req, d.project_id);
      if (d.status !== 'published' && !editor) {
        sendJson(res, 404, { error: 'Document not found' });
        return;
      }

      const read = Boolean(
        one('SELECT 1 FROM doc_reads WHERE user_id = ? AND learn_doc_id = ?', req.user!.id, S(d.id)),
      );
      const quizzes = all<Row>(
        'SELECT id, title, audience, difficulty, status FROM quizzes WHERE learn_doc_id = ?',
        S(d.id),
      );
      sendJson(res, 200, { doc: { ...docView(d), read }, quizzes });
    }),
  );

  router.patch(
    '/api/learn/docs/:id',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const d = getLearnDoc(req.params.id);
      const project = requireProjectAccess(req, res, S(d.project_id), 'editor');
      if (!project) return;

      const body = req.body as Record<string, unknown>;
      const patch: Record<string, SQLInputValue | boolean | undefined> = { updated_at: now() };
      if (body.title !== undefined) patch.title = str(body.title, 'Title', { max: 200 }).trim();
      if (body.content !== undefined) patch.content = str(body.content, 'Content', { max: 500_000, optional: true }) || null;
      if (body.audience !== undefined) patch.audience = pick(body.audience, AUDIENCES, 'Audience');
      update('learn_docs', S(d.id), patch);
      notifyLearn(S(d.project_id), { id: d.id });
      sendJson(res, 200, { doc: docView(getLearnDoc(S(d.id))) });
    }),
  );

  router.delete(
    '/api/learn/docs/:id',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const d = getLearnDoc(req.params.id);
      requireProjectAccess(req, res, S(d.project_id), 'editor');
      dbRun('DELETE FROM learn_docs WHERE id = ?', S(d.id));
      notifyLearn(S(d.project_id), { id: d.id });
      sendJson(res, 200, { ok: true });
    }),
  );

  router.post(
    '/api/learn/docs/:id/publish',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const d = getLearnDoc(req.params.id);
      requireProjectAccess(req, res, S(d.project_id), 'editor');
      update('learn_docs', S(d.id), { status: 'published', published_at: now(), updated_at: now() });
      notifyLearn(S(d.project_id), { id: d.id });
      sendJson(res, 200, { doc: docView(getLearnDoc(S(d.id))) });
    }),
  );

  router.post(
    '/api/learn/docs/:id/unpublish',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const d = getLearnDoc(req.params.id);
      requireProjectAccess(req, res, S(d.project_id), 'editor');
      update('learn_docs', S(d.id), { status: 'draft', updated_at: now() });
      notifyLearn(S(d.project_id), { id: d.id });
      sendJson(res, 200, { ok: true });
    }),
  );

  router.post(
    '/api/learn/docs/:id/read',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const d = getLearnDoc(req.params.id);
      requireProjectAccess(req, res, S(d.project_id));
      dbRun(
        'INSERT OR REPLACE INTO doc_reads (learn_doc_id, user_id, read_at) VALUES (?, ?, ?)',
        S(d.id), req.user!.id, now(),
      );
      sendJson(res, 200, { ok: true });
    }),
  );

  // ── Quizzes ─────────────────────────────────────────────────────────────────

  router.get(
    '/api/projects/:pid/learn/quizzes',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const project = requireProjectAccess(req, res, req.params.pid);
      if (!project) return;

      const editor = isEditorOf(req, project.id);
      const rows = all<Row>(
        `SELECT q.*,
                json_array_length(COALESCE(q.questions, q.questions_json, '[]')) AS question_count,
                (SELECT MAX(CAST(a.score AS REAL) / a.total) FROM quiz_attempts a
                 WHERE a.quiz_id = q.id AND a.user_id = ? AND a.total > 0) AS my_best
         FROM quizzes q
         WHERE q.project_id = ? ${editor ? '' : "AND q.status = 'published'"}
         ORDER BY q.updated_at DESC`,
        req.user!.id,
        S(project.id),
      );
      sendJson(res, 200, { quizzes: rows.map((r) => quizView(r)) });
    }),
  );

  router.post(
    '/api/projects/:pid/learn/quizzes',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const project = requireProjectAccess(req, res, req.params.pid, 'editor');
      if (!project) return;

      const body = req.body as Record<string, unknown>;
      const title = str(body.title, 'Title', { max: 200 }).trim();
      const audience = pick(body.audience ?? 'everyone', AUDIENCES, 'Audience');
      const learnDocId = body.learnDocId ? String(body.learnDocId) : null;

      if (learnDocId) {
        const doc = one('SELECT 1 FROM learn_docs WHERE id = ? AND project_id = ?', learnDocId, S(project.id));
        if (!doc) {
          sendJson(res, 400, { error: 'That document is not in this project' });
          return;
        }
      }

      const id = generateId();
      insert('quizzes', {
        id,
        project_id: S(project.id),
        learn_doc_id: learnDocId,
        title,
        audience,
        difficulty: String(body.difficulty ?? 'medium'),
        questions: '[]',  // M3 column name
        status: 'draft',
        stale: 0,
        dropped: 0,
        source_refs: '[]',
        created_by: req.user!.id,
        created_at: now(),
        updated_at: now(),
      });
      notifyLearn(S(project.id), { id });
      sendJson(res, 201, { quiz: quizView(getQuiz(id)) });
    }),
  );

  router.get(
    '/api/learn/quizzes/:id',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const q = getQuiz(req.params.id);
      const project = requireProjectAccess(req, res, S(q.project_id));
      if (!project) return;

      const editor = isEditorOf(req, q.project_id);
      if (q.status !== 'published' && !editor) {
        sendJson(res, 404, { error: 'Quiz not found' });
        return;
      }
      const reveal = editor && req.query.get('mode') !== 'take';
      sendJson(res, 200, { quiz: quizView(q, reveal) });
    }),
  );

  router.patch(
    '/api/learn/quizzes/:id',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const q = getQuiz(req.params.id);
      requireProjectAccess(req, res, S(q.project_id), 'editor');

      const body = req.body as Record<string, unknown>;
      const patch: Record<string, SQLInputValue | boolean | undefined> = { updated_at: now() };
      if (body.title !== undefined) patch.title = str(body.title, 'Title', { max: 200 }).trim();
      update('quizzes', S(q.id), patch);
      notifyLearn(S(q.project_id), { id: q.id });
      sendJson(res, 200, { quiz: quizView(getQuiz(S(q.id)), true) });
    }),
  );

  router.delete(
    '/api/learn/quizzes/:id',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const q = getQuiz(req.params.id);
      requireProjectAccess(req, res, S(q.project_id), 'editor');
      dbRun('DELETE FROM quizzes WHERE id = ?', S(q.id));
      notifyLearn(S(q.project_id), { id: q.id });
      sendJson(res, 200, { ok: true });
    }),
  );

  router.post(
    '/api/learn/quizzes/:id/publish',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const q = getQuiz(req.params.id);
      requireProjectAccess(req, res, S(q.project_id), 'editor');
      update('quizzes', S(q.id), { status: 'published', published_at: now(), updated_at: now() });
      notifyLearn(S(q.project_id), { id: q.id });
      sendJson(res, 200, { ok: true });
    }),
  );

  router.post(
    '/api/learn/quizzes/:id/unpublish',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const q = getQuiz(req.params.id);
      requireProjectAccess(req, res, S(q.project_id), 'editor');
      update('quizzes', S(q.id), { status: 'draft', updated_at: now() });
      notifyLearn(S(q.project_id), { id: q.id });
      sendJson(res, 200, { ok: true });
    }),
  );

  /** POST /api/learn/quizzes/:id/attempts — submit a quiz attempt */
  router.post(
    '/api/learn/quizzes/:id/attempts',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const q = getQuiz(req.params.id);
      const project = requireProjectAccess(req, res, S(q.project_id));
      if (!project) return;

      const editor = isEditorOf(req, q.project_id);
      if (q.status !== 'published' && !editor) {
        sendJson(res, 403, { error: 'This quiz is not published yet' });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const answers = (body.answers ?? {}) as Record<string, unknown>;
      const questions = parseJson<any[]>(S(q.questions_json ?? '[]'), []);

      const results = questions.map((x: any) => ({
        id: x.id,
        given: String(answers[x.id] ?? ''),
        correct: gradeAnswer(x, answers[x.id]),
        answer: x.answer,
        explanation: x.explanation ?? '',
      }));

      const score = results.filter((r) => r.correct).length;
      const id = generateId();

      insert('quiz_attempts', {
        id,
        quiz_id: S(q.id),
        user_id: req.user!.id,
        answers: JSON.stringify(answers),    // M3 column name
        results: JSON.stringify(results),    // M3 column name
        score,
        total: questions.length,
        created_at: now(),                   // M3 column name
      });

      const passed = questions.length > 0 && score / questions.length >= PASS_RATE;
      sendJson(res, 201, {
        attempt: { id, score, total: questions.length, passed, results },
      });
    }),
  );

  /** GET /api/learn/quizzes/:id/attempts — list attempts */
  router.get(
    '/api/learn/quizzes/:id/attempts',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const q = getQuiz(req.params.id);
      const project = requireProjectAccess(req, res, S(q.project_id));
      if (!project) return;

      const editor = isEditorOf(req, q.project_id);
      const rows = editor
        ? all<Row>(
            'SELECT a.id, a.score, a.total, a.created_at AS completed_at, u.name FROM quiz_attempts a JOIN users u ON u.id = a.user_id WHERE a.quiz_id = ? ORDER BY a.created_at DESC LIMIT 200',
            S(q.id),
          )
        : all<Row>(
            'SELECT id, score, total, created_at AS completed_at FROM quiz_attempts WHERE quiz_id = ? AND user_id = ? ORDER BY created_at DESC',
            S(q.id), req.user!.id,
          );
      sendJson(res, 200, { attempts: rows });
    }),
  );

  // ── Learning paths ──────────────────────────────────────────────────────────

  router.get(
    '/api/projects/:pid/learn/paths',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const project = requireProjectAccess(req, res, req.params.pid);
      if (!project) return;

      const editor = isEditorOf(req, project.id);
      const rows = all<Row>(
        `SELECT * FROM paths WHERE project_id = ? ${editor ? '' : "AND status = 'published'"} ORDER BY title`,
        S(project.id),
      );
      sendJson(res, 200, { paths: rows.map((r) => pathView(r, req.user!.id)) });
    }),
  );

  router.post(
    '/api/projects/:pid/learn/paths',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const project = requireProjectAccess(req, res, req.params.pid, 'editor');
      if (!project) return;

      const body = req.body as Record<string, unknown>;
      const title = str(body.title, 'Title', { max: 200 }).trim();
      const audience = pick(body.audience ?? 'everyone', AUDIENCES, 'Audience');
      const id = generateId();
      insert('paths', {
        id,
        project_id: S(project.id),
        title,
        audience,
        description: str(body.description, 'Description', { max: 2000, optional: true }) || null,
        steps: JSON.stringify(Array.isArray(body.steps) ? body.steps : []),
        status: body.publish ? 'published' : 'draft',
        created_by: req.user!.id,
        created_at: now(),
        updated_at: now(),
      });
      notifyLearn(S(project.id), { id });
      const r = one<Row>('SELECT * FROM paths WHERE id = ?', id)!;
      sendJson(res, 201, { path: pathView(r, req.user!.id) });
    }),
  );

  router.patch(
    '/api/learn/paths/:id',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const r = one<Row>('SELECT * FROM paths WHERE id = ?', req.params.id);
      if (!r) { sendJson(res, 404, { error: 'Path not found' }); return; }
      requireProjectAccess(req, res, S(r.project_id), 'editor');

      const body = req.body as Record<string, unknown>;
      const patch: Record<string, SQLInputValue | boolean | undefined> = { updated_at: now() };
      if (body.title !== undefined) patch.title = str(body.title, 'Title', { max: 200 }).trim();
      if (body.description !== undefined) patch.description = str(body.description, 'Description', { max: 2000, optional: true }) || null;
      if (body.audience !== undefined) patch.audience = pick(body.audience, AUDIENCES, 'Audience');
      if (body.steps !== undefined) patch.steps = JSON.stringify(Array.isArray(body.steps) ? body.steps : []);
      if (body.status !== undefined) patch.status = body.status === 'published' ? 'published' : 'draft';
      update('paths', S(r.id), patch);
      notifyLearn(S(r.project_id), { id: r.id });
      const updated = one<Row>('SELECT * FROM paths WHERE id = ?', S(r.id))!;
      sendJson(res, 200, { path: pathView(updated, req.user!.id) });
    }),
  );

  router.delete(
    '/api/learn/paths/:id',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const r = one<Row>('SELECT * FROM paths WHERE id = ?', req.params.id);
      if (!r) { sendJson(res, 404, { error: 'Path not found' }); return; }
      requireProjectAccess(req, res, S(r.project_id), 'editor');
      dbRun('DELETE FROM paths WHERE id = ?', S(r.id));
      notifyLearn(S(r.project_id), { id: r.id });
      sendJson(res, 200, { ok: true });
    }),
  );

  /** GET /api/projects/:pid/learn/progress — team progress (editor+) */
  router.get(
    '/api/projects/:pid/learn/progress',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const project = requireProjectAccess(req, res, req.params.pid, 'editor');
      if (!project) return;

      const members = all<Row>(
        'SELECT u.id, u.name, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name',
        S(project.id),
      );
      const paths = all<Row>(
        "SELECT * FROM paths WHERE project_id = ? AND status = 'published' ORDER BY title",
        S(project.id),
      );

      sendJson(res, 200, {
        paths: paths.map((p) => ({ id: p.id, title: p.title, audience: p.audience })),
        members: members.map((m) => ({
          id: m.id,
          name: m.name,
          role: m.role,
          progress: Object.fromEntries(
            paths.map((p) => [S(p.id), pathView(p, S(m.id)).progress]),
          ),
          quizzesPassed: N(
            one<{ n: number }>(
              'SELECT COUNT(DISTINCT quiz_id) AS n FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id WHERE a.user_id = ? AND q.project_id = ? AND a.total > 0 AND CAST(a.score AS REAL) / a.total >= ?',
              S(m.id), S(project.id), PASS_RATE,
            )?.n,
          ),
        })),
      });
    }),
  );
}
