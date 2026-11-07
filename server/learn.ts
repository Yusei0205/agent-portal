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

import { getLearnRepository } from './repositories/learn.ts';
import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import type { Row } from './db.ts';
import { generateId, now, str, badRequest, notFound, parseJson } from './util.ts';
import type { SQLInputValue } from 'node:sqlite';
import { emit } from './events.ts';

import { getMemberRow, getProjectRow } from './project-access.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { getAuthRepository } from './repositories/auth.ts';
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

async function requireProjectAccess(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
  level: 'viewer' | 'editor' = 'viewer',
): Promise<Row | null> {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  // S1-TODO(projects): requireProjectAccess is a sync helper called from many sync route handlers
  // in learn.ts. Converting all callers to async in this batch would touch 20+ routes.
  // Leave on direct SQLite until the learn module gets its own async conversion pass.
  const project = await getProjectRow(projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (req.user.is_admin) return project;
  const member = await getMemberRow(projectId, req.user.id);
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

async function isEditorOf(req: PortalRequest, projectId: unknown): Promise<boolean> {
  if (req.user?.is_admin) return true;
  const role = await getProjectRepository().roleOf(S(projectId), req.user!.id);
  return role === 'editor' || role === 'owner';
}

function notifyLearn(projectId: string, detail: Record<string, unknown> = {}): void {
  try { emit(projectId, { type: 'learn.updated', ...detail }); } catch { /* non-fatal */ }
}

// ── Learn docs ────────────────────────────────────────────────────────────────

async function getLearnDoc(id: string): Promise<Row> {
  const r = (await getLearnRepository().getDocById(id)) as unknown as Row | null;
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

async function getQuiz(id: string): Promise<Row> {
  const r = (await getLearnRepository().getQuizById(id)) as unknown as Row | null;
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

async function stepDone(userId: string, s: Step): Promise<boolean> {
  if (s.type === 'doc') return getLearnRepository().isRead(s.id, userId);
  const best = await getLearnRepository().getBestAttemptScore(s.id, userId);
  return best != null && best.total > 0 && best.score / best.total >= PASS_RATE;
}

async function pathView(r: Row, userId: string): Promise<Record<string, unknown>> {
  const repo = getLearnRepository();
  const steps = await Promise.all(parseJson<Step[]>(S(r.steps ?? '[]'), []).map(async (s) => {
    let item: Record<string, unknown> | null = null;
    if (s.type === 'doc') {
      const d = await repo.getDocById(s.id);
      item = d ? { id: d.id, title: d.title, doc_type: d.kind, published: d.status === 'published' ? 1 : 0, stale: d.stale } : null;
    } else {
      const q = await repo.getQuizById(s.id);
      item = q ? { id: q.id, title: q.title, audience: q.audience, difficulty: q.difficulty, status: q.status, stale: q.stale } : null;
    }
    return { ...s, item, done: item ? await stepDone(userId, s) : false };
  }));
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
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const project = await requireProjectAccess(req, res, req.params.pid);
      if (!project) return;

      const editor = await isEditorOf(req, project.id);
      const rows = ((await getLearnRepository().listDocsByProject(S(project.id), !editor)) as unknown as Row[])
        .sort((x, y) => S(y.updated_at).localeCompare(S(x.updated_at)));
      sendJson(res, 200, { docs: rows.map(docView) });
    }),
  );

  router.post(
    '/api/projects/:pid/learn/docs',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const project = await requireProjectAccess(req, res, req.params.pid, 'editor');
      if (!project) return;

      const body = req.body as Record<string, unknown>;
      const title = str(body.title, 'Title', { max: 200 }).trim();
      const doc_type = pick(body.doc_type ?? 'overview', DOC_TYPES, 'Type');
      const audience = pick(body.audience ?? 'everyone', AUDIENCES, 'Audience');

      const id = generateId();
      // M3 schema: kind (not doc_type), slug required, status (not published boolean)
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      await getLearnRepository().createDoc({
        id,
        project_id: S(project.id),
        title,
        slug,
        kind: doc_type,
        focus: '',
        doc_ids: '[]',
        source_refs: '[]',
        source_hash: null,
        business_md: '',
        technical_md: '',
        glossary: '[]',
        status: 'draft',
        stale: 0,
        error: null,
        run_id: null,
        created_by: req.user!.id,
        created_at: now(),
        updated_at: now(),
        approved_by: null,
        published_at: null,
        audience,
      });
      notifyLearn(S(project.id), { id });
      sendJson(res, 201, { doc: docView(await getLearnDoc(id)) });
    }),
  );

  router.get(
    '/api/learn/docs/:id',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const d = await getLearnDoc(req.params.id);
      const project = await requireProjectAccess(req, res, S(d.project_id));
      if (!project) return;

      const editor = await isEditorOf(req, d.project_id);
      if (d.status !== 'published' && !editor) {
        sendJson(res, 404, { error: 'Document not found' });
        return;
      }

      const read = await getLearnRepository().isRead(S(d.id), req.user!.id);
      const quizzes = (await getLearnRepository().listQuizzesByDoc(S(d.id)))
        .map((q) => ({ id: q.id, title: q.title, audience: q.audience, difficulty: q.difficulty, status: q.status }));
      sendJson(res, 200, { doc: { ...docView(d), read }, quizzes });
    }),
  );

  router.patch(
    '/api/learn/docs/:id',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const d = await getLearnDoc(req.params.id);
      const project = await requireProjectAccess(req, res, S(d.project_id), 'editor');
      if (!project) return;

      const body = req.body as Record<string, unknown>;
      const patch: Record<string, SQLInputValue | boolean | undefined> = { updated_at: now() };
      if (body.title !== undefined) patch.title = str(body.title, 'Title', { max: 200 }).trim();
      if (body.content !== undefined) patch.content = str(body.content, 'Content', { max: 500_000, optional: true }) || null;
      if (body.audience !== undefined) patch.audience = pick(body.audience, AUDIENCES, 'Audience');
      await getLearnRepository().updateDoc(S(d.id), patch as never);
      notifyLearn(S(d.project_id), { id: d.id });
      sendJson(res, 200, { doc: docView(await getLearnDoc(S(d.id))) });
    }),
  );

  router.delete(
    '/api/learn/docs/:id',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const d = await getLearnDoc(req.params.id);
      await requireProjectAccess(req, res, S(d.project_id), 'editor');
      await getLearnRepository().deleteDoc(S(d.id));
      notifyLearn(S(d.project_id), { id: d.id });
      sendJson(res, 200, { ok: true });
    }),
  );

  router.post(
    '/api/learn/docs/:id/publish',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const d = await getLearnDoc(req.params.id);
      await requireProjectAccess(req, res, S(d.project_id), 'editor');
      await getLearnRepository().updateDoc(S(d.id), { status: 'published', published_at: now(), updated_at: now() });
      notifyLearn(S(d.project_id), { id: d.id });
      sendJson(res, 200, { doc: docView(await getLearnDoc(S(d.id))) });
    }),
  );

  router.post(
    '/api/learn/docs/:id/unpublish',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const d = await getLearnDoc(req.params.id);
      await requireProjectAccess(req, res, S(d.project_id), 'editor');
      await getLearnRepository().updateDoc(S(d.id), { status: 'draft', updated_at: now() });
      notifyLearn(S(d.project_id), { id: d.id });
      sendJson(res, 200, { ok: true });
    }),
  );

  router.post(
    '/api/learn/docs/:id/read',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const d = await getLearnDoc(req.params.id);
      await requireProjectAccess(req, res, S(d.project_id));
      await getLearnRepository().markRead(S(d.id), req.user!.id, now());
      sendJson(res, 200, { ok: true });
    }),
  );

  // ── Quizzes ─────────────────────────────────────────────────────────────────

  router.get(
    '/api/projects/:pid/learn/quizzes',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const project = await requireProjectAccess(req, res, req.params.pid);
      if (!project) return;

      const editor = await isEditorOf(req, project.id);
      const rows = ((await getLearnRepository().listQuizzesByProject(S(project.id), !editor)) as unknown as Row[])
        .sort((x, y) => S(y.updated_at).localeCompare(S(x.updated_at)));
      sendJson(res, 200, { quizzes: rows.map((r) => quizView(r)) });
    }),
  );

  router.post(
    '/api/projects/:pid/learn/quizzes',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const project = await requireProjectAccess(req, res, req.params.pid, 'editor');
      if (!project) return;

      const body = req.body as Record<string, unknown>;
      const title = str(body.title, 'Title', { max: 200 }).trim();
      const audience = pick(body.audience ?? 'everyone', AUDIENCES, 'Audience');
      const learnDocId = body.learnDocId ? String(body.learnDocId) : null;

      if (learnDocId) {
        const doc = await getLearnRepository().getDocById(learnDocId);
        if (!doc || doc.project_id !== S(project.id)) {
          sendJson(res, 400, { error: 'That document is not in this project' });
          return;
        }
      }

      const id = generateId();
      await getLearnRepository().createQuiz({
        id,
        project_id: S(project.id),
        learn_doc_id: learnDocId,
        title,
        audience,
        difficulty: String(body.difficulty ?? 'medium'),
        doc_ids: '[]',
        source_refs: '[]',
        source_hash: null,
        questions: '[]',
        dropped: 0,
        status: 'draft',
        stale: 0,
        error: null,
        run_id: null,
        created_by: req.user!.id,
        created_at: now(),
        updated_at: now(),
        approved_by: null,
        published_at: null,
      });
      notifyLearn(S(project.id), { id });
      sendJson(res, 201, { quiz: quizView(await getQuiz(id)) });
    }),
  );

  router.get(
    '/api/learn/quizzes/:id',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const q = await getQuiz(req.params.id);
      const project = await requireProjectAccess(req, res, S(q.project_id));
      if (!project) return;

      const editor = await isEditorOf(req, q.project_id);
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
      const q = await getQuiz(req.params.id);
      await requireProjectAccess(req, res, S(q.project_id), 'editor');

      const body = req.body as Record<string, unknown>;
      const patch: Record<string, SQLInputValue | boolean | undefined> = { updated_at: now() };
      if (body.title !== undefined) patch.title = str(body.title, 'Title', { max: 200 }).trim();
      await getLearnRepository().updateQuiz(S(q.id), patch as never);
      notifyLearn(S(q.project_id), { id: q.id });
      sendJson(res, 200, { quiz: quizView(await getQuiz(S(q.id)), true) });
    }),
  );

  router.delete(
    '/api/learn/quizzes/:id',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const q = await getQuiz(req.params.id);
      await requireProjectAccess(req, res, S(q.project_id), 'editor');
      await getLearnRepository().deleteQuiz(S(q.id));
      notifyLearn(S(q.project_id), { id: q.id });
      sendJson(res, 200, { ok: true });
    }),
  );

  router.post(
    '/api/learn/quizzes/:id/publish',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const q = await getQuiz(req.params.id);
      await requireProjectAccess(req, res, S(q.project_id), 'editor');
      await getLearnRepository().updateQuiz(S(q.id), { status: 'published', published_at: now(), updated_at: now() });
      notifyLearn(S(q.project_id), { id: q.id });
      sendJson(res, 200, { ok: true });
    }),
  );

  router.post(
    '/api/learn/quizzes/:id/unpublish',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const q = await getQuiz(req.params.id);
      await requireProjectAccess(req, res, S(q.project_id), 'editor');
      await getLearnRepository().updateQuiz(S(q.id), { status: 'draft', updated_at: now() });
      notifyLearn(S(q.project_id), { id: q.id });
      sendJson(res, 200, { ok: true });
    }),
  );

  /** POST /api/learn/quizzes/:id/attempts — submit a quiz attempt */
  router.post(
    '/api/learn/quizzes/:id/attempts',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const q = await getQuiz(req.params.id);
      const project = await requireProjectAccess(req, res, S(q.project_id));
      if (!project) return;

      const editor = await isEditorOf(req, q.project_id);
      if (q.status !== 'published' && !editor) {
        sendJson(res, 403, { error: 'This quiz is not published yet' });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const answers = (body.answers ?? {}) as Record<string, unknown>;
      const questions = parseJson<any[]>(S(q.questions_json ?? q.questions ?? '[]'), []);

      const results = questions.map((x: any) => ({
        id: x.id,
        given: String(answers[x.id] ?? ''),
        correct: gradeAnswer(x, answers[x.id]),
        answer: x.answer,
        explanation: x.explanation ?? '',
      }));

      const score = results.filter((r) => r.correct).length;
      const id = generateId();

      await getLearnRepository().createAttempt({
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
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const q = await getQuiz(req.params.id);
      const project = await requireProjectAccess(req, res, S(q.project_id));
      if (!project) return;

      const editor = await isEditorOf(req, q.project_id);
      const attempts = await getLearnRepository().listAttemptsByQuiz(S(q.id), editor ? undefined : req.user!.id);
      attempts.sort((x, y) => y.created_at.localeCompare(x.created_at));
      let rows: Array<Record<string, unknown>>;
      if (editor) {
        const users = await getAuthRepository().getUsersByIds([...new Set(attempts.map((a) => a.user_id))]);
        const nameById = new Map(users.map((u) => [u.id, u.name]));
        rows = attempts.slice(0, 200).map((a) => ({ id: a.id, score: a.score, total: a.total, completed_at: a.created_at, name: nameById.get(a.user_id) ?? '' }));
      } else {
        rows = attempts.map((a) => ({ id: a.id, score: a.score, total: a.total, completed_at: a.created_at }));
      }
      sendJson(res, 200, { attempts: rows });
    }),
  );

  // ── Learning paths ──────────────────────────────────────────────────────────

  router.get(
    '/api/projects/:pid/learn/paths',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const project = await requireProjectAccess(req, res, req.params.pid);
      if (!project) return;

      const editor = await isEditorOf(req, project.id);
      const rows = ((await getLearnRepository().listPathsByProject(S(project.id))) as unknown as Row[])
        .filter((r) => editor || r.status === 'published')
        .sort((x, y) => S(x.title).localeCompare(S(y.title)));
      sendJson(res, 200, { paths: await Promise.all(rows.map((r) => pathView(r, req.user!.id))) });
    }),
  );

  router.post(
    '/api/projects/:pid/learn/paths',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const project = await requireProjectAccess(req, res, req.params.pid, 'editor');
      if (!project) return;

      const body = req.body as Record<string, unknown>;
      const title = str(body.title, 'Title', { max: 200 }).trim();
      const audience = pick(body.audience ?? 'everyone', AUDIENCES, 'Audience');
      const id = generateId();
      await getLearnRepository().createPath({
        id,
        project_id: S(project.id),
        title,
        audience,
        description: str(body.description, 'Description', { max: 2000, optional: true }) || '',
        steps: JSON.stringify(Array.isArray(body.steps) ? body.steps : []),
        status: body.publish ? 'published' : 'draft',
        created_by: req.user!.id,
        created_at: now(),
        updated_at: now(),
      });
      notifyLearn(S(project.id), { id });
      const r = ((await getLearnRepository().getPathById(id)) as unknown as Row);
      sendJson(res, 201, { path: await pathView(r, req.user!.id) });
    }),
  );

  router.patch(
    '/api/learn/paths/:id',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const r = ((await getLearnRepository().getPathById(req.params.id)) as unknown as Row | null);
      if (!r) { sendJson(res, 404, { error: 'Path not found' }); return; }
      await requireProjectAccess(req, res, S(r.project_id), 'editor');

      const body = req.body as Record<string, unknown>;
      const patch: Record<string, SQLInputValue | boolean | undefined> = { updated_at: now() };
      if (body.title !== undefined) patch.title = str(body.title, 'Title', { max: 200 }).trim();
      if (body.description !== undefined) patch.description = str(body.description, 'Description', { max: 2000, optional: true }) || null;
      if (body.audience !== undefined) patch.audience = pick(body.audience, AUDIENCES, 'Audience');
      if (body.steps !== undefined) patch.steps = JSON.stringify(Array.isArray(body.steps) ? body.steps : []);
      if (body.status !== undefined) patch.status = body.status === 'published' ? 'published' : 'draft';
      await getLearnRepository().updatePath(S(r.id), patch as never);
      notifyLearn(S(r.project_id), { id: r.id });
      const updated = ((await getLearnRepository().getPathById(S(r.id))) as unknown as Row);
      sendJson(res, 200, { path: await pathView(updated, req.user!.id) });
    }),
  );

  router.delete(
    '/api/learn/paths/:id',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const r = ((await getLearnRepository().getPathById(req.params.id)) as unknown as Row | null);
      if (!r) { sendJson(res, 404, { error: 'Path not found' }); return; }
      await requireProjectAccess(req, res, S(r.project_id), 'editor');
      await getLearnRepository().deletePath(S(r.id));
      notifyLearn(S(r.project_id), { id: r.id });
      sendJson(res, 200, { ok: true });
    }),
  );

  /** GET /api/projects/:pid/learn/progress — team progress (editor+) */
  router.get(
    '/api/projects/:pid/learn/progress',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const project = await requireProjectAccess(req, res, req.params.pid, 'editor');
      if (!project) return;

      const memberRecords = await getProjectRepository().listMembers(S(project.id));
      const memberUsers = await getAuthRepository().getUsersByIds(memberRecords.map((m) => m.user_id));
      const nameById = new Map(memberUsers.map((u) => [u.id, u.name]));
      const members: Row[] = memberRecords
        .map((m) => ({ id: m.user_id, name: nameById.get(m.user_id) ?? '', role: m.role }) as Row)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const paths = ((await getLearnRepository().listPathsByProject(S(project.id))) as unknown as Row[])
        .filter((p) => p.status === 'published')
        .sort((x, y) => S(x.title).localeCompare(S(y.title)));
      const quizzes = await getLearnRepository().listQuizzesByProject(S(project.id));

      const memberRows = await Promise.all(members.map(async (m) => {
        const progress: Record<string, unknown> = {};
        for (const p of paths) progress[S(p.id)] = (await pathView(p, S(m.id))).progress;
        let quizzesPassed = 0;
        for (const q of quizzes) {
          const best = await getLearnRepository().getBestAttemptScore(q.id, S(m.id));
          if (best && best.total > 0 && best.score / best.total >= PASS_RATE) quizzesPassed += 1;
        }
        return { id: m.id, name: m.name, role: m.role, progress, quizzesPassed };
      }));

      sendJson(res, 200, {
        paths: paths.map((p) => ({ id: p.id, title: p.title, audience: p.audience })),
        members: memberRows,
      });
    }),
  );
}
