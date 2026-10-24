import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { dataPath } from './config.ts';

export type Row = Record<string, any>;

/**
 * The schema. Entry 0 is the clean baseline; a later change is a new entry appended to the list (never an edit of an
 * earlier one). A database made before the baseline was cut is refused rather than migrated (spec D-4).
 *
 * Execution model: a session (`workflows`) is a goal the portal drives through one or more iterations; each iteration is
 * one agent run (`agent_runs`, with its streamed `agent_run_events`). A "single run" is a session with
 * max_iterations = 1. Agent runs with no `workflow_id` are background tasks (agent tests, ticket analyses, reviews,
 * Learn and Knowledge model calls), kept so cost, usage and insights see every model call.
 */
const BASELINE = `
  -- Accounts and settings
  CREATE TABLE users (
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
  CREATE UNIQUE INDEX users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, hint TEXT, updated_at TEXT NOT NULL);
  CREATE TABLE api_tokens (
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
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL
  );
  CREATE INDEX api_tokens_user ON api_tokens(user_id);
  CREATE TABLE invitations (
    token_hash TEXT PRIMARY KEY,
    email TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    portal_role TEXT NOT NULL DEFAULT 'member',
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    project_access TEXT,
    team_id TEXT,
    expires_at TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    used_at TEXT,
    used_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX invitations_created ON invitations(created_by, created_at);
  CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE scim_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    hint TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT NOT NULL DEFAULT '{}',
    ip TEXT
  );
  CREATE INDEX audit_log_ts ON audit_log(ts);
  CREATE INDEX audit_log_actor ON audit_log(actor_id, ts);

  -- Teams
  CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    monthly_budget_usd REAL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE team_members (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    PRIMARY KEY (team_id, user_id)
  );
  CREATE INDEX team_members_user ON team_members(user_id);
  CREATE TABLE team_projects (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    access TEXT NOT NULL DEFAULT 'viewer',
    PRIMARY KEY (team_id, project_id)
  );
  CREATE INDEX team_projects_project ON team_projects(project_id);

  -- Projects, repositories, connections
  CREATE TABLE projects (
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
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL
  );
  CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (project_id, user_id)
  );
  CREATE TABLE project_roles (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    applied_by TEXT,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (project_id, role_key)
  );
  CREATE TABLE project_jira (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    project_key TEXT NOT NULL,
    jql TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE project_aws (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    auth TEXT NOT NULL DEFAULT 'inherit',
    profile TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'inherit',
    sso_account_id TEXT NOT NULL DEFAULT '',
    sso_role_name TEXT NOT NULL DEFAULT '',
    connection_id TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE aws_identities (
    key TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    arn TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL
  );
  CREATE TABLE aws_connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    auth TEXT NOT NULL,
    profile TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL,
    sso_account_id TEXT NOT NULL DEFAULT '',
    sso_role_name TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE git_connections (
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
  CREATE TABLE repos (
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
  CREATE TABLE workspaces (
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
  CREATE INDEX workspaces_project ON workspaces(project_id);
  CREATE TABLE integrations (
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

  -- Sessions: a goal driven through iterations; each iteration is an agent run
  CREATE TABLE workflows (
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
  CREATE INDEX workflows_project ON workflows(project_id, updated_at);
  CREATE INDEX workflows_parent ON workflows(parent_id);
  CREATE TABLE workflow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    run_id TEXT,
    body TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    consumed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX workflow_events_wf ON workflow_events(workflow_id, id);
  CREATE TABLE workflow_context (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    seen INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX workflow_context_wf ON workflow_context(workflow_id, created_at);
  CREATE TABLE loop_run_states (
    workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
    iteration INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    last_check TEXT NOT NULL DEFAULT 'null',
    summaries TEXT NOT NULL DEFAULT '[]',
    spec_snapshot TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    burst_start INTEGER NOT NULL DEFAULT 0
  );

  -- Agent runs: one model execution (a session iteration, or a background task) and its streamed events
  CREATE TABLE agent_runs (
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
  CREATE INDEX agent_runs_project ON agent_runs(project_id, created_at);
  CREATE INDEX agent_runs_workflow ON agent_runs(workflow_id, created_at);
  CREATE TABLE agent_run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    parent_tool_use_id TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX agent_run_events_run ON agent_run_events(run_id, seq);
  CREATE TABLE inputs (
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
  CREATE INDEX inputs_project ON inputs(project_id, status);

  -- Loop engineering
  CREATE TABLE loop_specs (
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
  CREATE INDEX loop_specs_project ON loop_specs(project_id);
  CREATE TABLE trigger_history (
    id TEXT PRIMARY KEY,
    spec_id TEXT NOT NULL REFERENCES loop_specs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    dedup_key TEXT,
    workflow_id TEXT,
    fired_at TEXT NOT NULL
  );
  CREATE INDEX trigger_history_spec ON trigger_history(spec_id, fired_at);
  CREATE INDEX trigger_history_dedup ON trigger_history(spec_id, dedup_key);
  CREATE TABLE loop_metrics (
    id TEXT PRIMARY KEY,
    loop_spec_id TEXT REFERENCES loop_specs(id),
    project_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    terminal_state TEXT NOT NULL,
    iterations_used INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    verif_steps_pass INTEGER NOT NULL DEFAULT 0,
    verif_steps_fail INTEGER NOT NULL DEFAULT 0,
    stagnation_hit INTEGER NOT NULL DEFAULT 0,
    human_inputs INTEGER NOT NULL DEFAULT 0,
    pr_opened INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_s INTEGER
  );
  CREATE INDEX loop_metrics_spec ON loop_metrics(loop_spec_id, started_at);
  CREATE INDEX loop_metrics_project ON loop_metrics(project_id, started_at);
  CREATE TABLE outbound_webhooks (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    secret_hint TEXT NOT NULL DEFAULT '',
    events TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Knowledge base
  CREATE TABLE documents (
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
  CREATE TABLE sections (
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
  CREATE INDEX sections_doc ON sections(doc_id, ord);
  CREATE INDEX sections_project ON sections(project_id);
  CREATE VIRTUAL TABLE sections_fts USING fts5(heading, content, tokenize = 'porter unicode61');
  CREATE TABLE project_folders (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    PRIMARY KEY (project_id, path)
  );

  -- Code review
  CREATE TABLE reviews (
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
    posted_at TEXT
  );
  CREATE TABLE findings (
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
    source TEXT NOT NULL DEFAULT 'triage'
  );

  -- Learn
  CREATE TABLE learn_docs (
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
  CREATE TABLE quizzes (
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
  CREATE TABLE quiz_attempts (
    id TEXT PRIMARY KEY,
    quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    answers TEXT NOT NULL,
    results TEXT NOT NULL,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE paths (
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
  CREATE TABLE doc_reads (
    user_id TEXT NOT NULL,
    learn_doc_id TEXT NOT NULL REFERENCES learn_docs(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL,
    PRIMARY KEY (user_id, learn_doc_id)
  );
`;

const DIAGRAMS = `
  -- Architecture diagrams (NEW-1): one row per diagram, one row per generated version
  CREATE TABLE diagrams (
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
    UNIQUE (project_id, slug)
  );
  CREATE INDEX diagrams_pending ON diagrams(pending_workflow_id);
  CREATE TABLE diagram_versions (
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
    PRIMARY KEY (diagram_id, version)
  );
`;

const TEMPLATES = `
  -- Word and PowerPoint templates (D-13): per project, with a portal-wide default. Files live in DATA_DIR/templates.
  CREATE TABLE doc_templates (
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
  CREATE INDEX doc_templates_scope ON doc_templates(scope, project_id, kind);
  -- Presentation generator (NEW-7): one row per deck, produced by an agent session
  CREATE TABLE presentations (
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
    updated_at TEXT NOT NULL
  );
  CREATE INDEX presentations_project ON presentations(project_id, created_at);
  CREATE INDEX presentations_workflow ON presentations(workflow_id);
`;

const GENERATED_DOCS = `
  -- Documentation generator (NEW-6): one row per document, one row per generated version (Markdown plus the Word file)
  CREATE TABLE generated_docs (
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
    updated_at TEXT NOT NULL
  );
  CREATE INDEX generated_docs_project ON generated_docs(project_id, updated_at);
  CREATE INDEX generated_docs_pending ON generated_docs(pending_workflow_id);
  CREATE TABLE generated_doc_versions (
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
`;

const DOCS_SYNC = `
  -- "Keep docs current" (NEW-2): the coordinating session of one firing that refreshes diagrams and documents, then
  -- publishes them as files in a work branch (docs-sync.ts). One row per firing; the session row carries the push.
  CREATE TABLE docs_sync_jobs (
    workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
    spec_id TEXT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    repo_id TEXT NOT NULL,
    status TEXT NOT NULL,
    remaining TEXT NOT NULL DEFAULT '[]',
    items TEXT NOT NULL DEFAULT '[]',
    results TEXT NOT NULL DEFAULT '{}',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX docs_sync_spec ON docs_sync_jobs(spec_id, status);
`;

const MIGRATIONS: string[] = [BASELINE, DIAGRAMS, TEMPLATES, GENERATED_DOCS, DOCS_SYNC];

/** The schema version of a database that is up to date. */
export const SCHEMA_VERSION = MIGRATIONS.length;

let db: DatabaseSync | null = null;

/** Incremented each time openDb() is called. Used by long-running async loops to detect a DB swap. */
let _dbGeneration = 0;

/** Returns the current DB generation (incremented on every openDb call). */
export function dbGeneration(): number {
  return _dbGeneration;
}

export function openDb(file = dataPath('portal.db')): DatabaseSync {
  db = new DatabaseSync(file);
  _dbGeneration++;
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const cur = (db.prepare('SELECT version FROM schema_version').get() as Row | undefined)?.version ?? 0;
  const hasRunTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'").get());
  if (cur > MIGRATIONS.length || (cur > 0 && !hasRunTable)) {
    db.close();
    db = null;
    throw new Error(`${file} was made by an older or newer build and cannot be upgraded (the schema was rebuilt from a clean baseline). Move it aside to start with an empty database.`);
  }
  for (let v = cur; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      if (v === 0 && cur === 0) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v + 1);
      else db.prepare('UPDATE schema_version SET version = ?').run(v + 1);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not opened');
  return db;
}

/** True while the database connection is open (between openDb and closeDb). */
export function isDbOpen(): boolean {
  return db !== null;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

type P = SQLInputValue | boolean | undefined;

function norm(params: P[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

export function one<T = Row>(sql: string, ...params: P[]): T | undefined {
  return getDb().prepare(sql).get(...norm(params)) as T | undefined;
}

export function all<T = Row>(sql: string, ...params: P[]): T[] {
  return getDb().prepare(sql).all(...norm(params)) as T[];
}

export function run(sql: string, ...params: P[]): { changes: number; lastInsertRowid: number } {
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

export function update(table: string, id: string, patch: Record<string, P>, idCol = 'id'): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`, ...keys.map((k) => patch[k]), id);
}
