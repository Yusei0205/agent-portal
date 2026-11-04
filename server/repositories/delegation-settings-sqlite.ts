/**
 * SQLite implementation of DelegationSettingsRepository.
 *
 * Reads and writes the settings table keys prefixed with 'delegation.'.
 */

import { getDb } from '../db.ts';
import type { DelegationSettingsRepository, DelegationSettings } from './delegation-settings.ts';
import { DELEGATION_DEFAULTS } from './delegation-settings.ts';

export class SqliteDelegationSettingsRepository implements DelegationSettingsRepository {
  private _getKey(key: string): string | null {
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private _setKey(key: string, value: string): void {
    const db = getDb();
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  async get(): Promise<DelegationSettings> {
    const out = { ...DELEGATION_DEFAULTS };

    const enabled = this._getKey('delegation.enabled');
    if (enabled !== null) out.enabled = enabled === 'true';

    const maxParent = this._getKey('delegation.maxRunningPerParent');
    if (maxParent !== null) {
      const v = parseInt(maxParent, 10);
      if (Number.isFinite(v)) out.maxRunningPerParent = Math.max(0, Math.min(10, v));
    }

    const maxUser = this._getKey('delegation.maxRunningPerUser');
    if (maxUser !== null) {
      const v = parseInt(maxUser, 10);
      if (Number.isFinite(v)) out.maxRunningPerUser = Math.max(0, Math.min(20, v));
    }

    const idleStop = this._getKey('delegation.idleStopMinutes');
    if (idleStop !== null) {
      const v = parseInt(idleStop, 10);
      if (Number.isFinite(v)) out.idleStopMinutes = Math.max(1, Math.min(240, v));
    }

    const allowNested = this._getKey('delegation.allowNested');
    if (allowNested !== null) out.allowNested = allowNested === 'true';

    const nudge = this._getKey('delegation.nudgeThreshold');
    if (nudge !== null) {
      const v = parseInt(nudge, 10);
      if (Number.isFinite(v)) out.nudgeThreshold = Math.max(0, Math.min(20, v));
    }

    return out;
  }

  async patch(settings: Partial<DelegationSettings>): Promise<void> {
    if (settings.enabled !== undefined) this._setKey('delegation.enabled', String(settings.enabled));
    if (settings.maxRunningPerParent !== undefined) this._setKey('delegation.maxRunningPerParent', String(settings.maxRunningPerParent));
    if (settings.maxRunningPerUser !== undefined) this._setKey('delegation.maxRunningPerUser', String(settings.maxRunningPerUser));
    if (settings.idleStopMinutes !== undefined) this._setKey('delegation.idleStopMinutes', String(settings.idleStopMinutes));
    if (settings.allowNested !== undefined) this._setKey('delegation.allowNested', String(settings.allowNested));
    if (settings.nudgeThreshold !== undefined) this._setKey('delegation.nudgeThreshold', String(settings.nudgeThreshold));
  }
}
