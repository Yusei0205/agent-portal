/**
 * SQLite implementation of UserConfigRepository.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  UserConfigRepository,
  UserConfigStateRecord,
  TeamConfigVersionRecord,
  CreateTeamConfigVersionInput,
} from './user-config.ts';

function toStateRecord(row: Row): UserConfigStateRecord {
  return {
    user_id: String(row.user_id ?? ''),
    folder: String(row.folder ?? ''),
    following: Number(row.following ?? 1),
    customised_at: row.customised_at != null ? String(row.customised_at) : null,
    team_version_id: row.team_version_id != null ? String(row.team_version_id) : null,
  };
}

function toVersionRecord(row: Row): TeamConfigVersionRecord {
  return {
    id: String(row.id ?? ''),
    folder: String(row.folder ?? ''),
    files_json: String(row.files_json ?? '[]'),
    published_by: row.published_by != null ? String(row.published_by) : null,
    published_at: String(row.published_at ?? ''),
  };
}

export class SqliteUserConfigRepository implements UserConfigRepository {
  async getState(userId: string, folder: string): Promise<UserConfigStateRecord | null> {
    const row = one<Row>(
      'SELECT * FROM user_config_state WHERE user_id = ? AND folder = ?',
      userId,
      folder,
    );
    return row ? toStateRecord(row) : null;
  }

  async setState(
    userId: string,
    folder: string,
    state: Pick<UserConfigStateRecord, 'following' | 'customised_at' | 'team_version_id'>,
  ): Promise<void> {
    const existing = one<Row>(
      'SELECT user_id FROM user_config_state WHERE user_id = ? AND folder = ?',
      userId,
      folder,
    );
    if (existing) {
      dbRun(
        'UPDATE user_config_state SET following = ?, customised_at = ?, team_version_id = ? WHERE user_id = ? AND folder = ?',
        state.following,
        state.customised_at,
        state.team_version_id,
        userId,
        folder,
      );
    } else {
      insert('user_config_state', {
        user_id: userId,
        folder,
        following: state.following,
        customised_at: state.customised_at,
        team_version_id: state.team_version_id,
      });
    }
  }

  async getLatestTeamVersion(folder: string): Promise<TeamConfigVersionRecord | null> {
    const row = one<Row>(
      'SELECT * FROM team_config_versions WHERE folder = ? ORDER BY published_at DESC LIMIT 1',
      folder,
    );
    return row ? toVersionRecord(row) : null;
  }

  async listTeamVersions(folder: string): Promise<TeamConfigVersionRecord[]> {
    const rows = all<Row>(
      'SELECT * FROM team_config_versions WHERE folder = ? ORDER BY published_at DESC',
      folder,
    );
    return rows.map(toVersionRecord);
  }

  async publishTeamVersion(input: CreateTeamConfigVersionInput): Promise<TeamConfigVersionRecord> {
    insert('team_config_versions', {
      id: input.id,
      folder: input.folder,
      files_json: input.files_json,
      published_by: input.published_by,
      published_at: input.published_at,
    });
    const row = one<Row>('SELECT * FROM team_config_versions WHERE id = ?', input.id)!;
    return toVersionRecord(row);
  }
}
