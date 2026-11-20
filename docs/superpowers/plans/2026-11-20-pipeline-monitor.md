# Pipeline Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each project shows the status of its GitHub workflow runs on a Pipelines tab, and a failed deploy run alerts the project (Inbox, and a Slack or Teams channel once configured).

**Architecture:** The existing signed per-project GitHub webhook (`server/autofix/webhook.ts`) also hands every `workflow_run` delivery to a new `server/pipelines/` module, which stores runs (repository pattern, SQLite and DynamoDB), keeps one alert state per repository + workflow + branch, opens/refreshes/resolves an Inbox item, and posts to a chat webhook. Routes and a Setup tab read the stored runs; settings live in the settings store and the chat URL in the secret store.

**Tech Stack:** TypeScript on Node >= 22.13 (`node:test` with tsx), `node:sqlite`, DynamoDB (Local in tests), React (web/src), Playwright UI smoke.

**Spec:** `docs/superpowers/specs/2026-11-20-pipeline-monitor-design.md` (read the "Builder's calls" list: they are binding decisions).

## Global Constraints

- GitHub only. Data comes only from the existing webhook route `POST /api/hooks/autofix/:projectId` (same secret); no polling, no refresh button.
- Deploy workflow rule: default = workflow name contains "deploy" (case-insensitive); a project may replace it with an explicit list of names. Alerts by default only on the repository's default branch; a project may add branch names.
- Alert on conclusion `failure` or `timed_out` of a deploy run on an alerting branch. "Later" = higher GitHub `run_number` for the same workflow. One open alert per repository + workflow + branch; further failures refresh it (latest run, failure count). The first success with a higher run number (or a successful re-run attempt of the alerted run) resolves it and sends "recovered".
- Inbox alert: type `blocked`, `payload.kind = 'pipeline'`, labelled "Deploy failed".
- Chat: only `https://hooks.slack.com/...`, `https://*.webhook.office.com/...`, `https://*.logic.azure.com/...` (exact host suffix match, https only, no credentials in the URL, no redirects followed). Slack body `{"text": ...}`; Teams body a minimal Adaptive Card message. Text: `Deploy failed: <workflow> on <owner/repo>@<branch> (<sha7>) by <actor>. <run url>` and `Deploy recovered: ...`. No log text. 3 tries with backoff; a final failure is recorded and shown next to the setting.
- Chat URL stored with `setSecret('pipelines.chat.<projectId>')`; only host and last 4 characters are ever returned. Settings JSON under the settings key `pipelines.settings.<projectId>`. Only project owners and portal admins change settings or the URL (audit entries `pipelines.settings.update`, `pipelines.chat.update`); every project member can read the tab.
- Storage: last 50 runs per repository + workflow, never deleting the latest run of any branch. Schema created by an idempotent step on every database open (like `ensureAutofixSchema` in `server/db.ts`), never a positional migration.
- The webhook answers 202 and stores/alerts in the background (errors logged, never thrown). Every existing Auto-fix test stays green and unchanged.
- UI: phone width 360-412 px, no horizontal page scroll, no coloured left stripes (tinted status pills like the Auto-fix tab), theme tokens only.
- Tests: `node --disable-warning=ExperimentalWarning --import tsx --test <file>`; `npm run typecheck` 0 errors. Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01VKUCrkTguukHMdu9Rm7sub`.

## Review Focus

- The same `completed` failure delivered twice, or two deliveries racing: one Inbox item, one chat message.
- An older run completing after a newer success: it must not reopen or resolve anything.
- A chat URL on another host, http, with userinfo, or a redirecting endpoint: refused or not followed; nothing posted elsewhere.
- A `workflow_run` for a repository that is not in the project, or with a bad signature: nothing stored (the existing 401/404 behaviour).
- A project with many branches and workflows on a phone: rows stack, no horizontal scroll, non-alerting branches behind "Show all branches".

---

### Task 1: Pipeline runs repository

**Files:**
- Create: `server/repositories/pipeline-runs.ts`, `pipeline-runs-sqlite.ts`, `pipeline-runs-dynamodb.ts`
- Modify: `server/db.ts` (add the tables to the idempotent schema step that runs on every open; follow `ensureAutofixSchema`)
- Test: `test/pipeline-runs-repo.test.ts` (contract suite over both backends; DynamoDB only when `DYNAMODB_ENDPOINT` is set)

**Interfaces:**
- Produces:
  - `type PipelineStatus = 'queued' | 'in_progress' | 'success' | 'failure' | 'timed_out' | 'cancelled' | 'skipped' | 'other'`
  - `interface PipelineRun { project_id: string; repo_id: string; repo_full_name: string; run_id: number; run_attempt: number; run_number: number; workflow_id: number; workflow_name: string; branch: string; head_sha: string; actor: string; event: string; status: PipelineStatus; html_url: string; started_at: string | null; completed_at: string | null; inbox_alerted_attempt: number; chat_alerted_attempt: number; updated_at: string }`
  - `interface PipelineAlert { project_id: string; repo_id: string; workflow_id: number; branch: string; open: boolean; inbox_id: string | null; last_run_id: number; last_run_number: number; failures: number; updated_at: string }`
  - `interface PipelineRunsRepository { upsertRun(r: Omit<PipelineRun, 'inbox_alerted_attempt' | 'chat_alerted_attempt' | 'updated_at'>): Promise<{ run: PipelineRun; created: boolean }>; latestPerBranch(projectId: string): Promise<PipelineRun[]>; history(projectId: string, repoId: string, workflowId: number, branch: string, limit: number): Promise<PipelineRun[]>; prune(projectId: string, repoId: string, workflowId: number, keep: number): Promise<number>; markAlerted(projectId: string, runId: number, attempt: number, channel: 'inbox' | 'chat'): Promise<boolean>; getAlert(projectId: string, repoId: string, workflowId: number, branch: string): Promise<PipelineAlert | null>; putAlert(a: PipelineAlert, expectedUpdatedAt: string | null): Promise<boolean> }` plus `initPipelineRunsRepository`, `getPipelineRunsRepository`, `setPipelineRunsRepository`, `clearPipelineRunsRepository`.
  - `upsertRun` keeps the row whose `(run_attempt, status rank)` is newest: a `completed` status is never overwritten by a late `in_progress` of the same attempt; a higher attempt replaces a lower one. `markAlerted` is conditional (sets the channel's attempt only if it is lower than `attempt`; returns whether it changed). `putAlert` is conditional on `updated_at` (`null` = must not exist).

- [ ] **Step 1: Write the contract tests:** `upsert creates and a second upsert of the same run updates it`; `a late in_progress does not overwrite a completed status of the same attempt`; `a higher run_attempt replaces the row`; `latestPerBranch returns one row per repo+workflow+branch, the highest run_number`; `history is newest first and limited`; `prune keeps 50 per repo+workflow but never the latest run of a branch` (insert 60 runs on main and 1 older run on feature/x: after prune 50 main rows + the feature/x row remain); `markAlerted returns true once per run+attempt+channel, false on repeat, and true again for a higher attempt`; `two concurrent markAlerted calls: exactly one true`; `putAlert with a stale updated_at returns false`.
- [ ] **Step 2: Run them.** Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the interface, SQLite (tables `pipeline_runs` with primary key `(project_id, run_id)` and indexes on `(project_id, repo_id, workflow_id, branch, run_number)`, `pipeline_alerts` with primary key `(project_id, repo_id, workflow_id, branch)`), the idempotent schema step, and DynamoDB (follow `autofix-findings-dynamodb.ts` key style; conditional writes for `markAlerted` and `putAlert`).
- [ ] **Step 4: Run the tests and `npm run typecheck`.** Expected: PASS, 0 errors (DynamoDB suite skipped without `DYNAMODB_ENDPOINT`).
- [ ] **Step 5: Commit** `feat(pipelines): runs repository`.

### Task 2: Event parsing and pipeline settings

**Files:**
- Create: `server/pipelines/events.ts`, `server/pipelines/settings.ts`
- Test: `test/pipelines-events.test.ts`, `test/pipelines-settings.test.ts`

**Interfaces:**
- Produces:
  - `interface WorkflowRunEvent { repoFullName: string; runId: number; runAttempt: number; runNumber: number; workflowId: number; workflowName: string; branch: string; headSha: string; actor: string; event: string; status: PipelineStatus; htmlUrl: string; startedAt: string | null; completedAt: string | null }`
  - `parseWorkflowRun(eventName: string, payload: unknown): WorkflowRunEvent | null` (null for anything that is not a well-formed `workflow_run`; `action` requested => `queued`, in_progress => `in_progress`, completed => the conclusion mapped to `PipelineStatus`; `html_url` kept only when it is `https://github.com/...`)
  - `interface PipelineSettings { deploy_workflows: string[]; alert_branches: string[] }`; `DEFAULT_PIPELINE_SETTINGS = { deploy_workflows: [], alert_branches: [] }`
  - `getPipelineSettings(projectId: string): Promise<PipelineSettings>`, `savePipelineSettings(projectId: string, patch: Partial<PipelineSettings>, actor: { actorId: string | null; ip: string | null }): Promise<PipelineSettings>` (validates: arrays of trimmed non-empty strings, each at most 100 chars, at most 50 entries; audit `pipelines.settings.update`)
  - `isDeployWorkflow(s: PipelineSettings, workflowName: string): boolean` (empty list => name contains "deploy", case-insensitive; else exact case-insensitive match)
  - `isAlertingBranch(s: PipelineSettings, branch: string, defaultBranch: string | null): boolean`

- [ ] **Step 1: Write the tests:** recorded payload fixtures under `test/fixtures/github/` (reuse the existing `workflow_run` ones and add `workflow_run_requested.json`, `workflow_run_in_progress.json`, `workflow_run_timed_out.json`); each action maps to the right status; a non-github `html_url` becomes `''`; missing ids => null; `isDeployWorkflow` default rule ("Deploy portal" yes, "CI" no) and explicit list; `isAlertingBranch` default branch only, plus extras; settings validation rejects 51 entries, a 101-char name and non-strings; save writes an audit entry.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** both modules (settings via `getSetting`/`setSetting` from `server/settings.ts`, as `server/autofix/policy.ts` does).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pipelines): workflow_run parsing and settings`.

### Task 3: Chat notifier

**Files:**
- Create: `server/pipelines/chat.ts`
- Test: `test/pipelines-chat.test.ts`

**Interfaces:**
- Produces:
  - `chatUrlProblem(url: string): string | null` (null when allowed; see Global Constraints for hosts)
  - `getChatTarget(projectId: string): Promise<{ url: string; kind: 'slack' | 'teams' } | null>`; `setChatUrl(projectId: string, url: string | null, actor: { actorId: string | null; ip: string | null }): Promise<void>` (validates, stores in the secret store, audit `pipelines.chat.update`); `chatUrlHint(projectId: string): Promise<{ host: string; last4: string } | null>`
  - `chatStatus(projectId: string): Promise<{ lastFailureAt: string | null; lastError: string | null }>`
  - `buildChatMessage(kind: 'failed' | 'recovered', run: PipelineRun): string`
  - `sendChat(projectId: string, text: string): Promise<boolean>` (3 tries, 1 s / 4 s backoff, `redirect: 'manual'` and a redirect counts as failure, 10 s timeout per try; records the last failure; never throws; the error text recorded never contains the URL)
  - Test seam `_setChatFetch(fn | null)`.

- [ ] **Step 1: Write the tests:** allowed Slack and Teams URLs; refused: `http://hooks.slack.com/...`, `https://hooks.slack.com.evil.com/x`, `https://user:pw@hooks.slack.com/x`, `https://example.com/x`, an empty string; Slack body is `{"text": ...}` and Teams body is an Adaptive Card with the same text; a 500 then 200 sends once successfully on the second try; three failures record `lastFailureAt` and return false; a 302 is a failure and is not followed; the hint shows host and last 4 only; the message text has no log content and matches the copy in Global Constraints.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pipelines): Slack and Teams notifier`.

### Task 4: Recording runs and alerting

**Files:**
- Create: `server/pipelines/record.ts`
- Test: `test/pipelines-record.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3; `createInboxItem` (server/inbox.ts) and the inbox repository's `resolveConditional`; `emit` (server/events.ts).
- Produces: `recordPipelineRun(projectId: string, repo: { id: string; default_branch: string | null }, ev: WorkflowRunEvent): Promise<void>`: upsert; prune to 50; `emit(projectId, { type: 'pipeline.run', repoId, runId })`; for a deploy workflow on an alerting branch: on `failure`/`timed_out` and `markAlerted(...'inbox')` true: open or refresh the alert (conditional `putAlert`, retry once on a lost race) and create the Inbox item only when no alert is open (payload `{ kind: 'pipeline', workflow, repo, branch, sha, actor, url, failures }`), then `markAlerted(...'chat')` + `sendChat('failed')` when a chat target exists; on `success` with a run number higher than the alert's `last_run_number` (or the same run id with a higher attempt): close the alert, `resolveConditional` its Inbox item (a no-op if already resolved), and `sendChat('recovered')` once.

- [ ] **Step 1: Write the tests:** failure on main of "Deploy portal" => one Inbox item + one chat send; the same delivery twice => still one each; two different failing runs => one open alert with `failures: 2`, one Inbox item; success with higher run number => alert closed, Inbox item resolved, one "recovered" chat; an older run (lower run number) succeeding after a newer failure => nothing resolved; a successful re-run attempt of the failing run => resolved; failure of "CI" (not deploy) or on a feature branch => stored, not alerted; no chat target => Inbox only; a chat failure does not prevent or duplicate the Inbox item; an Inbox item resolved by hand then recovery => no error.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `recordPipelineRun`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pipelines): store runs and alert on failed deploys`.

### Task 5: Webhook wiring and routes

**Files:**
- Modify: `server/autofix/webhook.ts` (after the signature check and before the Auto-fix parsing, hand a `workflow_run` to the monitor in the background), `server/index.ts` (register the routes)
- Create: `server/pipelines/routes.ts`
- Test: `test/pipelines-routes.test.ts`; the existing `test/autofix-webhook.test.ts` must pass unchanged

**Interfaces:**
- Consumes: Tasks 1-4; `findProjectGithubRepo` (server/autofix/intake.ts); the permission helpers pattern of `server/autofix/routes.ts` (`requireProjectMember`, `requireProjectOwnerOrAdmin`: move them to a shared module only if needed, without changing behaviour).
- Produces:
  - Webhook: for event `workflow_run`, `parseWorkflowRun`; if the repository belongs to the project (`findProjectGithubRepo`), `recordPipelineRun` in the background, whatever Auto-fix's mode; the Auto-fix handling then continues exactly as today (its 202/404 answers unchanged; a repository not in the project still answers 404 and stores nothing).
  - `GET /api/projects/:id/pipelines?all=1` (members): `{ webhookSeen: boolean, repos: Array<{ repoId, fullName, defaultBranch, runs: PipelineRun[] }> }` with only default/alerting branches unless `all=1`; `GET /api/projects/:id/pipelines/history?repoId=&workflowId=&branch=` (members, limit 20); `GET /api/projects/:id/pipelines/settings` (members: settings, chat hint, chat status); `PUT /api/projects/:id/pipelines/settings` (owner/admin); `PUT /api/projects/:id/pipelines/chat` body `{ url: string | null }` (owner/admin; 400 with `chatUrlProblem` text); `POST /api/projects/:id/pipelines/chat/test` (owner/admin; sends "Test message from Agent Portal" and returns `{ ok }`).

- [ ] **Step 1: Write the tests:** a signed `workflow_run` failure for a project repo with Auto-fix mode `off` is stored and alerts; a bad signature => 401 and nothing stored; a repo not in the project => 404 and nothing stored; the Auto-fix webhook suite passes unchanged; route permission matrix (member read 200, member write 403, non-member 404, owner/admin write 200); the chat URL is never returned (only host + last 4); `all=1` returns other branches; the test-message route uses the chat seam.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new tests, `test/autofix-webhook.test.ts`, `test/autofix-github-events.test.ts` and `npm run typecheck`.** Expected: PASS, 0 errors.
- [ ] **Step 5: Commit** `feat(pipelines): webhook wiring and routes`.

### Task 6: Pipelines tab, Inbox label, docs

**Files:**
- Create: `web/src/pages/hub/Pipelines.jsx`, `web/src/styles/pipelines.css`
- Modify: `web/src/pages/hub/ProjectHub.jsx` (tab `{ id: 'pipelines', label: 'Pipelines' }` after Auto-fix), `web/src/styles.css`, `web/src/pages/Inbox.jsx` (label "Deploy failed" for `payload.kind === 'pipeline'` with workflow, repo, branch, failures and a GitHub link when it is `https://github.com/...`), `docs/user-guide.md` (a "Pipelines" section: what it shows, the deploy rule, alerting branches, the chat channel set-up for Slack and Teams, that it uses the same webhook as Auto-fix), `test/test-map.json` (a `pipelines` module), `test/ui/smoke.ts`
- Test: UI smoke cases

**Interfaces:**
- Consumes: Task 5 routes; the project event stream (`pipeline.run` events) to reload the list.

- [ ] **Step 1: Write the smoke cases** (mock the API with `page.route`, as the Auto-fix smoke does): the tab lists a repo with a failed "Deploy portal" run shown as a "Failed" pill and a link to GitHub; "Show all branches" reveals a feature-branch row; with no runs and `webhookSeen: false` the setup hint shows; members see settings read-only; at 390 px there is no horizontal page scroll; the Inbox shows "Deploy failed" for a pipeline item.
- [ ] **Step 2: Run them** (`SMOKE_ONLY=setup,inbox`; if Playwright's Chromium revision is missing, point `PLAYWRIGHT_BROWSERS_PATH` at symlinks to the installed revision under `/opt/pw-browsers`). Expected: FAIL.
- [ ] **Step 3: Implement** the tab (rows grouped by repository: status pill, workflow, branch, sha7, actor, relative start time, duration, GitHub link; a history drawer from the history route; the settings panel: deploy workflow names and alert branches as chip inputs, the chat URL field with hint/clear/"Send test message" and the last-failure line; owner/admin only for edits), the Inbox label, styles, docs and test map.
- [ ] **Step 4: Run the smoke subset, `npm run test:map:check`, `npm run typecheck`.** Expected: PASS, 0 errors; take one 390 px screenshot of the tab and check it.
- [ ] **Step 5: Commit** `feat(pipelines): Pipelines tab, Inbox label and guide`.
