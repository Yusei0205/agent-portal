/**
 * Repository interface for delegation settings.
 *
 * Wraps the settings table reads/writes in server/delegation.ts so they
 * can run against DynamoDB (portal-config table) or SQLite.
 */

import { SqliteDelegationSettingsRepository } from './delegation-settings-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DelegationSettings {
  enabled: boolean;
  maxRunningPerParent: number;
  maxRunningPerUser: number;
  idleStopMinutes: number;
  allowNested: boolean;
  nudgeThreshold: number;
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface DelegationSettingsRepository {
  /** Return current settings, with DELEGATION_DEFAULTS applied for missing keys. */
  get(): Promise<DelegationSettings>;

  /** Persist a partial update. Only specified keys are written. */
  patch(settings: Partial<DelegationSettings>): Promise<void>;
}

// ── Defaults (shared by both implementations) ─────────────────────────────────

export const DELEGATION_DEFAULTS: DelegationSettings = {
  enabled:             true,
  maxRunningPerParent: 3,
  maxRunningPerUser:   5,
  idleStopMinutes:     15,
  allowNested:         false,
  nudgeThreshold:      4,
};

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: DelegationSettingsRepository | null = null;

export async function initDelegationSettingsRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbDelegationSettingsRepository } = await import('./delegation-settings-dynamodb.ts');
    _instance = new DynamoDbDelegationSettingsRepository();
  } else {
    _instance = new SqliteDelegationSettingsRepository();
  }
}

export function getDelegationSettingsRepository(): DelegationSettingsRepository {
  if (_instance) return _instance;
  if (usesDynamoDb()) {
    throw new Error(
      'DynamoDB delegation-settings repository was not initialised. ' +
        'Call await initDelegationSettingsRepository() at server startup.',
    );
  }
  const inst = new SqliteDelegationSettingsRepository();
  _instance = inst;
  return inst;
}

export function setDelegationSettingsRepository(repo: DelegationSettingsRepository): void {
  _instance = repo;
}
export function clearDelegationSettingsRepository(): void { _instance = null; }
