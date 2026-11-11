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

/**
 * Migration 14: Real engine columns for p6_runs.
 * Adds per-run cache token tracking so review-lifecycle.ts can read them and
 * budget_usage records have full token data. Added by the engines agent.
 */
const M14_ENGINE_CACHE_TOKENS = `
  ALTER TABLE p6_runs ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE p6_runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
`;
/**
 * Migration 15: Session IDE — uploads tracking and terminal feature flag.
 *
 * Adds the terminal.enabled portal setting (default: true) and seeds
 * nothing else — the session uploads directory is managed on-disk.
 */
const M15_SESSION_IDE = `
  INSERT OR IGNORE INTO settings (key, value) VALUES ('terminal.enabled', 'true');
`;

/**
 * Migration 16: Session lifecycle polish (F1 + F3).
 *
 * - p6_workflows.title: user-editable display name (empty → UI uses goal slice).
 * - p6_workflows.last_turn_at: ISO timestamp of the last user message or run start;
 *   drives idle-stop without keeping timer state in memory.
 * - p6_workflows.stop_reason: why the session was paused ('idle' | '' | other).
 * - p6_workflow_events: lightweight event log for p6 sessions (rename, idle-stop,
 *   slash-commands). Separate from workflow_events (which FK-references old workflows)
 *   and from p6_events (which requires a run_id).
 * - settings: session.idle_timeout_minutes (default 30, range 5–240).
 */
const M16_SESSION_LIFECYCLE = `
  ALTER TABLE p6_workflows ADD COLUMN title TEXT NOT NULL DEFAULT '';
  ALTER TABLE p6_workflows ADD COLUMN last_turn_at TEXT;
  ALTER TABLE p6_workflows ADD COLUMN stop_reason TEXT NOT NULL DEFAULT '';
  ALTER TABLE p6_workflows ADD COLUMN parent_id TEXT;

  CREATE TABLE IF NOT EXISTS p6_workflow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS p6_wf_events_wf ON p6_workflow_events(workflow_id, id);
  CREATE INDEX IF NOT EXISTS p6_workflows_parent ON p6_workflows(parent_id);

  INSERT OR IGNORE INTO settings (key, value) VALUES ('session.idle_timeout_minutes', '30');
`;

/**
 * Migration 17: Per-run model tracking.
 *
 * Adds p6_runs.model so status-bar and budget_usage can report which model
 * was actually used in each run. Engines write the model name on completion.
 */
const M17_RUN_MODEL = `
  ALTER TABLE p6_runs ADD COLUMN model TEXT;
`;

/**
 * Migration 18: Per-user engine credentials (F4) + F8 settings keys.
 *
 * - engine_credentials: stores per-user credentials for kiro and claude-code engines.
 *   mode kiro: api_key | identity_center
 *   mode claude-code: api_key | subscription_token | bedrock_role
 *   Secrets stored encrypted (AES-256-GCM via server/secrets.ts).
 * - p6_workflows.credential_id: optional FK to an engine_credentials row so runs
 *   can use a specific credential instead of the user's default or portal provider.
 * - settings keys for Claude model list and settings-change tracking (F8).
 */
const M18_ENGINE_CREDENTIALS = `
  CREATE TABLE IF NOT EXISTS engine_credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    engine TEXT NOT NULL CHECK(engine IN ('kiro','claude-code')),
    name TEXT NOT NULL,
    mode TEXT NOT NULL,
    secret_enc TEXT,
    extra_config TEXT NOT NULL DEFAULT '{}',
    is_default INTEGER NOT NULL DEFAULT 0,
    last4 TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS engine_creds_user ON engine_credentials(user_id, engine);
  ALTER TABLE p6_workflows ADD COLUMN credential_id TEXT;
  INSERT OR IGNORE INTO settings (key, value) VALUES ('claude.models', '');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('settings.last_changed_at', '');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('settings.last_changed_by', '');
`;

/**
 * Migration 19: Personal config editor (F5).
 *
 * - team_config_versions: versioned snapshots of the team default per folder
 *   (kiro / claude / aws), published by admins.
 * - user_config_state: per-user, per-folder follow state. following=1 means the user
 *   has not deviated from the latest team version; first edit sets following=0.
 */
const M19_USER_CONFIG = `
  CREATE TABLE IF NOT EXISTS team_config_versions (
    id TEXT PRIMARY KEY,
    folder TEXT NOT NULL CHECK(folder IN ('kiro','claude','aws')),
    published_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    published_at TEXT NOT NULL DEFAULT (datetime('now')),
    files_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS team_config_versions_folder ON team_config_versions(folder, published_at);

  CREATE TABLE IF NOT EXISTS user_config_state (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    folder TEXT NOT NULL CHECK(folder IN ('kiro','claude','aws')),
    following INTEGER NOT NULL DEFAULT 1,
    customised_at TEXT,
    team_version_id TEXT,
    PRIMARY KEY (user_id, folder)
  );
`;

/**
 * Migration 20: Branch Scans (F9) + Review list enhancements (F10).
 *
 * - p10_scans: branch scan records (estimate → queued → reviewing → completed/failed).
 * - p10_scan_files: per-file scan progress; unique(scan_id, file_path).
 * - p10_reviews.scan_id: links a review's findings back to its parent scan.
 * - Settings:
 *     review.fullScanUsers   — JSON array of user IDs allowed to run branch scans.
 *     review.prCommentMode   — "manual" | "automatic" portal-level default for new reviews.
 *     litellm.baseUrl        — LiteLLM gateway base URL.
 *     litellm.key.enc        — LiteLLM API key, AES-256-GCM encrypted.
 *     litellm.model          — Default model to pass to the LiteLLM gateway.
 *     litellm.showGatewayWarning — Always true; UI uses this to warn that gateway sees code.
 *
 * NOTE: M19 is reserved for the F5 config-editor agent. If M19 has not yet been
 * added when this runs, it will be applied as migration ID 19 temporarily and M20
 * will shift to ID 20 once M19 is inserted. Databases in test/dev mode are
 * re-created on each run, so this is safe for this branch.
 */
const M20_BRANCH_SCANS = `
  CREATE TABLE IF NOT EXISTS p10_scans (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    repo_id TEXT REFERENCES repositories(id),
    branch TEXT,
    pinned_sha TEXT,
    include_paths TEXT NOT NULL DEFAULT '[]',
    exclude_paths TEXT NOT NULL DEFAULT '[]',
    background_doc_ids TEXT NOT NULL DEFAULT '[]',
    model_role TEXT,
    provider_id TEXT,
    model_id TEXT,
    status TEXT NOT NULL DEFAULT 'estimating'
      CHECK(status IN ('estimating','estimate_ready','queued','fetching','reviewing','completed','failed')),
    fail_reason TEXT,
    budget_tokens INTEGER,
    estimated_files INTEGER,
    estimated_bytes INTEGER,
    estimated_tokens INTEGER,
    estimated_cost_usd REAL,
    estimated_minutes REAL,
    files_total INTEGER NOT NULL DEFAULT 0,
    files_done INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    review_id TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    workflow_id TEXT
  );
  CREATE INDEX IF NOT EXISTS p10_scans_project ON p10_scans(project_id, created_at);

  CREATE TABLE IF NOT EXISTS p10_scan_files (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL REFERENCES p10_scans(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    file_sha TEXT,
    file_size INTEGER,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','done','skipped')),
    tokens_used INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    UNIQUE(scan_id, file_path)
  );
  CREATE INDEX IF NOT EXISTS p10_scan_files_scan ON p10_scan_files(scan_id, status);

  ALTER TABLE p10_reviews ADD COLUMN scan_id TEXT;

  INSERT OR IGNORE INTO settings (key, value) VALUES ('review.fullScanUsers', '[]');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('review.prCommentMode', '"manual"');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('litellm.baseUrl', '');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('litellm.key.enc', '');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('litellm.model', '"gpt-4o"');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('litellm.showGatewayWarning', 'true');
`;

/**
 * Migration 21: Persistent working copies + consumed-event tracking.
 *
 * - p6_workflows.work_dir: absolute path to the workflow's persistent working
 *   copy directory. NULL until the first run creates and persists it; all
 *   subsequent runs reuse the same directory so artefacts survive across turns.
 * - p6_workflow_events.consumed: 0/1 flag. Set to 1 by the runner when a run
 *   has picked up the event as its prompt, ensuring each message is only used
 *   once and is not replayed on the next resume.
 * - Index: (workflow_id, consumed, id) so the runner can quickly find pending
 *   unconsumed messages without scanning the full event table.
 */
const M21_WORKDIR_CONSUMED = `
  ALTER TABLE p6_workflows ADD COLUMN work_dir TEXT;
  ALTER TABLE p6_workflow_events ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS p6_wf_events_consumed
    ON p6_workflow_events(workflow_id, consumed, id);
`;

/**
 * Migration 22: API token scope expansion (F11).
 *
 * Adds a `scopes` JSON-array column to api_tokens to support the multi-scope
 * model: read | write | review | merge.
 * The legacy `scope` TEXT column is kept for backwards compatibility.
 * Existing tokens are seeded: scope='write' → scopes=["read","write"],
 * scope='read' → scopes=["read"].
 */
const M22_TOKEN_SCOPES = `
  ALTER TABLE api_tokens ADD COLUMN scopes TEXT;
  UPDATE api_tokens SET scopes = CASE WHEN scope = 'write' THEN '["read","write"]' ELSE '["read"]' END WHERE scopes IS NULL;
`;

/**
 * Migration 23: Delegation feature settings (F7).
 *
 * Seeds the delegation control knobs into the settings table:
 *   delegation.enabled             — global on/off (default true)
 *   delegation.maxRunningPerParent — max concurrent children per parent (0–10, default 3)
 *   delegation.maxRunningPerUser   — max concurrent children per user (0–20, default 5)
 *   delegation.idleStopMinutes     — auto-stop finished children after N minutes (1–240, default 15)
 *   delegation.allowNested         — allow children to delegate further (default false)
 *   delegation.nudgeThreshold      — in-process subagent count before nudge (0–20, 0=off, default 4)
 */
const M23_DELEGATION = `
  INSERT OR IGNORE INTO settings (key, value) VALUES ('delegation.enabled', 'true');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('delegation.maxRunningPerParent', '3');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('delegation.maxRunningPerUser', '5');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('delegation.idleStopMinutes', '15');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('delegation.allowNested', 'false');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('delegation.nudgeThreshold', '4');
`;

/**
 * Migration 25: Tests Module (F12a–F12c).
 *
 * - test_projects: per-portal-project test projects with app URL, viewport, timeout, AI rules.
 * - test_vault_items: named logins (username/password/TOTP) and secrets, encrypted at rest.
 * - test_vault_files: named files for upload steps, stored on disk.
 * - test_groups: ordered groups of scripts within a test project.
 * - test_scripts: ordered steps within a group.
 * - test_runs: run records; states: queued → running → passed | failed | cancelled | error.
 * - test_run_steps: per-step status, duration, error, screenshot_path.
 * - test_generations: async AI generation/refine/import jobs.
 * - settings.test.run_concurrency: max concurrent runs (default 2).
 *
 * This entry is at array position 24 (1-based migration ID 24).
 * Delegation settings were added at position 23 as M23_DELEGATION.
 */
const M25_TESTS_MODULE = `
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

/**
 * Migration 26: Delegate token binding + SSRF setting (F7 security hardening, F12 SSRF guard).
 *
 * - api_tokens.workflow_id: binds a delegate-scoped token to a specific parent workflow so the
 *   delegate_session MCP tool can only create children of that workflow.
 * - settings.test.allowPrivateNetworks: controls whether test runs may reach loopback /
 *   private-range addresses. Cloud metadata endpoints (169.254.x.x, metadata.google.internal,
 *   etc.) are ALWAYS blocked regardless of this setting. Default: 'true' so local dev works.
 */
const M26_DELEGATE_BIND = `
  ALTER TABLE api_tokens ADD COLUMN workflow_id TEXT;
  INSERT OR IGNORE INTO settings (key, value) VALUES ('test.allowPrivateNetworks', 'true');
`;

/**
 * Migration 27: FK cascade fixes via safe copy-rebuild (SQLite cannot add FKs with ALTER).
 *
 * - p10_scans.repo_id → ON DELETE SET NULL:
 *     Deleting a repository preserves scan history; the FK reference becomes NULL
 *     so the scan record remains auditable without the repo link.
 *
 * - p6_workflow_events.workflow_id → REFERENCES p6_workflows(id) ON DELETE CASCADE:
 *     Events belong to the workflow; deleting the workflow removes its events.
 *     The column was previously TEXT NOT NULL with no FK reference, so orphaned
 *     event rows could accumulate after a parent was deleted.
 *
 * Both rebuilds follow the recommended SQLite schema-change recipe:
 *   CREATE new → INSERT SELECT → DROP old → RENAME new.
 * Foreign-key checks are disabled for the duration so the copy can proceed
 * when referential constraints don't hold on the old data.
 */
const M27_FK_CASCADES = `
  PRAGMA foreign_keys = OFF;

  -- ── Rebuild p10_scans with repo_id ON DELETE SET NULL ──────────────────────
  CREATE TABLE IF NOT EXISTS p10_scans_new (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    repo_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
    branch TEXT,
    pinned_sha TEXT,
    include_paths TEXT NOT NULL DEFAULT '[]',
    exclude_paths TEXT NOT NULL DEFAULT '[]',
    background_doc_ids TEXT NOT NULL DEFAULT '[]',
    model_role TEXT,
    provider_id TEXT,
    model_id TEXT,
    status TEXT NOT NULL DEFAULT 'estimating'
      CHECK(status IN ('estimating','estimate_ready','queued','fetching','reviewing','completed','failed')),
    fail_reason TEXT,
    budget_tokens INTEGER,
    estimated_files INTEGER,
    estimated_bytes INTEGER,
    estimated_tokens INTEGER,
    estimated_cost_usd REAL,
    estimated_minutes REAL,
    files_total INTEGER NOT NULL DEFAULT 0,
    files_done INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    review_id TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    workflow_id TEXT
  );
  INSERT OR IGNORE INTO p10_scans_new SELECT * FROM p10_scans;
  DROP TABLE p10_scans;
  ALTER TABLE p10_scans_new RENAME TO p10_scans;
  CREATE INDEX IF NOT EXISTS p10_scans_project ON p10_scans(project_id, created_at);

  -- ── Rebuild p6_workflow_events with workflow_id FK ON DELETE CASCADE ────────
  CREATE TABLE IF NOT EXISTS p6_workflow_events_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL REFERENCES p6_workflows(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    consumed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO p6_workflow_events_new
    SELECT id, workflow_id, kind, body, data, consumed, created_at
      FROM p6_workflow_events
     WHERE workflow_id IN (SELECT id FROM p6_workflows);
  DROP TABLE p6_workflow_events;
  ALTER TABLE p6_workflow_events_new RENAME TO p6_workflow_events;
  CREATE INDEX IF NOT EXISTS p6_wf_events_wf ON p6_workflow_events(workflow_id, id);
  CREATE INDEX IF NOT EXISTS p6_wf_events_consumed
    ON p6_workflow_events(workflow_id, consumed, id);

  PRAGMA foreign_keys = ON;
`;

/**
 * Migration 28: Look-and-feel themes.
 *
 * - themes: custom theme storage (built-ins live in server/themes.ts, not DB).
 * - settings: theme.active — the active theme ID (default: 'aethrix-night').
 */
const M28_THEMES = `
  CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    template_json TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO settings (key, value) VALUES ('theme.active', '"aethrix-night"');
`;

/**
 * Migration 29: AI Attachments (F-AI-Attach).
 *
 * - ai_attachments: stores files uploaded by editors for AI generation context.
 *   kind: 'image' | 'document' | 'diagram'.
 *   parent_kind/parent_id: set when linked to a diagram/doc/presentation.
 *   NULL parent means the attachment is "pending" (not yet used).
 *   Orphans (parent_id IS NULL, older than 24h) are swept by a periodic cleanup.
 *
 * - attachment_ids TEXT column added to diagrams, generated_docs, and presentations
 *   to track which attachments were staged for a run. Persists across refreshes.
 */
const M29_AI_ATTACHMENTS = `
  CREATE TABLE IF NOT EXISTS ai_attachments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('image','document','diagram')),
    file_path TEXT NOT NULL,
    parent_kind TEXT CHECK(parent_kind IN ('diagram','doc','presentation')),
    parent_id TEXT,
    uploaded_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS ai_attachments_project ON ai_attachments(project_id, created_at);
  CREATE INDEX IF NOT EXISTS ai_attachments_parent ON ai_attachments(parent_kind, parent_id);

  ALTER TABLE diagrams ADD COLUMN attachment_ids TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE generated_docs ADD COLUMN attachment_ids TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE presentations ADD COLUMN attachment_ids TEXT NOT NULL DEFAULT '[]';
`;

/**
 * Migration 30: Per-workflow model selection (F-MODEL).
 *
 * - p6_workflows.model: the model ID the user chose when creating the session.
 *   Empty or NULL means "engine default" (current behaviour).
 *   Engines receive this via AgentRun.model and pass it as --model <id> (kiro)
 *   or as the SDK model option (claude-code).
 *   Child sessions inherit the parent's model in createChildSession().
 */
const M30_WORKFLOW_MODEL = `
  ALTER TABLE p6_workflows ADD COLUMN model TEXT NOT NULL DEFAULT '';
`;

/**
 * Migration 31: Git connections v2 extensions.
 *
 * - repositories.connection_id: links a cloned repo back to the git_connections_v2
 *   row that was used to add it, enabling credential lookup during clone/fetch.
 */
const M31_GIT_CONNECTIONS_EXT = `
  ALTER TABLE repositories ADD COLUMN connection_id TEXT;
`;

/**
 * Migration 32: Test generation warnings column.
 *
 * - test_generations.warnings: JSON array of warning strings surfaced when generation
 *   partially succeeded (some steps dropped or repaired after validation failure).
 */
const M32_TEST_GENERATION_WARNINGS = `
  ALTER TABLE test_generations ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]';
`;

/**
 * Migration 33: Dashboard performance indexes (Agent Performance Dashboard).
 *
 * - idx_dash_runs_created: allows the dashboard to scan p6_runs by period
 *   without a full-table scan when joining through p6_workflows.
 * - idx_dash_events_type: speeds up per-run tool-call counting by (run_id, type).
 * - idx_dash_budget_workflow: enables fast provider lookups on budget_usage by
 *   workflow_id (the column used instead of run_id for p6 runs).
 */
const M33_DASHBOARD_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_dash_runs_created ON p6_runs(created_at);
  CREATE INDEX IF NOT EXISTS idx_dash_events_type ON p6_events(run_id, type);
  CREATE INDEX IF NOT EXISTS idx_dash_budget_workflow ON budget_usage(workflow_id);
`;

/**
 * Migration 34: Jira integration.
 *
 * - project_jira: per-project Jira connection settings.
 *   project_keys is a JSON array of allowed Jira project keys (empty = all visible).
 * - p6_workflows.jira_key / jira_summary / jira_url: ticket attached when a session
 *   is created from a Jira ticket, so the driver can load and fence the ticket each
 *   iteration.
 */
const M34_JIRA = `
  CREATE TABLE IF NOT EXISTS project_jira (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    project_keys TEXT NOT NULL DEFAULT '[]',
    jql TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  ALTER TABLE p6_workflows ADD COLUMN jira_key TEXT NOT NULL DEFAULT '';
  ALTER TABLE p6_workflows ADD COLUMN jira_summary TEXT NOT NULL DEFAULT '';
  ALTER TABLE p6_workflows ADD COLUMN jira_url TEXT NOT NULL DEFAULT '';
`;

/**
 * Migration 35: Run error storage.
 *
 * - p6_runs.error: stores a human-readable failure message when a run ends with
 *   status 'failed'. The runner's catch block writes the last 2000 characters of
 *   the error (stderr tail for engine failures, exception message for others).
 *   Cancelled runs leave this empty. Previously the error was only visible in
 *   p6_events (run-failed payload) and never queryable on the run row itself.
 */
const M35_RUN_ERROR = `
  ALTER TABLE p6_runs ADD COLUMN error TEXT NOT NULL DEFAULT '';
`;

/**
 * Migration 36: Built-in theme overrides.
 *
 * - themes.builtin_override: flag indicating this row is an admin-provided
 *   override for a built-in theme (id matches a BUILTIN_THEMES key).
 *   0 = custom theme (existing behaviour), 1 = built-in override.
 *   DEFAULT 0 fills all existing custom rows automatically.
 */
const M36_THEMES_BUILTIN_OVERRIDE = `
  ALTER TABLE themes ADD COLUMN builtin_override INTEGER NOT NULL DEFAULT 0;
`;

/**
 * Migration 37: Session output artifacts saved to the Vault.
 *
 * - vault_files.folder: nullable folder path for grouping Vault files (e.g.
 *   "Sessions/My Goal (abc12345)" for session output artifacts). NULL means
 *   the file sits at the root (existing upload behaviour).
 * - vault_files.source_workflow_id: the workflow that produced this file,
 *   used to link session output vault copies back to their session.
 * - output_files.vault_file_id: FK to the vault_files row holding the
 *   current Vault copy of this output file, enabling download fallback when
 *   the on-disk work-dir copy is no longer present.
 * - output_files.hash: SHA-256 hex digest of the file content at collection
 *   time, used to skip re-collection when content is unchanged.
 */
const M37_SESSION_OUTPUTS = `
  ALTER TABLE vault_files ADD COLUMN folder TEXT;
  ALTER TABLE vault_files ADD COLUMN source_workflow_id TEXT;
  ALTER TABLE output_files ADD COLUMN vault_file_id TEXT;
  ALTER TABLE output_files ADD COLUMN hash TEXT;
`;

/**
 * Migration 38: Engine session persistence (F-SESSION-RESUME).
 *
 * - p6_workflows.engine_session_id: the ACP/SDK session ID returned by the
 *   engine on first run. Passed back on subsequent runs to resume the session
 *   so the agent retains full conversation context across portal turns.
 * - p6_workflows.engine_session_engine: records which engine created the
 *   session ID ('kiro' or 'claude-code') so an ID is never handed to the
 *   wrong engine.
 */
const M38_ENGINE_SESSION = `
  ALTER TABLE p6_workflows ADD COLUMN engine_session_id TEXT;
  ALTER TABLE p6_workflows ADD COLUMN engine_session_engine TEXT;
`;

/**
 * Migration 39: Workspace default engine, agent, and model.
 *
 * - workspaces_v2.default_engine: '' | 'kiro' | 'claude-code' | 'demo'.
 *   Empty string means no default. A new session created from this workspace
 *   inherits this engine when the request leaves engine unspecified.
 * - workspaces_v2.default_agent: trimmed agent name (max 200 chars, same
 *   character rules as lead_agent on workflows). Empty string means no default.
 * - workspaces_v2.default_model: trimmed model ID (max 200 chars, MODEL_RE).
 *   Empty string means no default.
 *
 * Fallback order for session creation: request → workspace → project → built-in default.
 */
const M39_WORKSPACE_DEFAULTS = `
  ALTER TABLE workspaces_v2 ADD COLUMN default_engine TEXT NOT NULL DEFAULT '';
  ALTER TABLE workspaces_v2 ADD COLUMN default_agent TEXT NOT NULL DEFAULT '';
  ALTER TABLE workspaces_v2 ADD COLUMN default_model TEXT NOT NULL DEFAULT '';
`;

/**
 * Migration 40: Test Case Sets (F12d).
 *
 * - test_case_sets: async-generated manual QA test case sheets per test project.
 * - test_cases: individual test case rows within a set, ordered by `ord`.
 *
 * Generation is chunked (outline → one call per category) to avoid the
 * 5-minute Kiro CLI timeout. Progress is stored as a JSON blob.
 * The `cancelled` column is a cooperative cancellation flag checked between
 * model calls; the cancel and delete endpoints set it to 1 before marking
 * status = 'cancelled' or deleting the row.
 */
const M40_CASE_SETS = `
  CREATE TABLE IF NOT EXISTS test_case_sets (
    id TEXT PRIMARY KEY,
    test_project_id TEXT NOT NULL REFERENCES test_projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','running','done','failed','cancelled')),
    progress TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    warnings TEXT NOT NULL DEFAULT '[]',
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT,
    cancelled INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS test_case_sets_project ON test_case_sets(test_project_id, created_at);

  CREATE TABLE IF NOT EXISTS test_cases (
    id TEXT PRIMARY KEY,
    case_set_id TEXT NOT NULL REFERENCES test_case_sets(id) ON DELETE CASCADE,
    ord REAL NOT NULL DEFAULT 0,
    test_id TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    scenario TEXT NOT NULL DEFAULT '',
    precondition TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '',
    expected_result TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '' CHECK(status IN ('','Pass','Fail','Blocked','Not Run')),
    remarks TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS test_cases_case_set ON test_cases(case_set_id, ord);
`;

/**
 * Migration 41: Generation trace steps + request/response on test cases.
 *
 * trace_steps: ordered trace of AI operations for case-set and script generations.
 *   - case_set_id  or generation_id is non-null (polymorphic FK, exactly one set).
 *   - ON DELETE CASCADE from their respective parent tables handles cleanup.
 *   - status 'running' means the step is currently in progress.
 *   - prompt stores {system, user} once per context step; subsequent steps omit
 *     system to avoid storing the same large attachment text repeatedly.
 *   - output and prompt fields are capped at 20k chars; output_truncated flags cuts.
 *
 * test_cases: two new nullable JSON columns.
 *   - request: { method, url, headers?, body? } — filled only for API test cases.
 *   - response: { status?, headers?, body? }    — filled only for API test cases.
 */
const M41_TRACE_REQUEST_RESPONSE = `
  CREATE TABLE IF NOT EXISTS trace_steps (
    id TEXT PRIMARY KEY,
    case_set_id TEXT REFERENCES test_case_sets(id) ON DELETE CASCADE,
    generation_id TEXT REFERENCES test_generations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running'
      CHECK(status IN ('running','ok','retry','failed','skipped')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER,
    detail TEXT NOT NULL DEFAULT '{}',
    prompt TEXT,
    output TEXT,
    output_truncated INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS trace_steps_case_set ON trace_steps(case_set_id, seq);
  CREATE INDEX IF NOT EXISTS trace_steps_generation ON trace_steps(generation_id, seq);

  ALTER TABLE test_cases ADD COLUMN request TEXT;
  ALTER TABLE test_cases ADD COLUMN response TEXT;
`;

/**
 * Migration 42: Generation progress tracking + cancellation flag (F12c hardening).
 *
 * - test_generations.progress: JSON blob tracking generation phase for live UI.
 *   Shape: { phase, message, percent, stepsSoFar }.
 *   DEFAULT '{}' fills all existing rows automatically.
 *
 * - test_generations.started_at: wall-clock timestamp when runGeneration first
 *   set status='running', distinct from created_at (which is the POST time).
 *
 * - test_generations.cancelled_at: non-null when a user cancel request was
 *   accepted. The existing CHECK constraint only allows
 *   'pending'|'running'|'done'|'failed' and cannot be modified via ALTER COLUMN.
 *   Rather than rebuilding the table — which would require careful PRAGMA work
 *   to avoid breaking the trace_steps FK that references test_generations (M41)
 *   — cancellation is stored in this separate column. The API layer derives
 *   status='cancelled' whenever cancelled_at IS NOT NULL.
 *
 *   Startup recovery now excludes cancelled_at IS NOT NULL rows so that a
 *   mid-cancel process restart does not additionally mark them as failed.
 */
const M42_GENERATION_PROGRESS = `
  ALTER TABLE test_generations ADD COLUMN progress TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE test_generations ADD COLUMN started_at TEXT;
  ALTER TABLE test_generations ADD COLUMN cancelled_at TEXT;
`;

/**
 * Migration 43: Resume/retry support for AI work (F12d-resume, F12c-retry, F8-retry).
 *
 * test_case_sets:
 *   - outline_categories: JSON string[] saved after the outline step so a
 *     resume knows which categories to skip if they already have cases.
 *   - attachment_ids: JSON string[]. Attachment IDs are now kept on the row
 *     (not deleted in the generation finally block) so resume can reuse them.
 *
 * test_generations:
 *   - group_id: target group for 'generate' kind, needed to replay the run.
 *   - attachment_ids: kept across failure so retry can reuse them.
 *
 * generated_docs:
 *   - workflow_id: FK to p6_workflows — tracks the most-recent generation run.
 *   - status TEXT DEFAULT 'ready': 'generating' while a workflow is live,
 *     'ready' on success, 'error' on failure.
 *   - error TEXT: last failure message.
 *
 * presentations:
 *   - status TEXT DEFAULT 'ready': same three-state pattern.
 *   - error TEXT: last failure message.
 *
 * diagrams: no schema change needed; status/error columns already exist.
 */
const M43_RESUME_RETRY = `
  ALTER TABLE test_case_sets ADD COLUMN outline_categories TEXT;
  ALTER TABLE test_case_sets ADD COLUMN attachment_ids TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE test_generations ADD COLUMN group_id TEXT;
  ALTER TABLE test_generations ADD COLUMN attachment_ids TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE generated_docs ADD COLUMN workflow_id TEXT REFERENCES p6_workflows(id);
  ALTER TABLE generated_docs ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
  ALTER TABLE generated_docs ADD COLUMN error TEXT;
  ALTER TABLE presentations ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
  ALTER TABLE presentations ADD COLUMN error TEXT;
`;

/**
 * Migration 44: Approvals — add fingerprint, status, expiry, and payload columns to p6_inputs.
 *
 * Enables exact-call binding (FR-GUARD-8): the server stores a SHA-256 fingerprint of
 * every tool call, shows deciding fields whole, enforces expiry, and allows only the
 * exact call the person reviewed. Also adds project_id for AgentCore container polling.
 */
const M44_APPROVAL_BINDING = `
  ALTER TABLE p6_inputs ADD COLUMN type TEXT NOT NULL DEFAULT 'approval';
  ALTER TABLE p6_inputs ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE p6_inputs ADD COLUMN project_id TEXT;
  ALTER TABLE p6_inputs ADD COLUMN payload TEXT;
  ALTER TABLE p6_inputs ADD COLUMN input_hash TEXT;
  ALTER TABLE p6_inputs ADD COLUMN expires_at TEXT;
  ALTER TABLE p6_inputs ADD COLUMN answered_at TEXT;
  ALTER TABLE p6_inputs ADD COLUMN answered_by TEXT;
`;

/**
 * Migration 45: Run limits — spend cap, working-time limit, and per-run stop reason.
 *
 * Adds stop_reason and time_limit_at to p6_runs so that budget/time stops are recorded
 * and visible in the UI and reports. Adds optional per-workflow budget_usd and
 * run_timeout_minutes overrides (FR-GUARD-10).
 */
const M45_RUN_LIMITS = `
  ALTER TABLE p6_runs ADD COLUMN stop_reason TEXT;
  ALTER TABLE p6_runs ADD COLUMN time_limit_at TEXT;
  ALTER TABLE p6_workflows ADD COLUMN budget_usd REAL;
  ALTER TABLE p6_workflows ADD COLUMN run_timeout_minutes REAL;
`;

/**
 * Migration 46: Loop sessions — the state of an iterating session (rules, failures, summaries, progress). '' = not a loop.
 */
const M46_LOOP_STATE = `
  ALTER TABLE p6_workflows ADD COLUMN loop_state TEXT NOT NULL DEFAULT '';
`;

/**
 * Migration 47: Feedback from portal users (sorted by admins, optionally handed to a session).
 */
const M47_FEEDBACK = `
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_name TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    page TEXT,
    status TEXT NOT NULL,
    admin_note TEXT,
    project_id TEXT,
    workflow_id TEXT,
    repo_id TEXT,
    branch TEXT,
    pr_url TEXT,
    pr_number INTEGER,
    decision_note TEXT,
    decided_by_name TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS feedback_user ON feedback(user_id, created_at);
`;

/**
 * Migration 48 (schema_migrations id 47 — there is no M24): Kiro credits kept apart from dollars.
 *
 * Kiro bills in credits. Runs and budget rows used to store the credit count in cost_usd, so it was shown
 * (and budgeted) as dollars. Credits get their own column; existing Kiro rows are moved over.
 */
const M48_KIRO_CREDITS = `
  ALTER TABLE p6_runs ADD COLUMN credits REAL NOT NULL DEFAULT 0;
  ALTER TABLE budget_usage ADD COLUMN credits REAL NOT NULL DEFAULT 0;
  UPDATE p6_runs SET credits = cost_usd, cost_usd = 0
    WHERE cost_usd > 0 AND workflow_id IN (SELECT id FROM p6_workflows WHERE engine = 'kiro');
  UPDATE budget_usage SET credits = cost_usd, cost_usd = 0 WHERE provider = 'kiro' AND cost_usd > 0;
`;

/** Expand only the engine CHECK; keep workflow rows, child foreign keys, and indexes intact.
 * SQLite's documented schema-edit procedure avoids dropping this heavily referenced table.
 */
export function migrateCodexEngine(database: DatabaseSync): void {
  const row = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'p6_workflows'").get() as { sql: string };
  const before = "CHECK(engine IN ('claude-code','kiro','demo'))";
  const after = "CHECK(engine IN ('claude-code','kiro','codex','demo'))";
  if (row.sql.includes(after)) return;
  if (!row.sql.includes(before)) throw new Error('Unexpected workflow engine constraint');
  const version = Number((database.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version);
  database.exec('PRAGMA writable_schema = ON');
  try {
    database.prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = 'p6_workflows'").run(row.sql.replace(before, after));
    database.exec('PRAGMA schema_version = ' + (version + 1));
  } finally {
    database.exec('PRAGMA writable_schema = RESET');
  }
  const check = database.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  if (check.integrity_check !== 'ok') throw new Error('Codex schema migration integrity check failed');
}

const M50_CODEX_CLOUD = `
  CREATE TABLE IF NOT EXISTS codex_connections (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    version INTEGER NOT NULL,
    lease_owner TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS codex_oauth_attempts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state_hash TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS codex_oauth_expiry ON codex_oauth_attempts(expires_at);
`;

export function migrateCodexConfig(database: DatabaseSync): void {
  const before = "CHECK(folder IN ('kiro','claude','aws'))";
  const after = "CHECK(folder IN ('kiro','claude','codex','aws'))";
  const version = Number((database.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version);
  database.exec('PRAGMA writable_schema = ON');
  try {
    for (const name of ['user_config_state', 'team_config_versions']) {
      const row = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) as { sql: string };
      if (row.sql.includes(after)) continue;
      if (!row.sql.includes(before)) throw new Error('Unexpected configuration folder constraint');
      database.prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = ?").run(row.sql.replace(before, after), name);
    }
    database.exec('PRAGMA schema_version = ' + (version + 1));
  } finally { database.exec('PRAGMA writable_schema = RESET'); }
  if ((database.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check !== 'ok') throw new Error('Codex setup migration integrity check failed');
}

/**
 * API simulation tables (docs/plans/2026-11-10-api-simulation.md).
 */
const M52_API_SIMULATION = `
  CREATE TABLE IF NOT EXISTS sim_apis (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    source_key TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'mock' CHECK(mode IN ('mock','hybrid','live')),
    live_base_url TEXT NOT NULL DEFAULT '',
    require_explicit_rule INTEGER NOT NULL DEFAULT 0,
    operation_modes TEXT NOT NULL DEFAULT '{}',
    approved_version INTEGER NOT NULL DEFAULT 0,
    latest_version INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sim_apis_project ON sim_apis(project_id);

  CREATE TABLE IF NOT EXISTS sim_spec_versions (
    api_id TEXT NOT NULL REFERENCES sim_apis(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved')),
    spec_json TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (api_id, version)
  );

  CREATE TABLE IF NOT EXISTS sim_rules (
    id TEXT PRIMARY KEY,
    api_id TEXT NOT NULL REFERENCES sim_apis(id) ON DELETE CASCADE,
    rule_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sim_rules_api ON sim_rules(api_id);
`;

/**
 * The API simulation tables, checked on every start instead of trusting a migration number. Migration numbers are
 * positions in the list above, so two branches that each add one claim the same number, and a database that has met the
 * other branch skips this one. Everything here is idempotent: it creates what is missing and changes nothing else.
 */
function ensureApiSimSchema(database: DatabaseSync): void {
  database.exec(M52_API_SIMULATION);
  const columns = (table: string): Set<string> =>
    new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  // A group name on each API (the client or document it came from).
  if (!columns('sim_apis').has('group_name')) database.exec("ALTER TABLE sim_apis ADD COLUMN group_name TEXT NOT NULL DEFAULT ''");
  // A label on each version, for example the document version "v1.9".
  if (!columns('sim_spec_versions').has('label')) database.exec("ALTER TABLE sim_spec_versions ADD COLUMN label TEXT NOT NULL DEFAULT ''");
  database.exec('CREATE INDEX IF NOT EXISTS sim_apis_group ON sim_apis(project_id, group_name)');
  // Whether the call log keeps request and response bodies (off unless a person turns it on), and the live API's login,
  // encrypted (see secrets.ts).
  if (!columns('sim_apis').has('log_bodies')) database.exec('ALTER TABLE sim_apis ADD COLUMN log_bodies INTEGER NOT NULL DEFAULT 0');
  if (!columns('sim_apis').has('live_headers_enc')) database.exec('ALTER TABLE sim_apis ADD COLUMN live_headers_enc TEXT');
  // The environments of the API (dev, UAT, prod: base URL, variables, login), encrypted (see api-sim/environments.ts).
  if (!columns('sim_apis').has('environments_enc')) database.exec('ALTER TABLE sim_apis ADD COLUMN environments_enc TEXT');
  database.exec(`
    CREATE TABLE IF NOT EXISTS sim_calls (
      id TEXT PRIMARY KEY,
      api_id TEXT NOT NULL REFERENCES sim_apis(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      via TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      mode TEXT NOT NULL,
      source TEXT NOT NULL,
      rule_id TEXT,
      warnings INTEGER NOT NULL DEFAULT 0,
      ms INTEGER NOT NULL DEFAULT 0,
      request_text TEXT,
      response_text TEXT
    );
    CREATE INDEX IF NOT EXISTS sim_calls_api_at ON sim_calls(api_id, at);
    CREATE TABLE IF NOT EXISTS sim_records (
      api_id TEXT NOT NULL REFERENCES sim_apis(id) ON DELETE CASCADE,
      collection TEXT NOT NULL,
      rec_key TEXT NOT NULL,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (api_id, collection, rec_key)
    );
  `);
}

const MIGRATIONS: Array<string | ((database: DatabaseSync) => void)> = [M1_CORE, M2_PROJECTS, M3_SESSIONS, M4_PERMISSIONS, M5_REPOS, M6_SESSIONS, M7_KNOWLEDGE, M8_REVIEW_LOOPS, M9_DOCS_PRESENTATIONS, M10_ADMIN_INSIGHTS_LEARN, M11_INTEGRATIONS_AWS, M12_REVIEW_UPGRADE, M13_REVIEW_KIND_RAWOUTPUT, M14_ENGINE_CACHE_TOKENS, M15_SESSION_IDE, M16_SESSION_LIFECYCLE, M17_RUN_MODEL, M18_ENGINE_CREDENTIALS, M19_USER_CONFIG, M20_BRANCH_SCANS, M21_WORKDIR_CONSUMED, M22_TOKEN_SCOPES, M23_DELEGATION, M25_TESTS_MODULE, M26_DELEGATE_BIND, M27_FK_CASCADES, M28_THEMES, M29_AI_ATTACHMENTS, M30_WORKFLOW_MODEL, M31_GIT_CONNECTIONS_EXT, M32_TEST_GENERATION_WARNINGS, M33_DASHBOARD_INDEXES, M34_JIRA, M35_RUN_ERROR, M36_THEMES_BUILTIN_OVERRIDE, M37_SESSION_OUTPUTS, M38_ENGINE_SESSION, M39_WORKSPACE_DEFAULTS, M40_CASE_SETS, M41_TRACE_REQUEST_RESPONSE, M42_GENERATION_PROGRESS, M43_RESUME_RETRY, M44_APPROVAL_BINDING, M45_RUN_LIMITS, M46_LOOP_STATE, M47_FEEDBACK, M48_KIRO_CREDITS, migrateCodexEngine, M50_CODEX_CLOUD, migrateCodexConfig, M52_API_SIMULATION];

MIGRATIONS.push(`CREATE TABLE IF NOT EXISTS automation_records (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_key TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (project_id, entity_key)
);
ALTER TABLE p6_workflows ADD COLUMN initial_goal TEXT;
UPDATE p6_workflows SET initial_goal = goal;
`);

// IDs are array positions (1-based): M1_CORE=1, ..., M43_RESUME_RETRY=42, M44_APPROVAL_BINDING=43, M45_RUN_LIMITS=44.
// A workspace can start its sessions with "Trust all tools" already ticked.
MIGRATIONS.push(`ALTER TABLE workspaces_v2 ADD COLUMN default_trust_tools INTEGER NOT NULL DEFAULT 0;`);

export const SCHEMA_VERSION = MIGRATIONS.length; // = 42

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
      // Split the migration into individual statements so ALTER TABLE ADD COLUMN
      // can be made idempotent: SQLite has no IF NOT EXISTS for column additions,
      // so we skip "duplicate column name" errors rather than rolling back.
      const migration = MIGRATIONS[i];
      if (typeof migration === 'function') migration(db);
      const stmts = (typeof migration === 'string' ? migration : '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of stmts) {
        try {
          db.exec(stmt);
        } catch (stmtErr: unknown) {
          const msg = (stmtErr as Error)?.message ?? '';
          // If the column already exists (e.g. from a partial earlier run), skip it.
          const isAddColumn = /^\s*alter\s+table\b.+\badd\s+column\b/i.test(stmt);
          if (isAddColumn && /duplicate column name/i.test(msg)) continue;
          throw stmtErr;
        }
      }
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

  ensureApiSimSchema(db);

  // Startup recovery: any workflow or run that was left 'running' when the
  // previous process stopped (crash, SIGKILL, restart) will never complete.
  // Flip them to 'failed' so they are not stuck forever. This is idempotent —
  // rows already in a terminal state are unaffected by the WHERE clause.
  db.exec(`
    UPDATE p6_workflows
       SET status = 'failed', updated_at = datetime('now')
     WHERE status = 'running';

    UPDATE p6_runs
       SET status = 'failed', finished_at = datetime('now')
     WHERE status IN ('pending', 'running') AND finished_at IS NULL;

    UPDATE p10_loop_runs
       SET status = 'failed'
     WHERE status = 'running';

    UPDATE p10_scans
       SET status = 'failed'
     WHERE status IN ('estimating', 'queued', 'fetching', 'reviewing');

    UPDATE p10_reviews
       SET status = 'failed'
     WHERE status IN ('running', 'pending');

    UPDATE repositories
       SET status = 'error', last_error = 'Interrupted by server restart'
     WHERE status = 'cloning';

    UPDATE test_runs
       SET status = 'error', finished_at = datetime('now')
     WHERE status IN ('queued', 'running');

    UPDATE test_generations
       SET status = 'failed',
           error = 'Interrupted by a server restart. Start the generation again.',
           finished_at = datetime('now'),
           progress = '{}'
     WHERE status IN ('pending', 'running') AND cancelled_at IS NULL;

    UPDATE test_case_sets
       SET status = 'failed',
           error = 'Interrupted by server restart',
           finished_at = datetime('now')
     WHERE status IN ('pending', 'running');

    UPDATE trace_steps
       SET status = 'failed',
           error = 'Interrupted by server restart',
           finished_at = datetime('now'),
           duration_ms = NULL
     WHERE status = 'running';

    UPDATE diagrams
       SET status = 'error',
           error = 'Interrupted by server restart'
     WHERE status = 'generating';

    UPDATE generated_docs
       SET status = 'failed',
           error = 'Interrupted by server restart'
     WHERE status = 'generating';

    UPDATE presentations
       SET status = 'failed',
           error = 'Interrupted by server restart'
     WHERE status = 'generating';
  `);

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
  // Abort all active runs before closing so background executeRun tasks do not
  // insert into a subsequent in-memory database (which would cause FK violations).
  if (_beforeCloseHook) {
    try { _beforeCloseHook(); } catch { /* ignore */ }
  }
  db?.close();
  db = null;
}

// ── Before-close hook ─────────────────────────────────────────────────────────

/**
 * Register a callback to run immediately before the database is closed.
 * Used by the run driver to abort all active background runs (controls.ts).
 * Only one hook is supported; repeated calls replace the previous registration.
 */
let _beforeCloseHook: (() => void) | null = null;

export function setBeforeCloseHook(fn: () => void): void {
  _beforeCloseHook = fn;
}

// ── Query helpers ─────────────────────────────────────────────────────────────

type P = SQLInputValue | boolean | undefined;
/** A value the query helpers accept (booleans become 0/1, undefined becomes NULL). */
export type DbParam = P;

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
