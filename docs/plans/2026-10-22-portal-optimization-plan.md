# Portal optimisation plan — loop engineering mode, simplified UX, governance

Status: **draft** · 2026-10-22 · synthesised from loop-research, ux-audit, governance-audit reports

---

## 1. Summary

- **Turn the portal into a loop machine.** The biggest speed-up is removing the human from the "start a new session" step entirely. Loops should fire from a Jira status change, a failed CI run, or a cron schedule — not from a person clicking *New session*. The gap between what the portal has (`drive()` in `workflows.ts`) and what loop engineering requires (durable triggers, a verification pipeline, reusable specs) is bridgeable in two weeks without a new runtime.
- **The setup path is broken.** Getting from zero to a pushed PR currently takes 10 hops across 8 pages (`Settings.jsx`, `AwsAccounts.jsx`, `Connections.jsx`, `ProjectSettings.jsx`, `Repos.jsx`, `Builder.jsx`, `NewSessionDialog.jsx`, `SessionWorkspace.jsx`). A single project **Setup hub** with an inline readiness panel collapses that to one page and one dialog.
- **The session workspace buries what matters.** Approvals live in the *History* tab (labelled wrong), push cards only appear in the *Live* tab, and there is no cross-project surface for items that need a human. A unified **Inbox** (already designed in the sessions-workspace refactor) with a nav badge solves this without adding any new concept.
- **Durability is one table away.** The `drive()` loop loses its `failures`, `summaries`, and `lastCheck` locals on every restart (`workflows.ts:~145`). Persisting these into a `loop_run_states` table requires no new dependency, fixes restart lossiness, and unblocks reliable loop metrics.
- **Governance has three critical gaps** — no audit log, no per-user/project budget ceiling, and no approval SLA. Each is a 1–4 hour change. Leaving them open means one runaway session can exhaust the monthly cap and leave no trace.
- **The setup endpoint is an open invitation for the first-admin race condition.** `auth.ts:userCount()` has no rate-limit or invite token on `/api/auth/setup`. A one-line setup nonce written to `data/master.key` (already there) at startup closes it.
- **All three reports agree on the priority order**: durability and governance first (days), then loop specs and the Setup hub (one week), then triggers and Inbox (two weeks). The one genuine conflict — whether to add a full Organisation → Team → Project hierarchy now or defer it — is resolved below.

---

## 2. Principles

1. **Fix it where you are.** If a user is in the session launcher and the repo is missing, they can add the repo there, in an inline sheet, without navigating to `Connections.jsx`. No redirects. This is the single most repeated frustration across the UX audit.
2. **One source of truth per setting, with visible precedence.** Every setting that appears in more than one place today (provider, push mode, lead agent, budget) is owned at exactly one level. The three levels — portal default → project override → session override — are shown as a labelled table wherever a setting appears, with a pencil link to its authoritative page.
3. **Loops are specs.** A loop is a named, shareable object with five required fields: trigger, goal template, verification pipeline, stop rules, and memory config. Sessions are one run of a loop spec. Starting a session without a spec is still possible (blank mode), but every session can be promoted to a spec with one click.
4. **Durable by default.** Anything that changes the outcome of a run is written to the database before being acted on. In-memory state (`driving` Map, `failures`, `summaries` in `drive()`) is always a cache of database state, never the source of truth.
5. **Explicit terminal states.** Every loop spec names its done/blocked/escalate/budget-exhausted states. The UI never shows a session stuck with no explanation. When a session hits `blocked` and no human is watching, it escalates to the Inbox and optionally to a GitHub issue.
6. **Autonomy rate is the north-star metric.** The measure of success is the fraction of loop spec runs that reach `done` and open a PR without any human input. All other metrics (cost per done session, stagnation rate, human intervention rate) are secondary.

---

## 3. Target experience

### Journey 1 — First-time setup (new project, CodeCommit via Kiro)

After the change, a new user lands on **Project › Setup** and sees a readiness panel at the top. Every gap shows a [Fix] link that opens an inline panel — no page navigation. The sequence is:

```
┌─ Project: Refund service ─────────────────────────────────────────────────┐
│  Setup                                                                     │
│                                                                            │
│  ┌─ Ready to run? ────────────────────────────────────────────────────┐   │
│  │  ✅ Provider        Kiro CLI  (portal default)                     │   │
│  │  ❌ AWS account     None — needed for CodeCommit      [Add]        │   │
│  │  ❌ Git connection  None                              [Add]        │   │
│  │  ❌ Repository      None                              [Add]        │   │
│  │  ⚠️ Lead agent      None — agents will self-organise  [Fix]        │   │
│  │  ✅ Budget          $5 / session  (portal default)                 │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
│  Settings precedence                                                       │
│  Portal default  →  Project override  →  Session override                 │
│  (Settings)          (here)               (launcher / workspace)          │
│                                                                            │
│  [Connection & provider]  [Repositories]  [Agents & skills]               │
│  [Team & members]         [Jira]          [Configuration]                 │
└────────────────────────────────────────────────────────────────────────────┘
```

Each [Add] / [Fix] opens an **inline sheet** anchored to the hub. Adding an AWS account while on the Repositories sheet opens a nested sheet (up to two levels deep). By the time all items are green the user can click *Start session* from the readiness panel itself.

Total page visits: **1** (the Setup hub). Current: 8.

---

### Journey 2 — Launch a loop from a Jira ticket

The user navigates to **Tickets**, opens `RLP-2683`, and clicks *Start coding run*. The launcher pre-fills the Jira key and finds a matching **loop spec** for the project (e.g., "Feature branch loop"):

```
┌─ Start session ──────────────────────────────────────────────── [×] ─┐
│                                                                        │
│  Loop spec: ● Feature branch  ○ Bug fix  ○ Blank                      │
│  (Specs pre-fill verification, stop rules, push mode from the spec)   │
│                                                                        │
│  Jira ticket  RLP-2683 — Fix refund limit  ✅                         │
│  Goal  (filled from spec template)                                    │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │ Implement {{ticket.summary}} in {{repo.name}}. Stop when all    │ │
│  │ tests pass and the PR is ready for review.                      │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  Repository  ● refund-service · main ▾             [+ Add]            │
│                                                                        │
│  Agent pushes:  ○ Never  ○ Ask me  ● Auto  (from spec)                │
│                                                                        │
│  Verification  lint → typecheck → test → llm-judge  (from spec)       │
│                                                                        │
│  ▸ Advanced  (model · lead · budget · iterations · trust · context)   │
│                                                                        │
│  Using: Kiro CLI · prod-bedrock · $5 budget  [Change]                 │
│  ─────────────────────────────────────────────────────────────────    │
│  [Cancel]                                      [▶ Start session]      │
└────────────────────────────────────────────────────────────────────────┘
```

The session starts, the agent runs the verification pipeline after each iteration, and reaches `done` by opening a PR. The user never touches the session — it appears in the Inbox as **DONE** with an [Open PR] link.

---

### Journey 3 — Handle a blocked session from the Inbox

A session working on `RLP-2690` hits `blocked` because it needs a product decision. The user receives a notification badge on the *Inbox* nav item (visible on every page). Opening the Inbox:

```
┌─ Inbox ──────────────────────────────────────────────────────────────────┐
│  [All projects ▾]   Filter: ● Needs you  ○ All  ○ Running  ○ Done        │
│                                                                           │
│  ⚠️ WAITING  refund-service / RLP-2690  ·  3 min ago                     │
│     "Should the refund cap apply to subscription orders?"                │
│     [Answer]  [Dismiss]                                                  │
│                                                                           │
│  🔔 PUSH READY  refund-service / feature/rlp-2683  ·  8 min ago          │
│     13 files changed  +412 −88   [Review changes]  [Push]  [Reject]     │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

[Answer] deep-links to the session's History tab with focus on the question. [Push] executes the push from the Inbox without leaving the page. After the push, the Inbox shows the session as DONE with an [Open PR] link that routes to Code review with the branch pre-selected.

---

### Journey 4 — Review and merge the PR

After any session push, a **Review** button appears on the session's Changes tab. Clicking it opens Code review with the session's `work_branch` and base branch already filled in (today the user must navigate to `Review.jsx` and re-select both manually). The reviewer accepts or dismisses findings and clicks *Post to GitHub* to comment on the PR. The PR link is also shown in the Inbox card.

---

## 4. Workstreams

### A — Loop engineering mode

**Problem.** All sessions start manually. The `verify_command` is a single free-text string with no pipeline, no step record, and no LLM judge. The `drive()` loop loses its state (`failures`, `summaries`, `lastCheck`) on every restart (`workflows.ts:~145`). There are no reusable loop specs, no cross-session metrics, and no event-driven triggers. This forces the developer to babysit every session instead of designing the system.

**Proposal.** Introduce `loop_specs` as a first-class object. Sessions become instances of a spec. Replace `verify_command: string` with a `verification: json` pipeline. Persist iteration state to `loop_run_states`. Add cron triggers first, then webhook triggers for GitHub and Jira.

**Data model / API changes.**

New tables:

```sql
CREATE TABLE loop_specs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  trigger_kind    TEXT NOT NULL DEFAULT 'manual',  -- manual|cron|webhook|github_event|jira_event
  trigger_config  TEXT NOT NULL DEFAULT '{}',      -- JSON: {cron} | {event, filter, secret}
  goal_template   TEXT NOT NULL,                   -- Handlebars: "Fix {{ticket.summary}}"
  rules           TEXT,
  verification    TEXT NOT NULL DEFAULT '[]',      -- JSON array of step objects (see below)
  stop_rules      TEXT NOT NULL DEFAULT '{}',      -- JSON: maxIterations, budgetUsd, stagnationWindow
  memory_config   TEXT NOT NULL DEFAULT '{}',      -- JSON: progressFile, appendDecisions
  escalation      TEXT NOT NULL DEFAULT '{}',      -- JSON: onBlocked, onFail
  push_mode       TEXT,
  trust_tools     INTEGER,
  lead_agent      TEXT,
  engine          TEXT,
  monthly_budget_usd REAL,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE loop_run_states (
  workflow_id   TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
  iteration     INTEGER NOT NULL DEFAULT 0,
  burst_start   INTEGER,
  failures      INTEGER NOT NULL DEFAULT 0,
  last_check    TEXT NOT NULL DEFAULT '{}',   -- JSON: {steps:[{step,ok,output,duration_ms}], overall_ok, ran_at}
  summaries     TEXT NOT NULL DEFAULT '[]',   -- JSON array of last N summary strings
  spec_snapshot TEXT NOT NULL DEFAULT '{}',   -- copy of loop spec fields at session-start
  worktree_path TEXT,
  updated_at    TEXT NOT NULL
);
```

Add to `workflows`:

```sql
ALTER TABLE workflows ADD COLUMN loop_spec_id TEXT REFERENCES loop_specs(id);
```

`verification` step schema (one element of the JSON array):

```json
{"step": "lint", "cmd": "npm run lint", "fast": true, "required": false}
{"step": "test", "cmd": "npm test",     "fast": false, "required": true}
{"step": "llm_judge", "kind": "llm", "rubric": "...", "model": "haiku", "required": false}
```

Migration: existing `workflows.verify_command` rows are migrated to a single-step pipeline `[{"step":"verify","cmd":"<old value>","fast":false,"required":true}]` and `loop_run_states` rows are back-filled with `failures=0`, `summaries=[]`.

New server module `server/loop-triggers.ts`:
- Reads `loop_specs` with `trigger_kind='cron'` on startup, registers with `node-cron`.
- `POST /api/loop-specs/:id/trigger` — signed webhook; validates secret from `trigger_config.secret`, substitutes payload into goal template, calls `createWorkflow()`.
- Dedup guard: a cron/webhook trigger does not start if a session from the same spec is already `running`.

New API endpoints:
- `GET /api/projects/:pid/loop-specs` — list all specs.
- `POST /api/projects/:pid/loop-specs` — create.
- `PATCH /api/projects/:pid/loop-specs/:sid` — update.
- `DELETE /api/projects/:pid/loop-specs/:sid` — delete (does not affect running sessions).
- `POST /api/projects/:pid/loop-specs/:sid/run` — manual trigger.
- `GET /api/projects/:pid/loop-specs/:sid/metrics?window=30d` — aggregate stats.
- `GET /api/projects/:pid/loop-metrics` — cross-spec leaderboard.

New table for aggregate metrics (computed on session close):

```sql
CREATE TABLE loop_metrics (
  id               TEXT PRIMARY KEY,
  loop_spec_id     TEXT REFERENCES loop_specs(id),
  workflow_id      TEXT NOT NULL REFERENCES workflows(id),
  terminal_state   TEXT NOT NULL,
  iterations_used  INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL NOT NULL DEFAULT 0,
  verif_steps_pass INTEGER NOT NULL DEFAULT 0,
  verif_steps_fail INTEGER NOT NULL DEFAULT 0,
  stagnation_hit   INTEGER NOT NULL DEFAULT 0,
  human_inputs     INTEGER NOT NULL DEFAULT 0,
  pr_opened        INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  duration_s       INTEGER
);
```

**UI changes.**

- *Sessions* tab: "Loop specs" sub-tab showing the spec library with triggers, last-run stats, and a [Run now] button.
- *New session* dialog: preset picker at the top showing project loop specs (replaces the blank/feature/bug-fix tabs from `NewSessionDialog.jsx`). Selecting a spec pre-fills verification steps, stop rules, and push mode.
- *Session workspace*: verification steps shown in the iteration strip — each step as a coloured chip (lint ✅ / test ❌).
- *Loop spec editor*: create/edit page with trigger builder (cron expression with human-readable preview, webhook URL + secret), goal template with `{{ticket.summary}}` / `{{pr.title}}` hints, pipeline builder (ordered list of steps, add/remove/reorder), and stop-rules form.
- *Metrics dashboard*: per-spec success rate, average cost per done session, autonomy rate, p50/p95 duration.

**Acceptance criteria.**

- A loop spec with `trigger_kind='cron'` fires at the scheduled time without any user interaction.
- After a server restart, `loop_run_states.failures` and `loop_run_states.summaries` are read back by `resumeAfterRestart()` — the stagnation window does not reset.
- Verification pipeline steps run in order; a step with `required=true` and exit code ≠ 0 stops the pipeline and the result is written to `loop_run_states.last_check`.
- LLM-judge step uses the Haiku model and costs less than $0.01 per call for a 200-token rubric.
- A webhook trigger with a wrong secret returns 401 and does not start a session.
- `GET /api/projects/:pid/loop-specs/:sid/metrics` returns success rate, avg cost, avg iterations for the requested window.

**Effort.** L (8–10 days total): `loop_run_states` + `drive()` changes (S, 1 day); verification pipeline (S, 1 day); `loop_specs` table + API + "Save as spec" button (M, 2 days); cron triggers (M, 1 day); spec editor UI (M, 2 days); metrics table + dashboard (M, 2 days); webhook triggers (deferred to Phase 2).

**Dependencies.** None — no new runtime dependency required for Phase 1 triggers. `node-cron` (pinned version `3.0.0`) is the only new npm package.

---

### B — Setup and information architecture

**Problem.** Setting up a project from scratch takes 10 hops. The word "connection" has three unrelated meanings (`ProjectSettings.jsx` Connection component = model provider; `Connections.jsx` = git credential store; `ConnectionBadge` in the session dialog = model provider badge). Settings live at portal, project, and session level with no visible precedence. `PORTAL_ITEMS` in `App.jsx` groups git credentials under a "Portal" label with a lock icon that gives no hint that git connections live there.

**Proposal.** Replace the ≥5 project setup pages with a single **Setup hub** at `Project › Setup`. Add a readiness panel at the top. Rename "Connections" to "Git connections" everywhere. Show the three-level precedence table on every multi-level setting. Fix the dead-end link in `Repos.jsx` `ConnectionRepoPicker` that sends users to `#/connections` instead of opening an inline sheet.

**Data model / API changes.**

No new tables. New API endpoint:

```
GET /api/projects/:pid/readiness
→ {
    provider: {ok: bool, value: string, source: 'portal'|'project'},
    awsAccount: {ok: bool, value: string, testedAt: string|null},
    gitConnection: {ok: bool, value: string},
    repository: {ok: bool, value: string, status: 'ready'|'cloning'|'error'},
    leadAgent: {ok: bool, value: string|null},
    budget: {ok: bool, value: number, source: 'portal'|'project'}
  }
```

This endpoint is cheap (all data already in DB) and drives the readiness panel live via the existing SSE project event stream.

**UI changes.**

- `App.jsx` `PROJECT_NAV`: replace the individual *Project and team*, *Repositories*, *Agents and skills*, *Workspaces*, *Configuration* items with a single **Setup** item. Internal navigation within Setup uses a sub-nav (tabs or left rail).
- New `web/src/pages/ProjectSetup.jsx`: renders the readiness panel at the top, then the sub-nav for each setup section. The readiness panel polls `/api/projects/:pid/readiness` and refreshes on the SSE stream.
- `Connections.jsx`, all nav labels, and all link text: rename "Connection" → "Git connection" wherever it means the git credential store.
- `NewSessionDialog.jsx`: the repo `[+ Add]` button opens an **inline sheet** (a `<dialog>` anchored below the repo picker) that allows creating a git connection and adding a repo without navigating away. This sheet supports one level of nesting ("Add AWS account" within the sheet).
- Settings precedence: add a `<PrecedenceTable>` component (a `<table>` with three columns: Portal default → Project override → Session override) rendered at the top of every multi-level setting field in `ProjectSettings.jsx`, `NewSessionDialog.jsx`, and `SessionWorkspace.jsx › Settings tab`.
- `ProjectSettings.jsx` `Connection()` component: rename the prop and section heading to "Model provider & AWS account" to distinguish it from the git credential concept.

**Acceptance criteria.**

- A new user can go from zero to a running session on CodeCommit in ≤ 2 page visits (Setup hub + Sessions page).
- The readiness panel shows ✅/⚠️/❌ for all six items and [Fix] links that open inline panels.
- No navigation occurs when adding a repo from the session launcher; the newly added repo appears in the picker immediately.
- Searching the portal for "connection" returns distinct results for "Git connections" and "model provider", not the same word meaning both.
- The three-level precedence table appears on the provider, push mode, lead agent, and budget fields.

**Effort.** M (4–5 days): readiness API (S, 0.5 day); Setup hub page (M, 1.5 days); inline repo/connection sheet (M, 1 day); rename "Connection" throughout (S, 0.5 day); precedence table component (S, 0.5 day).

**Dependencies.** Should land before or alongside Workstream C (Inbox), as both touch `App.jsx` nav.

---

### C — Session experience

**Problem.** The *History* tab label obscures the fact that it contains pending approvals (`e.kind === 'human' && !e.consumed` badge in `SessionWorkspace.jsx`). Push approval cards only appear in the *Live* tab — a user watching *Changes* never sees the push prompt. There is no cross-session notification surface; users must navigate to each session individually. After a push, there is no "send to review" action; the user must go to `Review.jsx` and re-select the branch. The five workspace tabs have equal visual weight.

**Proposal.** Rename *History* tab to *Activity* and surface a "Needs you" count badge directly on the tab. Add a portal-wide **Inbox** nav item. Show push and approval actions in the Inbox (and on a banner at the top of any workspace tab, not just Live). Add a "Review in Code review" button to the Changes tab push card. Promote the most-used session actions to keyboard shortcuts.

**Data model / API changes.**

New API endpoint:

```
GET /api/inbox?projects=all&filter=needs_you
→ [{
    kind: 'waiting'|'push_ready'|'running'|'done',
    workflowId, projectId, projectName, sessionTitle,
    detail: string,       -- agent question | "N files +X -Y" | "iter M of N · $Z spent"
    prUrl: string|null,
    createdAt: string
  }]
```

Backed by a join of `workflows` + `inputs` (pending) + `workflow_events` (push ready). Counts returned as an `X-Inbox-Needs-You: N` response header so the nav badge can be updated without polling the full list.

**UI changes.**

- `App.jsx`: add **Inbox** as a top-level nav item with a badge count. The badge is updated via SSE `project.event` messages that already flow to all connected clients (`events.ts`).
- `web/src/pages/Inbox.jsx`: new page. Cards grouped as *Needs you* (waiting + push ready) then *Running* then *Done*. Each card shows one-liner detail and inline actions ([Answer], [Push], [Reject], [Open PR], [Open session]). Actions call existing API endpoints; no page navigation required.
- `SessionWorkspace.jsx`: rename *History* tab to **Activity**. Add a red badge on the tab when `unconsumedHumanEvents > 0`. Add a yellow sticky banner at the top of every tab (not just Live) when a push is pending or the session is blocked — the banner has [Review changes] and [Push] buttons.
- `SessionWorkspace.jsx` Changes tab: add a *Send to Code review* button on the push card that navigates to `Review.jsx` with `?branch=<work_branch>&base=<base_branch>` pre-filled.
- `Review.jsx`: read `branch` and `base` from URL query params and pre-select them in the branch pickers.
- Keyboard shortcuts: `Alt+N` opens *New session* (already planned in the cloudcode-reference plan), `Alt+I` opens Inbox, `Alt+A` focuses the composer, `R` in the session workspace refreshes the canvas.

**Acceptance criteria.**

- A user on the Changes tab sees a push-pending banner and can approve the push without leaving the tab.
- The Inbox "Needs you" count matches the sum of pending `inputs` and pending push approvals across all projects.
- Navigating from a push card to Code review lands with both branches pre-selected.
- The Activity tab badge is updated within 2 s of a new human input arriving (via SSE, no polling).
- Inbox actions (Push, Answer) work without a page navigation.

**Effort.** M (3–4 days): Inbox page + API (M, 1.5 days); push banner on all workspace tabs (S, 0.5 day); Activity tab rename + badge (S, 0.5 day); Review.jsx URL param pre-fill (S, 0.5 day); keyboard shortcuts (S, 0.5 day).

**Dependencies.** Workstream B (nav changes). Deferred: email/webhook notifications (Phase 2).

---

### D — Session control plane

**Problem.** `drive()` in `workflows.ts` is a pure in-memory async loop. Its locals (`failures`, `summaries`, `lastCheck`, `burst_start`) are lost on every restart. Sessions auto-resume correctly but with a reset stagnation window and failure counter. There is no top-level concurrency cap per user — one user can start unlimited top-level sessions (`delegationRoom()` only covers subagents). There is no graceful drain; a SIGTERM mid-iteration kills the run abruptly. Approval inputs have no timeout; a waiting run can stall forever. `work/<runId>/` folders accumulate indefinitely. Kiro CLI child processes may survive after `stopRun()` because `child.kill()` is not called explicitly (`runner.ts`).

**Proposal.** Persist iteration state to `loop_run_states` (see Workstream A — same table). Add graceful drain on SIGTERM. Add per-user and per-project top-level concurrency caps. Add approval SLA with escalation. Add a TTL cleanup job for worktrees. Fix Kiro child process orphaning.

**Data model / API changes.**

To `workflows` table (migrations):

```sql
ALTER TABLE workflows ADD COLUMN locked_by    TEXT;   -- server instance id
ALTER TABLE workflows ADD COLUMN locked_until TEXT;   -- heartbeat_at + 2 × interval
ALTER TABLE workflows ADD COLUMN heartbeat_at TEXT;
```

The `drive()` loop calls `db.run("UPDATE workflows SET heartbeat_at=?, locked_until=? WHERE id=?", ...)` every 15 s. A watchdog (`setInterval`, 30 s) reclaims any `running` workflow whose `locked_until < now`.

To `inputs` table:

```sql
ALTER TABLE inputs ADD COLUMN expires_at   TEXT;
ALTER TABLE inputs ADD COLUMN escalated_at TEXT;
```

Settings additions (stored in `settings.ts` JSON blob):

```json
{
  "agents": {
    "maxTopLevelPerUser": 5,
    "approvalSlaMinutes": 60,
    "worktreeTtlDays": 30
  }
}
```

New API: `PATCH /api/workflows/:id/owner` — transfer session ownership to another project member. Logged to `workflow_events`.

**UI changes.**

- Settings › Agent defaults: expose `Max sessions per user` (default 5), `Approval SLA` (default 60 min), `Worktree retention` (default 30 days).
- Session launcher: if the user is at their concurrency cap, the [Start session] button is disabled with an inline message "You have N sessions running. Stop one to start another."
- Inbox: overdue approval cards (past SLA) shown with a red border and "Overdue" badge.
- Session workspace header: add a *Transfer ownership* action in the kebab menu.

**Acceptance criteria.**

- After a server restart, `loop_run_states.failures` and `.summaries` are used by `resumeAfterRestart()` — verified by a unit test that manually sets `failures=1` before restart simulation.
- A SIGTERM allows up to 60 s for running iterations to finish before calling `recoverWorkflows()`.
- A user at the `maxTopLevelPerUser` cap receives a 429 response from `POST /api/projects/:pid/workflows`.
- An input past `approvalSlaMinutes` emits a `input.overdue` project event visible in the Inbox.
- Worktree folders older than `worktreeTtlDays` for completed/failed/stopped sessions are deleted by the daily cleanup job.
- `stopRun()` sends SIGTERM to the Kiro CLI child process (verified by checking `child.kill('SIGTERM')` is called in `runner.ts`).

**Effort.** M (3–4 days): `loop_run_states` + heartbeat + watchdog (M, 1 day, shared with Workstream A); graceful drain (S, 0.5 day); concurrency cap (S, 0.5 day); approval SLA (M, 1 day); worktree cleanup (S, 0.5 day); Kiro child kill (S, 0.5 day).

**Dependencies.** Workstream A `loop_run_states` table is shared.

---

### E — User management and governance

**Problem.** There is no audit log — admin actions, member changes, and settings edits leave no queryable trace. The setup endpoint (`/api/auth/setup`) has no rate-limit or invite token, enabling a first-admin race condition. A single user can consume the entire monthly budget (only one global cap in `settings.ts:assertBudget()`). API tokens have no per-project scope — a write token allows writes to all of the holder's projects. There is no OIDC login path; teams on Entra ID, Okta, or Google Workspace must maintain a parallel credential store. There is no invitation flow; admins share passwords out-of-band.

**Proposal: resolve the governance–team-hierarchy conflict.** The governance audit recommends a full Organisation → Team → Project hierarchy (A2). The UX audit does not mention it. For a self-hosted, single-team portal, a full org/group model adds schema complexity with little near-term benefit. **Decision: defer the org hierarchy to Phase 3.** Instead, implement Teams as a lightweight grouping (one `teams` table, one `team_members` table) that allows setting a budget and adding members in bulk, without multi-level role inheritance. This mirrors GitHub's Team model, not GitLab's subgroup model. If the portal grows beyond ~20 projects, the hierarchy can be added on top.

**Data model / API changes.**

```sql
-- Audit log (OWASP ASVS 7.2)
CREATE TABLE audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  actor_id TEXT,
  action   TEXT NOT NULL,   -- 'user.create', 'settings.update', 'session.stop', …
  target   TEXT,            -- 'user:u_123', 'project:p_456'
  detail   TEXT NOT NULL DEFAULT '{}',
  ip       TEXT
);
CREATE INDEX audit_log_ts    ON audit_log(ts);
CREATE INDEX audit_log_actor ON audit_log(actor_id, ts);

-- Invitation flow
CREATE TABLE invitations (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  project_id TEXT REFERENCES projects(id),
  access     TEXT,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  used_at    TEXT
);

-- Lightweight teams
CREATE TABLE teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  monthly_budget_usd REAL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL DEFAULT 'member',   -- 'member' | 'lead'
  PRIMARY KEY (team_id, user_id)
);
ALTER TABLE projects ADD COLUMN team_id TEXT REFERENCES teams(id);
```

Per-level budget ceilings:

```sql
ALTER TABLE users    ADD COLUMN monthly_budget_usd REAL;
ALTER TABLE projects ADD COLUMN monthly_budget_usd REAL;
```

`assertBudget()` in `settings.ts` gains two additional checks: `userMonthSpend(userId)` vs `users.monthly_budget_usd`, and `monthSpend(projectId)` vs `projects.monthly_budget_usd`. The first check that fails blocks the run with a clear message identifying which ceiling was hit.

API token per-project scope:

```sql
ALTER TABLE api_tokens ADD COLUMN project_id TEXT REFERENCES projects(id);
```

Token policy in `api-tokens.ts`: if `project_id IS NOT NULL`, enforce that the request `:pid` matches.

Setup endpoint hardening: on first startup, write a one-time nonce to `data/master.key` (already used for encryption). The `/api/auth/setup` endpoint validates this nonce from the request body, consuming it so the endpoint is only callable once. Rate-limit: 3 attempts per IP per hour.

OIDC SSO:
- `POST /api/auth/oidc/start` → redirect to IdP.
- `GET /api/auth/oidc/callback` → exchange code, upsert user row (`oidc_subject TEXT` column on `users`), call `startSession()`.
- Library: `openid-client` npm package (well-maintained, supports PKCE). Store only `oidc_subject` and OIDC configuration URL in the DB; no tokens stored beyond the session cookie.
- Local password login remains as fallback.
- Do not implement SAML in Phase 1; OIDC covers Entra ID, Okta, and Google Workspace.

**UI changes.**

- Settings › Users: add *Invite user* button that sends an invite link (copy to clipboard, no SMTP required initially). Invite rows show email, expiry, and who sent it.
- Settings › Users: add *Teams* tab. Create/edit teams, set a team budget, add members.
- Settings › Users: show per-user spend with a progress bar against their ceiling.
- Settings › Security: new section with OIDC configuration (discovery URL, client ID, client secret in vault, "Test" button).
- Settings › Audit log: read-only table of the last 500 log entries, filterable by actor and action. Export as CSV.
- API tokens page: add a *Project scope* picker to the token creation form (optional; blank = all projects).
- Admin Users list: "Deactivate" now also stops running sessions owned by that user (calls `stopWorkflow()` for each).

**Acceptance criteria.**

- Every mutating HTTP handler writes to `audit_log` via a shared `audit(ctx, action, target, detail)` helper — verified by integration tests that assert an audit row exists after each sensitive action.
- `/api/auth/setup` returns 403 after the first successful call.
- An invite link expires after 7 days and can only be used once (`used_at IS NOT NULL` check).
- `assertBudget()` stops a session if the user's personal monthly spend would exceed `users.monthly_budget_usd`, with an error message naming the ceiling.
- An API token with `project_id=p_abc` receives 403 when calling an endpoint for project `p_xyz`.
- OIDC login succeeds with a Google Workspace account; the user is created on first login and blocked if later deactivated.
- Deactivating a user cancels all their running sessions within 5 s.

**Effort.** M–L: audit log (S, 0.5 day); setup hardening (S, 0.5 day); invitation flow (M, 1 day); per-user/project budgets (S, 0.5 day); teams table + UI (M, 1 day); token scoping (S, 0.5 day); OIDC (M–L, 3–5 days).

**Dependencies.** Audit log should be first (unblocks forensics immediately). OIDC depends on no other workstream.

---

### F — Observability and metrics

**Problem.** There is no cross-session view. Spend is tracked per session but not aggregated by user, project, or loop spec. There is no Prometheus-compatible metrics endpoint. `workflow_events` contains a rich event log but it is not exposed as a human-readable activity feed. Budget threshold alerts do not exist.

**Proposal.** Add a structured metrics endpoint, a per-user cost view, a project activity feed, and a spend-threshold webhook.

**Data model / API changes.**

New endpoints:
- `GET /api/metrics` — Prometheus text format. Metrics: `portal_sessions_active{project}` (from `driving.size`), `portal_runs_active` (from `active.size` in `runner.ts`), `portal_budget_used_usd{month}`, `portal_approval_pending` (count of `inputs WHERE status='pending'`). Zero schema changes required.
- `GET /api/projects/:pid/activity?limit=50` — joins `workflow_events` + `audit_log` with `users`; returns a human-readable actor-attributed feed. Used by the Inbox.
- `GET /api/usage?userId=…` — extend the existing admin-only endpoint to accept a `userId` filter and return spend broken down by project. Non-admins see their own data only.

New table (stores outbound webhook subscriptions):

```sql
CREATE TABLE outbound_webhooks (
  id         TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  secret     TEXT NOT NULL,    -- HMAC secret, encrypted in DB
  events     TEXT NOT NULL,    -- JSON array: ["budget.threshold", "session.blocked"]
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

`assertBudget()` publishes a `budget.threshold` event (at 80 % and 100 %) via the existing `notifyProject()` SSE channel and to any matching `outbound_webhooks` rows. A lightweight `deliverWebhook(url, secret, payload)` function (fetch + HMAC-SHA256 signature header) handles delivery; no queue needed for Phase 1.

**UI changes.**

- Settings › Budget: add a threshold alert section with a Slack webhook URL field and a "Test" button. The 80 %/100 % thresholds are configurable.
- Insights (project): add a "Sessions" chart showing success rate and cost per day, broken down by loop spec. Uses the `loop_metrics` table from Workstream A.
- Insights (portal): extend the existing `/api/usage` breakdown to show per-user spend with team grouping if teams are configured (Workstream E).
- Inbox: "Done" session cards link to the loop spec metrics page if the session was created from a spec.

**Acceptance criteria.**

- `GET /api/metrics` returns valid Prometheus text format and can be scraped by a standard Prometheus exporter without errors.
- A spend crossing 80 % fires a `budget.threshold` event visible in the portal SSE stream within 1 iteration of the crossing.
- An outbound webhook receives the event with a valid HMAC-SHA256 `X-Portal-Signature` header.
- Non-admin users can view their own spend breakdown but receive 403 on other users' data.
- The project Insights "Sessions" chart shows per-spec success rate after at least one loop spec run completes.

**Effort.** S–M (2–3 days): metrics endpoint (S, 0.5 day); activity feed API (S, 0.5 day); per-user usage (S, 0.5 day); outbound webhook table + delivery (S, 0.5 day); budget threshold event (S, 0.5 day); UI charts (M, 1 day).

**Dependencies.** Workstream A `loop_metrics` table. Workstream E teams for per-team spend view.

---

## 5. Roadmap

### Phase 0 — Quick wins (days 1–3)

Ship these with almost no risk; each is a single-file change or a new table with a helper.

| Item | File(s) | Effort |
|---|---|---|
| Audit log table + `audit()` helper | `server/db.ts`, every mutating route handler | 0.5 d |
| Per-user and per-project budget columns + `assertBudget()` checks | `server/settings.ts`, `server/db.ts` | 0.5 d |
| Graceful SIGTERM drain (60 s) | `server/index.ts` | 0.5 d |
| Top-level session concurrency cap | `server/workflows.ts`, `server/settings.ts` | 0.5 d |
| Worktree TTL cleanup job | `server/workflows.ts` or `server/index.ts` | 0.5 d |
| Setup endpoint hardening (nonce, rate-limit) | `server/auth.ts` | 0.5 d |
| Rename "Connection" → "Git connection" in nav | `web/src/App.jsx`, `web/src/pages/Connections.jsx` | 0.5 d |
| Kiro child process `kill('SIGTERM')` on abort | `server/agent/runner.ts` | 0.5 d |

**Why first:** every one of these eliminates a real risk (cost blowout, data loss, orphan processes, security). None requires a new UI screen. All are reversible.

---

### Phase 1 — MVP loop mode (~2 weeks, days 4–17)

The goal of this phase is the first unattended loop completing a session without any human click.

| Item | Workstream | Days |
|---|---|---|
| `loop_run_states` table + `drive()` reads/writes it | A + D | 1 |
| Verification pipeline (replace `verify_command` with `verification: json`) | A | 1 |
| `loop_specs` table + CRUD API + "Save as spec" on session | A | 1 |
| Cron trigger (`server/loop-triggers.ts`, `node-cron`) | A | 1 |
| Invitation flow (token, `/invite` page, SMTP-free) | E | 1 |
| API token per-project scope | E | 0.5 |
| Setup hub + readiness panel + `/api/projects/:pid/readiness` | B | 2 |
| Inline repo/connection sheet in session launcher | B | 1 |
| Settings precedence table component | B | 0.5 |
| Inbox page + `/api/inbox` endpoint + nav badge | C | 1.5 |
| Activity tab rename + push banner on all workspace tabs | C | 0.5 |
| Review.jsx URL param pre-fill from push card | C | 0.5 |
| Metrics endpoint (`/api/metrics`, Prometheus) | F | 0.5 |
| Budget threshold event + outbound webhook | F | 0.5 |

**What to build first for the biggest speed-up:** `loop_run_states` + verification pipeline + cron trigger. These three items together mean a loop spec can fire on a schedule, run to completion, and survive a restart without losing state. Everything else makes the experience smoother, but these three directly produce the "loops run without me" result the owner is after.

---

### Phase 2 — Full loop engineering UI (~3 weeks after Phase 1)

| Item | Workstream |
|---|---|
| Loop spec editor with trigger builder (cron + webhook) | A |
| GitHub webhook trigger (`pull_request.opened`, `workflow_run.completed`) | A |
| Jira status-change trigger (poll or webhook) | A |
| LLM-judge verification step (Haiku, rubric in spec) | A |
| Spec-first planning mode (SPEC phase before RUNNING, approval gate) | A |
| `loop_metrics` table + per-spec dashboard | A + F |
| Teams table + per-team budget + member bulk-add | E |
| OIDC SSO login (`openid-client`, Google / Entra / Okta) | E |
| Approval SLA + overdue badge in Inbox | D |
| Iteration checkpoint (`workflow_checkpoints` table) | D |

---

### Phase 3 — Scale and enterprise

| Item | Workstream |
|---|---|
| Org → Team → Project hierarchy (GitLab-style role inheritance) | E |
| SCIM 2.0 auto-provisioning | E |
| Escalation actions (create GitHub issue on blocked, Slack message) | A |
| Pending iterations job queue (lightweight SQLite queue, replaces in-memory Promise) | D |
| Isolated compute per session (container/microVM per run) | — |
| Cross-spec autonomy rate dashboard and FinOps export | F |

---

## 6. Risks and open questions

**1. Loop stagnation and reward hacking.**
The portal already detects stagnation via `stagnated(summaries)` in `guardrails.ts`. But the LLM-judge verifier is at level 3 on the verification ladder — the agent can still pass a judge that evaluates its own output. Options: (a) require a separate verifier subagent (level 4) for loop specs with `trust_tools=high`; (b) accept level 3 as good enough for the current team size and revisit when autonomy rate stalls; (c) run CI as the primary verifier (level 2) and treat the LLM judge as advisory only. Recommended: (c) for Phase 1, (a) for Phase 2.

**2. Webhook trigger rate and budget burn.**
A flapping CI pipeline could fire the webhook trigger dozens of times per hour. The proposal includes a rate-limit (3 sessions per spec per hour) and a spec-level monthly budget cap. Question: is 3 per hour the right default, or should it be configurable per trigger kind? Option: make the cap configurable (`trigger_config.maxPerHour`, default 3) and show the current hourly count in the spec editor.

**3. OIDC vs SAML priority.**
The governance audit notes SAML 2.0 is dominant in large enterprises. The proposal defers SAML to Phase 3 and implements OIDC first (covers Google Workspace, Entra ID via OIDC, Okta). If the team's IdP is SAML-only (e.g., some Ping Identity or ADFS setups), Phase 2 OIDC will not unblock them. Options: (a) ship OIDC first, add SAML later; (b) use WorkOS or Auth0 as a managed layer that handles both OIDC and SAML (higher cost, faster delivery, no maintenance burden). Recommend confirming the team's IdP before committing to (a).

**4. SQLite write contention under multiple concurrent loops.**
SQLite with WAL mode handles concurrent reads well but serialises writes. If 10+ loop specs fire simultaneously (e.g., a nightly batch), the `loop_run_states` heartbeat updates and `loop_metrics` inserts will serialise. Options: (a) accept the contention at the current scale (SQLite WAL can handle ~100 writes/s, far above any foreseeable load for a self-hosted portal); (b) migrate to PostgreSQL when contention is measured; (c) batch heartbeat updates (write once per iteration rather than every 15 s). Recommend (a) for Phase 1 with a note to measure.

**5. Durable execution boundary.**
The iteration checkpoint (`workflow_checkpoints` table) in Workstream D covers the iteration boundary but not mid-turn tool calls. A restart mid-iteration still re-runs the entire iteration (duplicate cost). Full durable execution requires Temporal-style event sourcing. Options: (a) accept the boundary limitation (a restart mid-iteration is rare and the cost is one extra iteration); (b) integrate Temporal (large dependency, operational overhead, strong durability guarantee). Recommend (a) for Phase 1–2, revisit only if restart-induced duplicate costs become measurable.

**6. Worktree cleanup and uncommitted changes.**
The TTL cleanup job deletes `work/<runId>/` folders after `worktreeTtlDays`. If a session was stopped with uncommitted changes that were never pushed, those changes are deleted. Options: (a) only clean up sessions that reached `done` or were explicitly `stopped` after a push; (b) before deleting, create a git stash commit on the worktree branch and note it in the session's final event; (c) warn the owner 24 h before deletion with a link to push or download the changes. Recommend (c) for any session with uncommitted changes detected at cleanup time.

**7. No email infrastructure.**
The invitation flow, approval SLA escalation, and spend-threshold alerts all benefit from email. The proposal deliberately avoids adding SMTP as a hard dependency (it routes everything through the portal Inbox and optional outbound webhooks). Question: is a copy-to-clipboard invite link acceptable, or does the team require email delivery? Option: add optional SMTP configuration (`settings.smtp.*`, nodemailer) that is used if configured and silently skipped if not. This keeps the hard dependency optional.

---

## 7. Sources

- Macedo, S. (2026). *Stop Hand-Holding Your Coding Agent.* arXiv:2607.00038v1. https://arxiv.org/html/2607.00038v1
- Lulla et al. (2026). *Loop Engineering: Building Blocks, Adoption, and Impact.* arXiv:2608.21884v1. https://arxiv.org/html/2608.21884v1
- Augment Code. (2026). *What is loop engineering?* https://www.augmentcode.com/guides/what-is-loop-engineering
- IBM. (2026). *What is loop engineering?* https://www.ibm.com/think/topics/loop-engineering
- Kilo AI. (2026). *What Is Loop Engineering?* https://kilo.ai/articles/what-is-loop-engineering
- Bughiu, M. (2026). *How to Schedule a Recurring Claude Code Task.* https://startdebugging.net/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/
- Warp. (2026). *What Metrics Prove AI Coding Agents Are Working?* https://www.warp.dev/articles/metrics-that-prove-ai-coding-agents-are-working
- arXiv. (2026). *Benchmarking Models as Runtime Controllers for Loop Engineering.* arXiv:2608.28281v1. https://arxiv.org/html/2608.28281v1
- GitHub: anthropics/cwc-long-running-agents. https://github.com/anthropics/cwc-long-running-agents
- o-mega.ai. (2026). *Long-Running Coding Agents: The 2026 Guide.* https://o-mega.ai/articles/long-running-coding-agents-the-2026-guide
- GitHub. (2026). *Onboarding your AI peer programmer: setting up GitHub Copilot Coding Agent.* https://github.blog/ai-and-ml/github-copilot/onboarding-your-ai-peer-programmer-setting-up-github-copilot-coding-agent-for-success/
- GitHub. (2026). *Agents panel: launch Copilot coding agent tasks anywhere on GitHub.* https://github.blog/news-insights/product-news/agents-panel-launch-copilot-coding-agent-tasks-anywhere-on-github/
- Devin. (2026). *Agents 101.* https://devin.ai/agents101
- Cursor. (2026). *Background agents.* https://cursor.com/help/ai-features/background-agents
- GitLab. (2026). *How to tailor GitLab access with custom roles.* https://about.gitlab.com/blog/how-to-tailor-gitlab-access-with-custom-roles/
- Temporal. (2026). *What is durable execution?* https://temporal.io/blog/what-is-durable-execution
- AWS. (2026). *What is AWS IAM Identity Center?* https://docs.aws.amazon.com/singlesignon/latest/userguide/what-is.html
- Factory. (2026). *Droid CLI quickstart.* https://docs.factory.ai/cli/getting-started/quickstart
- Guild AI. (2026). *Software factories by the numbers.* https://www.guild.ai/blog/engineering/software-factories-by-the-numbers
- Basilsworkshop. (2026). *The retry storm.* https://basilsworkshop.substack.com/p/the-retry-storm
