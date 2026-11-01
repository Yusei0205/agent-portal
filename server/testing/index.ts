/**
 * Tests module — registers all routes and exports the M25 migration SQL.
 *
 * Call registerTestingRoutes() from server/index.ts after other route registrations.
 */

import { registerTestProjectRoutes } from './projects.ts';
import { registerTestVaultRoutes } from './vault.ts';
import { registerScriptRoutes } from './scripts.ts';
import { registerRunRoutes } from './runner.ts';
import { registerGenerateRoutes } from './generate.ts';
import { registerCaseSetRoutes } from './case-sets.ts';

export { setModelCallFn } from './generate.ts';
export { extractJsonArray } from './generate.ts';
export { setAgentStepFn } from './runner.ts';
export { setBedrockClientFactory } from './model-provider.ts';
export { attemptRepairStep } from './types.ts';

export function registerTestingRoutes(): void {
  // Order matters: more-specific paths must come before generic /:param routes.
  // /api/tests/capability has no param conflict.
  // vault/files, vault/import, vault/:itemId — files/import registered first inside vault.ts.
  registerTestProjectRoutes();
  registerTestVaultRoutes();
  registerScriptRoutes();
  registerRunRoutes();
  registerGenerateRoutes();
  registerCaseSetRoutes();
}

// ── M25 migration SQL ──────────────────────────────────────────────────────────

export const M25_TESTS_MODULE = `
  CREATE TABLE IF NOT EXISTS test_projects (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    app_url TEXT NOT NULL,
    api_base_url TEXT,
    repo_ids TEXT NOT NULL DEFAULT '[]',
    vault_doc_paths TEXT NOT NULL DEFAULT '[]',
    viewport_width INTEGER NOT NULL DEFAULT 1440,
    viewport_height INTEGER NOT NULL DEFAULT 900,
    timeout_secs INTEGER NOT NULL DEFAULT 300,
    rules_for_ai TEXT NOT NULL DEFAULT '',
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS test_projects_project ON test_projects(project_id);

  CREATE TABLE IF NOT EXISTS test_vault_items (
    id TEXT PRIMARY KEY,
    test_project_id TEXT NOT NULL REFERENCES test_projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('login','secret')),
    username TEXT,
    password_enc TEXT,
    totp_secret_enc TEXT,
    value_enc TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(test_project_id, name)
  );
  CREATE INDEX IF NOT EXISTS test_vault_items_project ON test_vault_items(test_project_id);

  CREATE TABLE IF NOT EXISTS test_vault_files (
    id TEXT PRIMARY KEY,
    test_project_id TEXT NOT NULL REFERENCES test_projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT,
    uploaded_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(test_project_id, name)
  );
  CREATE INDEX IF NOT EXISTS test_vault_files_project ON test_vault_files(test_project_id);

  CREATE TABLE IF NOT EXISTS test_groups (
    id TEXT PRIMARY KEY,
    test_project_id TEXT NOT NULL REFERENCES test_projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS test_groups_project ON test_groups(test_project_id, sort_order);

  CREATE TABLE IF NOT EXISTS test_scripts (
    id TEXT PRIMARY KEY,
    test_project_id TEXT NOT NULL REFERENCES test_projects(id) ON DELETE CASCADE,
    test_group_id TEXT NOT NULL REFERENCES test_groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    steps TEXT NOT NULL DEFAULT '[]',
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS test_scripts_group ON test_scripts(test_group_id, sort_order);
  CREATE INDEX IF NOT EXISTS test_scripts_project ON test_scripts(test_project_id);

  CREATE TABLE IF NOT EXISTS test_runs (
    id TEXT PRIMARY KEY,
    test_project_id TEXT NOT NULL REFERENCES test_projects(id) ON DELETE CASCADE,
    script_id TEXT REFERENCES test_scripts(id) ON DELETE SET NULL,
    group_id TEXT REFERENCES test_groups(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK(status IN ('queued','running','passed','failed','cancelled','error')),
    error TEXT,
    artifact_dir TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS test_runs_project ON test_runs(test_project_id, created_at);
  CREATE INDEX IF NOT EXISTS test_runs_script ON test_runs(script_id);

  CREATE TABLE IF NOT EXISTS test_run_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
    script_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('passed','failed','error','skipped')),
    duration_ms INTEGER,
    error TEXT,
    screenshot_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS test_run_steps_run ON test_run_steps(run_id, step_index);

  CREATE TABLE IF NOT EXISTS test_generations (
    id TEXT PRIMARY KEY,
    test_project_id TEXT NOT NULL REFERENCES test_projects(id) ON DELETE CASCADE,
    script_id TEXT REFERENCES test_scripts(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK(kind IN ('generate','refine','import')),
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','running','done','failed')),
    error TEXT,
    result_script_ids TEXT NOT NULL DEFAULT '[]',
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS test_generations_project ON test_generations(test_project_id, created_at);

  INSERT OR IGNORE INTO settings (key, value) VALUES ('test.run_concurrency', '2');
`;

// ── M40 migration SQL (reference copy — actual migration lives in server/db.ts) ──

export { M40_CASE_SETS } from './case-sets.ts';
