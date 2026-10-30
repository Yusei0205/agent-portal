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

/**
 * M4: Permission system — rule groups, rules, portal/project overrides, tool rules.
 * Seeded with two built-in groups: 'core-safe' (always blocked) and 'standard'.
 */
const M4_PERMISSIONS = `
  CREATE TABLE IF NOT EXISTS permission_rule_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS permission_rules (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES permission_rule_groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    pattern TEXT,
    category TEXT,
    action TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'always',
    reason TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS permission_rules_group ON permission_rules(group_id, sort_order);

  CREATE TABLE IF NOT EXISTS portal_permissions (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    default_group_id TEXT NOT NULL DEFAULT 'standard',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_permissions (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    rule_group_id TEXT NOT NULL REFERENCES permission_rule_groups(id),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_tool_rules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    action TEXT NOT NULL,
    command_pattern TEXT,
    scope TEXT NOT NULL DEFAULT 'always',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS project_tool_rules_project ON project_tool_rules(project_id);

  -- Built-in groups
  INSERT OR IGNORE INTO permission_rule_groups (id, name, description, is_builtin, created_at, updated_at) VALUES
    ('core-safe', 'Core Safe', 'Commands that are always blocked regardless of trust level', 1, datetime('now'), datetime('now')),
    ('standard', 'Standard', 'Default permission rules for most projects', 1, datetime('now'), datetime('now'));

  -- Core-safe rules (scope=always): always blocked, cannot be overridden by trusted flag
  INSERT OR IGNORE INTO permission_rules (id, group_id, name, pattern, category, action, scope, reason, sort_order, created_at, updated_at) VALUES
    ('core-safe-1', 'core-safe', 'Block cdk deploy', '^cdk deploy', NULL, 'block', 'always', 'CDK deployments require manual approval outside the portal', 10, datetime('now'), datetime('now')),
    ('core-safe-2', 'core-safe', 'Block cdk destroy', '^cdk destroy', NULL, 'block', 'always', 'CDK destroy requires manual approval outside the portal', 20, datetime('now'), datetime('now')),
    ('core-safe-3', 'core-safe', 'Block aws delete', '^aws .*(delete|remove|destroy)', NULL, 'block', 'always', 'Destructive AWS CLI calls require manual approval', 30, datetime('now'), datetime('now')),
    ('core-safe-4', 'core-safe', 'Block rm -rf', 'rm\s+-[a-zA-Z]*r[a-zA-Z]*f|rm\s+-[a-zA-Z]*f[a-zA-Z]*r', NULL, 'block', 'always', 'Recursive force delete is not allowed in agent runs', 40, datetime('now'), datetime('now'));

  -- Standard group rules
  INSERT OR IGNORE INTO permission_rules (id, group_id, name, pattern, category, action, scope, reason, sort_order, created_at, updated_at) VALUES
    ('std-1', 'standard', 'Block cdk deploy', '^cdk deploy', NULL, 'block', 'always', 'CDK deployments require manual approval outside the portal', 10, datetime('now'), datetime('now')),
    ('std-2', 'standard', 'Block cdk destroy', '^cdk destroy', NULL, 'block', 'always', 'CDK destroy requires manual approval', 20, datetime('now'), datetime('now')),
    ('std-3', 'standard', 'Ask git push (untrusted)', '^git push', NULL, 'ask', 'untrusted', 'Git push requires confirmation in untrusted runs', 30, datetime('now'), datetime('now')),
    ('std-4', 'standard', 'Ask git commit (untrusted)', '^git commit', NULL, 'ask', 'untrusted', 'Git commit requires confirmation in untrusted runs', 40, datetime('now'), datetime('now')),
    ('std-5', 'standard', 'Block aws destructive', '^aws .*(delete|remove|destroy)', NULL, 'block', 'always', 'Destructive AWS CLI calls require manual approval', 50, datetime('now'), datetime('now'));

  -- Default portal permission row
  INSERT OR IGNORE INTO portal_permissions (id, default_group_id, updated_at) VALUES
    (1, 'standard', datetime('now'));
`;

/**
 * Migration 5: P4 repositories, git_connections (simplified), and workspaces tables.
 * The M2 tables (repos, git_connections, workspaces) are for the legacy model.
 * These new tables use cleaner names and schemas for the greenfield rebuild.
 */
const M5_REPOS = `
  CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    default_branch TEXT,
    identity TEXT,
    last_synced_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS repositories_project ON repositories(project_id);

  CREATE TABLE IF NOT EXISTS git_connections_v2 (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    credentials_enc TEXT,
    scope TEXT NOT NULL DEFAULT 'personal',
    owner_id TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS git_connections_v2_owner ON git_connections_v2(owner_id);

  CREATE TABLE IF NOT EXISTS workspaces_v2 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    repo_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS workspaces_v2_project ON workspaces_v2(project_id);
`;

/**
 * Migration 6: P6 sessions (workflows), runs, run events, approval inputs, inbox.
 * The M3 tables cover the full reference model; these are the greenfield rebuild
 * tables that the P6 code exclusively uses (simpler schema, no legacy fields).
 */
const M6_SESSIONS = `
  CREATE TABLE IF NOT EXISTS p6_workflows (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','running','done','blocked','failed','paused')),
    engine TEXT NOT NULL DEFAULT 'claude-code'
      CHECK(engine IN ('claude-code','kiro','demo')),
    trust_tools INTEGER NOT NULL DEFAULT 0,
    lead_agent TEXT,
    workspace_id TEXT,
    output_files_enabled INTEGER NOT NULL DEFAULT 0,
    repo_ids TEXT NOT NULL DEFAULT '[]',
    iteration_count INTEGER NOT NULL DEFAULT 0,
    max_iterations INTEGER NOT NULL DEFAULT 10,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS p6_workflows_project ON p6_workflows(project_id, updated_at);

  CREATE TABLE IF NOT EXISTS p6_runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES p6_workflows(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','running','done','failed','cancelled')),
    started_at TEXT,
    finished_at TEXT,
    cost_usd REAL DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS p6_runs_workflow ON p6_runs(workflow_id, created_at);

  CREATE TABLE IF NOT EXISTS p6_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES p6_runs(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS p6_events_run ON p6_events(run_id, id);

  CREATE TABLE IF NOT EXISTS p6_inputs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES p6_runs(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    tool_input TEXT,
    response TEXT,
    allow_all INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS p6_inputs_run ON p6_inputs(run_id);

  CREATE TABLE IF NOT EXISTS p6_inbox (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    workflow_id TEXT REFERENCES p6_workflows(id),
    run_id TEXT REFERENCES p6_runs(id),
    type TEXT NOT NULL CHECK(type IN ('approval','question','push','blocked','review-ready')),
    payload TEXT NOT NULL DEFAULT '{}',
    resolved INTEGER NOT NULL DEFAULT 0,
    resolved_by TEXT REFERENCES users(id),
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS p6_inbox_project ON p6_inbox(project_id, resolved);
`;

/**
 * Migration 7: P7 Knowledge base, vault files, output files.
 */
const M7_KNOWLEDGE = `
  CREATE TABLE IF NOT EXISTS knowledge_docs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    markdown_path TEXT,
    status TEXT NOT NULL DEFAULT 'processing'
      CHECK(status IN ('processing','ready','error')),
    error TEXT,
    uploaded_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS knowledge_docs_project ON knowledge_docs(project_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_search
    USING fts5(doc_id UNINDEXED, content);

  CREATE TABLE IF NOT EXISTS knowledge_decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    asked_by TEXT REFERENCES users(id),
    answered_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS knowledge_decisions_project ON knowledge_decisions(project_id);

  CREATE TABLE IF NOT EXISTS vault_files (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    user_id TEXT,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    size_bytes INTEGER,
    mime_type TEXT,
    uploaded_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS vault_files_project ON vault_files(project_id);
  CREATE INDEX IF NOT EXISTS vault_files_user ON vault_files(user_id);

  CREATE TABLE IF NOT EXISTS output_files (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES p6_workflows(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES p6_runs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    size_bytes INTEGER,
    mime_type TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    refused_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS output_files_workflow ON output_files(workflow_id);
  CREATE INDEX IF NOT EXISTS output_files_run ON output_files(run_id);
`;

/**
 * Migration 8: P10 Code Review tables (reviews, findings) with new schema columns,
 * Loop Specs and Loop Runs tables for the greenfield rebuild.
 * Seeded with 7 built-in loop spec templates.
 */
const M8_REVIEW_LOOPS = `
  CREATE TABLE IF NOT EXISTS p10_reviews (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    base_ref TEXT NOT NULL,
    head_ref TEXT NOT NULL,
    pr_number INTEGER,
    repo_id TEXT REFERENCES repositories(id),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','running','done','failed')),
    post_mode TEXT NOT NULL DEFAULT 'draft'
      CHECK(post_mode IN ('draft','auto')),
    from_loop TEXT,
    workflow_id TEXT REFERENCES p6_workflows(id),
    min_severity TEXT NOT NULL DEFAULT 'medium',
    summary TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS p10_reviews_project ON p10_reviews(project_id, created_at);

  CREATE TABLE IF NOT EXISTS p10_findings (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL REFERENCES p10_reviews(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    line_number INTEGER,
    severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    confidence REAL,
    accepted INTEGER NOT NULL DEFAULT 0,
    posted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS p10_findings_review ON p10_findings(review_id);

  CREATE TABLE IF NOT EXISTS p10_loop_specs (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    name TEXT NOT NULL,
    description TEXT,
    trigger_type TEXT NOT NULL
      CHECK(trigger_type IN ('manual','cron','interval','webhook','github','jira')),
    trigger_config TEXT NOT NULL DEFAULT '{}',
    goal_template TEXT NOT NULL,
    rules TEXT,
    stop_config TEXT NOT NULL DEFAULT '{}',
    max_iterations INTEGER NOT NULL DEFAULT 10,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS p10_loop_specs_project ON p10_loop_specs(project_id);

  CREATE TABLE IF NOT EXISTS p10_loop_runs (
    id TEXT PRIMARY KEY,
    spec_id TEXT NOT NULL REFERENCES p10_loop_specs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'running'
      CHECK(status IN ('running','done','failed','stopped')),
    iteration INTEGER NOT NULL DEFAULT 0,
    last_workflow_id TEXT REFERENCES p6_workflows(id),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS p10_loop_runs_spec ON p10_loop_runs(spec_id, started_at);

  -- Seed 7 built-in loop specs (is_builtin=1, project_id=NULL means global/built-in)
  INSERT OR IGNORE INTO p10_loop_specs (id, project_id, name, description, trigger_type, trigger_config, goal_template, stop_config, max_iterations, is_builtin) VALUES
    ('builtin-investigate-fix', NULL, 'Investigate and fix a ticket', 'Research a ticket, reproduce it, write the RCA, fix it, and open a PR.', 'manual', '{}', 'Investigate and fix: {{ticket}}', '{"maxIterations":10,"stagnationWindow":3}', 10, 1),
    ('builtin-feature-ticket', NULL, 'Feature from Jira ticket', 'Implement a feature described in a Jira ticket. Fires when the ticket enters In Progress.', 'jira', '{"statusName":"In Progress"}', 'Implement feature from {{ticket.title}}: {{ticket.description}}', '{"maxIterations":10,"requireVerification":true}', 10, 1),
    ('builtin-bug-fix', NULL, 'Bug fix', 'Fix a bug from a Jira ticket or a direct instruction.', 'manual', '{}', 'Fix bug: {{description}}', '{"maxIterations":8,"requireVerification":true}', 8, 1),
    ('builtin-nightly-test-fixer', NULL, 'Nightly test fixer', 'Run nightly, pick up any failing tests, and open a PR with a fix.', 'cron', '{"cron":"0 2 * * *"}', 'Find and fix failing tests', '{"maxIterations":6,"budgetUsd":3,"requireVerification":true}', 6, 1),
    ('builtin-dependency-update', NULL, 'Dependency update', 'Update outdated dependencies, run tests, and open a PR.', 'cron', '{"cron":"0 3 * * 1"}', 'Update outdated dependencies and run tests', '{"maxIterations":5,"budgetUsd":2}', 5, 1),
    ('builtin-keep-docs-current', NULL, 'Keep docs current', 'When a PR is merged or nightly: refresh stale diagrams and docs, open one PR with the changes.', 'github', '{"events":["pull_request"],"mergedOnly":true,"cron":"0 1 * * *","actions":["refresh_diagrams","refresh_docs"],"publishPr":true}', 'Refresh stale architecture diagrams and documentation', '{"maxIterations":1,"budgetUsd":5}', 1, 1),
    ('builtin-review-prs', NULL, 'Review new pull requests', 'When a PR is opened, reopened, gets new commits or is marked ready for review, review it. Drafts and portal own PRs are skipped.', 'github', '{"events":["pull_request"],"action":"review_pr","postMode":"draft","minSeverity":"medium","maxComments":20}', 'Review pull request #{{pr_number}}', '{"maxIterations":1,"budgetUsd":2}', 1, 1);
`;

/**
 * Migration 9: Documents & Presentations (P9).
 * Drops the M3 legacy definitions of generated_docs, generated_doc_versions,
 * doc_templates and presentations (different schemas) and replaces them with
 * the greenfield definitions that the P9 server code uses.
 */
const M9_DOCS_PRESENTATIONS = `
  -- Drop M3 legacy versions of tables that have incompatible schemas in P9.
  -- This is safe in the greenfield rebuild (no production data yet).
  DROP TABLE IF EXISTS generated_doc_versions;
  DROP TABLE IF EXISTS generated_docs;
  DROP TABLE IF EXISTS presentations;
  DROP TABLE IF EXISTS doc_templates;

  CREATE TABLE IF NOT EXISTS generated_docs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    doc_type TEXT NOT NULL
      CHECK(doc_type IN ('overview','architecture','api','runbook','user-guide')),
    sources_json TEXT NOT NULL DEFAULT '{}',
    diagram_style TEXT NOT NULL DEFAULT 'mermaid',
    diagram_cloud TEXT,
    lead_agent TEXT,
    trust_all_tools INTEGER NOT NULL DEFAULT 0,
    audience TEXT,
    latest_version_id TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS generated_docs_project ON generated_docs(project_id, created_at);

  CREATE TABLE IF NOT EXISTS generated_doc_versions (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES generated_docs(id) ON DELETE CASCADE,
    version_num INTEGER NOT NULL DEFAULT 1,
    md_path TEXT,
    docx_path TEXT,
    warnings TEXT,
    workflow_id TEXT REFERENCES p6_workflows(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS generated_doc_versions_doc ON generated_doc_versions(doc_id, version_num);

  CREATE TABLE IF NOT EXISTS presentations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    source_kind TEXT NOT NULL
      CHECK(source_kind IN ('topic','document','session','diagram')),
    source_ref TEXT,
    topic TEXT,
    slide_count INTEGER NOT NULL DEFAULT 12,
    audience TEXT,
    diagram_style TEXT NOT NULL DEFAULT 'mermaid',
    diagram_cloud TEXT,
    lead_agent TEXT,
    trust_all_tools INTEGER NOT NULL DEFAULT 0,
    pptx_path TEXT,
    preview_json TEXT,
    workflow_id TEXT REFERENCES p6_workflows(id),
    stale INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS presentations_project ON presentations(project_id, created_at);

  CREATE TABLE IF NOT EXISTS doc_templates (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('docx','pptx')),
    path TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS doc_templates_project ON doc_templates(project_id, type);
`;

/**
 * Migration 10: Admin, Insights, Learn (P12).
 * Adds budget_usage table and doc_reads table.
 * learn_docs, quizzes, quiz_attempts, paths already created in M3.
 * Adds audience column to learn_docs and doc_type alias.
 */
const M10_ADMIN_INSIGHTS_LEARN = `
  -- Fine-grained budget tracking per run
  CREATE TABLE IF NOT EXISTS budget_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id),
    project_id TEXT REFERENCES projects(id),
    workflow_id TEXT REFERENCES p6_workflows(id),
    run_id TEXT REFERENCES agent_runs(id),
    cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    provider TEXT,
    model TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS budget_usage_project ON budget_usage(project_id, created_at);
  CREATE INDEX IF NOT EXISTS budget_usage_user ON budget_usage(user_id, created_at);

  -- doc_reads: new table not in M3
  CREATE TABLE IF NOT EXISTS doc_reads (
    learn_doc_id TEXT NOT NULL REFERENCES learn_docs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    read_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (learn_doc_id, user_id)
  );
`;

/**
 * Migration 11: MCP Integrations and AWS Accounts per project.
 */
const M11_INTEGRATIONS_AWS = `
  CREATE TABLE IF NOT EXISTS mcp_integrations (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('http','stdio','atlassian','aws','browser','drawio')),
    config_enc TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS mcp_integrations_project ON mcp_integrations(project_id);

  CREATE TABLE IF NOT EXISTS aws_accounts (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    auth_method TEXT NOT NULL CHECK(auth_method IN ('keys','profile','instance-role','sso')),
    region TEXT,
    credentials_enc TEXT,
    profile_name TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS aws_accounts_project ON aws_accounts(project_id);
`;

/**
 * Migration 12: Code Review upgrade — reproducibility, cost tracking, merge gate.
 * Adds columns to p10_reviews for: parent_review_id, source_sha, dest_sha,
 * provider_id, model_id, jira_context, run_log, token counts, duration,
 * started_at, merged_at, merged_by, head_commit_sha.
 * Seeds review.mergeThreshold and review.rateCard settings.
 */
const M12_REVIEW_UPGRADE = `
  ALTER TABLE p10_reviews ADD COLUMN parent_review_id TEXT;
  ALTER TABLE p10_reviews ADD COLUMN source_sha TEXT;
  ALTER TABLE p10_reviews ADD COLUMN dest_sha TEXT;
  ALTER TABLE p10_reviews ADD COLUMN provider_id TEXT;
  ALTER TABLE p10_reviews ADD COLUMN model_id TEXT;
  ALTER TABLE p10_reviews ADD COLUMN jira_context TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE p10_reviews ADD COLUMN run_log TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE p10_reviews ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE p10_reviews ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE p10_reviews ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE p10_reviews ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE p10_reviews ADD COLUMN llm_requests INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE p10_reviews ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE p10_reviews ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE p10_reviews ADD COLUMN files_reviewed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE p10_reviews ADD COLUMN duration_ms INTEGER;
  ALTER TABLE p10_reviews ADD COLUMN started_at TEXT;
  ALTER TABLE p10_reviews ADD COLUMN merged_at TEXT;
  ALTER TABLE p10_reviews ADD COLUMN merged_by TEXT;
  ALTER TABLE p10_reviews ADD COLUMN head_commit_sha TEXT;
  INSERT OR IGNORE INTO settings (key, value) VALUES ('review.mergeThreshold', '"high"');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('review.rateCard', '{"inputUsd":3,"outputUsd":15,"cacheWriteUsd":3.75,"cacheReadUsd":0.30}');
`;

/**
 * Migration 13: Review workflow kind + raw_output column.
 *
 * - p6_workflows.kind: explicit workflow classification ('review' for code reviews).
 *   Replaces goal-string sniffing in the demo engine and lifecycle hook.
 * - p10_reviews.raw_output: full untruncated assistant transcript for parsing/audit.
 *   The summary column now stores a bounded human-readable snippet (≤ 4 KB).
 */
const M13_REVIEW_KIND_RAWOUTPUT = `
  ALTER TABLE p6_workflows ADD COLUMN kind TEXT;
  ALTER TABLE p10_reviews ADD COLUMN raw_output TEXT;
`;

const MIGRATIONS: string[] = [M1_CORE, M2_PROJECTS, M3_SESSIONS, M4_PERMISSIONS, M5_REPOS, M6_SESSIONS, M7_KNOWLEDGE, M8_REVIEW_LOOPS, M9_DOCS_PRESENTATIONS, M10_ADMIN_INSIGHTS_LEARN, M11_INTEGRATIONS_AWS, M12_REVIEW_UPGRADE, M13_REVIEW_KIND_RAWOUTPUT];

export const SCHEMA_VERSION = MIGRATIONS.length; // = 13

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
      const err = e as Error;
      const enhanced = new Error(`Migration ${migrationId} failed: ${err.message}`);
      enhanced.stack = err.stack;
      throw enhanced;
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
