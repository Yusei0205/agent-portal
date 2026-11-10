/**
 * Repository interface for audit_log.
 *
 * Covers access patterns D1–D3 from the data design doc:
 *   D1 Write audit entry (append-only)
 *   D2 Read audit log paginated (admin view, newest first)
 *   D3 Filter by actor
 *
 * DynamoDB differences:
 *   - Pagination is cursor-based (ExclusiveStartKey). The total count field
 *     is omitted or set to -1 when not supported.
 *   - Audit entries are partitioned by UTC date: AUDIT#<yyyy-mm-dd>.
 *     Multi-day queries scan each date partition in sequence.
 */

import { SqliteAuditRepository } from './audit-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: number | string;   // integer in SQLite, composite string in DynamoDB
  ts: string;
  actor_id: string | null;
  actor_name?: string | null;
  actor_email?: string | null;
  action: string;
  target: string | null;
  detail: object;
  ip: string | null;
}

export interface AppendAuditInput {
  actorId: string | null;
  action: string;
  target: string | null;
  detail: object;
  ip: string | null;
}

export interface AuditQueryOptions {
  limit: number;
  offset?: number;     // SQLite: use OFFSET. DynamoDB: ignored when cursor present.
  cursor?: string;     // DynamoDB: base64 ExclusiveStartKey from previous response.
  actorId?: string;
  action?: string;     // prefix match
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  /**
   * Exact row count in SQLite (allows offset-based pagination).
   * null in DynamoDB (counting all matching items would require a full scan).
   */
  total: number | null;
  /** True when more pages exist beyond the current result set. */
  hasMore: boolean;
  /** Opaque cursor for the next page. Present on both backends when hasMore=true. */
  nextCursor?: string;
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface AuditRepository {
  /** Append a single audit entry. Fire-and-forget safe (caller need not await). */
  append(input: AppendAuditInput): Promise<void>;

  /**
   * Query the audit log.
   * Returns entries newest-first with optional actorId/action filters.
   * total is exact in SQLite; -1 in DynamoDB.
   */
  query(opts: AuditQueryOptions): Promise<AuditQueryResult>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: AuditRepository | null = null;

export async function initAuditRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbAuditRepository } = await import('./audit-dynamodb.ts');
    _instance = new DynamoDbAuditRepository();
  } else {
    _instance = new SqliteAuditRepository();
  }
}

export function getAuditRepository(): AuditRepository {
  if (_instance) return _instance;
  if (usesDynamoDb()) {
    throw new Error(
      'DynamoDB audit repository was not initialised. ' +
        'Call await initAuditRepository() at server startup.',
    );
  }
  _instance = new SqliteAuditRepository();
  return _instance;
}

export function setAuditRepository(repo: AuditRepository): void { _instance = repo; }
export function clearAuditRepository(): void { _instance = null; }
