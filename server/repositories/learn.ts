/**
 * Repository interface for learn_docs, quizzes, quiz_attempts, paths, doc_reads.
 *
 * DynamoDB table: portal-learn (DYNAMODB_TABLE_PORTAL_LEARN, default 'portal-learn')
 *
 * Key design (all entities share one table):
 *   PK=LDOC#<id>  SK=#META     → learn_docs
 *   PK=QUIZ#<id>  SK=#META     → quizzes
 *   PK=QATT#<quizId>  SK=<userId>#<id>  → quiz_attempts
 *   PK=PATH#<id>  SK=#META     → paths
 *   PK=DREAD#<docId>  SK=<userId>  → doc_reads
 * GSI-LearnByProject:
 *   PK=learnProjectId  SK=<entityType>#<createdAt>#<id>
 */

import { SqliteLearnRepository } from './learn-sqlite.ts';
import { usesDynamoDb } from './backend.ts';
import type { SQLInputValue } from 'node:sqlite';

// ── Record types ──────────────────────────────────────────────────────────────

export interface LearnDocRecord {
  id: string;
  project_id: string;
  title: string;
  slug: string;
  kind: string;
  focus: string;
  doc_ids: string;
  source_refs: string;
  source_hash: string | null;
  business_md: string;
  technical_md: string;
  glossary: string;
  status: string;
  stale: number;
  error: string | null;
  run_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  approved_by: string | null;
  published_at: string | null;
  audience: string | null;
  content?: string | null;
}

export interface QuizRecord {
  id: string;
  project_id: string;
  title: string;
  audience: string;
  difficulty: string;
  learn_doc_id: string | null;
  doc_ids: string;
  source_refs: string;
  source_hash: string | null;
  questions: string;
  dropped: number;
  status: string;
  stale: number;
  error: string | null;
  run_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  approved_by: string | null;
  published_at: string | null;
}

export interface QuizAttemptRecord {
  id: string;
  quiz_id: string;
  user_id: string;
  answers: string;
  results: string;
  score: number;
  total: number;
  created_at: string;
}

export interface PathRecord {
  id: string;
  project_id: string;
  title: string;
  audience: string;
  description: string;
  steps: string;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocReadRecord {
  learn_doc_id: string;
  user_id: string;
  read_at: string;
}

// ── Repository interface ───────────────────────────────────────────────────────

export interface LearnRepository {
  // learn_docs
  createDoc(doc: LearnDocRecord): Promise<LearnDocRecord>;
  getDocById(id: string): Promise<LearnDocRecord | null>;
  listDocsByProject(projectId: string, publishedOnly?: boolean): Promise<LearnDocRecord[]>;
  updateDoc(id: string, fields: Partial<LearnDocRecord>): Promise<void>;
  deleteDoc(id: string): Promise<void>;

  // quizzes
  createQuiz(quiz: QuizRecord): Promise<QuizRecord>;
  getQuizById(id: string): Promise<QuizRecord | null>;
  listQuizzesByProject(projectId: string, publishedOnly?: boolean): Promise<QuizRecord[]>;
  listQuizzesByDoc(docId: string): Promise<QuizRecord[]>;
  updateQuiz(id: string, fields: Partial<QuizRecord>): Promise<void>;
  deleteQuiz(id: string): Promise<void>;

  // quiz_attempts
  createAttempt(attempt: QuizAttemptRecord): Promise<QuizAttemptRecord>;
  listAttemptsByQuiz(quizId: string, userId?: string): Promise<QuizAttemptRecord[]>;
  getBestAttemptScore(quizId: string, userId: string): Promise<{ score: number; total: number } | null>;

  // paths
  createPath(path: PathRecord): Promise<PathRecord>;
  getPathById(id: string): Promise<PathRecord | null>;
  listPathsByProject(projectId: string): Promise<PathRecord[]>;
  updatePath(id: string, fields: Partial<PathRecord>): Promise<void>;
  deletePath(id: string): Promise<void>;

  // doc_reads
  markRead(docId: string, userId: string, readAt: string): Promise<void>;
  isRead(docId: string, userId: string): Promise<boolean>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: LearnRepository | null = null;

export async function initLearnRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbLearnRepository } = await import('./learn-dynamodb.ts');
    _instance = new DynamoDbLearnRepository();
  } else {
    _instance = new SqliteLearnRepository();
  }
}

export function getLearnRepository(): LearnRepository {
  if (!_instance) _instance = new SqliteLearnRepository();
  return _instance;
}

export function setLearnRepository(repo: LearnRepository): void { _instance = repo; }
export function clearLearnRepository(): void { _instance = null; }
