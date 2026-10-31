# Serverless migration plan: CloudFront, S3, Lambda and AgentCore instead of EC2

Status: **draft for review** (2026-10-31). Builds on branch `integration/all-prs` and on `reports/Cost efficient AWS hosting and pipeline.md` (the EC2 plan this replaces).

## 1. Goal

Run Agent Portal with **no servers to manage**:

- the web app comes from S3 through CloudFront;
- the API runs on AWS Lambda;
- each agent run gets its own isolated Bedrock AgentCore Runtime microVM;
- the data lives in managed, scale-to-zero services.

Why:

1. Pay only for what is used. A small team is idle most of the day.
2. Isolate agents from the portal's data and credentials. That is the biggest open security risk in the EC2 plan.
3. No patching, and no single instance to lose.

This is a **rewrite of the backend's foundations**, not a hosting change. Today's server is one long-running Node process that assumes:

- a local SQLite file;
- a local disk for projects, git clones and documents;
- an in-memory event bus for live updates;
- child processes for agents, git, pandoc, Chromium and draw.io;
- timers for triggers and health checks.

Each of those needs a serverless replacement. The plan below does it in phases, so the team can keep using the portal throughout.

## 2. What the server depends on today (from the code)

| Dependency | Size in the code | Where |
|---|---|---|
| SQLite, synchronous API (`node:sqlite`) | 52 tables; helpers `one/all/run/insert/update` called from most of the 116 server files | `server/db.ts` and its callers |
| Full-text search (SQLite FTS5) | knowledge base search and cited Q&A | `server/knowledge.ts`, `server/db.ts` |
| Local disk | 42 modules use `node:fs`: project folders, uploads converted to Markdown, vault, generated documents, diagrams, `.claude/` config files, run work folders, backups, `master.key` | `projects.ts`, `knowledge.ts`, `vault.ts`, `docgen.ts`, `config-files.ts`, … |
| Child processes | 14 modules: git (clone, worktree, push), Claude Code (SDK), Kiro CLI, pandoc, Chromium (documents, icons), draw.io, uv/tool packs | `git.ts`, `agent/*`, `convert.ts`, `docimage.ts`, `drawio-render.ts`, `tool-packs.ts` |
| In-process pub/sub to the live views | 3 Server-Sent Events routes, replay after a sequence number already exists | `events.ts`, `http.ts`, `runs.ts` |
| Long-running loops in the process | session driver (iterate, verify, push), run queue, control plane | `workflows/driver.ts`, `control-plane.ts` |
| Timers | trigger engine (cron, Jira polling), approval SLA, cleanup | `loop-triggers.ts`, `index.ts`, `http.ts` |
| HTTP API | 308 routes on one small custom router | `http.ts` and route modules |

## 3. Target architecture

```
Browser
  │  https://portal.example.com
  ▼
CloudFront (+ WAF)
  ├── /*            → S3 bucket: the built React app (private, Origin Access Control)
  ├── /api/*        → Lambda function URL (Origin Access Control, IAM auth), response streaming on
  └── /hooks/*      → same Lambda (GitHub/Jira webhooks, HMAC checked)

Lambda "api"  (container image, the existing router via AWS Lambda Web Adapter)
  ├── Aurora Serverless v2 PostgreSQL (scale to zero) through the RDS Data API  → no VPC, no NAT
  ├── S3 "data" bucket: project documents, vault, generated outputs, uploads, config files
  ├── Step Functions: one execution per session (iterations, checks, pushes, waits for people)
  ├── EventBridge Scheduler: cron triggers, Jira polling, cleanup, SLA checks
  └── AgentCore Runtime: InvokeAgentRuntime, one microVM per agent run

AgentCore Runtime container "agent-runner"  (arm64)
  ├── Claude Code (Agent SDK) + git + the portal's guard and hooks
  ├── clones the run's repositories into session storage, works, pushes a branch
  ├── calls Bedrock with its own execution role (Bedrock only; no portal data access)
  └── reports events, questions and approvals back to the API with a per-run token

Lambda "jobs" (container image, up to 15 min, 10 GB)
  └── pandoc, Chromium, draw.io: document conversion, generated documents, diagrams
```

### Choices and why

| Concern | Choice | Rejected and why |
|---|---|---|
| Database | **Aurora Serverless v2 PostgreSQL**, minimum capacity 0 (pauses when idle), accessed through the **RDS Data API** | DynamoDB: 52 relational tables with joins would mean remodelling everything. Aurora DSQL: Postgres-compatible but missing features this app uses (full-text search, some DDL). Keeping SQLite on EFS: SQLite's write-ahead log does not work on network file systems. |
| Full-text search | Postgres `tsvector` + GIN index | OpenSearch Serverless: a few hundred dollars a month minimum, far too much for this size. |
| API | **Lambda** running the existing router through the **AWS Lambda Web Adapter**, so `http.ts` and the route modules keep working | Splitting 308 routes into separate functions: much more work for no gain at this size. API Gateway REST: no streaming, extra cost; function URLs plus CloudFront cover it. |
| Live updates | SSE from the Lambda (response streaming, at most 15 minutes per connection). The browser already reconnects and replays from the last sequence number. Events are read from the database (`agent_run_events` by `seq`) instead of the in-memory bus | API Gateway WebSockets or AppSync Events: an option later if polling the database costs too much; not needed at first. |
| Files | **S3**, through a small storage interface (`get/put/list/delete`) that also has a local-disk version for tests and development | EFS: needs a VPC (and then a NAT for internet access) and stays mounted all the time. |
| Agent runs | **AgentCore Runtime**, one microVM per run, session storage for the working copy | Running agents in Lambda: 15-minute limit and no isolation guarantees beyond the function. |
| Long-running sessions | **Step Functions Standard**, one execution per session; an iteration waits for the agent with a task token; human approvals wait the same way | A loop inside Lambda: 15-minute limit. |
| Schedules | **EventBridge Scheduler** | Timers in a process: there is no process any more. |
| Secrets | **Secrets Manager or SSM Parameter Store with KMS**, replacing `master.key` | A key file on disk: there is no disk. |
| Sign-in | Keep the portal's own sessions (now rows in Postgres) and OIDC. Cognito is optional later | Changing identity at the same time as everything else. |

## 4. How the main flows work

**Starting an agent run.**

1. The browser posts to `/api/...`.
2. The `api` Lambda checks permissions, budgets and the safety settings (PR #4), writes the run row, creates a per-run token and calls `InvokeAgentRuntime` with the run's settings.
3. The AgentCore container clones the repositories into session storage and runs Claude Code. The portal's guard (paths, blocked commands, config protection from PRs #3 to #6) runs inside the container, so it is enforced where the commands run.
4. Each SDK message is posted back to the API in batches (`POST /api/runs/:id/events` with the run token) and stored in `agent_run_events`.
5. The browser's SSE stream reads new rows by `seq`.

**Approvals and questions.**

1. The container's `canUseTool` posts the request (with the fingerprint from PR #5) and waits for the answer by polling the API.
2. The person answers in the browser as today.
3. Expiry (PR #5) keeps forgotten requests from holding a microVM. AgentCore bills memory while it waits, so the expiry matters more here.

**Sessions (multi-iteration).**

1. A Step Functions execution replaces `workflows/driver.ts`. Its loop: compose the prompt, run an iteration (AgentCore, wait for the callback), run the checks (in the same microVM through `InvokeAgentRuntimeCommand`, or in a `jobs` Lambda), then decide to continue, finish, block, push or wait for a person.
2. Stop rules (PR #9), budgets (PR #7) and the push approval with the working-copy fingerprint (PR #5) move into the state machine and the API.

**Pushing.** The container pushes the session branch with a short-lived, repository-scoped token issued for that run (a GitHub App installation token, or CodeCommit credentials through the execution role), only after the portal allows it.

**Documents and diagrams.** Upload conversion (pandoc), generated Word/PowerPoint documents, Chromium rendering and draw.io run in the `jobs` Lambda container. Anything longer than 15 minutes runs as an AgentCore command instead.

**Knowledge base.** Uploaded files go to S3. Conversion runs in `jobs`, and the Markdown and its search index go into Postgres (`tsvector`). Agents read the documents from S3 copies in their session, or through a small search tool that calls the API.

**Triggers.** EventBridge Scheduler covers cron, Jira polling and cleanup. GitHub and other webhooks go through CloudFront to the API.

## 5. Phases

Each phase ships on its own, behind the existing tests, and keeps the portal usable. Phases S1 and S2 can run on today's single server first (the "hybrid" step), so the agent isolation and pay-per-run benefits arrive early.

| Phase | What | Main changes | Rough effort (one engineer) |
|---|---|---|---|
| **S0 Foundations** | Make the code ready for the move while it still runs on one server | Async data layer: the `one/all/run/insert/update` helpers become `async`, and every caller is converted (mechanical but wide: most server files). A database adapter with SQLite and Postgres versions; the test suite runs against both. A storage interface (local disk / S3) used by the 42 file-using modules. An event-source interface (in-memory / database-backed). | 3–4 weeks |
| **S1 Agents on AgentCore** | A new `agentcore` engine beside the SDK, Kiro and demo engines | `agent-runner` container image. Runner API for events, questions, approvals and the run token. Guard and hooks inside the container. Clone and push in the session. AgentCore execution role (Bedrock only). Engine selection per project. The real-engine tests run against the container locally. | 3–4 weeks |
| **S2 Data to Aurora and S3** | Move the database and files | Postgres schema from the 52 SQLite tables. FTS5 replaced by `tsvector`. One-time migration script (SQLite → Postgres, data folder → S3). `master.key` replaced by a KMS-backed secret. | 2–3 weeks |
| **S3 API on Lambda, app on S3** | Leave the server | Lambda Web Adapter image for the API. Function URL with Origin Access Control. SPA build to S3. CloudFront behaviors (`/api/*` streaming, no caching). SSE from database-backed events. Webhooks. | 2 weeks |
| **S4 Orchestration and jobs** | Replace the in-process loops and timers | Step Functions session state machine (iterations, checks, pushes, waits). Run queue and concurrency caps as database rows. EventBridge Scheduler for triggers and cleanup. `jobs` Lambda for pandoc, Chromium and draw.io. | 3–4 weeks |
| **S5 Pipeline and cutover** | Infrastructure as code and the switch | AWS CDK (TypeScript) stack. GitHub Actions with OIDC deploys the images, the SPA and the stack. Rehearse the data migration. Cut over. Remove the EC2 path from the docs. | 1–2 weeks |

**Total: about 14–19 weeks** for one engineer familiar with the code, faster with two working in parallel on S1 and S2 after S0.

## 6. Cost estimate (Singapore, light use by 5–30 people)

These figures are **estimates** to check with the AWS Pricing Calculator before committing.

| Item | Basis | Monthly |
|---|---|---|
| Aurora Serverless v2 (minimum 0 ACU, active about 8 h on working days at 0.5–1 ACU) plus storage | ACU-hours plus GB-month | about $15–40 |
| Lambda (api + jobs) | requests plus GB-seconds; SSE connections count while open | about $2–10 |
| Step Functions Standard | per state transition | about $1 |
| S3 (app + data) | storage plus requests | about $1–3 |
| CloudFront | always-free tier covers this traffic | about $0–1 |
| WAF | web ACL plus 4 rules | about $10 |
| Secrets, KMS, EventBridge Scheduler, logs, alarms | | about $3–6 |
| **Total before agent runs and Claude** | | **about $30–70** |
| AgentCore Runtime | v2: $0.1276 per vCPU-hour (CPU not billed while waiting on the model), $0.0169 per GB-hour of memory held | about $0.03–0.05 per 30-minute run; about $30/month at 20 runs a day |
| Claude on Bedrock | tokens, billed through AWS Marketplace | usage-based, usually the largest line |

Compared with the EC2 plan (about $79–162 a month before Claude): cheaper when the team is idle much of the time, similar or higher with heavy all-day agent use, and with agent isolation built in.

## 7. Risks and open questions

| Risk | Effect | Mitigation |
|---|---|---|
| Aurora resumes from zero capacity in roughly 15 seconds | The first request after an idle spell is slow | Keep a 0.5 ACU minimum during working hours (a few dollars more), or warm it on sign-in |
| RDS Data API limits (response size, request time) | Large queries (exports, insights) can fail | Paginate; move heavy reports to `jobs` |
| Converting the synchronous data layer to async touches most of the server | The biggest and riskiest step | Do it first (S0), mechanically, with the ~1,000 existing tests on both databases |
| AgentCore Runtime availability in Singapore is not confirmed | It may need another region for agents | Check before S1; agents can run in a nearby region while the data stays in Singapore |
| AgentCore bills memory while a run waits for a person | Forgotten approvals cost money | The approval expiry from PR #5; short idle timeouts |
| Kiro CLI uses a local sign-in | It may not work inside AgentCore | Keep Kiro on the legacy path, or use a Kiro API key in the container (check) |
| SSE connections over 15 minutes | Streams are cut every 15 minutes | The browser already reconnects with replay; verify in tests |
| Git-heavy work (large repositories) in each microVM | Slower runs, more transfer | Shallow clones; cache repository bundles in S3 |
| More AWS services to understand | Harder to debug | CDK in the repo, structured logs, one dashboard |

## 8. Decisions needed from the owner

1. Go fully serverless (this plan), or stop after the hybrid step (S0 and S1 on one small server).
2. Region: Singapore for everything, or agents in another region if AgentCore is not available in Singapore.
3. Whether the Kiro engine must work on the serverless path.
4. Infrastructure as code: AWS CDK in TypeScript (recommended, same language as the app) or Terraform.
5. Domain name for CloudFront, or the default `*.cloudfront.net` at first.

## 9. Next steps

1. Review this plan.
2. Confirm AgentCore Runtime availability and limits for the chosen region (session storage size, concurrent sessions).
3. Spike (about 1 week): run one agent run end to end on AgentCore with the real Claude Code container, posting events back to a local portal. Measure start-up time and cost per run.
4. Spike (a few days): run the API on Lambda through the Web Adapter, against Aurora Serverless v2 through the Data API, with one SSE route. Measure cold start and resume time.
5. Then start S0.
