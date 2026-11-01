/**
 * Repository interface for auth entities: users, sessions, invitations.
 *
 * Covers access patterns A1–A6 from the data design doc plus invitation
 * management (governance/users.ts).
 *
 * All methods are async so both the synchronous SQLite implementation and
 * the DynamoDB implementation satisfy the same contract.
 */

import { SqliteAuthRepository } from './auth-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Errors ────────────────────────────────────────────────────────────────────

/** Thrown by createUser when the supplied email is already in use. */
export class EmailAlreadyTakenError extends Error {
  constructor() {
    super('A user with this email already exists');
    this.name = 'EmailAlreadyTakenError';
  }
}

/**
 * Thrown by createFirstAdmin when at least one user already exists.
 * The portal is not in first-run state.
 */
export class AdminAlreadyExistsError extends Error {
  constructor() {
    super('Admin account already exists');
    this.name = 'AdminAlreadyExistsError';
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  is_admin: number;
  disabled: number;
  google_sub: string | null;
  created_at: string;
}

/** User joined with their most-recent session timestamp (for admin user list). */
export interface UserWithLastActive extends UserRecord {
  last_active_at: string | null;
}

/** Session joined with user fields — returned by session lookup on every auth'd request. */
export interface SessionWithUser {
  user_id: string;
  email: string;
  name: string;
  is_admin: number;
  disabled: number;
  expires_at: string;
}

export interface CreateUserInput {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  is_admin: number;
  disabled: number;
  created_at: string;
}

export interface CreateSessionInput {
  token_hash: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

export interface InvitationRecord {
  token_hash: string;
  email: string | null;
  is_admin: number;
  portal_role: string;
  project_id: string | null;
  project_access: string | null;
  team_id: string | null;
  expires_at: string;
  created_by: string;
  created_at: string;
  used_at: string | null;
  used_by: string | null;
}

export interface CreateInvitationInput {
  token_hash: string;
  email: string | null;
  is_admin: number;
  portal_role: string;
  project_id: string | null;
  project_access: string | null;
  team_id: string | null;
  expires_at: string;
  created_by: string;
  created_at: string;
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface AuthRepository {
  // ── Users ──────────────────────────────────────────────────────────────────

  /** Count all users — used for first-run "needs setup" check. No Scan in DynamoDB. */
  countUsers(): Promise<number>;

  /** Get user by ID (A6). */
  getUserById(id: string): Promise<UserRecord | null>;

  /** Get user by email for login (A1). */
  getUserByEmail(email: string): Promise<UserRecord | null>;

  /**
   * Create a new user.
   * Atomically writes the user item, email reservation, index entry, and counter.
   * Throws EmailAlreadyTakenError if the email is already registered.
   */
  createUser(input: CreateUserInput): Promise<UserRecord>;

  /**
   * Apply a partial update to user fields (disabled, is_admin, password_hash, name).
   * Caller must have already validated the patch keys.
   */
  updateUserFields(id: string, patch: Record<string, string | number>): Promise<void>;

  /**
   * List all users ordered by created_at ASC.
   * Includes last_active_at (most recent session creation time) for the admin view.
   * DynamoDB: last_active_at is stored as a denormalized attribute on the user item;
   * it is updated when a session is created.
   */
  listUsersWithLastActive(): Promise<UserWithLastActive[]>;

  // ── Sessions ───────────────────────────────────────────────────────────────

  /**
   * Create a session. Also updates the user's lastActiveAt (DynamoDB denormalization).
   */
  createSession(input: CreateSessionInput): Promise<void>;

  /**
   * Look up a session by token hash and return joined user fields.
   * Returns null if the session does not exist.
   * The caller is responsible for checking expires_at and disabled.
   * DynamoDB: 1 GSI query + 1 GetItem (see design doc "Keep it to one lookup plus user fetch").
   */
  getSessionWithUser(tokenHash: string): Promise<SessionWithUser | null>;

  /** Delete a single session (logout). */
  deleteSession(tokenHash: string): Promise<void>;

  /**
   * Delete all sessions with expires_at < now.
   * DynamoDB: TTL handles automatic expiry; this call is a no-op in DynamoDB mode.
   */
  deleteExpiredSessions(): Promise<void>;

  // ── Invitations ────────────────────────────────────────────────────────────

  /** Create an invitation token. */
  createInvitation(input: CreateInvitationInput): Promise<void>;

  /** Look up an invitation by its token hash (accept-invite flow). */
  getInvitationByHash(tokenHash: string): Promise<InvitationRecord | null>;

  /** List pending (unused, non-expired) invitations for admin panel. */
  listPendingInvitations(now: string): Promise<InvitationRecord[]>;

  /** Mark an invitation as used and record the new user ID.
   * Returns true if the claim succeeded (was not already used).
   * Returns false if the invitation was already used by a concurrent request.
   */
  markInvitationUsed(tokenHash: string, userId: string, usedAt: string): Promise<boolean>;

  /**
   * Release a previously claimed invitation (undo markInvitationUsed).
   * Called when user creation fails after claiming, so the invite can be retried.
   * Silently no-ops if the invite is not found.
   */
  releaseInvitationClaim(tokenHash: string): Promise<void>;

  /**
   * Atomically create the first admin user.
   * Succeeds only if no users exist in the portal yet.
   * Throws AdminAlreadyExistsError if any user already exists.
   * Throws EmailAlreadyTakenError if (in the very unlikely case) the email is taken.
   */
  createFirstAdmin(input: CreateUserInput): Promise<UserRecord>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: AuthRepository | null = null;

/** Initialise the singleton. Call once at server startup. Idempotent. */
export async function initAuthRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbAuthRepository } = await import('./auth-dynamodb.ts');
    _instance = new DynamoDbAuthRepository();
  } else {
    _instance = new SqliteAuthRepository();
  }
}

/** Return the singleton. Falls back to SQLite init if not yet initialised. */
export function getAuthRepository(): AuthRepository {
  if (_instance) return _instance;
  if (usesDynamoDb()) {
    throw new Error(
      'DynamoDB auth repository was not initialised. ' +
        'Call await initAuthRepository() at server startup.',
    );
  }
  _instance = new SqliteAuthRepository();
  return _instance;
}

export function setAuthRepository(repo: AuthRepository): void { _instance = repo; }
export function clearAuthRepository(): void { _instance = null; }
