/**
 * Repository interface for user_config_state and team_config_versions.
 *
 * SQLite default.  DynamoDB activated by USE_DYNAMODB=true.
 *
 * DynamoDB tables:
 *   user_config_state    → portal-users  PK=UCONF#<userId>  SK=FOLDER#<folder>
 *   team_config_versions → portal-config PK=TEAMCFG#<folder> SK=VER#<publishedAt>#<id>
 */

import { SqliteUserConfigRepository } from './user-config-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ───────────────────────────────────────────────────────────────

export interface UserConfigStateRecord {
  user_id: string;
  folder: string;
  following: number;
  customised_at: string | null;
  team_version_id: string | null;
}

export interface TeamConfigVersionRecord {
  id: string;
  folder: string;
  files_json: string;
  published_by: string | null;
  published_at: string;
}

export interface CreateTeamConfigVersionInput {
  id: string;
  folder: string;
  files_json: string;
  published_by: string | null;
  published_at: string;
}

// ── Repository interface ───────────────────────────────────────────────────────

export interface UserConfigRepository {
  /** Get the follow state for a user+folder pair. Returns null when no row exists (implies following=true). */
  getState(userId: string, folder: string): Promise<UserConfigStateRecord | null>;

  /** Upsert the follow state for a user+folder pair. */
  setState(
    userId: string,
    folder: string,
    state: Pick<UserConfigStateRecord, 'following' | 'customised_at' | 'team_version_id'>,
  ): Promise<void>;

  /** Get the latest team config version for a folder. Returns null if none. */
  getLatestTeamVersion(folder: string): Promise<TeamConfigVersionRecord | null>;

  /** List all team config versions for a folder, newest first. */
  listTeamVersions(folder: string): Promise<TeamConfigVersionRecord[]>;

  /** Publish a new team config version. */
  publishTeamVersion(input: CreateTeamConfigVersionInput): Promise<TeamConfigVersionRecord>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: UserConfigRepository | null = null;

export async function initUserConfigRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbUserConfigRepository } = await import('./user-config-dynamodb.ts');
    _instance = new DynamoDbUserConfigRepository();
  } else {
    _instance = new SqliteUserConfigRepository();
  }
}

export function getUserConfigRepository(): UserConfigRepository {
  if (!_instance) _instance = new SqliteUserConfigRepository();
  return _instance;
}

export function setUserConfigRepository(repo: UserConfigRepository): void { _instance = repo; }
export function clearUserConfigRepository(): void { _instance = null; }
