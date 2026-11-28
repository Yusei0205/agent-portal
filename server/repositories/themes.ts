/**
 * Repository interface for custom themes (themes table).
 *
 * Built-in themes are stored as JSON files in shared/themes/ and never hit the
 * database.  This repository covers only custom themes and builtin-override rows.
 *
 * SQLite default.  DynamoDB activated by USE_DYNAMODB=true.
 *
 * DynamoDB table: portal-config
 * Key design:
 *   PK=THEMES  SK=THEME#<id>
 *   builtin_override attribute distinguishes overrides from custom themes.
 */

import { SqliteThemesRepository } from './themes-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ───────────────────────────────────────────────────────────────

export interface ThemeRecord {
  id: string;
  name: string;
  template_json: string;
  builtin_override: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateThemeInput {
  id: string;
  name: string;
  template_json: string;
  builtin_override: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpdateThemeFields {
  name?: string;
  template_json?: string;
  updated_by?: string | null;
  updated_at?: string;
}

// ── Repository interface ───────────────────────────────────────────────────────

export interface ThemesRepository {
  /** Get any theme by id (custom or override). */
  getById(id: string): Promise<ThemeRecord | null>;
  /** Get a builtin-override row (builtin_override=1) by id. */
  getOverrideById(id: string): Promise<ThemeRecord | null>;
  /** Get a custom theme (builtin_override=0) by id. */
  getCustomById(id: string): Promise<ThemeRecord | null>;
  /** Check if a builtin-override exists for id. */
  hasOverride(id: string): Promise<boolean>;
  /** List custom themes (builtin_override=0), newest first. */
  listCustom(): Promise<ThemeRecord[]>;
  /** List all themes (custom + overrides). */
  listAll(): Promise<ThemeRecord[]>;
  /** Create a new theme record. */
  create(input: CreateThemeInput): Promise<ThemeRecord>;
  /** Update an existing theme. */
  update(id: string, fields: UpdateThemeFields): Promise<ThemeRecord | null>;
  /** Delete a theme by id. */
  delete(id: string): Promise<void>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: ThemesRepository | null = null;

export async function initThemesRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbThemesRepository } = await import('./themes-dynamodb.ts');
    _instance = new DynamoDbThemesRepository();
  } else {
    _instance = new SqliteThemesRepository();
  }
}

export function getThemesRepository(): ThemesRepository {
  if (!_instance) _instance = new SqliteThemesRepository();
  return _instance;
}

export function setThemesRepository(repo: ThemesRepository): void { _instance = repo; }
export function clearThemesRepository(): void { _instance = null; }
