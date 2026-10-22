import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { dataPath } from './config.ts';

export type Row = Record<string, any>;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, hint TEXT, updated_at TEXT NOT NULL);

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (project_id, user_id)
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
    UNIQUE (project_id, slug)
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
  CREATE INDEX runs_project ON runs(project_id, created_at);
  CREATE TABLE run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    parent_tool_use_id TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX run_events_run ON run_events(run_id, seq);

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
    answered_at TEXT
  );
  CREATE INDEX inputs_project ON inputs(project_id, status);

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

  CREATE TABLE project_roles (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    applied_by TEXT,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (project_id, role_key)
  );

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
  `,
  // Knowledge documents can be grouped by the folder they were uploaded from.
  `ALTER TABLE documents ADD COLUMN folder TEXT NOT NULL DEFAULT '';`,
  // ...and by the repository they belong to.
  `ALTER TABLE documents ADD COLUMN repo_id TEXT;`,
  // Virtual folders that exist even before any file is placed in them.
  `CREATE TABLE IF NOT EXISTS project_folders (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    PRIMARY KEY (project_id, path)
  );`,
  // Which Jira project (and optional extra JQL) a portal project works on.
  `CREATE TABLE IF NOT EXISTS project_jira (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    project_key TEXT NOT NULL,
    jql TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );`,
  // A project's own AWS account (for its repositories and the AWS commands agents run). Keys live in secrets.
  `CREATE TABLE IF NOT EXISTS project_aws (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    auth TEXT NOT NULL DEFAULT 'inherit',
    profile TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );`,
  // The AWS account a set of credentials turned out to belong to, so the AWS accounts screen can group by it.
  `CREATE TABLE IF NOT EXISTS aws_identities (
    key TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    arn TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL
  );`,
  // Autonomous workflow sessions: a saved goal the portal drives through repeated runs, and its history.
  `CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL,
    stop_reason TEXT NOT NULL DEFAULT '',
    repo_id TEXT,
    branch TEXT,
    model TEXT NOT NULL DEFAULT 'sonnet',
    budget_usd REAL NOT NULL DEFAULT 5,
    max_iterations INTEGER NOT NULL DEFAULT 8,
    verify_command TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL DEFAULT '',
    iteration INTEGER NOT NULL DEFAULT 0,
    burst_start INTEGER NOT NULL DEFAULT 0,
    spent_usd REAL NOT NULL DEFAULT 0,
    last_run_id TEXT,
    summary TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workflows_project ON workflows(project_id, updated_at);
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
  CREATE INDEX IF NOT EXISTS workflow_events_wf ON workflow_events(workflow_id, id);`,
  // A session can be started from a Jira ticket; it is read again at every iteration.
  `ALTER TABLE workflows ADD COLUMN jira_key TEXT NOT NULL DEFAULT '';
  ALTER TABLE workflows ADD COLUMN jira_summary TEXT NOT NULL DEFAULT '';
  ALTER TABLE workflows ADD COLUMN jira_url TEXT NOT NULL DEFAULT '';`,
  // The new branch the agent chose for a session's changes.
  `ALTER TABLE workflows ADD COLUMN work_branch TEXT NOT NULL DEFAULT '';`,
  // The project agent that leads a session (plans, delegates to the others); empty means the default main agent.
  `ALTER TABLE workflows ADD COLUMN lead_agent TEXT NOT NULL DEFAULT '';`,
  // One connection per project: its model provider, and an AWS SSO account/role picked from the portal's SSO sign-in.
  // Sessions on Kiro CLI are billed in credits, so they get a credit budget next to the dollar one.
  `ALTER TABLE project_aws ADD COLUMN provider TEXT NOT NULL DEFAULT 'inherit';
  ALTER TABLE project_aws ADD COLUMN sso_account_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE project_aws ADD COLUMN sso_role_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE workflows ADD COLUMN budget_credits REAL NOT NULL DEFAULT 20;
  ALTER TABLE workflows ADD COLUMN spent_credits REAL NOT NULL DEFAULT 0;`,
  // AWS accounts are set up once on the AWS accounts page; a project picks one of them (project_aws.connection_id).
  `CREATE TABLE IF NOT EXISTS aws_connections (
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
  ALTER TABLE project_aws ADD COLUMN connection_id TEXT NOT NULL DEFAULT '';`,
  // Material people attach to a session for its agents: documents, files, notes, links, earlier results.
  `CREATE TABLE IF NOT EXISTS workflow_context (
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
  CREATE INDEX IF NOT EXISTS workflow_context_wf ON workflow_context(workflow_id, created_at);`,
  // A session can work across several repositories: [{ repoId, branch }]; repo_id / branch keep the first one.
  `ALTER TABLE workflows ADD COLUMN repos TEXT NOT NULL DEFAULT '[]';`,
  // Reusable repository sign-ins (Connections page); a repository may use one instead of its own token.
  `CREATE TABLE IF NOT EXISTS git_connections (
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
  ALTER TABLE repos ADD COLUMN connection_id TEXT;`,
  // Named sets of a project's repositories (and integrations) to start sessions over.
  `CREATE TABLE IF NOT EXISTS workspaces (
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
  ALTER TABLE workflows ADD COLUMN workspace_id TEXT;
  ALTER TABLE workflows ADD COLUMN integrations TEXT NOT NULL DEFAULT '[]';`,
  // MCP integrations agents can use (Integrations page); secrets live in the secrets store.
  `CREATE TABLE IF NOT EXISTS integrations (
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
  );`,
  // Personal access tokens for the REST API (only their SHA-256 is kept).
  `CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'read',
    expires_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id);`,
  // The engine a session runs on ('claude' or 'kiro'); empty follows the project's connection.
  `ALTER TABLE workflows ADD COLUMN engine TEXT NOT NULL DEFAULT '';`,
  // Delegated sessions: a session can hand a task to a separate child session.
  `ALTER TABLE workflows ADD COLUMN parent_id TEXT;
  ALTER TABLE workflows ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE workflows ADD COLUMN waiting_children INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE workflows ADD COLUMN seen_by_parent INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX IF NOT EXISTS workflows_parent ON workflows(parent_id);`,
  // Agent pushes: never (default), ask (a person approves each push) or auto; a push waiting for approval.
  `ALTER TABLE workflows ADD COLUMN push_mode TEXT NOT NULL DEFAULT 'never';
  ALTER TABLE workflows ADD COLUMN pending_push TEXT NOT NULL DEFAULT '';`,
  // Playground sessions have no repository and are exempt from the repo-required rule.
  `ALTER TABLE workflows ADD COLUMN playground INTEGER NOT NULL DEFAULT 0;`,
  // Trust all tools: file edits and shell commands run without asking for approval.
  `ALTER TABLE workflows ADD COLUMN trust_tools INTEGER NOT NULL DEFAULT 0;`,
  // Project defaults for new sessions and runs: the lead agent and the model they start with ('' = none).
  `ALTER TABLE projects ADD COLUMN default_lead_agent TEXT NOT NULL DEFAULT '';
  ALTER TABLE projects ADD COLUMN default_model TEXT NOT NULL DEFAULT '';`,
  // Stage 1: Audit log (OWASP ASVS 7.2), per-user/project budget ceilings, approval SLA columns.
  `CREATE TABLE IF NOT EXISTS audit_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    actor_id TEXT,
    action   TEXT NOT NULL,
    target   TEXT,
    detail   TEXT NOT NULL DEFAULT '{}',
    ip       TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_log_ts    ON audit_log(ts);
  CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log(actor_id, ts);
  ALTER TABLE users    ADD COLUMN monthly_budget_usd REAL;
  ALTER TABLE projects ADD COLUMN monthly_budget_usd REAL;
  ALTER TABLE inputs ADD COLUMN expires_at   TEXT;
  ALTER TABLE inputs ADD COLUMN escalated_at TEXT;`,
  // Stage 1: Durable loop state — persisted per session so restarts do not reset the stagnation window.
  `CREATE TABLE IF NOT EXISTS loop_run_states (
    workflow_id   TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
    iteration     INTEGER NOT NULL DEFAULT 0,
    failures      INTEGER NOT NULL DEFAULT 0,
    last_check    TEXT NOT NULL DEFAULT 'null',
    summaries     TEXT NOT NULL DEFAULT '[]',
    spec_snapshot TEXT NOT NULL DEFAULT '{}',
    worktree_path TEXT,
    updated_at    TEXT NOT NULL
  );`,
  // Stage 1: Session lease / heartbeat columns to support multi-instance recovery.
  `ALTER TABLE workflows ADD COLUMN locked_by    TEXT;
  ALTER TABLE workflows ADD COLUMN locked_until TEXT;
  ALTER TABLE workflows ADD COLUMN heartbeat_at TEXT;`,
];

let db: DatabaseSync | null = null;

export function openDb(file = dataPath('portal.db')): DatabaseSync {
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const cur = (db.prepare('SELECT version FROM schema_version').get() as Row | undefined)?.version ?? 0;
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
