# DynamoDB Data Design for Agent Portal

Date: 2026-11-02
Author: backend-agent
Builds on: `2026-11-02-full-cloud-portal-plan.md` (section 8 decision: DynamoDB)
Region: ap-southeast-1 (Singapore)
Database: AWS DynamoDB on-demand

---

## Executive summary

The portal has 88 SQLite tables (including 2 FTS5 virtual tables) spread across 45 migrations, served by ~935 synchronous call sites in 67 files. Migrating to DynamoDB requires replacing all relational patterns — JOINs, aggregates, FTS — with DynamoDB-native equivalents.

**Recommended design:** 7-table hybrid. No single-table design (too many heterogeneous access patterns; hot-partition risk on run events). No per-table-per-entity design (80+ tables with tiny volumes; prohibitive GSI overhead).

**Pilot module:** `api-tokens` — self-contained, 3 clear access patterns, no joins, existing tests.

**Total effort:** approximately 10–15 weeks for one engineer to convert all 45 modules to the async repository layer (S1 from the migration plan) with a DynamoDB implementation wired in. The data-layer work (S1) is the critical path and can run in parallel with AgentCore work (S5).

**Key open question:** FTS replacement. The cheapest no-idle-cost option is a DynamoDB inverted index in `portal-search`. If semantic recall proves weak, Bedrock Knowledge Bases add ~$0 idle cost at very low query volumes and can replace the inverted index.

---

## 1. Inventory

Tables grouped by owning module, with the migration that introduced them, a volume class, and a large-text flag. "Large text" means fields that can exceed ~10 KB and therefore risk the DynamoDB 400 KB item limit.

Volume classes:
- **tiny/config** — tens of rows, rarely written, globally read
- **medium** — hundreds to low thousands of rows per portal, CRUD-dominant
- **append-heavy log** — rows only inserted, never updated, can grow into millions per run

### 1.1 Auth and identity (M1, M22, M26)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `users` | M1 | tiny/config | no |
| `sessions` | M1 | medium | no |
| `settings` | M1 | tiny/config | no |
| `secrets` | M1 | tiny/config | no |
| `api_tokens` | M1, M22, M26 | medium | no |
| `invitations` | M1 | medium | no |
| `password_resets` | M1 | medium | no |
| `scim_tokens` | M1 | tiny/config | no |

### 1.2 Teams, projects, and membership (M2)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `teams` | M2 | medium | no |
| `team_members` | M2 | medium | no |
| `projects` | M2 | medium | no |
| `project_members` | M2 | medium | no |
| `git_connections` (legacy) | M2 | medium | no |
| `repos` (legacy) | M2 | medium | no |
| `integrations` (legacy) | M2 | medium | no |
| `workspaces` (legacy) | M2 | medium | no |

### 1.3 Permissions (M4)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `permission_rule_groups` | M4 | tiny/config | no |
| `permission_rules` | M4 | tiny/config | no |
| `portal_permissions` | M4 | tiny/config | no |
| `project_permissions` | M4 | medium | no |
| `project_tool_rules` | M4 | medium | no |

### 1.4 Repositories and connections v2 (M5, M31)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `repositories` | M5, M31 | medium | no |
| `git_connections_v2` | M5 | medium | no |
| `workspaces_v2` | M5, M39 | medium | no |

### 1.5 Audit (M1)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `audit_log` | M1 | append-heavy log | yes (detail JSON) |

### 1.6 P6 sessions and runs — the hot path (M6, M13, M14, M16–M18, M21, M30, M34, M38, M44, M45)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `p6_workflows` | M6, M13, M16–M18, M21, M30, M34, M38, M39 (via workspaces), M45 | medium–large | yes (goal, summary) |
| `p6_runs` | M6, M14, M17, M35, M45 | medium–large | no |
| `p6_events` | M6 | **append-heavy log** | yes (payload JSON up to tens of KB) |
| `p6_inputs` (approvals) | M6, M44 | medium | yes (payload) |
| `p6_inbox` | M6 | medium | no |
| `p6_workflow_events` | M16, M21, M27 | append-heavy log | no |
| `engine_credentials` | M18 | medium | no |

### 1.7 Legacy sessions/workflows/runs (M3 — active in non-P6 paths)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `workflows` | M3 | medium | yes (goal) |
| `workflow_events` | M3 | append-heavy log | no |
| `agent_runs` | M3 | medium–large | yes (prompt) |
| `agent_run_events` | M3 | append-heavy log | yes (data JSON) |
| `inputs` | M3 | medium | yes (payload) |
| `loop_specs` | M3 | medium | yes (goal_template) |

### 1.8 Budget and insights (M10, M33)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `budget_usage` | M10 | append-heavy log | no |

### 1.9 Knowledge base (M7)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `knowledge_docs` | M7 | medium | no |
| `knowledge_search` (FTS5 virtual) | M7 | append-heavy log | **yes** (document content) |
| `knowledge_decisions` | M7 | medium | yes (answer) |
| `vault_files` | M7, M37 | medium | no |
| `output_files` | M7, M37 | medium | no |

### 1.10 Documents and sections (M3 — legacy doc pipeline)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `documents` | M3 | medium | no |
| `sections` | M3 | append-heavy log | **yes** (content field) |
| `sections_fts` (FTS5 virtual) | M3 | append-heavy log | yes |

### 1.11 AI-generated content (M9, M29, M43)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `generated_docs` | M9, M43 | medium | no |
| `generated_doc_versions` | M9 | medium | **yes** (markdown content, path to S3) |
| `presentations` | M9, M43 | medium | no |
| `doc_templates` | M9 | medium | no |
| `diagrams` | M3 | medium | no |
| `diagram_versions` | M3 | medium | **yes** (mermaid/drawio XML) |
| `ai_attachments` | M29 | medium | no |

### 1.12 Learn, quizzes, paths (M3, M10)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `learn_docs` | M3 | medium | **yes** (business_md, technical_md) |
| `quizzes` | M3 | medium | yes (questions JSON) |
| `quiz_attempts` | M3 | append-heavy log | no |
| `paths` | M3 | medium | no |
| `doc_reads` | M10 | append-heavy log | no |

### 1.13 Code reviews and scans (M8, M12, M13, M20, M27)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `p10_reviews` | M8, M12, M13 | medium | **yes** (raw_output, diff) |
| `p10_findings` | M8 | medium–large | yes (body, suggestion) |
| `p10_loop_specs` | M8 | medium | yes (goal_template) |
| `p10_loop_runs` | M8 | append-heavy log | no |
| `p10_scans` | M20, M27 | medium | no |
| `p10_scan_files` | M20 | medium–large | no |

### 1.14 Configuration (M19)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `team_config_versions` | M19 | medium | **yes** (files_json with config file content) |
| `user_config_state` | M19 | medium | no |

### 1.15 Connections, integrations, AWS (M11, M34)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `mcp_integrations` | M11 | medium | no |
| `aws_accounts` | M11 | medium | no |
| `project_jira` | M34 | medium | no |

### 1.16 Themes (M28, M36)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `themes` | M28, M36 | tiny/config | yes (template_json) |

### 1.17 Testing module (M25, M32, M40–M43)

| Table | Migration | Volume | Large text |
|---|---|---|---|
| `test_projects` | M25 | medium | no |
| `test_vault_items` | M25 | medium | no |
| `test_vault_files` | M25 | medium | no |
| `test_groups` | M25 | medium | no |
| `test_scripts` | M25 | medium | **yes** (steps JSON) |
| `test_runs` | M25 | append-heavy log | no |
| `test_run_steps` | M25 | append-heavy log | no |
| `test_generations` | M25, M32, M42, M43 | medium | no |
| `test_case_sets` | M40, M43 | medium | no |
| `test_cases` | M40 | medium–large | yes (scenario, steps, expected_result) |
| `trace_steps` | M41 | append-heavy log | **yes** (prompt, output up to 20 KB each) |

---

## 2. Access patterns

### 2.1 auth (`server/auth.ts`)

| # | Query | Pattern |
|---|---|---|
| A1 | Look up user by email (login) | `SELECT * FROM users WHERE email = ?` |
| A2 | Look up user by Google sub | `SELECT * FROM users WHERE google_sub = ?` |
| A3 | Look up session by token hash | `SELECT * FROM sessions WHERE token_hash = ?` |
| A4 | Delete expired sessions | `DELETE FROM sessions WHERE expires_at < ?` (TTL handles this in DynamoDB) |
| A5 | Count users (first-run check) | `SELECT COUNT(*) FROM users` |
| A6 | Get user by ID | `SELECT * FROM users WHERE id = ?` |

### 2.2 api-tokens (`server/api-tokens.ts`)

| # | Query | Pattern |
|---|---|---|
| B1 | List tokens for user | `SELECT * FROM api_tokens WHERE user_id = ?` |
| B2 | Look up token by hash (auth check on every request) | `SELECT * FROM api_tokens WHERE token_hash = ?` |
| B3 | Get token by ID | `SELECT * FROM api_tokens WHERE id = ?` |
| B4 | Revoke (update revoked_at) | `UPDATE api_tokens SET revoked_at = ? WHERE id = ?` |

### 2.3 permissions (`server/permissions.ts`, `server/governance/users.ts`)

| # | Query | Pattern |
|---|---|---|
| C1 | Load all rule groups | `SELECT * FROM permission_rule_groups` |
| C2 | Load rules for a group | `SELECT * FROM permission_rules WHERE group_id = ? ORDER BY sort_order` |
| C3 | Get portal default group | `SELECT * FROM portal_permissions WHERE id = 1` |
| C4 | Get project permission override | `SELECT * FROM project_permissions WHERE project_id = ?` |
| C5 | List tool rules for project | `SELECT * FROM project_tool_rules WHERE project_id = ?` |

### 2.4 audit (`server/audit.ts`)

| # | Query | Pattern |
|---|---|---|
| D1 | Write audit entry | `INSERT INTO audit_log ...` |
| D2 | Read audit log (admin) paginated | `SELECT * FROM audit_log ORDER BY ts DESC LIMIT ? OFFSET ?` |
| D3 | Filter audit by actor | `SELECT * FROM audit_log WHERE actor_id = ? ORDER BY ts DESC` |

### 2.5 projects (`server/projects.ts`)

| # | Query | Pattern |
|---|---|---|
| E1 | List all projects (admin) | `SELECT * FROM projects WHERE archived = 0 ORDER BY created_at DESC` |
| E2 | List user's projects via membership | `SELECT p.* FROM projects p JOIN project_members pm ON pm.project_id = p.id WHERE pm.user_id = ?` |
| E3 | Get project by ID | `SELECT * FROM projects WHERE id = ?` |
| E4 | Get project by slug | `SELECT * FROM projects WHERE slug = ?` |
| E5 | List project members | `SELECT pm.*, u.name, u.email FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ?` |
| E6 | Check membership | `SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?` |

### 2.6 sessions/workflows — the hot path (`server/workflows/crud.ts`, `server/session-lifecycle.ts`, `server/runs.ts`)

| # | Query | Pattern |
|---|---|---|
| F1 | List workflows by project, sorted by updated_at | `SELECT * FROM p6_workflows WHERE project_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?` (pagination) |
| F2 | Get workflow by ID | `SELECT * FROM p6_workflows WHERE id = ?` |
| F3 | List runs for workflow, sorted by created_at | `SELECT * FROM p6_runs WHERE workflow_id = ? ORDER BY created_at DESC` |
| F4 | Get latest run for workflow | `SELECT * FROM p6_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1` |
| F5 | Stream events by run, from sequence N | `SELECT * FROM p6_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT 100` |
| F6 | Get run by ID | `SELECT * FROM p6_runs WHERE id = ?` |
| F7 | Get pending input for run | `SELECT * FROM p6_inputs WHERE run_id = ? AND status = 'pending'` |
| F8 | Count child workflows | `SELECT COUNT(*) FROM p6_workflows WHERE parent_id = ?` (server/workflows/crud.ts `enrichWorkflowRow`) |
| F9 | Get parent workflow title | `SELECT title, goal FROM p6_workflows WHERE id = ?` |
| F10 | List all running workflows (controls) | `SELECT * FROM p6_workflows WHERE status = 'running'` |
| F11 | List unconsumed workflow events | `SELECT * FROM p6_workflow_events WHERE workflow_id = ? AND consumed = 0 ORDER BY id` |
| F12 | List inbox items by project+resolved | `SELECT * FROM p6_inbox WHERE project_id = ? AND resolved = 0 ORDER BY created_at DESC` |
| F13 | Get approval input by hash | `SELECT * FROM p6_inputs WHERE input_hash = ? AND run_id = ?` |

### 2.7 dashboard (`server/dashboard.ts`)

All queries join `p6_runs` through `p6_workflows` with period filters, project-scope sub-selects, and aggregates. Cited directly from the file.

| # | Query | Aggregate |
|---|---|---|
| G1 | COUNT DISTINCT agents with ≥1 run in period | COUNT DISTINCT + JOIN + WHERE created_at ≥ since |
| G2 | COUNT running sessions | COUNT WHERE status='running' |
| G3 | COUNT pending (queued) sessions | COUNT WHERE status='pending' |
| G4 | COUNT completed today / yesterday | SUM CASE WHEN finished_at range |
| G5 | Success rate (current period) | SUM CASE done / SUM CASE terminal |
| G6 | Success rate (previous period) | Same, shifted window |
| G7 | Agent stats: runs, success rate, avg duration | COUNT + AVG + GROUP BY lead_agent |
| G8 | Agent-to-agent edges (parent→child workflow links) | JOIN p6_workflows cw ON cw.parent_id = pw.id, GROUP BY source/target |
| G9 | Recent 10 sessions | ORDER BY updated_at DESC LIMIT 10 |
| G10 | Active session drill-down | SELECT runs + child workflows for one workflow |
| G11 | Per-agent run list with cost, token counts, error | JOIN p6_runs + p6_events for error messages |

### 2.8 insights (`server/insights.ts`)

All queries use `budget_usage` joined with `agent_runs`, `projects`, `users`.

| # | Query | Aggregate |
|---|---|---|
| H1 | Total cost + tokens in period | SUM(cost_usd), SUM(tokens) FROM budget_usage WHERE created_at ≥ ? |
| H2 | Run counts by status | COUNT GROUP BY status FROM agent_runs |
| H3 | Average run duration | AVG(julianday(finished_at) - julianday(started_at)) FROM agent_runs |
| H4 | Daily cost for last 30 days | SUM(cost_usd) GROUP BY date(created_at) FROM budget_usage |
| H5 | Cost by project | SUM(cost_usd) GROUP BY project_id JOIN projects |
| H6 | Cost by user (admin only) | SUM(cost_usd) GROUP BY user_id JOIN users LIMIT 50 |

### 2.9 knowledge (`server/knowledge.ts`)

| # | Query | Pattern |
|---|---|---|
| K1 | List docs for project | `SELECT * FROM knowledge_docs WHERE project_id = ?` |
| K2 | FTS search in project | `SELECT ... FROM knowledge_search JOIN knowledge_docs WHERE project_id = ? AND knowledge_search MATCH ? ORDER BY rank LIMIT 20` |
| K3 | FTS context fetch for "ask" | Same query, LIMIT 5 |
| K4 | List decisions for project | `SELECT * FROM knowledge_decisions WHERE project_id = ? ORDER BY created_at DESC` |
| K5 | Get doc by ID | `SELECT * FROM knowledge_docs WHERE id = ?` |

### 2.10 reviews (`server/review.ts`, `server/review-lifecycle.ts`)

| # | Query | Pattern |
|---|---|---|
| R1 | List reviews by project paginated | `SELECT * FROM p10_reviews WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?` |
| R2 | Get review by ID | `SELECT * FROM p10_reviews WHERE id = ?` |
| R3 | List findings by review | `SELECT * FROM p10_findings WHERE review_id = ? ORDER BY severity, file_path` |
| R4 | List recent reviews across multiple projects | `SELECT * FROM p10_reviews WHERE project_id IN (...) AND created_at >= ? ORDER BY created_at DESC` (server/review-lifecycle.ts) |
| R5 | Get credentials by provider for review | `SELECT credentials_enc FROM git_connections_v2 WHERE provider = ? AND (owner_id = ? OR scope = 'shared') ORDER BY created_at` |

### 2.11 branch scans (`server/scan.ts`)

| # | Query | Pattern |
|---|---|---|
| S1 | List scans by project paginated | `SELECT * FROM p10_scans WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?` |
| S2 | List scan files by scan + status | `SELECT * FROM p10_scan_files WHERE scan_id = ? AND status = ?` |
| S3 | Get scan by ID | `SELECT * FROM p10_scans WHERE id = ?` |

### 2.12 MCP server (`server/mcp-server.ts`)

| # | Query | Pattern |
|---|---|---|
| M1 | List workflows (MCP tool) with pagination + status filter | `SELECT * FROM p6_workflows WHERE ... ORDER BY updated_at DESC LIMIT ? OFFSET ?` |
| M2 | Scroll run events backwards by cursor | `SELECT * FROM p6_events JOIN p6_runs WHERE workflow_id = ? AND id < ? ORDER BY id DESC LIMIT ?` |
| M3 | List reviews with pagination | `SELECT * FROM p10_reviews WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?` |

### 2.13 Testing module (`server/testing/`)

| # | Query | Pattern |
|---|---|---|
| T1 | List test projects by portal-project | `SELECT * FROM test_projects WHERE project_id = ?` |
| T2 | List test runs for a project | `SELECT * FROM test_runs WHERE test_project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?` |
| T3 | List scripts for a group, ordered | `SELECT * FROM test_scripts WHERE test_group_id = ? ORDER BY sort_order` |
| T4 | List groups for a test project, ordered | `SELECT * FROM test_groups WHERE test_project_id = ? ORDER BY sort_order` |
| T5 | List case sets for test project | `SELECT * FROM test_case_sets WHERE test_project_id = ? ORDER BY created_at DESC` |
| T6 | List cases for case set, ordered | `SELECT * FROM test_cases WHERE case_set_id = ? ORDER BY ord` |
| T7 | List trace steps for generation | `SELECT * FROM trace_steps WHERE generation_id = ? ORDER BY seq` |

---

## 3. Key design

### 3.1 Decision: 7-table hybrid

**Single-table rejected.** The portal has ~88 heterogeneous entities with very different read/write rates and key cardinalities. Packing all of them under one partition key prefix creates unavoidable hot-partition problems on `p6_events` (thousands of writes per run) and forces every access pattern through an enormous GSI fan-out.

**Per-entity tables rejected.** 87 DynamoDB tables is operationally painful (CloudFormation limits, IAM policy size, Terraform state). Many entities are tiny (settings, permission groups) and gain nothing from their own table.

**7-table hybrid chosen** based on three grouping criteria:
1. Write rate and item size (high-write log data isolated from CRUD data)
2. Access locality (entities accessed together sit in the same table)
3. Security boundary (test vault items with encrypted passwords isolated from the main content table)

| DynamoDB table | Entities | Write rate |
|---|---|---|
| `portal-config` | settings, secrets, permission groups/rules, portal_permissions, themes | tiny |
| `portal-users` | users, sessions, api_tokens, invitations, password_resets, scim_tokens, engine_credentials, user_config_state, team_config_versions | low–medium |
| `portal-projects` | projects, teams, team_members, project_members, git_connections_v2, repos, workspaces_v2, mcp_integrations, aws_accounts, project_permissions, project_tool_rules, project_jira, audit_log | medium |
| `portal-runs` | p6_workflows, p6_runs, p6_workflow_events, p6_inputs, p6_inbox, budget_usage, agent_runs (legacy) | medium–high |
| `portal-events` | p6_events, agent_run_events (legacy) | **very high** (append-only) |
| `portal-content` | knowledge_docs, knowledge_decisions, vault_files, output_files, documents, sections, generated_docs, generated_doc_versions, presentations, diagrams, diagram_versions, learn_docs, quizzes, quiz_attempts, paths, p10_reviews, p10_findings, p10_scans, p10_scan_files, ai_attachments, doc_templates, loop_specs, p10_loop_specs, p10_loop_runs | medium |
| `portal-tests` | test_projects, test_vault_items, test_vault_files, test_groups, test_scripts, test_runs, test_run_steps, test_generations, test_case_sets, test_cases, trace_steps | medium–high |

`portal-events` is isolated specifically to avoid hot-partition contention. An agent run can emit 10–100+ events per second; mixing that with CRUD entities on a shared partition would throttle other operations even in on-demand mode.

### 3.2 Table schemas and GSIs

---

#### Table: `portal-config`

**Use case:** global configuration — not per-user or per-project. Accessed at startup, on settings changes, and before every agent run (permission group lookup).

| PK | SK | Entity |
|---|---|---|
| `SETTINGS` | `K#<key>` | One `settings` row |
| `SECRET` | `K#<name>` | One `secrets` row |
| `PERM_GROUP` | `G#<groupId>` | `permission_rule_groups` |
| `PERM_RULE#<groupId>` | `R#<sortOrder>#<id>` | `permission_rules` (ordered by sort_order) |
| `PORTAL_PERM` | `#SINGLETON` | `portal_permissions` (single row) |
| `THEME` | `T#<themeId>` | `themes` |

**GSIs:** none needed (all reads target a known PK).

**Access-pattern mapping:**

| Pattern | DynamoDB operation |
|---|---|
| Get setting by key | GetItem(`SETTINGS`, `K#<key>`) |
| Load all permission rules for group | Query(`PERM_RULE#<groupId>`) — SK begins_with `R#` |
| Load all permission groups | Query(`PERM_GROUP`) — full partition |
| Get portal permission singleton | GetItem(`PORTAL_PERM`, `#SINGLETON`) |

---

#### Table: `portal-users`

**Use case:** user-centric authentication data. Token lookup happens on every single API request; session lookup is the auth hot path.

| PK | SK | Entity |
|---|---|---|
| `USER#<userId>` | `#META` | `users` row |
| `USER#<userId>` | `SESSION#<tokenHash>` | `sessions` row |
| `USER#<userId>` | `TOKEN#<tokenId>` | `api_tokens` row |
| `USER#<userId>` | `INVITE#<tokenHash>` | `invitations` row |
| `USER#<userId>` | `PWRESET#<tokenHash>` | `password_resets` row |
| `USER#<userId>` | `SCIM#<scimId>` | `scim_tokens` row |
| `USER#<userId>` | `ECRED#<credId>` | `engine_credentials` row |
| `USER#<userId>` | `UCFG#<folder>` | `user_config_state` row |
| `TEAM_CFG#<folder>` | `V#<publishedAt>#<id>` | `team_config_versions` (ordered by time) |

**GSIs:**

| GSI name | PK | SK | Purpose |
|---|---|---|---|
| `GSI-UserEmail` | `email` (string) | `userId` | Login by email (`SELECT * FROM users WHERE email = ?`) |
| `GSI-GoogleSub` | `googleSub` (string) | `userId` | OAuth login by Google subject |
| `GSI-TokenHash` | `tokenHash` (string) | `entityType#userId` | Session and API token lookup by hash (every request auth) |

`GSI-TokenHash` covers both sessions (SK `SESSION#<userId>`) and api_tokens (SK `TOKEN#<userId>`). Both are looked up by their hash, and the entityType prefix distinguishes them.

**TTL field:** `expiresAtEpoch` — set for sessions, invitations, password_resets, api_tokens with an `expires_at`. DynamoDB's TTL deletes the item automatically without a scan-based cleanup job.

**Access-pattern mapping:**

| Pattern | DynamoDB operation |
|---|---|
| Login by email (A1) | Query `GSI-UserEmail` PK=email |
| Google login (A2) | Query `GSI-GoogleSub` PK=googleSub |
| Auth check: session (A3) | Query `GSI-TokenHash` PK=hash, filter entityType=SESSION |
| Auth check: API token (B2) | Query `GSI-TokenHash` PK=hash, filter entityType=TOKEN |
| List user's tokens (B1) | Query PK=`USER#<id>`, SK begins_with `TOKEN#` |
| Get user by ID (A6) | GetItem(`USER#<id>`, `#META`) |
| Count all users (A5) | Maintained as a counter item: GetItem(`USER_COUNT`, `#TOTAL`) |

---

#### Table: `portal-projects`

**Use case:** project registry, team/membership graph, git connections, repos, workspaces, audit log.

| PK | SK | Entity |
|---|---|---|
| `PROJECT#<projectId>` | `#META` | `projects` row (slug, name, description) |
| `PROJECT#<projectId>` | `MEMBER#<userId>` | `project_members` row |
| `PROJECT#<projectId>` | `REPO#<repoId>` | `repositories` row |
| `PROJECT#<projectId>` | `WS#<wsId>` | `workspaces_v2` row |
| `PROJECT#<projectId>` | `MCP#<mcpId>` | `mcp_integrations` row |
| `PROJECT#<projectId>` | `AWS#<awsId>` | `aws_accounts` row |
| `PROJECT#<projectId>` | `PERM#config` | `project_permissions` row |
| `PROJECT#<projectId>` | `TOOLRULE#<ruleId>` | `project_tool_rules` row |
| `PROJECT#<projectId>` | `JIRA#config` | `project_jira` row |
| `TEAM#<teamId>` | `#META` | `teams` row |
| `TEAM#<teamId>` | `MEMBER#<userId>` | `team_members` row |
| `GIT_CONN#<connId>` | `#META` | `git_connections_v2` row |
| `AUDIT#<dateUTC>` | `<isoTs>#<id>` | `audit_log` row (partitioned by date) |

Note: `AUDIT` partition key includes the date (e.g. `AUDIT#2026-11-02`) to keep audit partitions bounded. The admin audit view always requests a date range: it queries by date prefix, never by scanning the whole table.

**GSIs:**

| GSI name | PK | SK | Purpose |
|---|---|---|---|
| `GSI-EntityId` | `id` (every item stores its own UUID) | `type` | Get any entity by its UUID; resolves E3, E4 by adding a `slug` GSI alternative |
| `GSI-ProjectSlug` | `slug` | `projectId` | Get project by slug (E4) |
| `GSI-UserProjects` | `userId` (projected from MEMBER items) | `projectId` | List all projects a user belongs to (E2) |
| `GSI-RepoProject` | `repoId` | `projectId` | Look up which project owns a repo |
| `GSI-ConnOwner` | `connOwnerId` | `provider#createdAt` | List git connections by owner + provider (patterns R5, scan in scan.ts) |

**Access-pattern mapping:**

| Pattern | DynamoDB operation |
|---|---|
| List user's projects (E2) | Query `GSI-UserProjects` PK=userId |
| Get project by ID (E3) | GetItem(`PROJECT#<id>`, `#META`) |
| Get project by slug (E4) | Query `GSI-ProjectSlug` PK=slug |
| List project members with names (E5) | Query PK=`PROJECT#<id>` SK begins_with `MEMBER#`, then BatchGet users from `portal-users` |
| Check membership (E6) | GetItem(`PROJECT#<id>`, `MEMBER#<userId>`) |
| List repos for project | Query PK=`PROJECT#<id>` SK begins_with `REPO#` |
| List git connections by provider | Query `GSI-ConnOwner` PK=userId, SK begins_with `<provider>#` |
| Audit log by date range (D2) | Query PK=`AUDIT#<date>` for each date in range, paginate with SK |
| Audit log by actor (D3) | GSI-ActorAudit: PK=actorId, SK=ts (add this GSI) |

---

#### Table: `portal-runs`

**Use case:** session/workflow lifecycle — the hottest CRUD path. Workflows are created, updated frequently during a run. Runs are created and updated on state transitions. Inputs/approvals are polled by the runner and resolved by the user.

| PK | SK | Entity |
|---|---|---|
| `WF#<workflowId>` | `#META` | `p6_workflows` row |
| `WF#<workflowId>` | `RUN#<isoCreatedAt>#<runId>` | `p6_runs` row |
| `WF#<workflowId>` | `WFEVT#<isoCreatedAt>#<id>` | `p6_workflow_events` row |
| `RUN#<runId>` | `INPUT#<inputId>` | `p6_inputs` row |
| `BU#<projectId>#<dateUTC>` | `<isoCreatedAt>#<id>` | `budget_usage` row (date-partitioned) |
| `INBOX#<projectId>` | `<resolved>#<isoCreatedAt>#<id>` | `p6_inbox` row (SK prefix `0#` = unresolved, `1#` = resolved) |
| `AGRUN#<runId>` | `#META` | `agent_runs` (legacy) row |

Note on `p6_inbox` SK: the prefix `0#` or `1#` on the sort key means a query with SK begins_with `0#` fetches only unresolved items without needing a FilterExpression on every page. Resolved items are still queryable (SK begins_with `1#`).

**GSIs:**

| GSI name | PK | SK | Projected attrs | Purpose |
|---|---|---|---|---|
| `GSI-ProjectWorkflows` | `projectId` | `WF#<isoUpdatedAt>#<workflowId>` | KEYS_ONLY + status, title, lead_agent | List workflows for a project sorted by updated_at (F1, M1) |
| `GSI-WorkflowStatus` | `projectId` | `STATUS#<status>#<isoUpdatedAt>` | KEYS_ONLY | Filter workflows by status (running, pending) for dashboard G2, G3 |
| `GSI-RunId` | `runId` | — | ALL | Fetch run by runId when workflowId is not known (F6) |
| `GSI-BudgetProject` | `projectId` | `<isoCreatedAt>#<id>` | cost_usd, input_tokens, output_tokens, model, provider | Insights queries (H1–H6) |
| `GSI-InputStatus` | `projectId` | `STATUS#<status>#<isoCreatedAt>` | ALL | List pending inputs/approvals across a project |

Denormalized fields stored directly on `WF#` META items: `projectId`, `leadAgent`, `status`, `updatedAt`, `costUsd`, `inputTokens`, `outputTokens`. This supports all dashboard aggregates without a secondary table join.

Denormalized fields on `RUN#` items: `projectId`, `workflowId`, `leadAgent`, `status`, `startedAt`, `finishedAt`, `costUsd`, `inputTokens`, `outputTokens`. Dashboard queries (G7, G11) use `GSI-ProjectWorkflows` to get all workflowIds for a project, then Query each `WF#<id>` for its runs.

**Access-pattern mapping:**

| Pattern | DynamoDB operation |
|---|---|
| List workflows by project (F1) | Query `GSI-ProjectWorkflows` PK=projectId, SK begins_with `WF#`, ScanIndexForward=false, paginate with ExclusiveStartKey |
| Get workflow (F2) | GetItem(`WF#<id>`, `#META`) |
| List runs for workflow (F3) | Query PK=`WF#<id>` SK begins_with `RUN#`, ScanIndexForward=false |
| Latest run (F4) | Query PK=`WF#<id>` SK begins_with `RUN#`, ScanIndexForward=false, Limit=1 |
| Get run by ID (F6) | Query `GSI-RunId` PK=runId |
| Pending inputs for run (F7) | Query PK=`RUN#<id>` SK begins_with `INPUT#`, FilterExpression=status='pending' |
| Count children (F8) | Maintained as a `childCount` attribute on `WF#<id>#META`; atomic ADD on each child create/delete |
| Unresolved inbox (F12) | Query PK=`INBOX#<projectId>` SK begins_with `0#` |
| Dashboard running count (G2) | Query `GSI-WorkflowStatus` PK=projectId SK begins_with `STATUS#running#` |
| Dashboard queued count (G3) | Query `GSI-WorkflowStatus` PK=projectId SK begins_with `STATUS#pending#` |
| Dashboard agent stats (G7) | For each projectId in scope: Query `GSI-ProjectWorkflows`, load run items, compute in application |
| Budget totals (H1) | Query `GSI-BudgetProject` PK=projectId SK between date range |

---

#### Table: `portal-events`

**Use case:** run event log — written at 10–100+ events/second during an active run. Events are immutable once written. Old events are archived to S3 and TTL-deleted from DynamoDB after 30 days (configurable).

| PK | SK | Entity |
|---|---|---|
| `RUN#<runId>` | `SEQ#<10-digit-zero-padded-seq>` | `p6_events` row |
| `AGRUN#<runId>` | `SEQ#<10-digit-zero-padded-seq>` | `agent_run_events` (legacy) row |

Zero-padded sequence: `0000000001`, `0000000002`, … ensures lexicographic sort matches numeric sort. This is critical because SK comparisons in DynamoDB are lexicographic, not numeric.

**No GSIs needed.** All access patterns are: stream forward from seq N, or stream backward from cursor. Both are served by Query on the partition key with a SK range condition.

**TTL field:** `archiveEpoch` — set 30 days after `created_at`. A Lambda function triggered by DynamoDB Streams (or EventBridge Scheduler) first copies the expiring items to S3 in Newline-Delimited JSON before the TTL fires. The S3 copy is the long-term audit log.

**Item size:** the `payload` field can be large (up to tens of KB for long tool responses). Items that exceed 400 KB must have their payload written to S3, with the DynamoDB item storing the S3 key. The runner must check payload size before writing.

**Access-pattern mapping:**

| Pattern | DynamoDB operation |
|---|---|
| Stream events from seq N (F5) | Query PK=`RUN#<id>` SK >= `SEQ#<N>`, ScanIndexForward=true, paginate |
| Scroll backward from cursor (M2) | Query PK=`RUN#<id>` SK < `SEQ#<cursor>`, ScanIndexForward=false, Limit=N |
| Load all events for replay | Query PK=`RUN#<id>`, ScanIndexForward=true, paginate until exhausted |

---

#### Table: `portal-content`

**Use case:** AI-generated content, knowledge base, documents, reviews, scans, attachments. All project-scoped. Moderate volume; large text fields go to S3.

| PK | SK | Entity |
|---|---|---|
| `PROJECT#<projectId>` | `KDOC#<docId>` | `knowledge_docs` |
| `PROJECT#<projectId>` | `KDEC#<decisionId>` | `knowledge_decisions` |
| `PROJECT#<projectId>` | `VAULT#<fileId>` | `vault_files` |
| `PROJECT#<projectId>` | `OUTFILE#<fileId>` | `output_files` |
| `PROJECT#<projectId>` | `DIAG#<diagId>` | `diagrams` |
| `PROJECT#<projectId>` | `DIAGVER#<diagId>#<version>` | `diagram_versions` |
| `PROJECT#<projectId>` | `GDOC#<docId>` | `generated_docs` |
| `PROJECT#<projectId>` | `GDOCVER#<docId>#<verId>` | `generated_doc_versions` |
| `PROJECT#<projectId>` | `PRES#<presId>` | `presentations` |
| `PROJECT#<projectId>` | `LDOC#<docId>` | `learn_docs` |
| `PROJECT#<projectId>` | `QUIZ#<quizId>` | `quizzes` |
| `PROJECT#<projectId>` | `PATH#<pathId>` | `paths` |
| `PROJECT#<projectId>` | `REVIEW#<isoCreatedAt>#<reviewId>` | `p10_reviews` |
| `PROJECT#<projectId>` | `FINDING#<reviewId>#<findingId>` | `p10_findings` |
| `PROJECT#<projectId>` | `SCAN#<isoCreatedAt>#<scanId>` | `p10_scans` |
| `PROJECT#<projectId>` | `SCANFILE#<scanId>#<filePath>` | `p10_scan_files` |
| `PROJECT#<projectId>` | `ATTACH#<parentKind>#<parentId>#<attachId>` | `ai_attachments` |
| `PROJECT#<projectId>` | `DOCTEMPL#<type>#<templateId>` | `doc_templates` |
| `PROJECT#<projectId>` | `LOOPSPEC#<specId>` | `p10_loop_specs` |
| `PROJECT#<projectId>` | `LOOPRUN#<isoStartedAt>#<runId>` | `p10_loop_runs` |
| `QUIZATTEMPT#<quizId>` | `<userId>#<attemptId>` | `quiz_attempts` |
| `DOCREAD#<learnDocId>` | `<userId>` | `doc_reads` |

Large-text fields (`markdown`, `raw_output`, `drawio` XML, content sections) are stored in S3. The DynamoDB item holds the S3 key.

**GSIs:**

| GSI name | PK | SK | Purpose |
|---|---|---|---|
| `GSI-EntityId` | `id` | `entityType` | Get any content entity by UUID (for `GET /api/reviews/:id`, `GET /api/diagrams/:id`, etc.) |
| `GSI-ReviewWorkflow` | `workflowId` | `reviewId` | Find the review generated by a given workflow (review-lifecycle.ts) |
| `GSI-OutputWorkflow` | `workflowId` | `outputFileId` | Find output files for a workflow |
| `GSI-ScanRepo` | `repoId` | `isoCreatedAt` | Find scans for a repo |

**Access-pattern mapping:**

| Pattern | DynamoDB operation |
|---|---|
| List reviews by project paginated (R1) | Query PK=`PROJECT#<id>` SK begins_with `REVIEW#`, ScanIndexForward=false, paginate |
| Get review by ID (R2) | Query `GSI-EntityId` PK=reviewId |
| List findings by review (R3) | Query PK=`PROJECT#<id>` SK begins_with `FINDING#<reviewId>#` |
| List scans by project (S1) | Query PK=`PROJECT#<id>` SK begins_with `SCAN#`, ScanIndexForward=false, paginate |
| Knowledge docs for project (K1) | Query PK=`PROJECT#<id>` SK begins_with `KDOC#` |
| FTS search (K2, K3) | See section 4.4 |

---

#### Table: `portal-tests`

**Use case:** testing module — test projects, scripts, runs, generated case sets. Contains encrypted vault items (passwords, TOTP secrets) so it is isolated from the main content table for least-privilege IAM.

| PK | SK | Entity |
|---|---|---|
| `PROJ#<portalProjectId>` | `TP#<testProjectId>` | index: project → test projects |
| `TP#<testProjectId>` | `#META` | `test_projects` row |
| `TP#<testProjectId>` | `VAULTITEM#<itemId>` | `test_vault_items` (encrypted fields in item) |
| `TP#<testProjectId>` | `VAULTFILE#<fileId>` | `test_vault_files` |
| `TP#<testProjectId>` | `GROUP#<sortOrder>#<groupId>` | `test_groups` (SK sorted by sortOrder) |
| `TP#<testProjectId>` | `SCRIPT#<groupId>#<sortOrder>#<scriptId>` | `test_scripts` |
| `TP#<testProjectId>` | `RUN#<isoCreatedAt>#<runId>` | `test_runs` |
| `TP#<testProjectId>` | `GEN#<isoCreatedAt>#<genId>` | `test_generations` |
| `TP#<testProjectId>` | `CASESET#<isoCreatedAt>#<caseSetId>` | `test_case_sets` |
| `RUN#<runId>` | `STEP#<stepIndex>` | `test_run_steps` |
| `CASESET#<caseSetId>` | `CASE#<ordPadded>#<caseId>` | `test_cases` |
| `GEN#<genId>` | `TRACE#<seqPadded>` | `trace_steps` (for test_generations) |
| `CASESET#<caseSetId>` | `TRACE#<seqPadded>` | `trace_steps` (for test_case_sets) |

**GSIs:**

| GSI name | PK | SK | Purpose |
|---|---|---|---|
| `GSI-EntityId` | `id` | `entityType` | Get any test entity by UUID |
| `GSI-ScriptGroup` | `groupId` | `sortOrder#scriptId` | List scripts for a group ordered by sort_order (T3) |

---

### 3.3 Searchable text table: `portal-search`

Not one of the 7 domain tables. A standalone inverted-index table for FTS replacement (detailed in section 4.4).

---

## 4. Replacements

### 4.1 Joins → denormalization

SQLite joins that DynamoDB cannot express are replaced by one of three strategies:

**Strategy A — Denormalize at write time.** Frequently-needed fields from a parent entity are duplicated into child items. Updated via a fan-out write when the parent changes.

| SQLite join | Denormalized field | Update trigger |
|---|---|---|
| `p6_runs JOIN p6_workflows` (dashboard, insights) | `projectId`, `leadAgent` stored on each `p6_runs` item | Write `leadAgent` and `projectId` from workflow when creating a run |
| `budget_usage JOIN projects` (insights H5) | `projectName` stored on `budget_usage` item | Write `projectName` when creating budget_usage row; update via a fan-out when project name changes |
| `budget_usage JOIN users` (insights H6) | `userName` stored on `budget_usage` item | Write at create time; update on user rename |
| `p6_workflows JOIN p6_workflows` (parent title in enrichWorkflowRow) | `parentTitle` stored on child workflow item | Write at child creation; update when parent title changes |

**Strategy B — BatchGet with application join.** When a list of IDs is known, load items from a second table in batch.

| SQLite join | DynamoDB replacement |
|---|---|
| `project_members JOIN users` (list members with names, E5) | Query members → extract userIds → BatchGet from `portal-users` |
| `p10_reviews JOIN repositories` (review list with repo name) | Query reviews → extract repoIds → BatchGet from `portal-projects` |

**Strategy C — Single-request composite item.** Parent + children stored under the same partition key, fetched together with one Query.

| SQLite pattern | DynamoDB replacement |
|---|---|
| `SELECT workflow + latest run` (F2/F4) | Query PK=`WF#<id>` returns `#META` (workflow) + all `RUN#` items; take latest by SK |
| `SELECT project + members` (project detail) | Query PK=`PROJECT#<id>` returns `#META` + `MEMBER#` items |

### 4.2 COUNT, SUM, GROUP BY → counters and precomputed rollups

| SQLite aggregate | DynamoDB replacement | File reference |
|---|---|---|
| `COUNT(*) FROM users` (A5, first-run check) | Atomic counter item `USER_COUNT#TOTAL` in `portal-users`; incremented on user create/delete | `server/auth.ts` |
| `COUNT(*) FROM project_members WHERE project_id = ?` | `memberCount` attribute on `PROJECT#<id>#META`; atomic ADD on add/remove member | `server/projects.ts` |
| `COUNT(*) FROM p6_workflows WHERE parent_id = ?` (F8) | `childCount` attribute on `WF#<id>#META`; atomic ADD on child create/delete | `server/workflows/crud.ts` |
| `COUNT(*) WHERE status = 'running'` (G2) | Query `GSI-WorkflowStatus` and count returned items (small result — bounded by active sessions) | `server/dashboard.ts` |
| `SUM(cost_usd) GROUP BY project_id` (H5) | Per-project-per-day cost rollup item: PK=`STATS#<projectId>`, SK=`DAY#<date>`, attribute `costUsd`; ADD on each `budget_usage` write | `server/insights.ts` |
| `SUM(cost_usd) GROUP BY user_id` (H6) | Per-user-per-day cost rollup item: PK=`USERSTATS#<userId>`, SK=`DAY#<date>` | `server/insights.ts` |
| `SUM(cost_usd)` total in period (H1) | Load all `STATS#<projectId>` items for the date range (at most 30 items for 30d), sum in application | `server/insights.ts` |
| `SUM(cost_usd + input_tokens + output_tokens)` by period | Same rollup items; also store `inputTokens` and `outputTokens` per day | `server/insights.ts` |
| `AVG(duration)` for runs (H3) | Store `totalDurationMs` and `durationCount` in rollup; compute average in application | `server/insights.ts` |
| Dashboard `SUM(CASE WHEN status='done')` / total (G5) | Status counters per project per day: `doneCount`, `failedCount`, `cancelledCount`; atomic ADD on each run state transition | `server/dashboard.ts` |
| `COUNT(*) FROM p10_scan_files WHERE scan_id = ? AND status = ?` | `filesTotal`, `filesDone` attributes on the scan item; atomic ADD as files are processed | `server/scan.ts` |
| `GROUP BY lead_agent` (G7 agent stats) | Computed from in-memory aggregation after querying runs via `GSI-ProjectWorkflows`; result cached per-request. For a single-user portal the result set is small (< 100 runs per day). | `server/dashboard.ts` |

**Rollup write pattern.** Every time a run changes state (start, done, failed, cancelled):

```
UpdateItem(portal-runs):
  Key: PK=STATS#<projectId>, SK=DAY#<date>
  UpdateExpression: ADD doneCount :inc, totalCostUsd :cost ...
  ConditionExpression: (none needed, ADD initialises to 0)
```

This is a single atomic write; no transaction needed.

### 4.3 ORDER BY and pagination

All list endpoints that use `ORDER BY ... LIMIT ? OFFSET ?` are replaced with key-condition-based pagination using DynamoDB's `ExclusiveStartKey`.

| Pattern | DynamoDB approach |
|---|---|
| List workflows ORDER BY updated_at DESC (F1) | `GSI-ProjectWorkflows`, ScanIndexForward=false. Client passes `lastEvaluatedKey` as cursor. |
| List runs ORDER BY created_at DESC (F3) | Query PK=`WF#<id>` SK begins_with `RUN#`, ScanIndexForward=false. |
| List reviews ORDER BY created_at DESC (R1) | Query PK=`PROJECT#<id>` SK begins_with `REVIEW#`, ScanIndexForward=false. |
| List audit log ORDER BY ts DESC (D2) | Query `AUDIT#<date>` SK ranges, ScanIndexForward=false. For multi-day, query each day partition in sequence. |
| List scans ORDER BY created_at DESC (S1) | Query PK=`PROJECT#<id>` SK begins_with `SCAN#`, ScanIndexForward=false. |
| Events ORDER BY id ASC from seq N (F5) | Query PK=`RUN#<id>` SK >= `SEQ#<N>`, ScanIndexForward=true. |
| Recent sessions ORDER BY updated_at DESC LIMIT 10 (G9) | Query `GSI-ProjectWorkflows` for each project in scope, Limit=10, ScanIndexForward=false. For the admin view (all projects), maintain a `RECENT_SESSIONS#global` item with a JSON array of the 10 most recent workflow IDs, updated atomically on each status change. |

**Offset-based pagination (LIMIT ? OFFSET ?)** has no direct equivalent. The repository layer converts all `offset`-based callers to cursor-based pagination. The HTTP API keeps page/pageSize parameters but the DynamoDB implementation ignores `offset > 0` for first-time page loads — callers must send the cursor token from the previous response to get subsequent pages. The MCP server (`mcp-server.ts`) already uses cursor-based scrolling for events; its workflow list needs to be converted.

### 4.4 FTS5 search → DynamoDB inverted index

The portal uses FTS5 in two places:

| Table | File | Query |
|---|---|---|
| `knowledge_search` | `server/knowledge.ts` L339, L371 | `MATCH ? ORDER BY rank LIMIT 20` (search) and `LIMIT 5` (context for "ask") |
| `sections_fts` | defined in M3, no active query found in server code | unused or accessed via legacy path |

**Replacement: `portal-search` DynamoDB table with word-level inverted index.**

Table schema:
```
PK: WORD#<projectId>#<normalizedToken>
SK: DOC#<docId>#<chunkId>
Attributes: docId, chunkId, heading, excerpt (first 500 chars), score (TF weight)
TTL: stale_epoch (set when doc is deleted or re-indexed)
```

Index write (on document ingest, already async in Lambda):
1. Tokenize and normalize document content (lowercase, strip punctuation, simple stemming).
2. For each distinct token, write a `WORD#<projectId>#<token>` item with the docId and an excerpt.
3. Set a TTL equal to `now + 7 days` on all old items for the same docId before writing new ones (safe re-index).

Search query (K2):
1. Tokenize query into tokens (e.g., "authentication" → ["authent"]).
2. For each token: Query `portal-search` PK=`WORD#<projectId>#<token>` → list of `{docId, excerpt, score}`.
3. Intersect docId sets across tokens (AND semantics). 
4. Sort by combined score, take top 20.
5. BatchGet the full doc metadata from `portal-content`.
6. Return results.

**Limits and trade-offs:** This approach has no BM25 ranking, no phrase search, and no stemming beyond simple normalization. For a single-user personal portal with < 1,000 documents this is adequate. If recall quality becomes a problem, the natural upgrade path is Bedrock Knowledge Bases (S3-backed, semantic search, ~$0 idle cost at <100 queries/month at $0.0004/1000 chars indexed + $0.02/query).

`sections_fts` is not actively queried in the current P6 codebase. It maps to the legacy M3 `documents`/`sections` tables. These will be migrated to the same inverted-index pattern as knowledge_search, or left out of scope if the legacy doc pipeline is superseded by P9 (`generated_docs`).

### 4.5 Transactions and atomic claims

**Approval claim (F13, FR-GUARD-8 binding).**
The approval flow in `server/agent/approvals.ts` currently uses an in-memory Map. In DynamoDB the claim is an atomic conditional update:

```
UpdateItem(portal-runs):
  Key: PK=RUN#<runId>, SK=INPUT#<inputId>
  UpdateExpression: SET #status = :claimed, claimedAt = :now
  ConditionExpression: #status = :pending
  ExpressionAttributeValues: {:pending='pending', :claimed='claimed'}
```

If two concurrent requests try to claim the same approval, only one succeeds; the other receives `ConditionalCheckFailedException`. The runner polls `GetItem` until `status = 'answered'`.

**Run-limit check (atomic increment with cap).**
`server/runs.ts` enforces a concurrency cap (e.g., max 3 concurrent runs per user). In DynamoDB:

```
UpdateItem(portal-runs):
  Key: PK=RUNLIMIT#<userId>, SK=#COUNT
  UpdateExpression: ADD activeCount :one
  ConditionExpression: activeCount < :maxActive OR attribute_not_exists(activeCount)
```

If `ConditionalCheckFailedException`, the run is rejected. On run completion, decrement:

```
UpdateItem: ADD activeCount :negOne
ConditionExpression: activeCount > :zero
```

**Workflow state transitions (idempotent).**
Workflow status is updated with a condition on the current status:

```
UpdateItem:
  ConditionExpression: #status = :expectedCurrentStatus
```

This prevents stale updates if two Lambda invocations race on the same workflow.

**DynamoDB Transactions (`TransactWriteItems`)** are used for:
- Creating a workflow + its first run atomically
- Resolving an approval + updating the input status + incrementing the workflow's approval count

Transactions are limited to 100 items across ≤ 25 tables. All transactional writes in the portal are within this limit.

### 4.6 Uniqueness constraints

SQLite `UNIQUE` constraints are replaced with `ConditionExpression: attribute_not_exists(PK)` on PutItem.

| Constraint | DynamoDB replacement |
|---|---|
| `users.email UNIQUE` | PutItem on `GSI-UserEmail` projection: check via GetItem/Query before insert, plus a `EMAILLOCK#<normalizedEmail>` lock item with `attribute_not_exists` |
| `users.google_sub UNIQUE` | Same pattern for `GSI-GoogleSub` |
| `projects.slug UNIQUE` | PutItem(`GSI-ProjectSlug`) with `attribute_not_exists(PK)` on a lock item |
| `api_tokens.token_hash UNIQUE` | Guaranteed by HMAC generation; collision probability negligible |
| `p10_scan_files UNIQUE(scan_id, file_path)` | PK=`TP#<scanId>`, SK=`SCANFILE#<filePath>` with `attribute_not_exists` |
| `repositories UNIQUE(project_id, slug)` | PK=`PROJECT#<id>`, SK=`REPO#<slug>` with `attribute_not_exists` |

**Pattern for email uniqueness** (two items per user to support the unique constraint):
```
TransactWriteItems:
  Put: PK=USER#<id>, SK=#META, ConditionExpression=attribute_not_exists(PK)
  Put: PK=EMAILLOCK#<normalizedEmail>, SK=#LOCK, userId=<id>,
       ConditionExpression=attribute_not_exists(PK)
```
If either condition fails, neither item is written.

### 4.7 TTL for expiring data

| Table | Expiry field | TTL behaviour |
|---|---|---|
| `sessions` | `expires_at` | DynamoDB TTL deletes automatically; no cleanup job needed |
| `api_tokens` | `expires_at` | TTL (tokens that are revoked also get TTL set to `now`) |
| `invitations` | `expires_at` | TTL |
| `password_resets` | `expires_at` | TTL |
| `p6_inputs` (approvals) | `expires_at` | TTL; expired items are never resolved |
| `inputs` (legacy approvals) | `expires_at` | TTL |
| `p6_events` | 30 days after `created_at` | TTL after S3 archive (see section 4.8 below) |
| `agent_run_events` (legacy) | 30 days after `created_at` | TTL after S3 archive |
| `ai_attachments` with `parent_id IS NULL` | 24h after `created_at` | TTL for orphaned pending attachments |
| Bedrock SSO device flow (in `settings`) | short TTL | Single-item with TTL in `portal-config` |

### 4.8 Items over 400 KB → S3

| Entity | Large fields | S3 strategy |
|---|---|---|
| `p6_events.payload` | Tool responses, long text chunks | If `len(payload) > 300_000`: write to `s3://portal-data/events/<runId>/<seq>.json`; store S3 key in `payloadS3Key`; store `payloadSize` for UI display |
| `generated_doc_versions.markdown` | Full document Markdown | Always S3: `s3://portal-data/docs/<projectId>/<docId>/<version>.md` |
| `diagram_versions.drawio` | DrawIO XML (can be > 1 MB) | Always S3: `s3://portal-data/diagrams/<projectId>/<diagId>/<version>.xml` |
| `learn_docs.business_md` / `technical_md` | Long Markdown | Always S3 if `> 100 KB`; DynamoDB stores S3 key |
| `p10_reviews.raw_output` | Full LLM transcript | Always S3: `s3://portal-data/reviews/<reviewId>/raw_output.txt` |
| `team_config_versions.files_json` | Config file content JSON | S3 if `> 100 KB` |
| `trace_steps.prompt` / `output` | Already capped at 20 KB in M41; stored in DynamoDB directly | — |
| `knowledge_search content` | Full document text | S3 only; DynamoDB stores excerpts for search results |
| `sections.content` | Section text | S3 only; DynamoDB stores heading, anchor, and a 500-char excerpt |

The repository layer's `largeTextStrategy` helper checks size before write and transparently resolves S3 keys on read. The storage interface (`server/storage/`) already exists with local and S3 backends; this is a natural extension.

---

## 5. Repository interface

### 5.1 Shape

The async repository layer replaces `server/db.ts`'s synchronous `one`, `all`, `run`, `insert`, `update` helpers with per-entity repositories. Each repository is a plain object with typed async methods.

```typescript
// server/db/repository.ts (new file, created in S1)

export interface WorkflowRepository {
  getById(id: string): Promise<Workflow | null>;
  listByProject(projectId: string, opts?: { limit?: number; cursor?: string; status?: string }): Promise<{ items: Workflow[]; cursor?: string }>;
  create(w: NewWorkflow): Promise<Workflow>;
  update(id: string, patch: Partial<Workflow>): Promise<Workflow>;
  delete(id: string): Promise<void>;
  incrementChildCount(id: string, delta: 1 | -1): Promise<void>;
  listChildren(parentId: string): Promise<Workflow[]>;
}

export interface RunRepository {
  getById(id: string): Promise<Run | null>;
  listByWorkflow(workflowId: string, opts?: { limit?: number; cursor?: string }): Promise<{ items: Run[]; cursor?: string }>;
  create(r: NewRun): Promise<Run>;
  updateStatus(id: string, status: RunStatus, patch?: Partial<Run>): Promise<Run>;
  claimRunSlot(userId: string, maxActive: number): Promise<boolean>; // returns false if at cap
  releaseRunSlot(userId: string): Promise<void>;
}

export interface RunEventRepository {
  append(runId: string, events: NewRunEvent[]): Promise<void>;
  listFrom(runId: string, fromSeq: number, limit?: number): Promise<RunEvent[]>;
  listBefore(runId: string, beforeSeq: number, limit?: number): Promise<RunEvent[]>;
}

export interface InputRepository {
  create(input: NewInput): Promise<Input>;
  claimPending(runId: string, inputId: string): Promise<boolean>; // atomic claim
  resolve(inputId: string, decision: InputDecision): Promise<void>;
  getById(id: string): Promise<Input | null>;
}

export interface BudgetRepository {
  record(entry: NewBudgetEntry): Promise<void>;
  getDailyTotals(projectId: string, fromDate: string, toDate: string): Promise<DailyTotal[]>;
  getUserDailyTotals(userId: string, fromDate: string, toDate: string): Promise<DailyTotal[]>;
}

// ... one repository per entity group
```

All methods are `async` from the start. The SQLite implementation wraps the synchronous SQLite calls in `Promise.resolve()`. The DynamoDB implementation issues AWS SDK calls. No caller in the business logic knows which backend is active.

### 5.2 Repository factory

```typescript
// server/db/index.ts (replaces current db.ts entry point)

export interface RepositorySet {
  workflows: WorkflowRepository;
  runs: RunRepository;
  runEvents: RunEventRepository;
  inputs: InputRepository;
  budget: BudgetRepository;
  projects: ProjectRepository;
  users: UserRepository;
  sessions: SessionRepository;
  apiTokens: ApiTokenRepository;
  permissions: PermissionRepository;
  knowledge: KnowledgeRepository;
  // ... all ~20 repository interfaces
}

export function createRepositories(backend: 'sqlite' | 'dynamodb', config: BackendConfig): RepositorySet {
  if (backend === 'dynamodb') return createDynamoRepositories(config);
  return createSqliteRepositories(config);
}
```

The `backend` value is read from `PORTAL_DB_BACKEND` env var (default `sqlite`). Lambda sets `dynamodb`; local dev keeps `sqlite`.

### 5.3 How SQLite and DynamoDB implementations sit behind it

```
server/db/
  index.ts               ← factory + RepositorySet type
  repository.ts          ← interfaces (WorkflowRepository, etc.)
  sqlite/
    workflows.ts          ← SQLiteWorkflowRepository implements WorkflowRepository
    runs.ts
    ...
  dynamodb/
    workflows.ts          ← DynamoWorkflowRepository implements WorkflowRepository
    runs.ts
    client.ts             ← DynamoDB DocumentClient singleton, table name env vars
    ...
```

The SQLite implementation delegates to the existing `one/all/insert/update` helpers (now wrapped as `async`). The DynamoDB implementation calls the AWS SDK.

### 5.4 How tests run against both implementations

Test files currently import helpers from `test/fixtures.ts` which creates a fresh in-memory SQLite database. After S1, `fixtures.ts` exposes `createTestRepositories()` which always returns the SQLite implementation. All existing tests continue to pass unchanged.

A separate CI job sets `PORTAL_DB_BACKEND=dynamodb` and points at a **DynamoDB Local** container (or an actual `ap-southeast-1` test account). The DynamoDB tests use the same test files — the module-level `createTestRepositories()` call dispatches to DynamoDB.

This is the exit criterion for Phase S2: all affected tests pass on both backends.

---

## 6. Conversion order

Module IDs below match `test/test-map.json`. The order minimises cross-module dependencies and starts with the modules that block S5 (AgentCore).

### Phase 6.1 — Config and identity (week 1)
These modules have no inter-module dependencies and are prerequisites for every other module.

| Module | Tables | Effort | Risk |
|---|---|---|---|
| `db` (migration + factory) | all | 3 days | Medium — must not break all 935 call sites at once. Use progressive migration: add `async` shim that calls sync under the hood, swap implementations behind the factory. |
| `config` | settings, secrets | 1 day | Low |
| `auth` | users, sessions | 1 day | Low |
| `api-tokens` ✓ **pilot** | api_tokens | 1 day | Low |
| `permissions` | permission_rule_groups, permission_rules, portal_permissions, project_permissions, project_tool_rules | 1 day | Low |
| `audit` | audit_log | 1 day | Low |

**Pilot module: `api-tokens`.** Three access patterns (list by user, lookup by hash, get by ID), two write operations (create, revoke), existing tests in `test/api-tokens.test.ts` and `test/token-scopes.test.ts`. Converting this module first validates the repository interface, the DynamoDB client setup, `GSI-TokenHash`, and TTL handling without touching the session hot path.

### Phase 6.2 — Project graph (weeks 1–2)

| Module | Tables | Effort | Risk |
|---|---|---|---|
| `projects` | projects, teams, team_members, project_members | 2 days | Medium — E5 (members with names) needs BatchGet across two tables |
| `workspaces` | workspaces_v2, repositories, git_connections_v2 | 2 days | Low |
| `connections` | git_connections_v2 | 1 day | Low |
| `repos` | repositories | 1 day | Low |
| `integrations` | mcp_integrations | 1 day | Low |
| `aws-accounts` | aws_accounts | 0.5 days | Low |
| `credentials` | engine_credentials | 1 day | Low |
| `settings` | settings (already in `config`) | 0.5 days | Low |
| `delegation` | p6_workflows (childCount counter), api_tokens (workflow_id) | 1 day | Low |

### Phase 6.3 — Session hot path (weeks 2–4) ⚠️ riskiest

| Module | Tables | Effort | Risk |
|---|---|---|---|
| `sessions` / `workflows` | p6_workflows, p6_runs, p6_workflow_events, p6_inputs, p6_inbox | 2 weeks | **High** — 935 call sites, in-memory approvals Map must be replaced, ORDER BY + pagination redesign, atomic state transitions, run-limit counters |
| `security` | cross-cutting (agent/runner.ts, approvals.ts) | 3 days | High |
| `output-files` | output_files, vault_files | 1 day | Low |

The session module is the riskiest because: (a) it is the hot path for every agent run, (b) the in-memory `pendingApprovals` Map (`server/agent/approvals.ts`) must be replaced by DynamoDB conditional updates while preserving sub-second response time for approval polling, and (c) the `p6_events` table will hold millions of rows per run.

Mitigation: convert session module last in the phase; run the full session smoke test (`npm run test:affected -- --module sessions`) after every sub-component change.

### Phase 6.4 — Append-only events (week 4)

| Module | Tables | Effort | Risk |
|---|---|---|---|
| `portal-events` table setup | p6_events, agent_run_events | 3 days | Medium — item size check before write, S3 overflow, TTL+archival |

### Phase 6.5 — Content modules (weeks 4–6)

| Module | Tables | Effort | Risk |
|---|---|---|---|
| `knowledge` | knowledge_docs, knowledge_decisions, inverted-index in `portal-search` | 3 days | Medium — FTS replacement |
| `generated-docs` | generated_docs, generated_doc_versions | 2 days | Low |
| `presentations` | presentations | 1 day | Low |
| `diagrams` | diagrams, diagram_versions | 1 day | Low |
| `vault` | vault_files | 1 day | Low |
| `attachments` | ai_attachments | 1 day | Low |

### Phase 6.6 — Review and scan modules (weeks 6–7)

| Module | Tables | Effort | Risk |
|---|---|---|---|
| `reviews` | p10_reviews, p10_findings, p10_loop_specs, p10_loop_runs | 2 days | Medium — multi-project review scan (R4) needs BatchQuery across projects |
| `branch-scans` | p10_scans, p10_scan_files | 2 days | Low |
| `loop-specs` | p10_loop_specs, p10_loop_runs | 1 day | Low |

### Phase 6.7 — Analytics and insights (weeks 7–8) ⚠️ requires counters

| Module | Tables | Effort | Risk |
|---|---|---|---|
| `dashboard` | counter rollups in portal-runs | 3 days | **High** — every dashboard query is an aggregate; must be powered by precomputed counters written atomically on run state transitions. Full query behaviour must be validated for off-by-one in date partitions. |
| `insights` | budget_usage daily rollups | 2 days | Medium |

### Phase 6.8 — Learn, quiz, testing (weeks 8–10)

| Module | Tables | Effort | Risk |
|---|---|---|---|
| `knowledge` (learn sub) | learn_docs, quizzes, quiz_attempts, paths | 1 day | Low |
| `testing-module` | all test_* tables, trace_steps | 3 days | Medium |
| `user-config` | team_config_versions, user_config_state | 1 day | Low |

### Phase 6.9 — Cleanup and legacy modules (weeks 10–11)

| Module | Tables | Effort | Risk |
|---|---|---|---|
| Legacy M3 tables (workflows, agent_runs, etc.) | Migrate data, redirect reads | 3 days | Medium — legacy tables are still active in some non-P6 paths; check all callers |
| `bedrock-sso` | sessions TTL for device flows | 0.5 days | Low |
| `kiro` | no DB tables | 0 | Low |
| `theme` | themes (portal-config) | 0.5 days | Low |
| `health` | no DB tables | 0 | — |
| `guardrails` | no DB tables | 0 | — |

### Summary effort table

| Phase | Modules | Effort |
|---|---|---|
| 6.1 Config + identity | db factory + 5 modules | 1 week |
| 6.2 Project graph | 9 modules | 1.5 weeks |
| 6.3 Session hot path | 3 modules | 2.5 weeks |
| 6.4 Events table | 1 module | 0.5 weeks |
| 6.5 Content | 6 modules | 1.5 weeks |
| 6.6 Reviews/scans | 3 modules | 1 week |
| 6.7 Analytics | 2 modules | 1 week |
| 6.8 Learn/testing | 3 modules | 1.5 weeks |
| 6.9 Legacy cleanup | misc | 1 week |
| **Total** | **45 modules** | **~11.5 weeks** |

With buffer for test failures and regressions: **12–15 weeks** for one engineer. Matches the S1 estimate in the migration plan.

---

## 7. Data migration

The one-time migration exports `data/portal.db` (the local SQLite database) into DynamoDB.

### 7.1 Strategy

A Node.js migration script (`scripts/migrate-to-dynamodb.ts`) runs once from the developer's machine before cutover. It:

1. Opens the SQLite database read-only.
2. Walks every table in dependency order (users before projects before workflows).
3. Translates each row into the DynamoDB item shape (applying the PK/SK scheme from section 3).
4. Writes items in batches of 25 using `BatchWriteItem` (DynamoDB's maximum per batch).
5. Logs a progress line per table and a final row count.
6. On completion, writes a `migration.json` manifest to S3 with timestamps and row counts for audit.

### 7.2 Order of tables

```
1.  users
2.  sessions
3.  settings / secrets / themes
4.  api_tokens
5.  permission_rule_groups / permission_rules / portal_permissions
6.  teams → team_members
7.  projects → project_members
8.  project_permissions, project_tool_rules, project_jira
9.  git_connections_v2 → repositories → workspaces_v2
10. mcp_integrations, aws_accounts
11. engine_credentials, user_config_state, team_config_versions
12. p10_loop_specs (no project FK required)
13. knowledge_docs → knowledge_decisions
14. vault_files, output_files
15. documents → sections (write section excerpts; full text to S3)
16. generated_docs → generated_doc_versions (markdown body to S3)
17. presentations, diagrams → diagram_versions (drawio to S3)
18. learn_docs, quizzes, quiz_attempts, paths
19. doc_templates, ai_attachments
20. p10_reviews → p10_findings
21. p10_scans → p10_scan_files
22. p10_loop_runs
23. p6_workflows → p6_runs (denormalize projectId, leadAgent into run items)
24. p6_workflow_events (consumed flag preserved)
25. p6_events → portal-events table (TTL set; large payloads to S3)
26. p6_inputs, p6_inbox
27. budget_usage (also build daily rollup items in the same pass)
28. agent_runs → agent_run_events (legacy)
29. audit_log (partitioned by date)
30. test_projects → test_groups → test_scripts → test_vault_items → test_vault_files
31. test_runs → test_run_steps
32. test_generations → test_case_sets → test_cases → trace_steps
33. invitations, password_resets, scim_tokens
```

### 7.3 Cutover

After the migration script finishes:

1. Stop the local portal (`npm run start` process).
2. Verify item counts match SQLite row counts (± items affected by TTL since migration started).
3. Set `PORTAL_DB_BACKEND=dynamodb` in the Lambda environment.
4. Deploy.
5. Run smoke tests against the Lambda URL.
6. Keep `portal.db` as a read-only backup for 30 days.

The migration script is idempotent (uses `PutItem` with `attribute_not_exists` to avoid duplicating existing items on a retry). A partial failure can be resumed by re-running the script; already-migrated items are skipped.

### 7.4 Large-text migration

Fields identified as always-S3 (see section 4.8) are extracted from SQLite, written to S3 during the migration walk, and replaced with the S3 key in the DynamoDB item. The migration script reads `PORTAL_DATA_BUCKET` from env (the same S3 bucket used by the Lambda portal).

---

## 8. Cost estimate

### 8.1 Usage assumptions (single-user personal portal, ap-southeast-1)

| Metric | Assumption |
|---|---|
| Agent runs per day | 5 |
| Events per run | 500 (mix of tool calls and text) |
| Average event payload | 1 KB |
| Page loads per day | 100 (dashboard, sessions, reviews) |
| DynamoDB reads per page load | 5 |
| Settings/permissions lookups (cached after first load) | 10/day |
| Budget rollup writes per run | 1 |
| Dashboard queries per day | 20 |
| Storage at steady state | 2 GB (events roll off to S3 after 30 days) |

### 8.2 Monthly throughput

| Operation | Calculation | Monthly count |
|---|---|---|
| Run events written | 5 runs × 500 events × 30 days | 75,000 writes |
| Workflow/run state updates | 5 runs × 6 transitions × 30 | 900 writes |
| Misc CRUD writes | 100/day | 3,000 writes |
| Reads (page loads + dashboard) | (100 PL × 5 reads + 20 dash × 10) × 30 | 21,000 reads |
| Permission/settings reads (hot, cached) | 10/day × 30 | 300 reads |
| **Total writes** | | ~79,000 WRU |
| **Total reads** | | ~21,300 RRU |

### 8.3 Cost at Singapore on-demand rates

Verified rates for ap-southeast-1 from [dynobase.dev/dynamodb-pricing-calculator/](https://dynobase.dev/dynamodb-pricing-calculator/) (October 2026):

| Line item | Rate | Monthly usage | Monthly cost |
|---|---|---|---|
| Write request units | $0.71 / million WRU | 0.079 million | $0.056 |
| Read request units | $0.1425 / million RRU | 0.0213 million | $0.003 |
| Storage | $0.285 / GB-month | 2 GB | $0.57 |
| Streams reads (if used for archival trigger) | $0.0228 / 100k | ~20k (run events) | $0.005 |
| **DynamoDB total** | | | **~$0.63 / month** |

The 25 GB free-tier storage allowance (provisioned Standard class, shared per region) is not applicable for on-demand tables, but the 25 GB free-tier storage allowance is per-account and may apply if no other tables consume it.

At 10× the above usage (50 runs/day, 1000 events each):
- WRU: ~790k/month × $0.71 = $0.56
- Storage grows ~10 GB/month before TTL archival = $2.85
- **Total: ~$4/month**

### 8.4 Comparison with Aurora Serverless v2

At the same single-user usage, Aurora costs approximately $15–20/month (storage + I/O at 0 ACU auto-pause, plus first-request resume latency). DynamoDB is 20–30× cheaper at this scale. The gap narrows at team scale (10+ users, hundreds of agent runs/day) where Aurora's SQL advantage in complex analytics also becomes more valuable — at that point Aurora at 0.5 minimum ACU costs roughly $40–60/month versus DynamoDB at $5–10/month.

---

## 9. Open questions

| # | Question | Impact | Decision needed by |
|---|---|---|---|
| OQ-1 | **FTS quality.** Is a DynamoDB inverted index sufficient for knowledge search, or does the portal need semantic recall (Bedrock Knowledge Bases, S3 Vectors)? | Architecture of `portal-search` table; affects pilot readiness | Before phase 6.5 |
| OQ-2 | **Dashboard performance at team scale.** The dashboard today runs 10+ sequential queries per page load, each joining p6_runs → p6_workflows. The counter-rollup approach in section 4.2 must be validated against real query patterns before committing to it. Is per-agent-per-day granularity sufficient, or does the UI need per-hour breakdowns? | Counter rollup schema; might need a finer grain | Before phase 6.7 |
| OQ-3 | **Approval polling latency.** The AgentCore runner polls `GET /api/inputs/:id` to wait for an approval. With DynamoDB, polling latency is the same as a GetItem call (~1–5 ms). The in-memory Map gave 0 ms. Does the runner's polling interval (assumed 2–5 s) need adjustment? | runner.ts / approvals.ts polling loop | Before phase 6.3 |
| OQ-4 | **Approval expiry + in-flight.** The current code uses `clearTimeout` to cancel an in-memory timer when an approval is resolved. With DynamoDB TTL (section 4.7), TTL fires up to 48 hours late in rare cases. Should the runner also enforce a hard wall-clock timeout client-side, independent of DynamoDB TTL? | Security correctness (FR-GUARD-8) | Before phase 6.3 |
| OQ-5 | **Large event payloads.** The 300 KB threshold for S3 overflow (section 4.8) is conservative. Tool responses from Claude Code (especially large file reads) can be 50–200 KB each. The runner must measure payload size before writing. If the Lambda runner and the API Lambda are separate processes (AgentCore + API), the runner must use the S3 backend directly. Does the runner container need S3 write IAM on the data bucket, or does it go through the API? | IAM policy design for AgentCore container | Before phase S5 |
| OQ-6 | **`git_connections_v2` scope='shared'.** Queries like `WHERE provider = ? AND (owner_id = ? OR scope = 'shared')` use an OR on two different attribute values. DynamoDB cannot express OR across different partition keys in one Query. Options: (a) maintain a separate `SHARED_CONN#<provider>` partition item, (b) store shared connections under a synthetic `owner_id = 'SHARED'`, (c) scan the GSI (acceptable if the total number of git connections is < 50). Chosen approach must be consistent across `server/review.ts`, `server/scan.ts`, and `server/mcp-server.ts`. | Key design of `portal-projects` | Before phase 6.2 |
| OQ-7 | **Legacy M3 tables.** The plan above focuses on the P6 tables (M6+). Several non-P6 code paths still use M3 tables (`agent_runs`, `agent_run_events`, `loop_specs`, `documents`, `sections`, etc.). Are these paths actively maintained or can they be archived/removed before migration begins? Removing unused tables simplifies the migration script significantly. | Migration script scope | Before phase 6.9 |
| OQ-8 | **DynamoDB Local for CI.** The test suite (`npm run test:affected`) runs against an in-memory SQLite database today. Running the DynamoDB suite in CI requires either DynamoDB Local (Docker container) or a dedicated AWS test account. Which is preferred? DynamoDB Local is free and offline; a real account is more faithful but requires IAM setup and incurs small costs. | CI / `testing-affected` rule | Before phase 6.1 |
| OQ-9 | **Global event log (`p6_events`)** ordering across multiple Lambda invocations. SQLite's `AUTOINCREMENT` gives a total order within one process. In DynamoDB, `seq` must be assigned atomically per run. Options: (a) monotonic counter item per run (atomic ADD), (b) timestamp + UUID with the UI deduplicating by time, (c) an SQS FIFO queue that sequences events before writing to DynamoDB. Option (a) is simplest; confirm it is acceptable for replay fidelity. | `portal-events` schema | Before phase 6.4 |
| OQ-10 | **Multi-project dashboard (admin).** `buildScope` in `server/dashboard.ts` can include all projects (admin mode). With DynamoDB, querying `GSI-ProjectWorkflows` for every project in a single page load may cause excessive read units. Is the admin dashboard used frequently enough to justify a pre-aggregated `PORTAL_STATS` item maintained on every run state transition? | Dashboard architecture | Before phase 6.7 |
