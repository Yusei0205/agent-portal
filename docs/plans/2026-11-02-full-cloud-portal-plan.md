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

## 9. Progress (updated 2026-11-02)

| Phase | Status | Commits |
|---|---|---|
| S0 Spike A (AgentCore runner) | Done, deployed | dcefd4a |
| S0 Spike B (Kiro headless) | Can start without an API key using IAM Identity Center sign-in (needs the user to approve one device code) | — |
| S0 Spike C (AppSync Events) | Done, deployed, PASS | 61f3f67 |
| S1 DynamoDB data design | Done | 836e8de |
| S1 modules converted | api-tokens, auth (users, sessions, invitations), permissions, audit, delegation settings, settings + secrets, projects + members + teams | c88c001, f993e25, 7ff92db, f982d7c, ac7c5de |
| S1 remaining | sessions/workflows/runs/events (hot path), inbox, reviews/scans, knowledge/vault/docs/diagrams, learn, testing module, dashboard/insights, repos/workspaces/git connections, integrations, credentials, themes, MCP server | — |

Known callers still on SQLite are marked `S1-TODO(<module>)` in the code: review.ts, learn.ts, jira.ts, mcp-server.ts, session-files.ts, inbox.ts (project membership checks).

### Rules learned during S1 (apply to every remaining module)

- A DynamoDB transaction cannot touch the same item twice. Put guards on the write itself.
- Uniqueness (email, slug) and one-time claims (first admin, invitations) use conditional writes, never read-then-write.
- Updates must be conditional on the item existing; plain `UpdateItem` is an upsert.
- Retry `BatchGetItem` unprocessed keys.
- Never fail open: authorisation and security settings must throw, not return defaults.
- Fire-and-forget writes use `registerBackgroundWrite`; the response end waits for them (Lambda freezes after the response).
- SQLite mode reads the database directly; caches and snapshots are DynamoDB-mode only.
- Contract tests must run the same assertions on both backends with a fresh store where counts matter, and must never skip their success path. CI runs them with `REQUIRE_DYNAMODB=1`.
