/**
 * SQLite implementation of ThemesRepository.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  ThemesRepository,
  ThemeRecord,
  CreateThemeInput,
  UpdateThemeFields,
} from './themes.ts';

function toRecord(row: Row): ThemeRecord {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    template_json: String(row.template_json ?? '{}'),
    builtin_override: Number(row.builtin_override ?? 0),
    created_by: row.created_by != null ? String(row.created_by) : null,
    updated_by: row.updated_by != null ? String(row.updated_by) : null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

export class SqliteThemesRepository implements ThemesRepository {
  async getById(id: string): Promise<ThemeRecord | null> {
    const row = one<Row>('SELECT * FROM themes WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async getOverrideById(id: string): Promise<ThemeRecord | null> {
    const row = one<Row>('SELECT * FROM themes WHERE id = ? AND builtin_override = 1', id);
    return row ? toRecord(row) : null;
  }

  async getCustomById(id: string): Promise<ThemeRecord | null> {
    const row = one<Row>('SELECT * FROM themes WHERE id = ? AND builtin_override = 0', id);
    return row ? toRecord(row) : null;
  }

  async hasOverride(id: string): Promise<boolean> {
    const row = one<Row>('SELECT id FROM themes WHERE id = ? AND builtin_override = 1', id);
    return row != null;
  }

  async listCustom(): Promise<ThemeRecord[]> {
    const rows = all<Row>('SELECT * FROM themes WHERE builtin_override = 0 ORDER BY updated_at DESC');
    return rows.map(toRecord);
  }

  async listAll(): Promise<ThemeRecord[]> {
    const rows = all<Row>('SELECT * FROM themes ORDER BY created_at');
    return rows.map(toRecord);
  }

  async create(input: CreateThemeInput): Promise<ThemeRecord> {
    insert('themes', {
      id: input.id,
      name: input.name,
      template_json: input.template_json,
      builtin_override: input.builtin_override,
      created_by: input.created_by,
      updated_by: input.updated_by,
      created_at: input.created_at,
      updated_at: input.updated_at,
    });
    const row = one<Row>('SELECT * FROM themes WHERE id = ?', input.id)!;
    return toRecord(row);
  }

  async update(id: string, fields: UpdateThemeFields): Promise<ThemeRecord | null> {
    const keys = Object.keys(fields) as Array<keyof UpdateThemeFields>;
    if (keys.length === 0) return this.getById(id);
    const setClauses = keys.map((k) => `${k} = ?`).join(', ');
    const vals = keys.map((k) => fields[k] ?? null);
    dbRun(
      `UPDATE themes SET ${setClauses} WHERE id = ?`,
      ...vals,
      id,
    );
    const row = one<Row>('SELECT * FROM themes WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async delete(id: string): Promise<void> {
    dbRun('DELETE FROM themes WHERE id = ?', id);
  }
}
