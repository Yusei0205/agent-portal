/**
 * Repository interface for knowledge_docs, knowledge_search (FTS5), and knowledge_decisions.
 *
 * Access patterns K1–K5 from the data design doc.
 *
 * SQLite is the default backend. DynamoDB is activated by USE_DYNAMODB=true.
 *
 * DynamoDB tables used:
 *   portal-content  — knowledge_docs (PK=PROJECT#<pid> SK=KDOC#<id>) and decisions
 *   portal-search   — inverted keyword index (see knowledge-dynamodb.ts for full design)
 *
 * Search design (DynamoDB mode):
 *   Term postings:  PK=TERM#<projectId>#<normalizedToken>  SK=DOC#<docId>
 *   Doc term sets:  PK=DOCTERMS#<docId>                    SK=#TERMS  (StringSet attribute)
 *
 *   On index:   tokenize content → write postings + update DOCTERMS item
 *   On update:  atomically increment docVersion → delete stale postings → write new
 *   On delete:  fetch DOCTERMS → batch-delete all posting items → delete doc
 *   On search:  for each query token, Query postings; aggregate by docId; BatchGet metadata
 *
 * Ranking (DynamoDB mode):
 *   Primary  — count of distinct matched query terms per doc (higher = better)
 *   Secondary — sum of matchCount (TF proxy) across matched postings
 *
 *   This is simpler than FTS5's BM25 but gives reasonable ordering for short corpora
 *   (< 1 000 documents per project, typical portal usage). FTS5 mode is unchanged.
 *
 * Large-text handling:
 *   Only the first MAX_INDEX_BYTES (100 KB) of document content is indexed for search.
 *   The full markdown is stored on disk under knowledge_docs.markdown_path as today.
 *   Documents exceeding MAX_INDEX_BYTES are indexed on their first 100 KB with a marker.
 *   S3 key seam: the `contentS3Key` attribute on a knowledge_docs item will hold the S3
 *   key when the S3 phase is enabled; the repository transparently resolves it on read.
 *   In S1 contentS3Key is never set.
 *
 * Concurrent-edit safety:
 *   knowledge_docs items carry a `docVersion` attribute (Number, starts at 0).
 *   indexDoc atomically increments docVersion via UpdateItem ADD, then uses the new
 *   version when writing postings. Stale postings from an older update are skipped on
 *   search and lazily removed by repairDocPostings().
 */

import { SqliteKnowledgeRepository } from './knowledge-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum bytes of content to index per document (S1 limit). */
export const MAX_INDEX_BYTES = 100 * 1024;

/** Maximum number of terms to index per document (after dedup). */
export const MAX_INDEX_TERMS = 3_000;

/** Maximum query terms processed per search (bounded read). */
export const MAX_QUERY_TERMS = 10;

/** Maximum postings read per term per search (bounded read). */
export const MAX_POSTINGS_PER_TERM = 100;

// ── Record types ─────────────────────────────────────────────────────────────

export interface KnowledgeDocRecord {
  id: string;
  project_id: string;
  name: string;
  original_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  markdown_path: string | null;
  status: 'processing' | 'ready' | 'error';
  error: string | null;
  uploaded_by: string | null;
  created_at: string;
  /** Monotonically increasing version; 0 = never indexed. DynamoDB only; always 0 in SQLite. */
  docVersion: number;
}

export interface KnowledgeDecisionRecord {
  id: string;
  project_id: string;
  question: string;
  answer: string;
  asked_by: string | null;
  answered_by: string | null;
  created_at: string;
}

export interface SearchResult {
  docId: string;
  name: string;
  snippet: string;
}

// ── Input types ──────────────────────────────────────────────────────────────

export interface CreateKnowledgeDocInput {
  id: string;
  project_id: string;
  name: string;
  original_name: string;
  mime_type: string | null;
  size_bytes: number;
  status: 'processing' | 'ready' | 'error';
  uploaded_by: string | null;
  created_at: string;
}

export interface UpdateDocPatch {
  status?: 'processing' | 'ready' | 'error';
  markdown_path?: string | null;
  error?: string | null;
  name?: string;
}

export interface CreateDecisionInput {
  id: string;
  project_id: string;
  question: string;
  answer: string;
  asked_by: string | null;
  answered_by: string | null;
  created_at: string;
}

// ── Repository interface ─────────────────────────────────────────────────────

export interface KnowledgeRepository {
  // ── Docs ─────────────────────────────────────────────────────────────────

  /** K1: List all docs for a project, newest first. */
  listDocs(projectId: string): Promise<KnowledgeDocRecord[]>;

  /** K5: Get a single doc by ID. Returns null if not found. */
  getDocById(id: string): Promise<KnowledgeDocRecord | null>;

  /** Create a new doc record (status=processing). */
  createDoc(input: CreateKnowledgeDocInput): Promise<KnowledgeDocRecord>;

  /**
   * Patch doc fields (status, markdown_path, error, name).
   * Does not touch the search index — call indexDoc() separately.
   */
  updateDoc(id: string, patch: UpdateDocPatch): Promise<void>;

  /**
   * Delete a doc and remove all its search postings.
   * Idempotent: silent no-op if the doc does not exist.
   */
  deleteDoc(id: string): Promise<void>;

  // ── Search index ──────────────────────────────────────────────────────────

  /**
   * Replace the search index for a document with content derived from `text`.
   *
   * SQLite: deletes all knowledge_search rows for docId, re-inserts chunked rows.
   * DynamoDB: atomically increments docVersion on the knowledge_docs item,
   *   deletes old postings (via DOCTERMS helper item), writes new postings.
   *
   * `text` is the full markdown content; only MAX_INDEX_BYTES is actually indexed.
   * `projectId` is needed by DynamoDB to build the partition key.
   */
  indexDoc(docId: string, projectId: string, text: string): Promise<void>;

  /**
   * Remove all search postings for a document without deleting the doc record.
   * Used during delete (called automatically by deleteDoc) and for manual repair.
   */
  removeDocIndex(docId: string): Promise<void>;

  /**
   * K2/K3: Full-text search within a project.
   * SQLite: FTS5 MATCH with rank ordering.
   * DynamoDB: keyword inverted index — see module-level search design above.
   * Returns at most `limit` results.
   */
  searchDocs(projectId: string, query: string, limit: number): Promise<SearchResult[]>;

  // ── Decisions ─────────────────────────────────────────────────────────────

  /** K4: List all decisions for a project, newest first. */
  listDecisions(projectId: string): Promise<KnowledgeDecisionRecord[]>;

  /** Create a new decision record. */
  createDecision(input: CreateDecisionInput): Promise<KnowledgeDecisionRecord>;
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: KnowledgeRepository | null = null;

export async function initKnowledgeRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbKnowledgeRepository } = await import('./knowledge-dynamodb.ts');
    _instance = new DynamoDbKnowledgeRepository();
  } else {
    _instance = new SqliteKnowledgeRepository();
  }
}

export function getKnowledgeRepository(): KnowledgeRepository {
  if (!_instance) _instance = new SqliteKnowledgeRepository();
  return _instance;
}

export function setKnowledgeRepository(repo: KnowledgeRepository): void { _instance = repo; }
export function clearKnowledgeRepository(): void { _instance = null; }
