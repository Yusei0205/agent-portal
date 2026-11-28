/**
 * Repository interface for engine_credentials.
 *
 * Access patterns:
 *   C1  getById(id)                         — internal refresh / token write-back
 *   C2  getByIdAndUser(id, userId)           — ownership check in routes
 *   C3  getDefaultByUserAndEngine(u, engine) — resolveCredentialEnv fallback
 *   C4  listByUser(userId)                  — GET /api/credentials
 *   C5  create(input)                       — POST /api/credentials
 *   C6  update(id, fields)                  — PUT /api/credentials/:id
 *   C7  updateToken(id, …)                  — after device-code / refresh completes
 *   C8  updateTokenConditional(id, …)       — conditional token write-back (AgentCore)
 *   C9  updateExtraConfig(id, …)            — profile store
 *   C10 clearDefaults(userId, engine)       — before setting a new default
 *   C11 setDefault(id, updatedAt)           — POST /api/credentials/:id/set-default
 *   C12 delete(id)                          — DELETE /api/credentials/:id
 *
 * SQLite default.  DynamoDB activated by USE_DYNAMODB=true.
 *
 * DynamoDB table: portal-users
 * Key design:
 *   PK=USER#<userId>   SK=CRED#<credId>   → main item  (C2–C4, C5–C12)
 *   PK=CRED#<credId>   SK=#LOOKUP         → userId pointer for C1
 */

import { SqliteCredentialsRepository } from './credentials-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ───────────────────────────────────────────────────────────────

export interface CredentialRecord {
  id: string;
  user_id: string;
  engine: string;
  name: string;
  mode: string;
  secret_enc: string | null;
  extra_config: string;
  is_default: number;
  last4: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  /** Display name of the user who last updated (joined from users table; may be null). */
  updated_by_name?: string | null;
}

export interface CreateCredentialInput {
  id: string;
  user_id: string;
  engine: string;
  name: string;
  mode: string;
  secret_enc: string | null;
  extra_config: string;
  is_default: number;
  last4: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

export interface UpdateCredentialFields {
  name?: string;
  secret_enc?: string;
  extra_config?: string;
  is_default?: number;
  last4?: string;
  updated_at?: string;
  updated_by?: string | null;
}

// ── Repository interface ───────────────────────────────────────────────────────

export interface CredentialsRepository {
  /** C1: Get a credential by its id (no ownership check). */
  getById(id: string): Promise<CredentialRecord | null>;

  /** C2: Get a credential by id that belongs to the given user. */
  getByIdAndUser(id: string, userId: string): Promise<CredentialRecord | null>;

  /** C3: Get the default credential for a user and engine. */
  getDefaultByUserAndEngine(userId: string, engine: string): Promise<CredentialRecord | null>;

  /** C4: List all credentials for a user, ordered by engine / is_default / created_at. */
  listByUser(userId: string): Promise<CredentialRecord[]>;

  /** C5: Create a new credential. */
  create(input: CreateCredentialInput): Promise<CredentialRecord>;

  /** C6: Partial update of a credential (name, secret, extra_config, etc.). */
  update(id: string, fields: UpdateCredentialFields): Promise<CredentialRecord | null>;

  /**
   * C7: Full token update after device-code / refresh completes.
   * Overwrites secret_enc, extra_config, last4, updated_at.
   */
  updateToken(
    id: string,
    secretEnc: string,
    extraConfig: string,
    last4: string,
    updatedAt: string,
  ): Promise<void>;

  /**
   * C8: Conditional token write-back after AgentCore run.
   * Only writes if the stored secret_enc equals expectedCiphertext.
   * Returns true when written, false when skipped (concurrent run won).
   */
  updateTokenConditional(
    id: string,
    secretEnc: string,
    extraConfig: string,
    last4: string,
    updatedAt: string,
    expectedCiphertext: string,
  ): Promise<boolean>;

  /** C9: Update only extra_config (profile store after device-code poll). */
  updateExtraConfig(id: string, extraConfig: string, updatedAt: string): Promise<void>;

  /** C10: Clear is_default for all credentials of a user+engine pair. */
  clearDefaults(userId: string, engine: string): Promise<void>;

  /** C11: Set is_default=1 for one credential. Does NOT clear others first. */
  setDefault(id: string, updatedAt: string): Promise<void>;

  /** C12: Delete a credential by id. */
  delete(id: string): Promise<void>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: CredentialsRepository | null = null;

export async function initCredentialsRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbCredentialsRepository } = await import('./credentials-dynamodb.ts');
    _instance = new DynamoDbCredentialsRepository();
  } else {
    _instance = new SqliteCredentialsRepository();
  }
}

export function getCredentialsRepository(): CredentialsRepository {
  if (!_instance) _instance = new SqliteCredentialsRepository();
  return _instance;
}

export function setCredentialsRepository(repo: CredentialsRepository): void { _instance = repo; }
export function clearCredentialsRepository(): void { _instance = null; }
