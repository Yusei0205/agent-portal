/**
 * SQLite implementation of AuthRepository.
 *
 * Wraps synchronous node:sqlite helpers in Promise.resolve().
 * All SQL for users, sessions, and invitations lives here.
 */

import { one, all, run as dbRun, insert, getDb, tx } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  AuthRepository,
  UserRecord,
  UserWithLastActive,
  SessionWithUser,
  CreateUserInput,
  CreateSessionInput,
  InvitationRecord,
  CreateInvitationInput,
} from './auth.ts';
import { EmailAlreadyTakenError, AdminAlreadyExistsError } from './auth.ts';

// ── Row converters ────────────────────────────────────────────────────────────

function toUserRecord(row: Row): UserRecord {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    password_hash: String(row.password_hash ?? ''),
    is_admin: Number(row.is_admin ?? 0),
    disabled: Number(row.disabled ?? 0),
    google_sub: row.google_sub != null ? String(row.google_sub) : null,
    created_at: String(row.created_at),
  };
}

function toInvitationRecord(row: Row): InvitationRecord {
  return {
    token_hash: String(row.token_hash),
    email: row.email != null ? String(row.email) : null,
    is_admin: Number(row.is_admin ?? 0),
    portal_role: String(row.portal_role ?? 'member'),
    project_id: row.project_id != null ? String(row.project_id) : null,
    project_access: row.project_access != null ? String(row.project_access) : null,
    team_id: row.team_id != null ? String(row.team_id) : null,
    expires_at: String(row.expires_at),
    created_by: String(row.created_by ?? ''),
    created_at: String(row.created_at),
    used_at: row.used_at != null ? String(row.used_at) : null,
    used_by: row.used_by != null ? String(row.used_by) : null,
  };
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class SqliteAuthRepository implements AuthRepository {
  private readonly loginFailures = new Map<string, { count: number; until: number }>();

  async recordLoginFailure(key: string, windowMs: number, nowMs: number): Promise<number> {
    const cur = this.loginFailures.get(key);
    const live = cur && cur.until > nowMs ? cur : { count: 0, until: nowMs + windowMs };
    live.count += 1;
    this.loginFailures.set(key, live);
    return live.count;
  }

  async getLoginFailures(key: string, nowMs: number): Promise<number> {
    const cur = this.loginFailures.get(key);
    return cur && cur.until > nowMs ? cur.count : 0;
  }

  async clearLoginFailures(key: string): Promise<void> {
    this.loginFailures.delete(key);
  }

  async countUsers(): Promise<number> {
    const row = one<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    return Number(row?.n ?? 0);
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const row = one<Row>('SELECT * FROM users WHERE id = ?', id);
    return row ? toUserRecord(row) : null;
  }

  async getUsersByIds(ids: string[]): Promise<UserRecord[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = all<Row>(
      `SELECT * FROM users WHERE id IN (${placeholders})`,
      ...ids,
    );
    return rows.map(toUserRecord);
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const row = one<Row>('SELECT * FROM users WHERE email = ?', email);
    return row ? toUserRecord(row) : null;
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    try {
      insert('users', {
        id: input.id,
        email: input.email,
        name: input.name,
        password_hash: input.password_hash,
        is_admin: input.is_admin,
        disabled: input.disabled,
        created_at: input.created_at,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE constraint failed: users.email')) {
        throw new EmailAlreadyTakenError();
      }
      throw e;
    }
    const row = one<Row>('SELECT * FROM users WHERE id = ?', input.id);
    return toUserRecord(row!);
  }

  async updateUserFields(id: string, patch: Record<string, string | number>): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    const setClauses = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    // UPDATE returns 0 changes for unknown id — that is the correct no-op behaviour.
    dbRun(
      `UPDATE users SET ${setClauses} WHERE id = ?`,
      ...Object.values(patch),
      id,
    );
  }

  async listUsersWithLastActive(): Promise<UserWithLastActive[]> {
    const rows = all<Row>(
      `SELECT u.id, u.email, u.name, u.password_hash, u.is_admin, u.disabled,
              u.google_sub, u.created_at,
              MAX(s.created_at) AS last_active_at
         FROM users u
         LEFT JOIN sessions s ON s.user_id = u.id
        GROUP BY u.id
        ORDER BY u.created_at`,
    );
    return rows.map((row) => ({
      ...toUserRecord(row),
      last_active_at: row.last_active_at != null ? String(row.last_active_at) : null,
    }));
  }

  async createSession(input: CreateSessionInput): Promise<void> {
    insert('sessions', {
      token_hash: input.token_hash,
      user_id: input.user_id,
      expires_at: input.expires_at,
      created_at: input.created_at,
    });
  }

  async getSessionWithUser(tokenHash: string): Promise<SessionWithUser | null> {
    const row = one<Row>(
      `SELECT u.id AS user_id, u.email, u.name, u.is_admin, u.disabled, s.expires_at, s.created_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
      tokenHash,
    );
    if (!row) return null;
    return {
      user_id: String(row.user_id),
      email: String(row.email),
      name: String(row.name),
      is_admin: Number(row.is_admin ?? 0),
      disabled: Number(row.disabled ?? 0),
      expires_at: String(row.expires_at),
      created_at: String(row.created_at ?? ''),
    };
  }

  async extendSession(_userId: string, tokenHash: string, expiresAt: string): Promise<void> {
    dbRun('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', expiresAt, tokenHash);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    dbRun('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
  }

  async deleteSessionsForUser(userId: string, keepTokenHash: string): Promise<number> {
    const rows = all<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id = ? AND token_hash <> ?', userId, keepTokenHash);
    if (rows.length) dbRun('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', userId, keepTokenHash);
    return rows.length;
  }

  async deleteExpiredSessions(): Promise<void> {
    const { now } = await import('../util.ts');
    dbRun('DELETE FROM sessions WHERE expires_at < ?', now());
  }

  async createInvitation(input: CreateInvitationInput): Promise<void> {
    insert('invitations', {
      token_hash: input.token_hash,
      email: input.email,
      is_admin: input.is_admin,
      portal_role: input.portal_role,
      project_id: input.project_id,
      project_access: input.project_access,
      team_id: input.team_id,
      expires_at: input.expires_at,
      created_by: input.created_by,
      created_at: input.created_at,
    });
  }

  async getInvitationByHash(tokenHash: string): Promise<InvitationRecord | null> {
    const row = one<Row>('SELECT * FROM invitations WHERE token_hash = ?', tokenHash);
    return row ? toInvitationRecord(row) : null;
  }

  async listPendingInvitations(now: string): Promise<InvitationRecord[]> {
    const rows = all<Row>(
      `SELECT * FROM invitations
        WHERE used_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC`,
      now,
    );
    return rows.map(toInvitationRecord);
  }

  async markInvitationUsed(tokenHash: string, userId: string, usedAt: string): Promise<boolean> {
    const result = dbRun(
      'UPDATE invitations SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL',
      usedAt,
      userId,
      tokenHash,
    );
    return result.changes > 0;
  }

  async releaseInvitationClaim(tokenHash: string): Promise<void> {
    dbRun(
      'UPDATE invitations SET used_at = NULL, used_by = NULL WHERE token_hash = ?',
      tokenHash,
    );
  }

  async createFirstAdmin(input: CreateUserInput): Promise<UserRecord> {
    // Atomically: check no users exist, then insert.
    // tx() wraps in BEGIN/COMMIT so concurrent requests cannot both see count=0.
    tx(() => {
      const row = one<{ n: number }>('SELECT COUNT(*) AS n FROM users');
      if ((row?.n ?? 0) > 0) throw new AdminAlreadyExistsError();
      try {
        insert('users', {
          id: input.id,
          email: input.email,
          name: input.name,
          password_hash: input.password_hash,
          is_admin: input.is_admin,
          disabled: input.disabled,
          created_at: input.created_at,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('UNIQUE constraint failed: users.email')) throw new EmailAlreadyTakenError();
        throw e;
      }
    });
    const row = one<Row>('SELECT * FROM users WHERE id = ?', input.id);
    return toUserRecord(row!);
  }

  // ── Synchronous helper for WebSocket upgrade auth ─────────────────────────
  // Used by terminal.ts and browser-live.ts which cannot easily be made async.
  // Not part of the AuthRepository interface.

  getSessionWithUserSync(tokenHash: string): SessionWithUser | null {
    const db = getDb();
    const row = db.prepare(
      `SELECT u.id AS user_id, u.email, u.name, u.is_admin, u.disabled, s.expires_at, s.created_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    ).get(tokenHash) as Row | undefined;
    if (!row) return null;
    return {
      user_id: String(row.user_id),
      email: String(row.email),
      name: String(row.name),
      is_admin: Number(row.is_admin ?? 0),
      disabled: Number(row.disabled ?? 0),
      expires_at: String(row.expires_at),
      created_at: String(row.created_at ?? ''),
    };
  }
}
