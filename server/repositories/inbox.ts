/**
 * Repository interface for p6_inbox.
 *
 * Access pattern F12: list inbox items by project (unresolved, newest first, paging).
 * Also supports per-user project-scoped views and race-safe atomic resolve.
 *
 * SQLite is the default backend.  DynamoDB is activated by USE_DYNAMODB=true.
 *
 * DynamoDB table used: portal-runs
 *
 * Key design:
 *   PK=INBOX_ITEM#<id>   SK=#META   — canonical item (all fields)
 *
 * GSI-InboxByProject (portal-runs):
 *   PK=inboxProjectId  SK=inboxSortKey
 *   inboxProjectId = project_id (when scoped to a project)
 *   inboxSortKey   = '<resolved>#<isoCreatedAt>#<id>'
 *   resolved=0 → unresolved, resolved=1 → resolved.
 *   Query SK begins_with '0#' ScanIndexForward=false → unresolved newest-first.
 *   On resolve: UpdateItem changes inboxSortKey from '0#...' to '1#...' (DynamoDB
 *   automatically updates the GSI).
 *
 * GSI-InboxGlobal (portal-runs, sparse):
 *   PK=inboxGlobal ('INBOX')  SK=inboxSortKey
 *   inboxGlobal attribute is set on every unresolved item; removed on resolve.
 *   Allows admin to list all unresolved items without a Scan.
 *
 * Unresolved counters:
 *   PK=INBOX_COUNT#<projectId>  SK=#UNRESOLVED  { count: N }
 *   PK=INBOX_COUNT#GLOBAL       SK=#UNRESOLVED  { count: N }
 *   Incremented on create, decremented on resolve.
 *   resolveConditional uses a conditional update on the item (resolved = 0)
 *   + decrements both counters in a TransactWriteItems call to be race-safe.
 */

import { SqliteInboxRepository } from './inbox-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ───────────────────────────────────────────────────────────────

export type InboxType = 'approval' | 'question' | 'push' | 'blocked' | 'review-ready';

export interface InboxRecord {
  id: string;
  project_id: string | null;
  workflow_id: string | null;
  run_id: string | null;
  type: InboxType;
  payload: string;
  resolved: number;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

// ── Input types ────────────────────────────────────────────────────────────────

export interface CreateInboxInput {
  id: string;
  project_id: string | null;
  workflow_id: string | null;
  run_id: string | null;
  type: InboxType;
  payload: string;
  created_at: string;
}

// ── Options ────────────────────────────────────────────────────────────────────

export interface ListInboxOpts {
  /** Only include items for these project IDs (undefined = all projects). */
  projectIds?: string[];
  /** Only include unresolved items. Default: false (all). */
  unresolvedOnly?: boolean;
  /** Max items per page. */
  limit: number;
  /** SQLite: row offset. DynamoDB: ignored (use cursor). */
  offset?: number;
  /** DynamoDB pagination cursor. */
  cursor?: string;
}

// ── Repository interface ───────────────────────────────────────────────────────

export interface InboxRepository {
  /**
   * Create a new inbox item.
   * Returns the created record.
   */
  create(input: CreateInboxInput): Promise<InboxRecord>;

  /**
   * Get an inbox item by its id.
   * Returns null when not found.
   */
  getById(id: string): Promise<InboxRecord | null>;

  /**
   * List unresolved inbox items for specific projects, newest first.
   * DynamoDB: queries each project partition in parallel.
   */
  listUnresolvedByProjects(
    projectIds: string[],
    opts: { limit: number; offset?: number },
  ): Promise<{ items: InboxRecord[]; total: number }>;

  /**
   * List ALL unresolved inbox items (admin view), newest first.
   * DynamoDB: queries GSI-InboxGlobal (sparse, only unresolved items).
   */
  listAllUnresolved(opts: { limit: number; offset?: number }): Promise<{ items: InboxRecord[]; total: number }>;

  /**
   * Count unresolved items across the given projects.
   * Used for the nav badge count.
   * DynamoDB: sums per-project counter items.
   */
  countUnresolvedByProjects(projectIds: string[]): Promise<number>;

  /**
   * Count ALL unresolved items (admin).
   * DynamoDB: reads the global counter item.
   */
  countAllUnresolved(): Promise<number>;

  /**
   * Atomically resolve an inbox item.
   * Only resolves if the item is currently unresolved (conditional write).
   * Returns true when resolved by this call; false when already resolved (race).
   *
   * SQLite: UPDATE WHERE resolved = 0, checks changes > 0.
   * DynamoDB: TransactWriteItems — conditional UpdateItem + counter decrements.
   */
  resolveConditional(id: string, userId: string, resolvedAt: string): Promise<boolean>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: InboxRepository | null = null;

export async function initInboxRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbInboxRepository } = await import('./inbox-dynamodb.ts');
    _instance = new DynamoDbInboxRepository();
  } else {
    _instance = new SqliteInboxRepository();
  }
}

export function getInboxRepository(): InboxRepository {
  if (!_instance) _instance = new SqliteInboxRepository();
  return _instance;
}

export function setInboxRepository(repo: InboxRepository): void { _instance = repo; }
export function clearInboxRepository(): void { _instance = null; }
