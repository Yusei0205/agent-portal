/**
 * SQLite implementation of SettingsRepository.
 *
 * Uses getDb() for synchronous node:sqlite access.
 * All mutating operations wrap their SQL in db.tx() for atomicity and include
 * a version bump so other instances (in the same process or on DynamoDB) can
 * detect that the snapshot is stale.
 *
 * The version is stored as the reserved key '_version' in the settings table.
 * It starts at 0 (absent row → 0) and is incremented by 1 per write call.
 */

import { getDb, tx } from '../db.ts';
import type { SettingsRepository, SecretRecord } from './settings.ts';

export class SqliteSettingsRepository implements SettingsRepository {
  // ── Version ─────────────────────────────────────────────────────────────────

  /** Increment _version inside an already-open transaction. */
  private bumpVersionInTx(): void {
    getDb()
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('_version', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
      )
      .run();
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  async getKey(key: string): Promise<string | null> {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async setKey(key: string, value: string): Promise<void> {
    tx(() => {
      getDb()
        .prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(key, value);
      this.bumpVersionInTx();
    });
  }

  async setKeys(pairs: Array<[string, string]>): Promise<void> {
    if (pairs.length === 0) return;
    tx(() => {
      const stmt = getDb().prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      );
      for (const [key, value] of pairs) {
        stmt.run(key, value);
      }
      this.bumpVersionInTx();
    });
  }

  async deleteKey(key: string): Promise<void> {
    tx(() => {
      getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
      this.bumpVersionInTx();
    });
  }

  async deleteKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    tx(() => {
      const stmt = getDb().prepare('DELETE FROM settings WHERE key = ?');
      for (const k of keys) stmt.run(k);
      this.bumpVersionInTx();
    });
  }

  async loadSnapshot(): Promise<{ version: number; keys: Map<string, string> }> {
    const rows = getDb()
      .prepare('SELECT key, value FROM settings')
      .all() as Array<{ key: string; value: string }>;
    const keys = new Map<string, string>();
    let version = 0;
    for (const row of rows) {
      if (row.key === '_version') {
        version = parseInt(row.value, 10) || 0;
      } else {
        keys.set(row.key, row.value);
      }
    }
    return { version, keys };
  }

  async getVersion(): Promise<number> {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = '_version'")
      .get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) || 0 : 0;
  }

  // ── Secrets ─────────────────────────────────────────────────────────────────

  async setSecret(
    name: string,
    encryptedValue: string,
    hint: string | null,
    updatedAt: string,
  ): Promise<void> {
    getDb()
      .prepare(
        'INSERT INTO secrets (name, value, hint, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, hint = excluded.hint, updated_at = excluded.updated_at',
      )
      .run(name, encryptedValue, hint ?? null, updatedAt);
  }

  async getSecret(name: string): Promise<SecretRecord | null> {
    const row = getDb()
      .prepare('SELECT name, value, hint, updated_at FROM secrets WHERE name = ?')
      .get(name) as
      | { name: string; value: string; hint: string | null; updated_at: string }
      | undefined;
    if (!row) return null;
    return {
      name: row.name,
      value: row.value,
      hint: row.hint ?? null,
      updatedAt: row.updated_at,
    };
  }

  async deleteSecret(name: string): Promise<void> {
    getDb().prepare('DELETE FROM secrets WHERE name = ?').run(name);
  }
}
