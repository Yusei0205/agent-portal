/**
 * SQLite implementation of LearnRepository.
 */

import { one, all, run as dbRun, insert, update } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  LearnRepository,
  LearnDocRecord,
  QuizRecord,
  QuizAttemptRecord,
  PathRecord,
  DocReadRecord,
} from './learn.ts';

const S = (v: unknown): string => String(v ?? '');
const N = (v: unknown): number => Number(v ?? 0);

function toDoc(row: Row): LearnDocRecord {
  return {
    id:           S(row.id),
    project_id:   S(row.project_id),
    title:        S(row.title ?? ''),
    slug:         S(row.slug ?? ''),
    kind:         S(row.kind ?? row.doc_type ?? 'overview'),
    focus:        S(row.focus ?? ''),
    doc_ids:      S(row.doc_ids ?? '[]'),
    source_refs:  S(row.source_refs ?? '[]'),
    source_hash:  row.source_hash != null ? S(row.source_hash) : null,
    business_md:  S(row.business_md ?? ''),
    technical_md: S(row.technical_md ?? ''),
    glossary:     S(row.glossary ?? '[]'),
    status:       S(row.status ?? 'draft'),
    stale:        N(row.stale),
    error:        row.error != null ? S(row.error) : null,
    run_id:       row.run_id != null ? S(row.run_id) : null,
    created_by:   row.created_by != null ? S(row.created_by) : null,
    created_at:   S(row.created_at ?? ''),
    updated_at:   S(row.updated_at ?? ''),
    approved_by:  row.approved_by != null ? S(row.approved_by) : null,
    published_at: row.published_at != null ? S(row.published_at) : null,
    audience:     row.audience != null ? S(row.audience) : null,
  };
}

function toQuiz(row: Row): QuizRecord {
  return {
    id:           S(row.id),
    project_id:   S(row.project_id),
    title:        S(row.title ?? ''),
    audience:     S(row.audience ?? 'everyone'),
    difficulty:   S(row.difficulty ?? 'medium'),
    learn_doc_id: row.learn_doc_id != null ? S(row.learn_doc_id) : null,
    doc_ids:      S(row.doc_ids ?? '[]'),
    source_refs:  S(row.source_refs ?? '[]'),
    source_hash:  row.source_hash != null ? S(row.source_hash) : null,
    questions:    S(row.questions ?? '[]'),
    dropped:      N(row.dropped),
    status:       S(row.status ?? 'draft'),
    stale:        N(row.stale),
    error:        row.error != null ? S(row.error) : null,
    run_id:       row.run_id != null ? S(row.run_id) : null,
    created_by:   row.created_by != null ? S(row.created_by) : null,
    created_at:   S(row.created_at ?? ''),
    updated_at:   S(row.updated_at ?? ''),
    approved_by:  row.approved_by != null ? S(row.approved_by) : null,
    published_at: row.published_at != null ? S(row.published_at) : null,
  };
}

function toAttempt(row: Row): QuizAttemptRecord {
  return {
    id:         S(row.id),
    quiz_id:    S(row.quiz_id),
    user_id:    S(row.user_id),
    answers:    S(row.answers ?? '[]'),
    results:    S(row.results ?? '[]'),
    score:      N(row.score),
    total:      N(row.total),
    created_at: S(row.created_at ?? ''),
  };
}

function toPath(row: Row): PathRecord {
  return {
    id:          S(row.id),
    project_id:  S(row.project_id),
    title:       S(row.title ?? ''),
    audience:    S(row.audience ?? 'everyone'),
    description: S(row.description ?? ''),
    steps:       S(row.steps ?? '[]'),
    status:      S(row.status ?? 'draft'),
    created_by:  row.created_by != null ? S(row.created_by) : null,
    created_at:  S(row.created_at ?? ''),
    updated_at:  S(row.updated_at ?? ''),
  };
}

export class SqliteLearnRepository implements LearnRepository {
  // learn_docs
  async createDoc(doc: LearnDocRecord): Promise<LearnDocRecord> {
    insert('learn_docs', {
      id: doc.id, project_id: doc.project_id, title: doc.title, slug: doc.slug,
      kind: doc.kind, focus: doc.focus, doc_ids: doc.doc_ids, source_refs: doc.source_refs,
      source_hash: doc.source_hash, business_md: doc.business_md, technical_md: doc.technical_md,
      glossary: doc.glossary, status: doc.status, stale: doc.stale, error: doc.error,
      run_id: doc.run_id, created_by: doc.created_by, created_at: doc.created_at,
      updated_at: doc.updated_at, approved_by: doc.approved_by, published_at: doc.published_at,
    });
    return toDoc(one<Row>('SELECT * FROM learn_docs WHERE id = ?', doc.id)!);
  }

  async getDocById(id: string): Promise<LearnDocRecord | null> {
    const row = one<Row>('SELECT * FROM learn_docs WHERE id = ?', id);
    return row ? toDoc(row) : null;
  }

  async listDocsByProject(projectId: string, publishedOnly = false): Promise<LearnDocRecord[]> {
    const rows = publishedOnly
      ? all<Row>("SELECT * FROM learn_docs WHERE project_id = ? AND status = 'published' ORDER BY updated_at DESC", projectId)
      : all<Row>('SELECT * FROM learn_docs WHERE project_id = ? ORDER BY updated_at DESC', projectId);
    return rows.map(toDoc);
  }

  async updateDoc(id: string, fields: Partial<LearnDocRecord>): Promise<void> {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f[k] = v;
    update('learn_docs', id, f);
  }

  async deleteDoc(id: string): Promise<void> {
    dbRun('DELETE FROM learn_docs WHERE id = ?', id);
  }

  // quizzes
  async createQuiz(quiz: QuizRecord): Promise<QuizRecord> {
    insert('quizzes', {
      id: quiz.id, project_id: quiz.project_id, title: quiz.title, audience: quiz.audience,
      difficulty: quiz.difficulty, learn_doc_id: quiz.learn_doc_id, doc_ids: quiz.doc_ids,
      source_refs: quiz.source_refs, source_hash: quiz.source_hash, questions: quiz.questions,
      dropped: quiz.dropped, status: quiz.status, stale: quiz.stale, error: quiz.error,
      run_id: quiz.run_id, created_by: quiz.created_by, created_at: quiz.created_at,
      updated_at: quiz.updated_at, approved_by: quiz.approved_by, published_at: quiz.published_at,
    });
    return toQuiz(one<Row>('SELECT * FROM quizzes WHERE id = ?', quiz.id)!);
  }

  async getQuizById(id: string): Promise<QuizRecord | null> {
    const row = one<Row>('SELECT * FROM quizzes WHERE id = ?', id);
    return row ? toQuiz(row) : null;
  }

  async listQuizzesByProject(projectId: string, publishedOnly = false): Promise<QuizRecord[]> {
    const rows = publishedOnly
      ? all<Row>("SELECT * FROM quizzes WHERE project_id = ? AND status = 'published' ORDER BY updated_at DESC", projectId)
      : all<Row>('SELECT * FROM quizzes WHERE project_id = ? ORDER BY updated_at DESC', projectId);
    return rows.map(toQuiz);
  }

  async listQuizzesByDoc(docId: string): Promise<QuizRecord[]> {
    const rows = all<Row>('SELECT id, title, audience, difficulty, status FROM quizzes WHERE learn_doc_id = ?', docId);
    return rows.map(toQuiz);
  }

  async updateQuiz(id: string, fields: Partial<QuizRecord>): Promise<void> {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f[k] = v;
    update('quizzes', id, f);
  }

  async deleteQuiz(id: string): Promise<void> {
    dbRun('DELETE FROM quizzes WHERE id = ?', id);
  }

  // quiz_attempts
  async createAttempt(attempt: QuizAttemptRecord): Promise<QuizAttemptRecord> {
    insert('quiz_attempts', {
      id: attempt.id, quiz_id: attempt.quiz_id, user_id: attempt.user_id,
      answers: attempt.answers, results: attempt.results, score: attempt.score,
      total: attempt.total, created_at: attempt.created_at,
    });
    return toAttempt(one<Row>('SELECT * FROM quiz_attempts WHERE id = ?', attempt.id)!);
  }

  async listAttemptsByQuiz(quizId: string, userId?: string): Promise<QuizAttemptRecord[]> {
    const rows = userId
      ? all<Row>('SELECT * FROM quiz_attempts WHERE quiz_id = ? AND user_id = ? ORDER BY created_at DESC', quizId, userId)
      : all<Row>('SELECT * FROM quiz_attempts WHERE quiz_id = ? ORDER BY created_at DESC', quizId);
    return rows.map(toAttempt);
  }

  async getBestAttemptScore(quizId: string, userId: string): Promise<{ score: number; total: number } | null> {
    const row = one<{ r: number | null }>(`
      SELECT MAX(CAST(score AS REAL) / total) AS r
      FROM quiz_attempts
      WHERE user_id = ? AND quiz_id = ? AND total > 0
    `, userId, quizId);
    if (!row?.r) return null;
    const best = one<{ score: number; total: number }>(`
      SELECT score, total FROM quiz_attempts
      WHERE user_id = ? AND quiz_id = ? AND total > 0
      ORDER BY CAST(score AS REAL) / total DESC LIMIT 1
    `, userId, quizId);
    return best ?? null;
  }

  // paths
  async createPath(path: PathRecord): Promise<PathRecord> {
    insert('paths', {
      id: path.id, project_id: path.project_id, title: path.title, audience: path.audience,
      description: path.description, steps: path.steps, status: path.status,
      created_by: path.created_by, created_at: path.created_at, updated_at: path.updated_at,
    });
    return toPath(one<Row>('SELECT * FROM paths WHERE id = ?', path.id)!);
  }

  async getPathById(id: string): Promise<PathRecord | null> {
    const row = one<Row>('SELECT * FROM paths WHERE id = ?', id);
    return row ? toPath(row) : null;
  }

  async listPathsByProject(projectId: string): Promise<PathRecord[]> {
    const rows = all<Row>('SELECT * FROM paths WHERE project_id = ? ORDER BY updated_at DESC', projectId);
    return rows.map(toPath);
  }

  async updatePath(id: string, fields: Partial<PathRecord>): Promise<void> {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f[k] = v;
    update('paths', id, f);
  }

  async deletePath(id: string): Promise<void> {
    dbRun('DELETE FROM paths WHERE id = ?', id);
  }

  // doc_reads
  async markRead(docId: string, userId: string, readAt: string): Promise<void> {
    dbRun('INSERT OR REPLACE INTO doc_reads (learn_doc_id, user_id, read_at) VALUES (?, ?, ?)', docId, userId, readAt);
  }

  async isRead(docId: string, userId: string): Promise<boolean> {
    return Boolean(one('SELECT 1 FROM doc_reads WHERE user_id = ? AND learn_doc_id = ?', userId, docId));
  }
}
