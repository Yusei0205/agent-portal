/**
 * Repository interface and factory for portal settings and secrets.
 *
 * Both the `settings` table (global key/value config) and `secrets` table
 * (per-project encrypted credentials) are managed here.  In DynamoDB both
 * map to the `portal-config` table with different partition keys:
 *   PK=SETTINGS  SK=K#<key>   → settings rows
 *   PK=SECRET    SK=K#<name>  → secrets rows
 *
 * ## Snapshot pattern (cross-instance freshness)
 *
 * Many callers read settings synchronously (getSetting, getSettings).
 * Rather than making every caller async, an in-memory snapshot is maintained:
 *
 *   1. initSettingsRepository() loads the full snapshot at server startup.
 *      If the snapshot cannot be loaded, startup fails (fail-closed).
 *   2. refreshSnapshotIfStale() is called at the start of every HTTP request
 *      via a pre-request hook registered in server/index.ts.  It reads only
 *      the version counter; a full reload only happens when the version
 *      changed.  Background timers must call this before reading settings.
 *   3. getSetting / getSettings in server/settings.ts read from the snapshot.
 *   4. setSetting updates the snapshot optimistically and fires the write
 *      through the repository.
 *
 * ## Version counter
 *
 * SQLite:  A reserved key '_version' in the settings table is incremented on
 *          every setKey / setKeys / deleteKey call inside the same transaction.
 * DynamoDB: PK=SETTINGS SK=_VERSION item holds a numeric `version` attribute,
 *           incremented via ADD in the same TransactWriteItems call.
 *
 * ## Fail-closed
 *
 * refreshSnapshotIfStale() throws on version-check or reload errors.  The
 * pre-request hook propagates the error; the request handler returns a 503.
 * It never silently falls back to stale or default values.
 */

import { SqliteSettingsRepository } from './settings-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SecretRecord {
  name: string;
  /** Encrypted at rest — never log this field. */
  value: string;
  hint: string | null;
  updatedAt: string;
}

export interface SettingsRepository {
  // ── Settings (global key/value config) ─────────────────────────────────────

  getKey(key: string): Promise<string | null>;
  setKey(key: string, value: string): Promise<void>;
  /** Atomic multi-key set — all keys written in one transaction / one version bump. */
  setKeys(pairs: Array<[string, string]>): Promise<void>;
  deleteKey(key: string): Promise<void>;
  /** Atomic multi-key delete — all keys removed in one transaction / one version bump. */
  deleteKeys(keys: string[]): Promise<void>;
  /** Return all settings keys and the current version in one atomic call. */
  loadSnapshot(): Promise<{ version: number; keys: Map<string, string> }>;
  /** Cheap version check — reads only the version counter. */
  getVersion(): Promise<number>;

  // ── Secrets (per-project encrypted credentials) ─────────────────────────────

  setSecret(
    name: string,
    encryptedValue: string,
    hint: string | null,
    updatedAt: string,
  ): Promise<void>;
  getSecret(name: string): Promise<SecretRecord | null>;
  deleteSecret(name: string): Promise<void>;
}

// ── Snapshot state ────────────────────────────────────────────────────────────

export interface Snapshot {
  version: number;
  keys: Map<string, string>;
}

let _instance: SettingsRepository | null = null;
let _snapshot: Snapshot | null = null;

// ── Factory ───────────────────────────────────────────────────────────────────

export async function initSettingsRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbSettingsRepository } = await import('./settings-dynamodb.ts');
    _instance = new DynamoDbSettingsRepository();
  } else {
    _instance = new SqliteSettingsRepository();
  }
  // Fail-closed: if snapshot can't be loaded, startup fails.
  const snap = await _instance.loadSnapshot();
  _snapshot = snap;
}

export function getSettingsRepository(): SettingsRepository | null {
  return _instance;
}

export function setSettingsRepository(repo: SettingsRepository): void {
  _instance = repo;
}

export function clearSettingsRepository(): void {
  _instance = null;
  _snapshot = null;
}

// ── Snapshot API ──────────────────────────────────────────────────────────────

/**
 * Read a setting from the in-memory snapshot (synchronous).
 * Throws if the snapshot has not been initialized.
 */
export function getSettingFromSnapshot(key: string): string | null {
  if (_snapshot === null) {
    throw new Error(
      'Settings snapshot not initialised. ' +
        'Ensure initSettingsRepository() was called at server startup.',
    );
  }
  return _snapshot.keys.get(key) ?? null;
}

/** True when the snapshot has been loaded (server fully started). */
export function isSnapshotReady(): boolean {
  return _snapshot !== null;
}

/**
 * Update a key in the snapshot and optimistically increment the version.
 * Called immediately after a single-key write is dispatched.
 */
export function _updateSnapshotKey(key: string, value: string): void {
  if (_snapshot) {
    _snapshot.keys.set(key, value);
    _snapshot.version++;
  }
}

/**
 * Update multiple keys in the snapshot with a single version bump.
 * Use after setKeys() to keep the snapshot version aligned with the store
 * (the store does one version bump per setKeys call, not one per key).
 */
export function _updateSnapshotKeys(pairs: Array<[string, string]>): void {
  if (_snapshot) {
    for (const [key, value] of pairs) {
      _snapshot.keys.set(key, value);
    }
    _snapshot.version++;
  }
}

/**
 * Remove a key from the snapshot and increment the version.
 */
export function _deleteSnapshotKey(key: string): void {
  if (_snapshot) {
    _snapshot.keys.delete(key);
    _snapshot.version++;
  }
}

/**
 * Remove multiple keys from the snapshot with a single version bump.
 */
export function _deleteSnapshotKeys(keys: string[]): void {
  if (_snapshot) {
    for (const k of keys) {
      _snapshot.keys.delete(k);
    }
    _snapshot.version++;
  }
}

/**
 * Force-reload the snapshot from the repository.
 * Called after initSettingsRepository and after manual writes.
 */
export async function reloadSnapshot(): Promise<void> {
  if (!_instance) return;
  const snap = await _instance.loadSnapshot();
  _snapshot = snap;
}

/**
 * Check the stored version against the snapshot version; reload if stale.
 *
 * Called at the start of every HTTP request via the pre-request hook.
 * Fails closed: throws if the version check fails.
 * No-op if the repository is not yet initialized (pre-startup safety).
 */
export async function refreshSnapshotIfStale(): Promise<void> {
  if (!_instance) return;
  if (_snapshot === null) {
    throw new Error('Settings snapshot not initialized. Server startup incomplete.');
  }
  let remoteVersion: number;
  try {
    remoteVersion = await _instance.getVersion();
  } catch (err: unknown) {
    throw new Error(
      `Settings version check failed: ${String((err as Error)?.message ?? err)}`,
    );
  }
  if (_snapshot.version === remoteVersion) return;
  try {
    const snap = await _instance.loadSnapshot();
    _snapshot = snap;
  } catch (err: unknown) {
    throw new Error(
      `Settings snapshot reload failed: ${String((err as Error)?.message ?? err)}`,
    );
  }
}

/** @internal Expose the raw snapshot (for tests). */
export function _getSnapshot(): Snapshot | null { return _snapshot; }

/** @internal Force-set the snapshot (for tests). */
export function _setSnapshot(snap: Snapshot | null): void { _snapshot = snap; }
