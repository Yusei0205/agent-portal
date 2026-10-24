# Agent Portal: Requirements Specification (as-built baseline)

Version 0.1 (draft for review) · 2026-10-24 · Derived from the code in this repository, not from design intent.

## 0. How to use this document

This is a description of what the portal does today. Use it to decide what to keep, change or drop before any refactor.

- Each requirement has an ID (`FR-<area>-<n>`). Refer to these IDs when you reply.
- The **Decision** column is empty on purpose. Fill in `Keep`, `Change`, `Drop` or `Merge into FR-x`.
- **Evidence** tells you how I know it exists: `code` (read the implementing module), `route` (found the API route and read its name/context only), `readme` (README states it; not re-verified in code).
- Section 7 lists observations that suggest where the portal is not optimised. These are findings, not decisions.

Out of scope for this baseline: UI visual design (CSS), test content, and the three plan files in `docs/plans/`. Where the optimisation plan (2026-10-22) has already been built, it is described here as implemented.

---

## 0.1 Product intent and owner decisions (2026-10-24)

**Purpose.** A side project that speeds up project delivery, QA and code review by automating the development workflow: keeping documentation current, generating system architecture graphs, troubleshooting, and reviewing code.

| # | Decision | Consequence for this spec |
|---|---|---|
| D-1 | Both engines (Claude Agent SDK and Kiro) stay. | O-2 becomes "one agent definition, two engine exports", not "pick one". |
| D-2 | 1–3 users today. | O-10 (worker split) is dropped; a single process is enough. Heavy governance (teams, SCIM, OIDC) is not needed now. |
| D-3 | Few features now, more planned, and it will be shared with others. | Keep the extension points (loop specs, triggers, roles, integrations). Park, don't delete, multi-user features. |
| D-4 | Existing `data/` compatibility is not required. | The schema can be rebuilt from a clean baseline. `runs` and `workflows` can be merged without a migration path. |
| D-5 | Make it more user friendly. | Simplification of navigation, setup and naming is a primary goal, ahead of new features. |

**Fit against the purpose (what exists vs what is missing).**

| Goal | Today | Gap |
|---|---|---|
| Keep documentation current | "Document a repository" session mode (FR-SESS-2); Learn documents with stale flag (FR-LEARN-2); technical-writer role (FR-AGT-1); `github_event` and cron triggers (FR-LOOP-3). | No ready-made "update docs when a PR merges" loop spec. The four seeded specs are feature, bug fix, nightly tests, dependency update. |
| Architecture graph generation | Mermaid blocks render in Markdown views (`Markdown.jsx`). Role prompts mention diagrams. | No dedicated feature that generates, stores, versions or refreshes a diagram from a repository. |
| Troubleshooting | Ticket analyze (FR-JIRA-2); AWS CLI read access for agents (FR-GUARD-1). | No incident/log-driven flow, no saved runbooks. |
| QA | QA-engineer role; Jira tickets; quizzes. | No test-case generation from FSD/TSD wired to a workflow. |
| Code review | Strong: two-pass review, PR posting (FR-REV-*). | Not triggered automatically on a new PR. |

These gaps are candidate new requirements (section 7.2). They are not built.

## 1. Product summary

A self-hosted web portal for running AI coding agents against a team's projects. A project holds documents, repositories, agents, skills, sessions and members. Agents run through one of three providers (Anthropic API, Amazon Bedrock, Kiro CLI) or a simulated Demo provider. Everything runs in one Node.js process with a built-in SQLite database.

### 1.1 Users and roles

| Role | Scope | Capabilities (from `PERMISSIONS_MATRIX` in `governance.ts`) |
|---|---|---|
| Portal admin | Whole portal | Everything: users, teams, settings, audit log, SCIM, OIDC, tokens, usage for all users. Gets `owner` on every project. |
| Portal member | Whole portal | Join projects, own API tokens, own profile, own usage, accept invitations. |
| Project owner | Project | Full project configuration, members, loop specs, repos, agents, push/approve anything, project budget. |
| Project editor | Project | Start sessions and runs, manage loop specs, manage knowledge, push changes, answer own requests. |
| Project viewer | Project | View sessions, runs, documents, findings; take quizzes. |
| Team maintainer / member | Team | Maintainer manages team members, project access, team budget. Members inherit team project access. |

Effective project access is the highest of direct membership and all team grants (`effectiveAccess`).

### 1.2 Tech baseline (`code`)

| Item | Current |
|---|---|
| Runtime | Node.js ≥ 22.13, single process, `node:sqlite` |
| Backend | TypeScript, hand-written HTTP router (`http.ts`), ~40 modules in `server/` |
| Frontend | React 19, plain JSX (not TypeScript), hand-written hash router, Recharts, Mermaid, Marked + DOMPurify |
| Agent SDK | `@anthropic-ai/claude-agent-sdk`, plus Kiro CLI over ACP |
| Live updates | Server-sent events (run streams, project streams, inbox events, tool install log) |
| Packaging | Dockerfile, `compose.yml`, optional `compose.aws.yml`, browser MCP compose profile |

---

## 2. Functional requirements

### 2.1 Authentication and accounts (AUTH)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-AUTH-1 | First visit with no users shows a setup page that creates the admin account. Alternatively `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars create it at start. | code (`index.ts`, `auth.ts`) | |
| FR-AUTH-2 | Email + password login. Passwords hashed with scrypt. Sessions are HttpOnly cookies; expired sessions are cleaned every 6 hours. | code | |
| FR-AUTH-3 | Users can change their own password and edit their profile (`/api/profile`). | route | |
| FR-AUTH-4 | Google OIDC sign-in (PKCE, state, nonce, RS256 JWK verification). Admin configures it. | code (`governance.ts`) | |
| FR-AUTH-5 | Admin invites users by a single-use, expiring, hashed-at-rest link (copy/paste, no email sending). Invitee accepts at `#/accept-invite/<token>`. | code | |
| FR-AUTH-6 | Admin can deactivate/reactivate a user and generate a password-reset link (`#/reset-password/<token>`). | code | |
| FR-AUTH-7 | SCIM 2.0 minimal: `/scim/v2/Users` and `/scim/v2/Groups`, authenticated with admin-issued SCIM tokens. | code | |
| FR-AUTH-8 | API tokens: users create/revoke personal tokens; optional project scope (`/api/tokens/scoped`). Tokens are sent back once. | code (`api-tokens.ts`, `governance.ts`) | |
| FR-AUTH-9 | All mutating API calls require a same-origin header. | readme | |

### 2.2 Projects, teams and access (PROJ)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-PROJ-1 | Create, edit, archive, delete a project. Each project has its own git repository on disk (`data/projects/<slug>/`) holding `CLAUDE.md`, agents, skills, docs and decisions. | code, readme | |
| FR-PROJ-2 | Add/update/remove project members with `viewer`/`editor`/`owner` access. | route | |
| FR-PROJ-3 | Teams: CRUD, team members (`maintainer`/`member`), grant a team access to projects, per-team monthly budget. | code | |
| FR-PROJ-4 | A project event stream (`/api/projects/:pid/stream`) pushes changes to open browsers. | route | |
| FR-PROJ-5 | Every change to agents, skills, documents and decisions is committed to the project's git repo. | readme | |
| FR-PROJ-6 | **Setup hub** per project: a readiness panel (provider, AWS account, git connection, repository, lead agent, budget) with a fix link for each gap. Tabs: Overview, Connection & provider, Repositories, Agents & skills, Team & members, Jira, Configuration, Budget. | code (`ProjectSetup.jsx`, `GET /api/projects/:pid/readiness`) | |
| FR-PROJ-7 | Project configuration files (e.g. `CLAUDE.md`) can be listed, edited, created as folders, deleted, exported and imported as a bundle. | route (`config-files.ts`) | |

### 2.3 Repositories and git (REPO)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-REPO-1 | Connect GitHub, AWS CodeCommit (`https://` or `codecommit::`) or generic git repositories to a project. A reference clone is made; status moves `new → … → Ready` (or error). | code | |
| FR-REPO-2 | Manual sync, list branches, delete a branch, list open pull requests per repository. | route | |
| FR-REPO-3 | **Git connections** (portal-level): saved credentials for GitHub etc., tested, reused across projects, can list the provider's repositories for quick adding. | code (`git-connections.ts`) | |
| FR-REPO-4 | CodeCommit: list repositories in the project's AWS account. Create CodeCommit pull requests when pushing. | code (`codecommit.ts`) | |
| FR-REPO-5 | Workspaces: a named set of repositories (and integrations) in a project that a session can use as a group. | code (`workspaces.ts`) | |

### 2.4 Cloud accounts and secrets (CLOUD)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-CLOUD-1 | Portal default AWS sign-in method: server identity (instance role/env), named profile, access keys, Bedrock API key, or AWS SSO (IAM Identity Center, browser device flow). | code (`settings.ts`, `sso.ts`) | |
| FR-CLOUD-2 | **AWS accounts** (portal-level): saved connections, tested, grouped by the real AWS account id they resolve to. Projects choose one or inherit. Legacy per-project keys migrate to AWS accounts at start. | code (`aws-connections.ts`, `aws-accounts.ts`, `project-aws.ts`) | |
| FR-CLOUD-3 | Secrets (API keys, tokens) are encrypted with AES-256-GCM in SQLite, or stored in AWS SSM Parameter Store. Never sent to the browser. The key comes from `PORTAL_SECRET_KEY` or `data/master.key`. | code (`secrets.ts`) | |
| FR-CLOUD-4 | **Vault**: files that are copied into every run's folder. Three scopes: project (members see, editors edit), personal (only the user, all their runs), team-wide (everyone). Download single file or zip. | code (`vault.ts`) | |

### 2.5 Model providers and engines (PROV)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-PROV-1 | Portal provider mode: `demo`, `anthropic`, `bedrock`, `kiro`. Default is `demo`. | code | |
| FR-PROV-2 | Optional exact model IDs behind the `sonnet`/`haiku`/`opus` aliases for Bedrock and Kiro. Free-text extra models (up to 50) can be added to the picker without a deploy. | code | |
| FR-PROV-3 | Model list is fetched from the provider (Bedrock / Kiro) and cached; the model picker shows it. | code (`models.ts`, `model-cache.ts`) | |
| FR-PROV-4 | A project can override the AWS account/provider and pick an **engine** per session: Claude Code or Kiro. | code (`project-aws.ts`, `workflows.ts`) | |
| FR-PROV-5 | "Test connection" for portal and project settings. | route | |
| FR-PROV-6 | Demo mode runs a simulated agent so every feature works without credentials. | code (`agent/demo.ts`) | |
| FR-PROV-7 | **Tool packs** (off by default): `uv/uvx`, `Kiro CLI`, `Browser MCP`. Admin installs uv/kiro from Settings with a live log stream; browser runs via compose profile with isolated context per run (max 3 concurrent). | code (`tool-packs.ts`) | |
| FR-PROV-8 | **Integrations** (MCP servers): portal-level definitions, tested, attached to sessions or workspaces. A built-in "Web browser" integration is created when the browser pack is available. | code (`integrations.ts`) | |

### 2.6 Knowledge base (KB)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-KB-1 | Upload Word, PDF, Excel, PowerPoint, Markdown, HTML (and `.odt/.rtf/.epub` with pandoc). Files convert to Markdown, are split into sections and indexed in SQLite FTS5. | code (`convert.ts`, `knowledge.ts`), readme | |
| FR-KB-2 | Folders (virtual, created before use), rename/delete folders, bulk move documents, assign a document to a repository. | route | |
| FR-KB-3 | Full-text search with section snippets and line numbers. | route | |
| FR-KB-4 | **Ask**: answer a question from the documents with cited sources (Haiku by default). History of Q&A is kept. | route, readme | |
| FR-KB-5 | **Open questions**: an unanswerable question can be sent to the team; the answer goes to the **Decisions log** (`docs/decisions.md`), which every agent reads first. | route, readme | |
| FR-KB-6 | Re-index a document, download the original, delete a document. Re-uploading a changed source marks dependent Learn content stale. | route, readme | |

### 2.7 Agents, roles and skills (AGT)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-AGT-1 | Seven role templates (business analyst, solution architect, backend dev, frontend dev, QA, reviewer, technical writer) can be applied, enabled/disabled, removed per project. | route, readme (`roles-library.ts`, `roles-delivery.ts`) | |
| FR-AGT-2 | Custom Claude agents: create/edit/enable/delete (`.claude/agents/`), with tool list and model choice. | route (`builder.ts`) | |
| FR-AGT-3 | Skills: create/edit/enable/delete (`.claude/skills/`), edit individual skill files, add from a skill-template catalog. `project-docs` is built in. | route | |
| FR-AGT-4 | Kiro agents: separate definition set (`kiro-agents.ts`) with list, edit, enable, delete, import; "lead agent" choices per engine. | route | |
| FR-AGT-5 | Shared library: save an agent/skill from a project, install into another project, delete from library. | route | |
| FR-AGT-6 | One-click **test run** of an agent. | route | |
| FR-AGT-7 | **Import** from a `.claude` folder, zip, or (admin) server path. Preview shows conflicts, invalid items and missing skills; per-item Overwrite/Skip/Rename; then confirm. | code (`importer.ts`) | |
| FR-AGT-8 | **Describe**: draft a new agent or skill from a plain-language description, optionally grounded in project documents. | route | |

### 2.8 Sessions (SESS), the core feature

A **session** is a saved goal that the portal drives through repeated agent runs ("iterations") until done, blocked, or a limit is hit (`workflows.ts`). A **run** is a single agent execution (`runs.ts`); the older single-run flow still exists.

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-SESS-1 | Start a session with: title, goal (≤ 6000 chars), repositories/branches or a workspace or "playground" (no repo), engine, model, lead agent, budget (default $5), max iterations (default 8), rules, push mode, trust-all-tools, integrations, context items, optional Jira key, optional loop spec, optional planning gate. | code | |
| FR-SESS-2 | Launcher modes: **Session** (autonomous), **Single run** (one run with approval choice), **Document a repository** (writes cited docs, no code changes). | code (`NewSessionDialog.jsx`) | |
| FR-SESS-3 | Each iteration ends with a `WORKFLOW_STATUS {state: continue|done|blocked, summary, next, needs, branch, delegate[], push}` line that the portal parses. | code (`guardrails.ts`) | |
| FR-SESS-4 | Session statuses seen in code: `queued`, `running`, `paused`, `stopped`, `done`, `blocked`, `failed`. Finished sessions re-open when a person sends a new message. | code | |
| FR-SESS-5 | Stop conditions: budget, max iterations per burst, stagnation (same summary N times, default 3), 2 consecutive failed runs, optional wall-clock limit, blocked commands. | code | |
| FR-SESS-6 | Controls: pause, resume, stop, cancel while queued, delete, send a message, change settings mid-session. | route | |
| FR-SESS-7 | **Verification**: after each iteration, run the check command (legacy single `verify_command`) or the spec's pipeline; the result is fed into the next iteration's prompt. | code | |
| FR-SESS-8 | **Context**: attach documents, files, notes to a session; they are injected into iteration prompts (inline budget 20,000 chars). | code (`session-context.ts`) | |
| FR-SESS-9 | **Delegation**: a session can hand tasks (up to 5 per status line) to child sessions. Limits: 3 per parent, 6 per user, nesting off by default. | code (`settings.ts` `delegation`) | |
| FR-SESS-10 | **Slash commands** in the session composer: `/help /model /agent /engine /context /usage /status /stop /resume /tools /browser /aws`. | code (`session-commands.ts`) | |
| FR-SESS-11 | Session workspace tabs: Live, Changes, Activity, Context, Settings. Live shows an agent graph/tree, timeline, and every tool call with cost per agent. | code (`SessionWorkspace.jsx`) | |
| FR-SESS-12 | Changes tab: file list, diffs, download a file or zip, view working copies per repo, attach a repo mid-session. | route | |
| FR-SESS-13 | **Push**: push mode `never | ask | auto`. `ask` creates a pending push card to Allow/Deny. A push goes to a new work branch; a pull request can be opened (GitHub/CodeCommit). Shared branches (e.g. main) are refused. | code | |
| FR-SESS-14 | **Plan-first gate**: with the gate on, the session pauses for a human to approve the plan before it acts. | code (`approve-plan`, `shouldPlanFirst`) | |
| FR-SESS-15 | Sessions interrupted by a server restart resume automatically (admin setting, default on). Loop state is persisted so counters survive. | code (`index.ts`, `loop_run_states`) | |
| FR-SESS-16 | Sessions list with status filter, sort, and live facts (latest run state, pending approvals). A legacy run URL redirects into the sessions UI. | code (`SessionList.jsx`, `legacyRunTarget`) | |
| FR-SESS-17 | Single runs: stream, stop, continue (follow-up), changes, file view/download, zip, push, remove worktree, answer approval/question. | route | |

### 2.9 Guardrails (GUARD)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-GUARD-1 | **Always blocked**, even in trusted sessions: terraform/tofu apply/destroy, cdk/sam/serverless/pulumi deploy, CloudFormation changes, Lambda changes, amplify publish, kubectl/helm mutations, `docker push`, any non-read AWS CLI verb, S3 mutations. | code | |
| FR-GUARD-2 | **Blocked unless trusted**: `git push`, `sudo`, deleting outside the working copy, `npm publish`, `curl \| sh`, disk/system commands. | code | |
| FR-GUARD-3 | Agents write only inside their own `work/<run id>/` folder. Run environment is cleaned of portal secrets. | readme | |
| FR-GUARD-4 | Trusted pushes are handled by the portal, which parses and validates the push command and branch name. | code | |
| FR-GUARD-5 | Shell steps in verification run with `AWS_*`, `ANTHROPIC_*`, `PORTAL_*`, `GITHUB_*`, `GH_*` env vars removed. | code | |

### 2.10 Loop engineering (LOOP)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-LOOP-1 | **Loop spec**: reusable named config with trigger, goal template (`{{ticket.key}}`, `{{repo.name}}`, `{{date}}`, payload vars), rules, verification pipeline, stop rules, memory config, escalation, push mode, trust, lead agent, engine, monthly budget. CRUD per project. | code (`loop-specs.ts`) | |
| FR-LOOP-2 | Four seeded specs: Feature from Jira ticket, Bug fix, Nightly test fixer, Dependency update. | code | |
| FR-LOOP-3 | Triggers: `manual`, `cron` (5-field), `interval`, `webhook` (HMAC), `github_event` (pull_request, workflow_run, check_suite), `jira_event` (polls Jira by JQL/status). Evaluated once a minute. | code (`loop-triggers.ts`) | |
| FR-LOOP-4 | Trigger safety: dedup per (spec, key) once an hour; rate limit default 3/hour; does not start while the spec already has a running session; trigger history is recorded. | code | |
| FR-LOOP-5 | Verification pipeline: ordered steps; `cmd` (shell, timeout default 300s) or `llm` judge (advisory only, Haiku, deterministic in Demo). Required steps decide pass/fail. Results stored and shown. | code (`loop-verification.ts`) | |
| FR-LOOP-6 | Progress file memory: per-iteration summaries written to a file (default last 20) and fed back to the agent. | code | |
| FR-LOOP-7 | Save a finished session as a loop spec. | route | |
| FR-LOOP-8 | Loop metrics per spec, per project and global (done rate, autonomy, cost per done session, stagnation, intervention). | route (`/api/.../loop-metrics`, `/api/metrics`) | |
| FR-LOOP-9 | Escalation: Inbox item and outbound webhook when blocked/failed/over budget; optional GitHub issue on blocked (GitHub repos). Dismissable. | code | |

### 2.11 Inbox and notifications (INBOX)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-INBOX-1 | Cross-project **Inbox** of everything needing a human (approvals, questions, pending pushes, blocked sessions), filters Needs you / Running / Done / All, navigation badge updated via SSE. | code (`loop-engine.ts`, `Inbox.jsx`) | |
| FR-INBOX-2 | Approve/deny or answer from the Inbox without opening the session. | code | |
| FR-INBOX-3 | **Outbound webhooks**: admin subscribes a URL to events `session.done`, `session.blocked`, `session.failed`, `push.pending`, `approval.overdue`, `budget.threshold`, `trigger.fired`. HMAC-SHA256 signature `X-Portal-Signature`, 3 attempts with backoff, test button. | code | |
| FR-INBOX-4 | Approval SLA: an unanswered approval is flagged overdue after N minutes (default 30); budget threshold alerts. | code (`control-plane.ts`) | |

### 2.12 Jira and tickets (JIRA)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-JIRA-1 | Per project: register a Jira OAuth app, connect a Jira site, map a Jira project key and optional extra JQL. | code (`jira.ts`) | |
| FR-JIRA-2 | Tickets page: list (Assigned to me / All open / Everything), view a ticket, see runs linked to it, **analyze** a ticket with an agent. | code (`Tickets.jsx`) | |
| FR-JIRA-3 | Ticket picker in the session launcher; "Start coding run" on a ticket pre-fills the key. Branch name, commit message and draft PR title include the key. | readme, code | |
| FR-JIRA-4 | Post a run result back as a Jira comment. Ticket attachments are downloaded for context. | route, code | |

### 2.13 Code review (REV)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-REV-1 | Review two branches or a GitHub pull request. Findings are shown next to changed lines with severity and category. | code (`review.ts`) | |
| FR-REV-2 | Two passes: cheap Haiku triage plus a rule-based heuristic scan (secrets, SQL concatenation, eval, TLS off, empty catch, debug output, `any`); optional Sonnet "Deep look". | code (`agent/heuristics.ts`) | |
| FR-REV-3 | Accept/dismiss each finding; post findings to GitHub as PR comments. | route | |

### 2.14 Learn (LEARN)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-LEARN-1 | Generate documents from project knowledge/repos: System overview, Feature guide, Glossary, FAQ. Two versions (for everyone / for engineers) plus a glossary. Draft → approve → publish/unpublish. | route (`learn.ts`, `docgen.ts`) | |
| FR-LEARN-2 | Documents track source hashes and flag **stale** when a source changes. Regenerate, export (single doc or all as zip), mark as read. | route | |
| FR-LEARN-3 | Quizzes generated from documents (audience, difficulty), validated against sources (unsupported questions are dropped), published and taken; attempts and scores stored. | route | |
| FR-LEARN-4 | Onboarding paths (manual or auto-built) of docs and quizzes; team progress view. | route | |

### 2.15 Insights, usage and cost (INS)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-INS-1 | Insights dashboard (project and all-projects): provider/kind breakdowns (chat, test, review, QA, learn, quiz, verify, connection), duration, failure, tool error rate, daily trends. | code (`insights.ts`, `Insights.jsx`) | |
| FR-INS-2 | Cost per run and per agent in a tree; monthly spend; **monthly budget** (default $50) blocks new runs when reached. Per-user and per-team usage. | code (`settings.ts`, `governance.ts`) | |
| FR-INS-3 | Demo mode shows what a run would have cost. | readme | |

### 2.16 Administration and operations (ADMIN)

| ID | Requirement | Evidence | Decision |
|---|---|---|---|
| FR-ADMIN-1 | Admin panel tabs: Users, Teams, Google sign-in, SCIM, Audit log, Control plane. | code | |
| FR-ADMIN-2 | **Audit log**: append-only record of auth, user, member, settings, secret, project, repo, git connection, session, push, approval, token, tool install, invitation, team, SCIM and OIDC actions with actor, target, IP. | code (`audit.ts`) | |
| FR-ADMIN-3 | **Control plane**: global / per-user (default 5) / per-project concurrency caps; excess sessions queue with a reason and position. | code (`control-plane.ts`) | |
| FR-ADMIN-4 | Graceful **drain** on SIGTERM/SIGINT (default 60 s) and via `/api/admin/drain`: stop accepting new work, wait for running iterations. | code | |
| FR-ADMIN-5 | Worktree clean-up: `work/<run id>/` folders for finished sessions are removed after N days (default 30); folders with uncommitted changes are skipped. Runs daily. | code | |
| FR-ADMIN-6 | `GET /api/health`, `dist/preflight.mjs` dependency check, backup via volume tar, upgrade with automatic DB migrations. | code, readme | |
| FR-ADMIN-7 | Settings page: provider, Kiro, AWS auth, budget, secrets storage (local / AWS SSM), agent defaults (permission mode, max turns 40, resume after restart, default push mode `ask`), model list, delegation, control plane. | code (`settings.ts`) | |

---

## 3. Navigation map (current)

Project items: Sessions, Workspaces, Tickets, Code review, Knowledge, Learn, Vault, Setup (Repositories, Agents and skills, Configuration, Project and team, Project insights).
Portal group: Inbox, Git connections, Integrations, AWS accounts, Vault, API access, All insights, Admin (admin only), Settings (admin only).

## 4. Data model (SQLite, from migrations in `db.ts`)

Core tables: `users`, `sessions` (login), `settings`, `secrets`, `projects`, `project_members`, `repos`, `runs`, `run_events`, `inputs`, `documents`, `sections` (+ `sections_fts`), `project_folders`, `reviews`, `findings`, `project_roles`, `learn_docs`, `quizzes`, `quiz_attempts`, `paths`, `doc_reads`, `project_jira`, `project_aws`, `aws_identities`, `workflows`, `workflow_events`.
Added later (seen in code, schema not re-read): `workflow_context`, `loop_specs`, `loop_run_states`, trigger history, `outbound_webhooks`, teams / team members / team projects, invitations, SCIM tokens, audit log, API tokens, workspaces, integrations, git/AWS connections, vault.

Note the two parallel execution tables: `runs` (+ `run_events`) and `workflows` (+ `workflow_events`).

## 5. External interfaces

| Interface | Direction | Notes |
|---|---|---|
| REST JSON API under `/api/*` | In | About 275 routes. Cookie auth or API token. |
| `/scim/v2/*` | In | Identity provisioning. |
| `/api/loop-specs/:sid/webhook`, `/github` | In | HMAC-verified trigger webhooks. |
| `/api/jira/callback`, `/api/auth/oidc/callback` | In | OAuth redirects. |
| SSE streams | Out | Run, project, inbox, tool install. |
| Outbound webhooks | Out | Signed JSON to admin-defined URLs. |
| Anthropic API, Bedrock, Kiro CLI (ACP) | Out | Model providers. |
| GitHub, CodeCommit, generic git, Jira Cloud, AWS SSO/SSM | Out | |
| Subprocesses: git, pandoc, kiro-cli, uvx, aws CLI | Out | |

## 6. Non-functional requirements (as built)

| ID | Requirement | Evidence |
|---|---|---|
| NFR-1 | Runs as one process with no external services. Port binds to 127.0.0.1 in Docker; HTTPS and `TRUST_PROXY=1` expected behind a reverse proxy. | readme |
| NFR-2 | Agents run as the portal's OS user; untrusted repos should run in a container or VM. | readme |
| NFR-3 | Request timeout disabled (long uploads and streams); headers timeout 60 s. | code |
| NFR-4 | Container memory capped at 3 GB. | readme |
| NFR-5 | Rate limiting exists for triggers only (3 firings/hour/spec). No general API or login rate limit was found in the files read. | code (partial) |
| NFR-6 | Secrets never logged or returned; shell environments are scrubbed. | code |

---

## 7. Observations on what is not optimised

These come from file sizes and structure. Measure before acting on any of them.

| # | Observation | Evidence | Candidate requirement |
|---|---|---|---|
| O-1 | **Two execution models.** Single runs (`runs.ts`, `/api/runs/*`) and sessions (`workflows.ts`, `/api/workflows/*`) overlap. The launcher already offers "Single run" as a mode inside sessions, and a legacy redirect exists. | code | Merge into one model; a single run is a session with `maxIterations = 1`. |
| O-2 | **Two agent-definition systems.** Claude agents/skills (`builder.ts`, `/agents`) and Kiro agents (`kiro-agents.ts`, `/kiro-agents`) have parallel CRUD and UI. | route | One agent definition with engine-specific export. |
| O-3 | **Very large modules.** `roles-library.ts` 115 KB, `roles-delivery.ts` 97 KB, `workflows.ts` 83 KB, `governance.ts` 63 KB (eight concerns in one file). Pages: `SessionWorkspace.jsx` 62 KB, `Knowledge.jsx` 61 KB, `Insights.jsx` 61 KB, `NewSessionDialog.jsx` 60 KB, `Builder.jsx` 60 KB, `Settings.jsx` 52 KB. CSS: `styles.css` 127 KB plus `hud.css`. | file listing | Split by concern; move role templates to data files. |
| O-4 | **Duplicated navigation.** Vault appears in project items and in Portal items. Insights appears twice (project / all). "Inbox" means two things: the cross-project Inbox (`/api/inbox`) and the Knowledge "Open questions" (`/api/projects/:pid/inbox`). | code (`App.jsx`, routes) | One name per concept; decide whether project vault and portal vault are one page. |
| O-5 | **Two overlapping setup surfaces.** Both are live in `App.jsx`: `ProjectSetup.jsx` (tabbed hub) lazy-imports components from `ProjectSettings.jsx`, and `Repos.jsx` imports from it too. The nav also lists Repositories / Agents / Configuration / Team as separate Setup items that duplicate the hub's tabs. | code | One setup hub; nav shows it once. |
| O-6 | **Settings spread over four levels** (portal, AWS account, project, session) with provider, push mode, budget and lead agent each configurable in several places. | plan, code | Single owner per setting, shown with precedence. |
| O-7 | **Frontend is untyped JSX** with a hand-written router and no shared API types, while the backend is TypeScript. | code | Type the web app, or generate API types. |
| O-8 | **Hand-rolled infrastructure.** HTTP router, mini cron parser, SSE, FTS indexing, markdown conversion and a 275-route API without a schema or OpenAPI description. | code | Decide which to keep; add an API schema. |
| O-9 | **Inconsistent naming in verification.** Code comments refer to both `failStop` and `required` for the same flag. The plan document used `failStop`; the type uses `required`. | code | One field name; migration for stored specs. |
| O-10 | **Single process drives everything** (session drivers, trigger polling, SLA checks, webhook retries). | code (`index.ts`) | **Dropped by D-2**: acceptable at 1–3 users. |
| O-11 | **README is behind the code.** It does not mention sessions, loop specs, Inbox, workspaces, teams/SCIM/OIDC, vault, integrations, insights or outbound webhooks. | readme vs code | Replace README feature list with this spec's summary. |
| O-12 | **Repo hygiene.** `server.out.log` and `server.err.log` sit in the repo root; test files over 40 KB (`workflows.test.ts` 82 KB) are hard to maintain. | file listing | Ignore logs; split tests with modules. |
| O-13 | **Security gap candidates** found in passing: no general login/API rate limit (NFR-5); first-admin setup race noted in the optimisation plan; check whether it was fixed. | plan, code (partial) | Verify, then specify. |

---

## 7.2 Candidate new requirements (from the purpose in 0.1; not built)

| ID | Candidate | Builds on |
|---|---|---|
| NEW-1 | Architecture diagram generator: produce Mermaid diagrams (system context, components, data flow) from a repository, store them versioned in the project, refresh on demand or on a trigger. | Document-a-repository mode, Markdown/Mermaid rendering, loop triggers |
| NEW-2 | "Keep docs current" loop spec: on PR merge or nightly, update affected docs and diagrams and open a PR. | `github_event`/cron triggers, technical-writer role |
| NEW-3 | Auto code review on new PR with comments posted back. | Review module, GitHub trigger |
| NEW-4 | QA pack: generate test cases from FSD/TSD and a ticket, trace each case to its source section. | Knowledge base, QA role |
| NEW-5 | Troubleshooting flow: paste an error/log or ticket, agent investigates with read-only access, writes findings to a runbook note. | Ticket analyze, guardrails |

## 8. Resolved questions

| Question | Answer |
|---|---|
| Keep both engines? | Yes (D-1). |
| Scale? | 1–3 users (D-2). |
| Audience? | Small now, to be shared later (D-3). |
| Keep `data/` compatibility? | No (D-4). |

## 8.1 Questions still open

1. Park or delete the multi-user features (teams, SCIM, Google sign-in, outbound webhooks)? Parking means hidden behind an "Advanced" admin switch and off by default.
2. Which of NEW-1 to NEW-5 matter first?
3. Do you want the Learn module (documents, quizzes, onboarding paths) kept? It overlaps with your doc-automation goal but adds quizzes and paths, which your purpose statement doesn't mention.

## 9. Verification limits of this draft

I read routes for every module and read the implementation of: sessions entry points, guardrails, loop specs/triggers/verification/engine headers, audit, governance headers and permissions matrix, settings, DB migrations (first part), app navigation. I did not read the bodies of knowledge, learn, review, builder, importer, insights, jira, or the front-end pages in full. Entries marked `route` or `readme` should be checked in the code when you decide to change them.
