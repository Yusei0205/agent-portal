/**
 * Repository interface for api_tokens.
 *
 * All methods are async so both the SQLite implementation (synchronous
 * under the hood, wrapped in Promise.resolve) and the DynamoDB
 * implementation (inherently async) satisfy the same contract.
 *
 * ## Choosing an implementation
 *
 * Call `initApiTokenRepository()` once at server startup before any routes
 * are registered.  When `DYNAMODB_TABLE_PORTAL_USERS` is set the DynamoDB
 * implementation is chosen; otherwise SQLite.
 *
 * For tests, call `setApiTokenRepository()` to inject a specific instance.
 */

import { SqliteApiTokenRepository } from './api-tokens-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TokenRecord {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  /** Legacy single-value scope column, kept for backward compatibility. */
  scope: string;
  /** JSON-encoded array of scopes; null on very old rows. */
  scopes: string | null;
  project_id: string | null;
  /** Set for delegate-scoped tokens; binds token to a parent workflow. */
  workflow_id: string | null;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** Token joined with its owning user — returned by getByHash for request auth. */
export interface TokenWithUser extends TokenRecord {
  user_email: string;
  user_name: string;
  user_is_admin: number;
  user_disabled: number;
}

/** Token with user metadata for the admin list view. */
export interface TokenWithUserMeta extends TokenRecord {
  user_name: string;
  user_email: string;
}

export interface CreateTokenInput {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  scope: string;
  scopes: string;
  project_id: string | null;
  workflow_id?: string | null;
  expires_at: string;
  created_at: string;
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface ApiTokenRepository {
  /** Insert a new token and return the stored record. */
  create(input: CreateTokenInput): Promise<TokenRecord>;

  /**
   * Get a token by ID and owner user ID.
   * The userId is required so DynamoDB can construct the primary key.
   */
  getByIdAndUser(id: string, userId: string): Promise<TokenRecord | null>;

  /**
   * Look up a token by its SHA-256 hash (called on every authenticated request).
   * Returns the token joined with user fields, or null if not found.
   */
  getByHash(hash: string): Promise<TokenWithUser | null>;

  /**
   * List non-delegate tokens for a user, newest first.
   * Tokens with the "delegate" scope are excluded.
   */
  listByUser(userId: string): Promise<TokenRecord[]>;

  /**
   * Admin view — list all non-delegate tokens across all users.
   * Includes user name and email.  Capped at 200 rows.
   */
  listAll(): Promise<TokenWithUserMeta[]>;

  /** Count non-revoked, non-expired tokens for a user. */
  countActive(userId: string): Promise<number>;

  /**
   * Update last_used_at for a token.
   * userId is required so DynamoDB can build the primary key without a GSI.
   */
  updateLastUsed(id: string, userId: string, ts: string): Promise<void>;

  /**
   * Set revoked_at on a token.
   * userId is required so DynamoDB can build the primary key without a GSI.
   */
  revoke(id: string, userId: string, ts: string): Promise<void>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: ApiTokenRepository | null = null;

/**
 * Initialise the repository singleton.
 * Call once at server startup.  Idempotent if called multiple times.
 *
 * When `DYNAMODB_TABLE_PORTAL_USERS` is set the DynamoDB implementation is
 * loaded dynamically (to avoid bundling the SDK when running locally).
 * Otherwise the SQLite implementation is used synchronously.
 */
export async function initApiTokenRepository(): Promise<void> {
  if (_instance) return;

  if (usesDynamoDb()) {
    const { DynamoDbApiTokenRepository } = await import('./api-tokens-dynamodb.ts');
    _instance = new DynamoDbApiTokenRepository();
  } else {
    _instance = new SqliteApiTokenRepository();
  }
}

/**
 * Return the singleton repository.
 *
 * If `initApiTokenRepository()` has not been called yet and no DynamoDB
 * env var is set this falls back to a synchronous SQLite init, making it
 * safe to call from test code and legacy code paths that were not updated
 * to call init explicitly.
 */
export function getApiTokenRepository(): ApiTokenRepository {
  if (_instance) return _instance;

  if (usesDynamoDb()) {
    throw new Error(
      'DynamoDB api-tokens repository was not initialised. ' +
        'Call await initApiTokenRepository() at server startup.',
    );
  }

  _instance = new SqliteApiTokenRepository();
  return _instance;
}

/** Replace the singleton — for tests and dependency injection. */
export function setApiTokenRepository(repo: ApiTokenRepository): void {
  _instance = repo;
}

/** Reset the singleton — for tests only. */
export function clearApiTokenRepository(): void {
  _instance = null;
}
