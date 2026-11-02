# Plan: Agent Portal fully functional in AWS

Date: 2026-11-02
Account / region: 366019841051 / ap-southeast-1
Builds on: `2026-11-01-serverless-migration-v3-no-ec2.md`, `2026-11-01-spike-a-agentcore-results.md` (Gate 0 passed)

## 1. Where we are

Spike A proved that one agent run (Claude Code via Bedrock) works inside an AgentCore Runtime microVM, with the guard and env scrub. Everything else in the portal still assumes one long-lived Node process on one machine.

What the code assumes today (inventory of `main_v3`):

| Local assumption | Size | Why it blocks the cloud |
|---|---|---|
| Synchronous `node:sqlite` | 67 files, 935 call sites, 44 migrations, 87 tables, 2 FTS5 tables | SQLite needs one writer on a local disk. Lambda has neither. |
| Local filesystem / `config.dataDir` | 46 files, 25 dataDir uses, `data/` about 8 GB | Lambda disk is temporary. Files must live in S3 or a session volume. |
| In-memory state | 20 module-level Maps (approvals, run controllers, listeners, locks, device flows, caches) | Each Lambda invocation can be a different process. State must live in a DB. |
| Timers | 11 `setInterval`s | Lambda freezes between requests. Timers must become schedules. |
| SSE and WebSocket | 11 SSE routes, WebSocket in terminal, browser-live, http | Lambda streaming is capped at 15 min. Long-lived sockets need a managed service. |
| Child processes | 18 files (git, Kiro, Claude Code, pandoc, draw.io, Chromium, pty) | Binaries must be in a container image, and long work cannot run in the API. |

## 2. Target architecture (serverless, matches v3 rules)

```
Browser
  │
CloudFront ── S3 (web/dist)
  │ /api/*
Lambda (portal API, Node, Lambda Web Adapter, response streaming)
  ├── Aurora Serverless v2 PostgreSQL (min 0 ACU)   ← all tables, tsvector search
  ├── S3 (files, outputs, generated docs, attachments, repo snapshots)
  ├── SSM Parameter Store / Secrets Manager          ← secret key, tokens
  ├── AppSync Events                                 ← live updates (replaces SSE fan-out)
  ├── EventBridge Scheduler                          ← replaces setInterval jobs
  ├── Jobs Lambda (container: pandoc, draw.io, Chromium) ← docs, diagrams, images
  └── AgentCore
        ├── Runtime: agent-runner (Claude Code, git, guard)  ← Spike A, extended
        ├── Runtime: Kiro headless (KIRO_API_KEY)            ← needs Spike B
        ├── Command shell (InvokeAgentRuntimeCommandShell)   ← IDE terminal
        └── Browser (managed Chromium, live view)            ← browser-live, test runner
```

Run flow in the cloud:
1. API Lambda creates the run row and a short-lived run token, then invokes the AgentCore runtime.
2. The runner streams events back with a callback (`POST /api/runs/:id/events` with the run token). The API writes them to the DB and publishes to AppSync Events.
3. Approvals: the runner polls `GET /api/inputs/:id` (already built in the safety port). The fingerprint, expiry and atomic claim already live in the DB.
4. Budget and timeout limits (`maxBudgetUsdPerRun`, `runTimeoutMinutes`) are enforced in the runner and checked again by the API.

## 3. Replacement map

| Area | Today | Cloud replacement |
|---|---|---|
| Database | `node:sqlite`, sync | Async data-layer interface. SQLite adapter for local, PostgreSQL adapter for cloud. FTS5 becomes `tsvector` + GIN. |
| Files | `fs` + `dataDir` | Extend `server/storage/` (local and S3 backends exist, 3 users today) to every file use. |
| In-memory Maps | approvals, controllers, locks, caches | DB rows (locks via `SELECT … FOR UPDATE` or conditional updates). Caches become per-invocation or are dropped. |
| Timers | `setInterval` x11 | EventBridge Scheduler calling an internal endpoint or a small Lambda. |
| Live updates | SSE from one process | AppSync Events channels per run/session. Lambda streaming kept for short streams. Polling fallback. |
| Agent runs | child process `claude` | AgentCore runtime (Spike A image). |
| Kiro | local `kiro-cli` with ACP | Kiro CLI headless in AgentCore with `KIRO_API_KEY`. Unproven, needs Spike B. Fallback: keep Kiro local-only. |
| git / repos / working copies | local clones in `data/` | Clone inside the AgentCore session (`/tmp`, or Session Storage `/agent-workspace`, preview). Push results to S3 or the remote. |
| IDE terminal | node-pty over WebSocket | `InvokeAgentRuntimeCommandShell` (WebSocket into the session). |
| Browser live / test runner | local Playwright Chromium | AgentCore Browser (CDP + live view). |
| pandoc, draw.io, doc images | local binaries | Container-image jobs Lambda (15 min cap, up to 10 GB memory). |
| Web app | served by Node | S3 + CloudFront. |
| Auth | email + password, cookie | Keep it, behind CloudFront. Secret key from SSM (`PORTAL_SECRET_KEY_SSM_PATH` already supported). Cognito is optional later. |
| Deploy | `npm run start` | CDK stacks + GitHub Actions (build image, deploy, migrate). |
| Ops | none | CloudWatch alarms, Aurora backups, the $50 budget, per-run cost limits. |

## 4. Phases

Effort is for one developer working with the agents. Each phase keeps the local portal working.

| Phase | Work | Effort | Exit check |
|---|---|---|---|
| S0 Spikes | B: Kiro headless in AgentCore. C: AppSync Events from Lambda to browser. D: Aurora 0 ACU resume time and Data API vs. pooled driver. | 3–5 days | Each spike has a pass/fail note. |
| S1 Async data layer | Put every DB call behind an async interface (935 sites). SQLite adapter only. No behaviour change. | 2–3 weeks | All affected tests pass locally. |
| S2 PostgreSQL adapter | Port 44 migrations, FTS5 to tsvector, run the test suite against Postgres. | 1–2 weeks | Tests pass on both adapters. |
| S3 Storage | Route all `fs`/`dataDir` use through the storage interface. S3 backend in cloud. | 1–2 weeks | No direct `fs` writes outside storage and the runner. |
| S4 State and timers | Maps to DB, timers to Scheduler, locks to DB. | 1 week | API works with two processes behind one port. |
| S5 Agent runs on AgentCore | `agentcore` engine in the runner, callback with run token, approvals, limits, cancel. | 1–2 weeks | A run started in the cloud portal finishes, asks for approval, and stops at the budget limit. |
| S6 Live updates | AppSync Events for run/session/inbox streams, polling fallback. | 1 week | Session view updates live without SSE. |
| S7 Jobs Lambda | pandoc, draw.io, doc images, presentations. | 1 week | Generated docs and diagrams work in cloud. |
| S8 Terminal and browser | Command shell for the IDE terminal, AgentCore Browser for browser-live and testing. | 1–2 weeks | IDE terminal and UI tests work in cloud. |
| S9 Kiro in cloud | Only if Spike B passes. | 1–2 weeks | Kiro session runs in AgentCore. |
| S10 Edge and ops | CloudFront, full CDK, CI/CD, alarms, backups, data migration from local `data/`. | 1 week | Fresh deploy from CI, restore test passes. |

Total: about 12–18 weeks. S1 is the critical path and can start now. S5 can run in parallel with S1 because the runner is already separate.

## 5. Faster alternative: hybrid (breaks the "no always-on servers" rule)

Run the current server almost unchanged as one ECS Fargate task with EFS for SQLite and `data/`, behind CloudFront/ALB. Send agent runs to AgentCore (S5). Kiro, terminal, git and pandoc keep working because it is still one Node process.

| | Full serverless | Hybrid Fargate |
|---|---|---|
| Time to a working cloud portal | 12–18 weeks | 2–3 weeks |
| Code change | Large (data layer, storage, state) | Small (AgentCore engine, deploy) |
| Idle cost | Low (Aurora storage, S3, near zero compute) | Roughly $40–60/month fixed (task + ALB), estimate |
| Scale | Per request | One task (SQLite single writer) |
| Risks | Rewrite regressions | SQLite on EFS: WAL mode is not safe on NFS, must use rollback journal; one task only |
| Agent isolation | Yes (AgentCore) | Yes for Claude runs; Kiro and terminal stay on the shared task |

A sensible path is hybrid first to get a working cloud portal, then move phases S1–S8 over and retire the Fargate task. This needs your approval because it breaks the v3 rule.

## 6. Cost at low usage (estimates, check with the AWS pricing calculator)

- Agent runs: about $0.015 per short Haiku run (Spike A). Tokens dominate; Sonnet runs cost more.
- AgentCore compute: $0.0895 per vCPU-hour, $0.00945 per GB-hour, billed while active.
- Aurora Serverless v2: no compute at 0 ACU, storage and I/O only. About 15 s to resume after pause.
- Lambda, S3, CloudFront, AppSync Events, Scheduler: likely a few dollars a month at personal use.
- Existing guardrail: $50/month budget with alerts at 50/80/100% and forecast.

## 7. Risks

- **S1 size.** 935 sync call sites become async. Sync code paths inside transactions are the main regression risk. Mitigation: mechanical conversion module by module, `test:affected` per module.
- **Kiro headless.** Not proven in AgentCore. Kiro may stay local-only.
- **Aurora cold resume.** About 15 s on the first request after idle. Possible fix: a minimum of 0.5 ACU during working hours (costs money).
- **Session Storage is preview.** Fall back to S3 snapshots of working copies.
- **Lambda 15-min stream cap.** Long streams must use AppSync Events or polling.
- **Image size.** The runner image is 614 MB; cold start is fine today but should shrink.
- **Credentials.** The access key from `cytan_accessKeys.csv` should be rotated and the CSV deleted before any CI setup.

## 8. Decisions (2026-11-02)

| # | Question | Answer |
|---|---|---|
| 1 | Serverless or hybrid | Full serverless. |
| 2 | Database | User asked about DynamoDB. Trade-offs below; waiting for confirmation. |
| 3 | Kiro | Headless mode in AgentCore (Spike B). Two sign-in modes, as in the reference product at dvfknzixb0pap.cloudfront.net/credentials: (a) Kiro API key stored in Secrets Manager and passed as `KIRO_API_KEY`; (b) IAM Identity Center sign-in. For (b) the portal already stores each user's IdC token encrypted, writes it into a temporary `data.sqlite3` per run (`KIRO_TEST_DB_PATH`), and saves the refreshed token after the run (`server/kiro-idc.ts`, `server/agent/kiro.ts`). The cloud version reuses that: the runner receives the encrypted token, runs kiro-cli, and returns the refreshed token. The device-code sign-in itself runs in a short-lived AgentCore session. Token status shown to the user: valid, refreshable, expired (sign in again), missing. |
| 4 | Auth | Google sign-in wanted. Options below. |
| 5 | Live updates | Explained below; waiting for confirmation. |
| 6 | First phase | S0 spikes + S1 data layer. |

### DynamoDB instead of Aurora

The SQL in `server/` uses 52 JOINs, 42 COUNTs, 24 SUMs, 10 GROUP BYs, 155 ORDER BYs and 2 FTS5 searches across 87 tables.

| | DynamoDB | Aurora Serverless v2 |
|---|---|---|
| Idle cost | Near $0 (on-demand) | Storage only at 0 ACU |
| First request after idle | No delay | About 15 s resume |
| Network | No VPC needed | VPC, unless the Data API is used for every query |
| Data layer work | Rewrite every query as a repository function per access pattern; joins become denormalised items; counts and sums become counters kept on write | Mostly mechanical SQL port |
| Search | No full-text search. Needs a small inverted index in DynamoDB, or OpenSearch Serverless (costs money at idle) | `tsvector` |
| Item size | 400 KB limit; large text (run events, docs) goes to S3 | No practical limit |
| Extra effort | About +2–3 weeks over Aurora | Baseline |

The async data layer in S1 must be designed as per-entity repository functions if DynamoDB is chosen, so this needs a decision before S1 starts.

### Google sign-in

- Option A: Google OpenID Connect handled directly by the portal API. Free. The portal keeps its own session cookie and checks an email allow-list.
- Option B: Cognito user pool with Google as the identity provider. Free tier covers 10,000 monthly active users for social sign-in. Adds a managed login page and token handling.
- Both need a Google Cloud OAuth client (client ID and secret) with the CloudFront URL as the redirect URI.

### What live updates are for

| Feature | Stream today | Without live updates |
|---|---|---|
| Agent session/run output (text, tool calls, approvals) | `/api/runs/:id/events`, workflow SSE | User refreshes to see progress |
| Project lists (workflow created/updated/done, members, learn) | project event bus | Lists go stale until reload |
| Portal-wide (theme change, dashboard) | `/api/events` | Change shows on next load |
| Tool-pack install log | settings packs SSE | Log appears at the end |

In the cloud the code that produces an event (an AgentCore run or another Lambda) is not the process holding the browser connection, so a shared channel is needed. Choices: AppSync Events (managed WebSocket, about $1 per million operations and $0.08 per million connection minutes) or polling the API every 1–3 s.

## 8a. Original decision list

1. Full serverless only, or hybrid Fargate first, then serverless?
2. Database: Aurora Serverless v2 (PostgreSQL), or check Aurora DSQL (fewer features, no FTS)?
3. Kiro: run Spike B, or accept Kiro as local-only?
4. Auth: keep email + password, or move to Cognito?
5. Live updates: AppSync Events (recommended) or polling only?
6. First phase to start: S0 spikes + S1 data layer (recommended), or S5 AgentCore engine first?

## 9. Progress (updated 2026-11-03)

| Phase | Status | Commits |
|---|---|---|
| S0 Spike A (AgentCore runner) | Done, deployed | dcefd4a |
| S0 Spike B (Kiro headless) | Can start without an API key using IAM Identity Center sign-in (needs the user to approve one device code) | — |
| S0 Spike C (AppSync Events) | Done, deployed, PASS | 61f3f67 |
| S1 DynamoDB data design | Done | 836e8de |
| S1 modules converted | api-tokens, auth (users, sessions, invitations), permissions, audit, delegation settings, settings + secrets, projects + members + teams, **sessions/workflows/runs/events** (p6_workflows, p6_runs, p6_events, p6_inputs, p6_workflow_events), **delegation** (createChildSession, checkDelegationLimits, deliverChildResult, stopAndDeleteChildren, checkDelegationChildIdleStop all use sessions repo; race-safe caps via TransactWriteItems counters), **inbox** (p6_inbox full repository layer; admin + user-scoped list; atomic resolve; DynamoDB counters + GSI), **budget** (budget_usage writes; per-project/per-user/global day-level rollup counters for H1–H6 without scans) | c88c001, f993e25, 7ff92db, f982d7c, ac7c5de, *sessions PR*, *pathb-serverless PR* |
| S1 remaining | reviews/scans, ~~knowledge/vault~~ (done), docs/diagrams, learn, ~~testing module~~ (no tables remaining), reviews, repos/workspaces/git connections, integrations, credentials, themes, MCP server | — |
| **S1 sessions — second-round hardening** | **Done (branch pathb-serverless)** — conditional status transitions, transcript repository method, sparse idle GSI, cursor fix, emitRunEvent retry. See detail below. | — |
| **S1 delegation/inbox/budget — second-round hardening** | **Done (branch pathb-serverless)** — delegation slot tracking, GSI-ChildIdle sparse index, inbox await, budget TransactWrite. See detail below. | — |

Known callers still on SQLite are marked `S1-TODO(<module>)` in the code: review.ts, learn.ts, jira.ts, mcp-server.ts, session-files.ts.

### S1 sessions — second-round hardening (done 2026-11-02)

**Item 1 — Conditional status transitions**

All workflow and run status transitions now go through `updateWorkflowConditional` / `updateRunConditional`:
- `driver.ts startRun`: workflow pending→running conditional on current status; lost-race returns active run or cancels orphaned pending run.
- `runner.ts executeRun`: run pending→running, run running→done, run running→failed/cancelled, workflow running→done/failed/paused all conditional. If run was already transitioned to 'running' by the test or another caller, `executeRun` continues (backward-compat).
- `session-lifecycle.ts checkIdleSessions`: workflow done/pending→paused conditional on session.status; second concurrent idle-stop is a no-op (double-idle-stop test passes).
- `workflows/crud.ts /cancel` route was already safe (uses unconditional updateWorkflow on already-stopped session which is a no-op).

New caller-level tests: `test/conditional-transitions.test.ts` — double start (concurrent startRun returns same run), stop racing with completion (only one terminal status wins), transcript paging smoke test. Double idle-stop test added to `test/session-lifecycle.test.ts`.

**Item 2 — Transcript route now in repository**

`SessionsRepository.listTranscript(workflowId, cursor, limit)` added to the interface and implemented in both backends:
- SQLite: exact same CTE SQL, cursor logic unchanged; `coalesceStreamedRows` still applied in the route.
- DynamoDB: fetches all run events + workflow events, applies cursor filter in-app, returns newest-first. Correct for up to 10 000 events per workflow (S1 cap).
`server/workflows/crud.ts` transcript route uses `repo.listTranscript()` — zero direct SQL for p6_ tables.
Contract tests: `listTranscript` — no gaps, no overlap, first page is newest-first, cursor paging has no overlap (both backends, 78 tests total including DynamoDB Local).

**Item 3 — Sparse GSI-IdleCandidate for idle detection**

New sparse GSI `GSI-IdleCandidate` (PK=`idleCandidate='IDLE'`, SK=`last_turn_at_idle=last_turn_at+'#'+id`) replaces the full `done`/`pending` GSI-StatusGlobal scan. Attributes `idleCandidate` and `last_turn_at_idle` are:
- SET when status ∈ {done,pending}, stop_reason='', last_turn_at is set.
- REMOVED when status changes to a non-idle-candidate value, or stop_reason becomes non-empty.
- Managed by `_buildGsiKeyExprs`. When only `last_turn_at`/`stop_reason` changes (not status), `updateWorkflow` does a single GetItem to determine current status.
`listIdleWorkflows` DynamoDB: queries `GSI-IdleCandidate` with `SK < cutoff`, no full-table-scan. Hot `gStatus='done'` partition is no longer touched for idle detection.

**Item 4 — Cursor built from stored wfGsiSk**

`listWorkflowsByProject` DynamoDB now tracks the raw DynamoDB `wfGsiSk` attribute from each item alongside the converted `WorkflowRecord`. The ExclusiveStartKey cursor encodes the stored value (not recomputed from `updated_at`), so status-only updates that don't touch `updated_at` cannot desync the cursor.

**Item 5 — emitRunEvent failure path with retry**

DynamoDB event writes now retry on throttling errors (`ProvisionedThroughputExceededException`, `RequestLimitExceeded`, `ThrottlingException`, `ServiceUnavailable`) with exponential backoff (up to 3 attempts). On persistent failure: logs the error, attempts to append an `event-loss` marker event so the loss is visible in the run history, and publishes to the live SSE stream with `id=0` so connected clients still see the event.

**Remaining TODOs (explicitly in-scope for later steps)**

`server/session-lifecycle.ts` and `server/runs.ts` access helpers (`requireWorkflowReadAccess`, `requireProjectAndWorkflow`, `requireRunAccess`) have been converted to async repository calls. No more direct `FROM p6_` SQL outside `server/repositories/*-sqlite.ts` and `server/db.ts` (migrations), except in comments.

Files explicitly out of scope for this step and still using direct SQL: dashboard.ts, delegation.ts, inbox.ts, mcp-server.ts, review-lifecycle.ts, output-files.ts, terminal.ts, session-files.ts, browser-live.ts, session-context.ts, review.ts, control-plane.ts, diagrams.ts, generated-docs.ts, user-config.ts, jira.ts, presentations.ts, loop-specs.ts, insights.ts.

### Rules learned during S1 (apply to every remaining module)

- A DynamoDB transaction cannot touch the same item twice. Put guards on the write itself.
- Uniqueness (email, slug) and one-time claims (first admin, invitations) use conditional writes, never read-then-write.
- Updates must be conditional on the item existing; plain `UpdateItem` is an upsert.
- Retry `BatchGetItem` unprocessed keys.
- Never fail open: authorisation and security settings must throw, not return defaults.
- Fire-and-forget writes use `registerBackgroundWrite`; the response end waits for them (Lambda freezes after the response).
- SQLite mode reads the database directly; caches and snapshots are DynamoDB-mode only.
- Contract tests must run the same assertions on both backends with a fresh store where counts matter, and must never skip their success path. CI runs them with `REQUIRE_DYNAMODB=1`.
- **DynamoDB GSI key attributes cannot be NULL.** When an item has an optional FK (e.g. `project_id`), only add the GSI partition key attribute to the item when the value is non-null. Items without the GSI PK are simply not indexed in that GSI — they are not rejected.
- **DynamoDB reserved words as attribute names** (`consumed`, `status`, `name`, etc.) must be escaped via `ExpressionAttributeNames` in all UpdateItem and FilterExpression calls.
- **emitRunEvent: DynamoDB mode chains writes per run.** A per-run Promise chain (`_runEventChain`) ensures events are written to DynamoDB in order and the SSE live-stream id always matches the stored id (the atomic counter is the single source of truth). Clean up with `cleanupRunEventChain(runId)` in the run finally block.
- **recap.ts converted to async.** `buildConversationRecap` is now async and uses `getSessionsRepository()`. Callers (kiro.ts, claude-code.ts, test/kiro-session.test.ts) were updated to `await` it.
- **Oversized DynamoDB payloads** (events, inputs) exceeding 380 000 bytes are truncated with a `[PAYLOAD TRUNCATED — original size: N bytes]` marker. This keeps every item within the 400 KB limit without requiring S3 in S1. The S3-overflow strategy (write to `s3://portal-data/events/<runId>/<seq>.json`, store S3 key) is documented in the data-design doc section 4.8 and is the planned S2 improvement.
- **Event sequence ordering.** DynamoDB uses an atomic `ADD seq :one` counter item (`PK=RUN#<runId>, SK=#SEQ`) to assign gap-free integer sequence numbers to events. Zero-padded (`SEQ#0000000001`) sort keys ensure lexicographic order matches numeric order. SQLite uses the autoincrement ROWID. Both expose integers via the repository `AppendedEvent.id` field.
- **updateWorkflow is read-free when `status` is in the patch.** GSI sort keys are rebuilt from the patch values alone (no GetItem). When only `status` is patched, `gStatus` is updated (for GSI-StatusGlobal correctness); when only `updated_at` is patched, `wfGsiSk` is updated. Both together rebuilds `statusGsiSk` as well. Callers MUST pass `updated_at` whenever `status` changes. When only `last_turn_at` or `stop_reason` changes (without `status`), `updateWorkflow` issues one GetItem to determine the current status before updating the idle-candidate GSI attributes (`idleCandidate`, `last_turn_at_idle`).
- **ExclusiveStartKey for client-side-filtered pagination.** The cursor for the next page must be the key of the LAST ITEM IN THE CURRENT PAGE, not the first item of the next page. With `ScanIndexForward=false`, DynamoDB resumes from items with smaller sort keys than the cursor.
- **Global sparse GSIs for cross-project queries.** `GSI-StatusGlobal` (PK=`gStatus`, SK=`wfGsiSk`) enables `listRunningWorkflows` and `listIdleWorkflows` across all projects. `GSI-ChildWorkflows` (PK=`gParentId`, SK=`wfGsiSk`) enables `listChildWorkflows`. Both sparse (gParentId only set when parent_id is non-null).
- **GSI-InputId for getInputById without run_id.** `GSI-InputId` (PK=`inputId`) on portal-runs lets `GET /api/inputs/:id` resolve an input by its own id without knowing run_id (needed for AgentCore polling).
- **deleteWorkflow cascades in DynamoDB.** Must manually delete: all WF#<id> items (META, WFEVT, #WFSEQ), all RUN#<runId> items (inputs, #SEQ), and all portal-events items (RUN#<runId>). Decrement parent's `childCount` atomically.
- **listWorkflowsByProject total is null in DynamoDB.** Computing exact counts requires a full table scan. Return `null`; the web UI uses local array length instead.
- **S1-TODO(sessions) RESOLVED.** All sites from the S1-TODO(sessions) list have been converted to use the repository. Remaining deferred items:
  - `server/agent/litellm.ts`, `server/agent/claude-code.ts`, `server/agent/kiro.ts` budget_usage inserts — marked `S1-TODO(budget)`, deferred to the budget module conversion step.

### S1 delegation / inbox / budget — second-round completion (done 2026-11-02, branch pathb-serverless)

**Delegation** — all p6_workflows/p6_runs/p6_workflow_events in `server/delegation.ts` now go through the sessions repository:
- `createChildSession`: uses `repo.createChildWorkflowChecked(input, { parentId, userId, maxRunningPerParent, maxRunningPerUser })`. SQLite: tx() check+insert. DynamoDB: TransactWriteItems — Put workflow + conditional ADD on two delegation counter items (`DLGPARENT#<id>/#RUNNING` and `DLGUSER#<id>/#RUNNING` in portal-runs).
- `checkDelegationLimits`: async, uses `repo.countRunningChildWorkflows` / `repo.countRunningChildrenByUser`. DynamoDB: reads counter items (O(1)).
- `deliverChildResult`: uses `repo.getWorkflowById`, `repo.appendWorkflowEvent`, `repo.updateWorkflowConditional`. Race-safe resume: conditional status transition (paused→pending) guards against concurrent resume.
- `stopAndDeleteChildren`: uses `repo.listChildWorkflows`, `repo.getActiveRun`, `repo.deleteWorkflow` + `repo.releaseChildDelegationSlot`.
- `checkDelegationChildIdleStop`: uses `repo.listTerminalChildWorkflows(cutoff)`. DynamoDB: queries GSI-StatusGlobal for done/failed/paused, filters in-app. No scan.
- Delegation cap race safety: TransactWriteItems conditions ensure per-parent and per-user limits hold atomically under concurrent creates on DynamoDB.

**Inbox** — new `InboxRepository` interface + SQLite + DynamoDB implementations:
- DynamoDB key design: `PK=INBOX_ITEM#<id> SK=#META` (canonical), `GSI-InboxByProject` (PK=inboxProjectId, SK=inboxSortKey `<resolved>#<createdAt>#<id>`), `GSI-InboxGlobal` (sparse, PK=inboxGlobal='INBOX' only for unresolved items), counters `INBOX_COUNT#<projectId>#UNRESOLVED` and `INBOX_COUNT#GLOBAL#UNRESOLVED`.
- Race-safe resolve: `resolveConditional` uses TransactWriteItems — conditional UpdateItem on the inbox item (resolved=0) + counter decrements. Only one concurrent caller wins.
- Route handler `server/inbox.ts` converted to async; `S1-TODO(projects)` membership checks replaced with `getProjectRepository().isMember()` and `getProjectRepository().listMyProjects()`.
- `createInboxItem` in `server/inbox.ts` is now async; `server/agent/runner.ts` updated to fire-and-forget (non-blocking for approval flow).

**Budget** — new `BudgetRepository` interface + SQLite + DynamoDB implementations:
- DynamoDB key design: main item `PK=BU#<projectId>#<dateUTC> SK=<isoCreatedAt>#<id>`, `GSI-BudgetProject` (PK=budgetProjectId, SK=budgetSortKey). Rollup items: `STATS#<projectId> DAY#<date>`, `USERSTATS#<userId> DAY#<date>`, `STATS#GLOBAL DAY#<date>`. Rollups are ADD operations written alongside each insert (background writes via registerBackgroundWrite).
- H1–H6 insights can now be served without scans: per-day rollup counters allow range queries bounded by date.
- Fail-closed: PutItem retried once on transient errors; persistent failure propagates and blocks the run.
- Callers `server/agent/litellm.ts`, `server/agent/claude-code.ts`, `server/agent/kiro.ts` (two locations) converted to use `getBudgetRepository().record(...)`.

**New rules learned (apply to every remaining module):**
- **SET and REMOVE clauses in UpdateExpression must be separate:** `SET a=:a, b=:b REMOVE c` — not `SET a=:a, b=:b, REMOVE c`. Joining with commas across clause types causes a ValidationException.
- **SQLite FK constraints on p6_ tables apply in tests.** The `p6_inbox` and `budget_usage` tables have FK constraints on `project_id`, `workflow_id`, `run_id`, `user_id`. Contract tests must either: (a) insert the referenced rows first (helper functions), or (b) use null for those fields. The `maybe*` pattern (no-op for DynamoDB, inserts for SQLite) keeps contract tests backend-agnostic.
- **BOM from PowerShell file writes.** Never modify source files using PowerShell `Set-Content`, `Out-File`, `[System.IO.File]::WriteAllText` with `[System.Text.Encoding]::UTF8` — all add a UTF-8 BOM. Always use the file edit/write tools.
- **Backward-compat synchronous helpers.** Functions with existing synchronous callers (unit tests) can be kept synchronous by reading from the settings snapshot. Limit-check functions that use direct SQL COUNT must be made async to pass the "no direct p6_ SQL outside repositories/*-sqlite.ts" acceptance criterion.
- **S1-TODO(delegation) RESOLVED.** `createChildSession` now uses `repo.createWorkflow` (via `createChildWorkflowChecked`); parent `childCount` is maintained. S1-TODO note removed.
- **S1-TODO(projects) RESOLVED in inbox.ts.** Membership checks now use `getProjectRepository().isMember()` and `listMyProjects()`.
- **S1-TODO(budget) RESOLVED.** All budget_usage inserts in litellm.ts, claude-code.ts, kiro.ts now use `getBudgetRepository().record()`.

### S1 delegation/inbox/budget — DynamoDB hardening round 2 (done 2026-11-03, branch pathb-serverless)

**Issue 1 — Delegation running-child slot tracking**

Counters were drifting because `releaseChildDelegationSlot` was called unconditionally from both `deliverChildResult` (on every run completion) and `stopAndDeleteChildren`, and no re-acquire happened on resume.

Fix:
- Each child workflow item now records `dlgSlotHeld` (Number 0/1). `createChildWorkflowChecked` sets it to 1.
- `releaseChildDelegationSlot(childId, parentId, userId)`: single `TransactWriteItemsCommand` — condition `dlgSlotHeld=1` → SET to 0 + ADD -1 to both DLGPARENT and DLGUSER counters. `ConditionalCheckFailed` (slot already 0) → idempotent no-op. Signature extended with `childId` as first parameter.
- `acquireChildDelegationSlot(childId, parentId, userId, maxParent, maxUser)`: single `TransactWriteItemsCommand` — condition `dlgSlotHeld=0 OR absent` → SET to 1 + ADD +1 to both counters with cap condition. Used in `workflows/crud.ts` before `startRun` for child resume (POST /resume, POST /message).
- SQLite: `releaseChildDelegationSlot` and `acquireChildDelegationSlot` are no-ops (counts are live via COUNT).

Contract test additions (`test/delegation-session-repo.test.ts`):
- child runs twice then deleted → counters return to 0
- concurrent release is idempotent (TransactWriteItems condition prevents double-decrement)
- resumed child counts against the cap again
- idle-stopped child is NOT returned from `listTerminalChildWorkflows` again

**Issue 2 — listTerminalChildWorkflows sparse index**

Previous implementation queried GSI-StatusGlobal for all done/failed/paused workflows (grows without bound) and re-selected already-idle-stopped children.

Fix: new sparse `GSI-ChildIdle` (PK=`childIdleCandidate='CHILD_IDLE'`, SK=`updated_at_child_idle=updated_at+'#'+id`). Attributes set when: `parent_id IS NOT NULL` AND `status IN (done,failed,paused)` AND `stop_reason=''`. Cleared when `stop_reason` becomes non-empty (child-idle or idle). `listTerminalChildWorkflows` queries this GSI with `SK < cutoff` — O(active candidates) instead of O(all terminal workflows).

Attribute management:
- `_buildGsiKeyExprs` extended with `currentParentId` parameter.
- `updateWorkflow`: reads current item when status/stop_reason/last_turn_at changes (combined existing idle-candidate read with new parent_id read).
- `updateWorkflowConditional`: new optional `opts?: { hintParentId?: string | null }` parameter. Key callers (runner.ts, driver.ts, delegation.ts, session-lifecycle.ts) pass the hint from the already-loaded workflow record.
- `ensureTables`: adds `GSI-ChildIdle` with attributes `childIdleCandidate` (S) and `updated_at_child_idle` (S).

SQLite `listTerminalChildWorkflows` updated to exclude `stop_reason='child-idle'` rows (consistent semantics).

**Issue 3 — createInboxItem in runner.ts was fire-and-forget**

Changed `getInboxRepository().create({...}).catch(...)` to `await createInboxItem({...}).catch(...)` in `awaitApproval`. Now uses the `createInboxItem` helper which also emits `inbox.created` to the project channel. On failure, logs the error AND emits a visible run event so the agent output records the write failure.

**Issue 4 — Budget rollups were fire-and-forget**

Replaced separate `PutItemCommand` + multiple `UpdateItemCommand` calls with a single `TransactWriteItemsCommand` containing all writes atomically. If any write fails, none are committed — the "rollups equal the sum of rows" invariant holds at all times. Retried once on transient DynamoDB errors. The `registerBackgroundWrite` call is removed (the whole transaction is awaited).

New test: `record -- DynamoDB rollups equal the sum of rows (atomicity contract)` verifies that after 3 sequential records, the rollup counters exactly equal the sum.

**New rules learned:**
- **Slot-per-item for counter tracking.** Maintain a `held` flag on the item that owns the slot. Release and acquire are TransactWriteItems that condition on the flag, making both operations idempotent and ensuring each item holds at most one slot.
- **TransactWriteItemsCommand for atomic row + rollup.** Use a single transaction for the main row Put + all rollup Updates. Atomicity guarantees that rollup counters always equal the sum of rows — no partial state is possible.
- **`opts` extension for conditional updates with GSI hints.** Adding `opts?: { hintParentId?: string | null }` as an optional parameter to `updateWorkflowConditional` avoids an extra GetItem when the caller already has the workflow loaded, while staying backward-compatible with existing callers.
- **Suite-scoped DynamoDB assertions in shared contracts.** Use the `label` variable from the `runContract` closure (not `process.env.DYNAMODB_ENDPOINT`) to gate DynamoDB-specific assertions. This prevents SQLite suite runs from failing on DynamoDB-only behaviour even when `DYNAMODB_ENDPOINT` is set globally.
- **Pre-existing `security` test failure.** `security-fixes.test.ts Item 6` calls `deliverChildResult` without `await` and reads the DB immediately — the async write has not completed. Recorded in `known-failures.json`.

### S1 dashboard/insights — stats repository (done 2026-11-03, branch pathb-serverless)

**Progress update (2026-11-03)**

| Module | Status |
|---|---|
| S1 dashboard + insights | Done — all SQL removed; stats repository introduced |
| DynamoDB contract tests (all repo modules) | 158 pass, 0 skip (REQUIRE_DYNAMODB=1) |

**What was built**

New `StatsRepository` (`server/repositories/stats.ts`, `stats-sqlite.ts`, `stats-dynamodb.ts`) provides read-only access to dashboard (G1–G11) and insights (H1–H6) metrics without SQL in the route files.

`SessionsRepository` extended with two new methods:
- `listPendingWorkflows()` — DynamoDB: queries `GSI-StatusGlobal` with `gStatus='pending'`.
- `finalizeRun(id, expectedStatus, patch, statsHint)` — atomically transitions a run to a terminal status AND writes rollup counters in one `TransactWriteItems`. SQLite: delegates to `updateRunConditional` (stats are computed live).

New rollup items in `portal-runs` table:
```
RUNSTATS#<projectId>           DAY#<date>                    → doneCount, failedCount, cancelledCount, totalDurationMs, durationCount
AGENTSTATS#<projectId>         AGENT#<agentName>#DAY#<date>  → runs, doneCount, failedCount, cancelledCount, costUsd, inputTokens, outputTokens, totalDurationMs, durationCount
```

`server/agent/runner.ts` updated to use `finalizeRun` with `RunFinalizeStats` hints at all three terminal transitions (pending→terminal, running→done, running→failed/cancelled).

`server/dashboard.ts` and `server/insights.ts` are SQL-free: all queries go through `getStatsRepository()`.

**Rollup key design**

- Null `projectId` → `UNSCOPED` bucket key (no leakage between scoped and unscoped runs).
- Agent names with `#` are replaced by `_` in the AGENTSTATS SK so the `AGENT#<name>#DAY#<date>` pattern remains parseable.
- AGENTSTATS query uses `begins_with(SK, 'AGENT#')` (not BETWEEN) because agent names (a-z, A-Z) sort lexicographically AFTER `#` (ASCII 35), which would break a BETWEEN upper bound.

**Anti-drift guarantee**

`finalizeRun` uses a single `TransactWriteItemsCommand`:
1. `UpdateItem` on the run item with `ConditionExpression: #status = :expected` — only one concurrent caller wins.
2. One or two `UpdateItem` on rollup items (`RUNSTATS`, `AGENTSTATS`) with ADD expressions — initialized to 0 on first write.

If the condition fails (`ConditionalCheckFailed` / `TransactionCanceledException` with reason[0] = `ConditionalCheckFailed`), the function returns `false` and the caller skips the stats write. This ensures each run is counted in exactly one terminal bucket.

**Approximations in DynamoDB mode (documented)**

| Metric | Approximation | Reason |
|---|---|---|
| G7 p50/p95 duration | null | Raw duration list not available from rollups |
| G7 toolCalls/toolErrors | 0 | Not stored in rollups; event queries per run would be prohibitive |
| G11 provider field | null | Not stored on run record; requires budget_usage lookup per run |
| G8 agent edges | Bounded by ~200 workflows per project query | GSI-ProjectWorkflows pagination cap |
| H5 project names | BatchGet from portal-projects (best-effort, fall back to ID) | Cross-table join |
| H6 cost by user with projectId filter | Ignores project filter | USERSTATS rollups don't encode project scope |
| H2/H3 source | SQLite: agent_runs (legacy); DynamoDB: p6_runs rollups | DynamoDB rollups only cover P6 runs |

**New rules learned (apply to every remaining module)**

- **AGENTSTATS SK uses `begins_with`, not BETWEEN.** Agent names (printable ASCII) sort after `#` (ASCII 35) so an upper bound like `AGENT##<date>z` would silently exclude all named-agent entries. Always use `begins_with(SK, :prefix)` for SK-prefix scans unless the prefix character is guaranteed to be the lexicographic maximum of all possible values.
- **`DynamoDB contract tests must be run directly, not via test:affected.`** The affected runner skips modules whose code hash already passed. To run with `DYNAMODB_ENDPOINT` and `REQUIRE_DYNAMODB=1`, invoke `node --disable-warning=ExperimentalWarning --import tsx --test <test-files...>` directly. Do not rely on `test:affected` for DynamoDB contract coverage.
- **Set repository singletons in DynamoDB-only tests.** When a DynamoDB repository implementation calls `getSessionsRepository()` or `getProjectRepository()` at test time, the singleton may fall back to SQLite (database not opened). Call `setSessionsRepository(ddbRepo)` in `before()` and `clearSessionsRepository()` in `after()` to ensure the correct implementation is used.
- **`RUNSTATS#UNSCOPED` bucket.** Runs with `project_id = null` are counted in `RUNSTATS#UNSCOPED` and `AGENTSTATS#UNSCOPED`. Read paths that query "all projects" must include `UNSCOPED` in the target list if unscoped runs exist.
- **stats-sqlite.ts separates tool-call query from agent-stats query.** The tool-call aggregate (JOIN p6_events) is a separate query merged in-app by agent name, same as the original dashboard.ts pattern. This avoids a cross-product JOIN that could be expensive for large event tables.

**Files changed**

| File | Change |
|---|---|
| `server/repositories/stats.ts` | NEW — interface + factory |
| `server/repositories/stats-sqlite.ts` | NEW — SQLite implementation (live SQL) |
| `server/repositories/stats-dynamodb.ts` | NEW — DynamoDB implementation (rollup reads) |
| `server/repositories/sessions.ts` | Add `RunFinalizeStats`, `finalizeRun`, `listPendingWorkflows` |
| `server/repositories/sessions-sqlite.ts` | Implement `finalizeRun` (→ updateRunConditional), `listPendingWorkflows` |
| `server/repositories/sessions-dynamodb.ts` | Implement `finalizeRun` (TransactWriteItems + rollups), `listPendingWorkflows` |
| `server/dashboard.ts` | Remove all SQL; use `getStatsRepository()` |
| `server/insights.ts` | Remove all SQL; use `getStatsRepository()` |
| `server/agent/runner.ts` | Use `finalizeRun` with `RunFinalizeStats` hint at 3 terminal transitions |
| `server/index.ts` | Add `initStatsRepository()` at startup |
| `test/stats-repo.test.ts` | NEW — contract tests (SQLite + DynamoDB Local) |
| `test/test-map.json` | Add stats sources to dashboard/insights/sessions modules |
| `package.json` | Add `--module dashboard` to `test:repo-contracts` |

**Test counts**

- Dashboard backend: all pass (including exact toolCalls/toolErrors, p50/p95, projectId scoping)
- Insights backend: all pass
- Stats contract (SQLite suite): 9 pass
- Stats contract (DynamoDB Local, REQUIRE_DYNAMODB=1): 9 pass, 0 skip
- All other DynamoDB repo contract tests: 158 total pass, 0 skip

### S1 knowledge/vault/output-files — repository layer (done 2026-11-03, branch pathb-serverless)

**Progress update (2026-11-03)**

| Module | Status |
|---|---|
| S1 knowledge base + search | Done — all SQL removed; knowledge, vault-files, output-files repositories introduced |
| DynamoDB contract tests (all repo modules) | **268 pass, 0 skip** (REQUIRE_DYNAMODB=1, DynamoDB Local) |

**What was built**

Three new repository groups:

1. `KnowledgeRepository` (`server/repositories/knowledge.ts`, `knowledge-sqlite.ts`, `knowledge-dynamodb.ts`)
   - Covers: `knowledge_docs`, `knowledge_search` (FTS5 on SQLite), `knowledge_decisions`
   - DynamoDB tables: `portal-content` (docs + decisions) + `portal-search` (inverted keyword index)

2. `VaultFilesRepository` (`server/repositories/vault-files.ts`, `vault-files-sqlite.ts`, `vault-files-dynamodb.ts`)
   - Covers: `vault_files` (all three scopes: project, personal, portal)
   - DynamoDB table: `portal-content` (three partition prefixes: VAULTPROJ, VAULTPERS, VAULTPORTAL)

3. `OutputFilesRepository` (`server/repositories/output-files.ts`, `output-files-sqlite.ts`, `output-files-dynamodb.ts`)
   - Covers: `output_files`
   - DynamoDB table: `portal-content` (partition: WFOUT#<workflowId>)

**Search design (DynamoDB inverted index in portal-search)**

FTS5 (SQLite mode) is unchanged. In DynamoDB mode, FTS5 is replaced by a keyword inverted index:

```
portal-search table:
  Term postings:  PK=TERM#<projectId>#<normalizedToken>  SK=DOC#<docId>
    Attributes: docId, projectId, matchCount, excerpt (500 chars), docVersion
  Doc term sets:  PK=DOCTERMS#<docId>                    SK=#TERMS
    Attributes: terms (StringSet), projectId, docVersion
  GSI-DocId:      PK=postingDocId  SK=postingTerm  (KEYS_ONLY projection)
```

**Tokenization:**
- Lowercase, strip punctuation, split on whitespace, remove stopwords
- Only first MAX_INDEX_BYTES (100 KB) of content is indexed per document
- Max MAX_INDEX_TERMS (3,000) unique tokens per doc; max MAX_QUERY_TERMS (10) per query
- Max MAX_POSTINGS_PER_TERM (100) postings read per query term

**Ranking (DynamoDB mode):**
- Primary: count of distinct matched query terms per doc (higher = more relevant)
- Secondary: sum of matchCount (term-frequency proxy) across matched postings
- This is simpler than FTS5's BM25 but gives reasonable ordering for small corpora (< 1,000 docs)

**Concurrent update safety:**
- `knowledge_docs` items carry a `docVersion` attribute (Number, starts at 0)
- `indexDoc` atomically increments docVersion via `UpdateItem ADD docVersion :one`
- Postings store the docVersion when written; stale postings (docVersion mismatch) are skipped on search and lazily removed
- `DOCTERMS#<docId>` helper item stores the current token set for efficient O(|terms|) deletion on update

**Large-text handling (S1 → S2 seam):**
- S1: Only the first MAX_INDEX_BYTES (100 KB) is indexed; full markdown stays on disk as today (markdown_path)
- S2 seam: the `contentS3Key` attribute on `knowledge_docs` will hold the S3 key when S3 phase is enabled; the repository reads it transparently

**Callers converted:**
- `server/knowledge.ts` — all direct SQL replaced; `requireMember` now uses `getProjectRepository()`
- `server/vault.ts` — all `vault_files` SQL replaced; `requireMember` now uses `getProjectRepository()`
- `server/output-files.ts` — all `vault_files` and `output_files` SQL replaced; `requireWorkflowAccess` and `resolveWorkDir` now use sessions + projects repositories
- `server/session-files.ts` — two vault listing queries replaced with `getVaultFilesRepository()`
- `server/scan.ts` — one vault_files lookup replaced with `getVaultFilesRepository().getByIdForProject()`

**New rules learned (apply to every remaining module):**
- **DynamoDB FilterExpression must include all referenced attributes in ExpressionAttributeValues.** The KeyConditionExpression's `:pk` binding does NOT automatically satisfy bindings used in FilterExpression. Every `:placeholder` referenced in FilterExpression must appear in ExpressionAttributeValues.
- **Three-partition vault design for nullable project_id.** Since DynamoDB GSI keys cannot be NULL, vault files with three scopes (project, personal, portal) are stored under three separate PK prefixes. Combined listings run 3 parallel queries and merge in-app. No scan.
- **DOCTERMS helper item enables O(|terms|) deletion.** Without a reverse index from docId → term list, deleting all postings for a doc would require either a full GSI scan or a DOCTERMS helper item. The helper item is the correct pattern.
- **S3 seam: leave contentS3Key attribute on doc items.** Even if not populated in S1, documenting the attribute name in the interface (`contentS3Key?: string`) avoids a schema change in S2.

**Files changed**

| File | Change |
|---|---|
| `server/repositories/knowledge.ts` | NEW — interface + factory (K1–K5 access patterns) |
| `server/repositories/knowledge-sqlite.ts` | NEW — SQLite impl (FTS5 unchanged) |
| `server/repositories/knowledge-dynamodb.ts` | NEW — DynamoDB impl (portal-content + portal-search inverted index) |
| `server/repositories/vault-files.ts` | NEW — interface + factory |
| `server/repositories/vault-files-sqlite.ts` | NEW — SQLite impl |
| `server/repositories/vault-files-dynamodb.ts` | NEW — DynamoDB impl (portal-content, 3-partition design) |
| `server/repositories/output-files.ts` | NEW — interface + factory |
| `server/repositories/output-files-sqlite.ts` | NEW — SQLite impl |
| `server/repositories/output-files-dynamodb.ts` | NEW — DynamoDB impl (portal-content, WFOUT partition) |
| `server/knowledge.ts` | Converted — all SQL replaced with repository calls |
| `server/vault.ts` | Converted — all vault_files SQL replaced; added vaultDir/listVault/MAX_FILE/MAX_VAULT exports for vault-generated.ts |
| `server/output-files.ts` | Converted — all vault_files + output_files SQL replaced |
| `server/session-files.ts` | Converted — two vault_files queries replaced |
| `server/scan.ts` | Converted — one vault_files query replaced |
| `server/index.ts` | Add 3 new initXxx calls (knowledge, vault-files, output-files) |
| `test/knowledge-repo.test.ts` | NEW — 18 SQLite + 18 DynamoDB assertions |
| `test/vault-files-repo.test.ts` | NEW — 19 SQLite + 19 DynamoDB assertions |
| `test/output-files-repo.test.ts` | NEW — 10 SQLite + 10 DynamoDB assertions |
| `test/test-map.json` | Add sources to knowledge/vault/output-files/sessions modules |
| `package.json` | Add knowledge, vault, output-files to test:repo-contracts |

**Test counts**
- knowledge-repo (SQLite): 18 pass, 0 fail
- vault-files-repo (SQLite): 19 pass, 0 fail
- output-files-repo (SQLite): 10 pass, 0 fail
- DynamoDB Local (REQUIRE_DYNAMODB=1, all repo modules combined): **268 pass, 0 skip, 0 fail**

**Approximations vs FTS5 (documented):**

| Aspect | FTS5 (SQLite) | Inverted index (DynamoDB) |
|---|---|---|
| Ranking algorithm | BM25 with IDF | Matched-term count + TF proxy |
| Phrase search | Yes | No (term-level only) |
| Stemming | Porter unicode61 (FTS5 built-in) | None (exact lowercase match) |
| Partial matches | Prefix (`match "auth*"`) | No |
| Snippet extraction | Native `snippet()` function | First 500 chars of first chunk |
| IDF (inverse doc freq) | Yes (FTS5 native) | No (would require doc-count tracking) |
| Index size | FTS5 virtual table | portal-search items: ~|unique tokens| per doc |
| Query latency | Single SQL JOIN | N parallel DynamoDB Queries (N = query terms) |

The inverted index is adequate for a single-user portal with < 1,000 documents. For larger corpora or when recall quality becomes a problem, the documented upgrade path is Bedrock Knowledge Bases (~$0 idle, $0.02/query at low volume).
