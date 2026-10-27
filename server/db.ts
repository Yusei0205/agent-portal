/**
 * Database layer — opens SQLite using node:sqlite, runs migrations in order.
 *
 * Migration strategy:
 *   - schema_migrations table tracks which migrations have been applied.
 *   - Each migration is idempotent (uses CREATE TABLE IF NOT EXISTS).
 *   - Migrations are never edited; new changes are appended.
 *   - A database made before the baseline was cut is refused, not upgraded (D-4).
 */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import path from 'node:path';
import type { Config } from './config.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Row = Record<string, unknown>;

// ── Migrations ────────────────────────────────────────────────────────────────

/**
 * Migration 1: Core schema — accounts, sessions, settings, secrets, audit log.
 */
const M1_CORE = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    monthly_budget_usd REAL,
    google_sub TEXT,
    google_email TEXT,
    google_name TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    hint TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'read',
    expires_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    project_id TEXT
  );
  CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id);

  CREATE TABLE IF NOT EXISTS invitations (
    token_hash TEXT PRIMARY KEY,
    email TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    portal_role TEXT NOT NULL DEFAULT 'member',
    project_id TEXT,
    project_access TEXT,
    team_id TEXT,
    expires_at TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    used_at TEXT,
    used_by TEXT
  );
  CREATE INDEX IF NOT EXISTS invitations_created ON invitations(created_by, created_at);

  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS scim_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    hint TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT NOT NULL DEFAULT '{}',
    ip TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log(ts);
  CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log(actor_id, ts);
`;

/**
 * Migration 2: Teams and projects.
 */
const M2_PROJECTS = `
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    monthly_budget_usd REAL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team_members (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    PRIMARY KEY (team_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS team_members_user ON team_members(user_id);

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    default_lead_agent TEXT NOT NULL DEFAULT '',
    default_model TEXT NOT NULL DEFAULT '',
    monthly_budget_usd REAL,
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    vault_generated INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (project_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS git_connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'team',
    owner_id TEXT,
    host TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    workspace TEXT NOT NULL DEFAULT '',
    aws_connection_id TEXT NOT NULL DEFAULT '',
    test_ok INTEGER,
    test_message TEXT NOT NULL DEFAULT '',
    tested_at TEXT,
    created_by TEXT,
    updated_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    provider TEXT NOT NULL,
    url TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    token_secret TEXT,
    auth_user TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    error TEXT,
    last_sync TEXT,
    created_at TEXT NOT NULL,
    connection_id TEXT,
    UNIQUE (project_id, slug)
  );

  CREATE TABLE IF NOT EXISTS integrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'team',
    owner_id TEXT,
    config TEXT NOT NULL DEFAULT '{}',
    allow_writes INTEGER NOT NULL DEFAULT 0,
    test_ok INTEGER,
    test_message TEXT NOT NULL DEFAULT '',
    tested_at TEXT,
    created_by TEXT,
    updated_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    repos TEXT NOT NULL DEFAULT '[]',
    integrations TEXT NOT NULL DEFAULT '[]',
    created_by TEXT,
    updated_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workspaces_project ON workspaces(project_id);
`;

/**
 * Migration 3: Sessions/workflows, agent runs, knowledge, reviews, learn.
 * Includes permission group seed data.
 */
const M3_SESSIONS = `
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL,
    stop_reason TEXT NOT NULL DEFAULT '',
    repo_id TEXT,
    branch TEXT,
    repos TEXT NOT NULL DEFAULT '[]',
    workspace_id TEXT,
    integrations TEXT NOT NULL DEFAULT '[]',
    engine TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT 'sonnet',
    lead_agent TEXT NOT NULL DEFAULT '',
    budget_usd REAL NOT NULL DEFAULT 5,
    budget_credits REAL NOT NULL DEFAULT 20,
    spent_usd REAL NOT NULL DEFAULT 0,
    spent_credits REAL NOT NULL DEFAULT 0,
    max_iterations INTEGER NOT NULL DEFAULT 8,
    iteration INTEGER NOT NULL DEFAULT 0,
    burst_start INTEGER NOT NULL DEFAULT 0,
    verify_command TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL DEFAULT '',
    permission_mode TEXT NOT NULL DEFAULT '',
    push_mode TEXT NOT NULL DEFAULT 'never',
    pending_push TEXT NOT NULL DEFAULT '',
    playground INTEGER NOT NULL DEFAULT 0,
    trust_tools INTEGER NOT NULL DEFAULT 0,
    planning_gate INTEGER NOT NULL DEFAULT 0,
    loop_spec_id TEXT,
    last_run_id TEXT,
    work_branch TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    jira_key TEXT NOT NULL DEFAULT '',
    jira_summary TEXT NOT NULL DEFAULT '',
    jira_url TEXT NOT NULL DEFAULT '',
    parent_id TEXT,
    depth INTEGER NOT NULL DEFAULT 0,
    waiting_children INTEGER NOT NULL DEFAULT 0,
    seen_by_parent INTEGER NOT NULL DEFAULT 1,
    queue_reason TEXT NOT NULL DEFAULT '',
    queued_at TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workflows_project ON workflows(project_id, updated_at);
  CREATE INDEX IF NOT EXISTS workflows_parent ON workflows(parent_id);

  CREATE TABLE IF NOT EXISTS workflow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    run_id TEXT,
    body TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    consumed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workflow_events_wf ON workflow_events(workflow_id, id);

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    workflow_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    repo_id TEXT,
    branch TEXT,
    worktree TEXT,
    session_id TEXT,
    resume_of TEXT,
    model TEXT,
    permission_mode TEXT,
    provider TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    error TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    created_by TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS agent_runs_project ON agent_runs(project_id, created_at);
  CREATE INDEX IF NOT EXISTS agent_runs_workflow ON agent_runs(workflow_id, created_at);

  CREATE TABLE IF NOT EXISTS agent_run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    parent_tool_use_id TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_run_events_run ON agent_run_events(run_id, seq);

  CREATE TABLE IF NOT EXISTS inputs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id TEXT,
    type TEXT NOT NULL,
    tool_name TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    response TEXT,
    created_by TEXT,
    answered_by TEXT,
    created_at TEXT NOT NULL,
    answered_at TEXT,
    expires_at TEXT,
    escalated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS inputs_project ON inputs(project_id, status);

  CREATE TABLE IF NOT EXISTS loop_specs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    trigger_kind TEXT NOT NULL DEFAULT 'manual',
    trigger_config TEXT NOT NULL DEFAULT '{}',
    goal_template TEXT NOT NULL DEFAULT '',
    verification TEXT NOT NULL DEFAULT '[]',
    stop_rules TEXT NOT NULL DEFAULT '{}',
    memory_config TEXT NOT NULL DEFAULT '{}',
    escalation TEXT NOT NULL DEFAULT '{}',
    push_mode TEXT,
    trust_tools INTEGER,
    lead_agent TEXT,
    engine TEXT,
    monthly_budget_usd REAL,
    planning_gate INTEGER NOT NULL DEFAULT 0,
    is_template INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS loop_specs_project ON loop_specs(project_id);

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'upload',
    mime TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    hash TEXT,
    original_path TEXT,
    md_path TEXT,
    status TEXT NOT NULL,
    error TEXT,
    sections_count INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT '',
    repo_id TEXT,
    UNIQUE (project_id, slug)
  );

  CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    heading TEXT NOT NULL,
    level INTEGER NOT NULL,
    anchor TEXT NOT NULL,
    content TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sections_doc ON sections(doc_id, ord);
  CREATE INDEX IF NOT EXISTS sections_project ON sections(project_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(heading, content, tokenize = 'porter unicode61');

  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    repo_id TEXT NOT NULL,
    base TEXT NOT NULL,
    head TEXT NOT NULL,
    pr_number INTEGER,
    head_sha TEXT,
    diff TEXT NOT NULL DEFAULT '',
    files TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    deep INTEGER NOT NULL DEFAULT 0,
    run_id TEXT,
    summary TEXT,
    error TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    posted_at TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    loop_spec_id TEXT,
    workflow_id TEXT,
    pr_title TEXT,
    pr_url TEXT,
    post_mode TEXT NOT NULL DEFAULT '',
    post_state TEXT NOT NULL DEFAULT '',
    post_options TEXT NOT NULL DEFAULT '{}',
    post_result TEXT NOT NULL DEFAULT '{}',
    cost_usd REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    file TEXT NOT NULL,
    line INTEGER,
    end_line INTEGER,
    severity TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    message TEXT NOT NULL,
    suggestion TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    source TEXT NOT NULL DEFAULT 'triage',
    confidence REAL,
    posted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS learn_docs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    kind TEXT NOT NULL,
    focus TEXT NOT NULL DEFAULT '',
    doc_ids TEXT NOT NULL DEFAULT '[]',
    source_refs TEXT NOT NULL DEFAULT '[]',
    source_hash TEXT,
    business_md TEXT NOT NULL DEFAULT '',
    technical_md TEXT NOT NULL DEFAULT '',
    glossary TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    run_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    approved_by TEXT,
    published_at TEXT
  );

  CREATE TABLE IF NOT EXISTS quizzes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    audience TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    learn_doc_id TEXT,
    doc_ids TEXT NOT NULL DEFAULT '[]',
    source_refs TEXT NOT NULL DEFAULT '[]',
    source_hash TEXT,
    questions TEXT NOT NULL DEFAULT '[]',
    dropped INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    run_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    approved_by TEXT,
    published_at TEXT
  );

  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id TEXT PRIMARY KEY,
    quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    answers TEXT NOT NULL,
    results TEXT NOT NULL,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS paths (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    audience TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS diagrams (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    focus TEXT NOT NULL DEFAULT '',
    repo_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    error TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    source_hash TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    pending_workflow_id TEXT,
    pending_sources TEXT NOT NULL DEFAULT '[]',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'mermaid',
    style TEXT NOT NULL DEFAULT 'mermaid',
    cloud TEXT NOT NULL DEFAULT '',
    lead_agent TEXT NOT NULL DEFAULT '',
    trust_tools INTEGER NOT NULL DEFAULT 0,
    workflow_id TEXT,
    ingested_run_id TEXT,
    UNIQUE (project_id, slug)
  );
  CREATE INDEX IF NOT EXISTS diagrams_pending ON diagrams(pending_workflow_id);
  CREATE INDEX IF NOT EXISTS diagrams_workflow ON diagrams(workflow_id);

  CREATE TABLE IF NOT EXISTS diagram_versions (
    diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    mermaid TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    citations TEXT NOT NULL DEFAULT '[]',
    sources TEXT NOT NULL DEFAULT '[]',
    source_hash TEXT,
    workflow_id TEXT,
    run_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'mermaid',
    style TEXT NOT NULL DEFAULT 'mermaid',
    cloud TEXT NOT NULL DEFAULT '',
    drawio TEXT,
    stats TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (diagram_id, version)
  );

  CREATE TABLE IF NOT EXISTS doc_templates (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    info TEXT NOT NULL DEFAULT '{}',
    uploaded_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS doc_templates_scope ON doc_templates(scope, project_id, kind);

  CREATE TABLE IF NOT EXISTS presentations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL DEFAULT '',
    source_label TEXT NOT NULL DEFAULT '',
    audience TEXT NOT NULL DEFAULT '',
    slide_target INTEGER NOT NULL DEFAULT 10,
    template_id TEXT,
    template_name TEXT,
    status TEXT NOT NULL,
    error TEXT,
    workflow_id TEXT,
    run_id TEXT,
    file TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    slide_count INTEGER NOT NULL DEFAULT 0,
    outline TEXT NOT NULL DEFAULT '[]',
    warnings TEXT NOT NULL DEFAULT '[]',
    template_used TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    lead_agent TEXT NOT NULL DEFAULT '',
    trust_tools INTEGER NOT NULL DEFAULT 0,
    ingested_run_id TEXT,
    vault_name TEXT,
    diagram_style TEXT NOT NULL DEFAULT 'mermaid',
    diagram_cloud TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS presentations_project ON presentations(project_id, created_at);
  CREATE INDEX IF NOT EXISTS presentations_workflow ON presentations(workflow_id);

  CREATE TABLE IF NOT EXISTS generated_docs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT '',
    repo_ids TEXT NOT NULL DEFAULT '[]',
    include_knowledge INTEGER NOT NULL DEFAULT 1,
    include_decisions INTEGER NOT NULL DEFAULT 1,
    diagram_ids TEXT NOT NULL DEFAULT '[]',
    template_id TEXT,
    template_name TEXT,
    status TEXT NOT NULL,
    error TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    source_hash TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    stale_reasons TEXT NOT NULL DEFAULT '[]',
    pending_workflow_id TEXT,
    pending_sources TEXT NOT NULL DEFAULT '{}',
    workflow_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    lead_agent TEXT NOT NULL DEFAULT '',
    trust_tools INTEGER NOT NULL DEFAULT 0,
    ingested_run_id TEXT,
    vault_name TEXT,
    diagram_style TEXT NOT NULL DEFAULT 'mermaid',
    diagram_cloud TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS generated_docs_project ON generated_docs(project_id, updated_at);
  CREATE INDEX IF NOT EXISTS generated_docs_pending ON generated_docs(pending_workflow_id);
  CREATE INDEX IF NOT EXISTS generated_docs_workflow ON generated_docs(workflow_id);

  CREATE TABLE IF NOT EXISTS generated_doc_versions (
    doc_id TEXT NOT NULL REFERENCES generated_docs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    markdown TEXT NOT NULL,
    file TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    template_used TEXT,
    warnings TEXT NOT NULL DEFAULT '[]',
    citations TEXT NOT NULL DEFAULT '[]',
    sources TEXT NOT NULL DEFAULT '{}',
    source_hash TEXT,
    workflow_id TEXT,
    run_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (doc_id, version)
  );

  -- Permission group seed data
  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('permissions.groups', '[{"id":"admins","name":"Admins","builtIn":true},{"id":"members","name":"Members","builtIn":true}]'),
    ('permissions.rules', '[]'),
    ('provider', '"demo"'),
    ('ui.advanced', 'false');
`;

const MIGRATIONS: string[] = [M1_CORE, M2_PROJECTS, M3_SESSIONS];

export const SCHEMA_VERSION = MIGRATIONS.length;

// ── Database singleton ─────────────────────────────────────────────────────────

let db: DatabaseSync | null = null;

export function openDb(file?: string, cfg?: Config): DatabaseSync {
  const dbPath = file ?? (cfg ? `${cfg.dataDir}/portal.db` : ':memory:');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  // Migration tracking table
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY)');

  // Determine which migrations have already been applied
  const applied = new Set<number>(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map(
      (r) => r.id,
    ),
  );

  for (let i = 0; i < MIGRATIONS.length; i++) {
    const migrationId = i + 1;
    if (applied.has(migrationId)) continue;
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(migrationId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  return db;
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not opened. Call openDb() first.');
  return db;
}

export function isDbOpen(): boolean {
  return db !== null;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

// ── Query helpers ─────────────────────────────────────────────────────────────

type P = SQLInputValue | boolean | undefined;

function norm(params: P[]): SQLInputValue[] {
  return params.map((p) =>
    p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p,
  );
}

export function one<T = Row>(sql: string, ...params: P[]): T | undefined {
  return getDb().prepare(sql).get(...norm(params)) as T | undefined;
}

export function all<T = Row>(sql: string, ...params: P[]): T[] {
  return getDb().prepare(sql).all(...norm(params)) as T[];
}

export function run(
  sql: string,
  ...params: P[]
): { changes: number; lastInsertRowid: number } {
  const r = getDb().prepare(sql).run(...norm(params));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

export function tx<T>(fn: () => T): T {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** Insert a row from an object; keys are trusted column names from server code. */
export function insert(table: string, row: Record<string, P>): void {
  const keys = Object.keys(row);
  run(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ...keys.map((k) => row[k]),
  );
}

export function update(
  table: string,
  id: string,
  patch: Record<string, P>,
  idCol = 'id',
): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  run(
    `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`,
    ...keys.map((k) => patch[k]),
    id,
  );
}
