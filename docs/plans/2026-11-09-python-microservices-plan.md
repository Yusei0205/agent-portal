# Plan: Python microservices behind the React frontend

Status: proposal, not started. Nothing in this document has been built or tested. Numbers come from a read of the repository on 2026-11-09.

## Goal

Keep the frontend in React. Replace the single Node/TypeScript server with Python services, split by module so that **one module failing does not stop the others**.

## What exists today

- `server/`: about 96,000 lines of TypeScript in 311 files, with roughly 425 route registrations.
- `server/repositories/`: about 25,000 lines. Every entity has a SQLite and a DynamoDB version.
- 215 backend test files, plus the web tests.
- Three separate Node runner containers: `agent-runner`, `kiro-runner`, `codex-runner`.
- Node-only libraries in use: `node-pty`, `ws`, the MCP SDK, `docx`, `pptxgenjs`, `exceljs`, Playwright.
- Heavily shared modules (number of imports): `db` 156, `http` 137, `util` 90, `config` 62, `audit` 35, `project-access` 34, `settings` 31, `secrets` 24, `events` 23.
- The server runs on Lambda behind the Lambda Web Adapter (`Dockerfile.lambda`); infrastructure is CDK in TypeScript (`infra/`).

The shared modules above are what tie the features together. They decide where the service boundaries can go.

## Principles

1. **Each service owns its own tables.** No service reads another service's tables.
2. **No synchronous calls between feature services.** They communicate through events (SQS / EventBridge). The one exception is a cached permission lookup against Core.
3. **Each service has its own Lambda, concurrency limit, dead-letter queue and alarms.**
4. **The frontend treats every module as optional.** A failed module shows "unavailable" on its own page only.
5. **Few, larger services.** Seven, not twenty-five: each extra service adds pipelines, alarms and local-setup cost.
6. **Strangler migration.** The existing Node server stays the default route until a module has moved; every move can be rolled back.

## Target services

| Service | Takes from the current server |
|---|---|
| **Core** | auth, users, projects, project-access, workspaces, settings, tokens, secrets, audit |
| **Runs** | runs, sessions, agent orchestration, runners, review, terminal, live browser view, realtime events |
| **Workflows** | automations engine, scheduled jobs, loops |
| **Integrations** | Gmail, Google, Jira, mail, git connections, repos, pull requests, MCP routes |
| **Knowledge** | knowledge, embeddings, search, learn, vault |
| **Documents** | docgen, diagrams, draw.io, OOXML, presentations |
| **Insights** | dashboard, insights, governance, feedback (read-only) |

The Tests module (Playwright and Chromium) is heavy. It starts inside Runs and can become its own service later.

Stack: FastAPI and Pydantic, managed with `uv`; OpenAPI generated for a typed frontend client; `boto3` for DynamoDB; `ptyprocess` for terminals; the Python Playwright API; `python-docx`, `python-pptx` and `openpyxl` for documents. The runners stay Node containers; only their orchestration moves to Python.

## Phases

### Phase 0: Boundaries (no code moves)

- Table of every route and its owning service.
- Table of which tables each service owns, and a list of every place one module reads another's data. These are the real cuts and some will need redesign.
- Decide how permissions and secrets are shared between services.
- Write contract tests that call a running server over HTTP, so the same test can run against the Node server and the Python one.
- Fix the response and error shapes the frontend depends on.

Exit: both tables reviewed and agreed; contract tests run green against the current server.

### Phase 1: Platform foundation

- Service template: FastAPI starter with health check, structured logging, error format and settings.
- Shared Python library: token verification, event publishing, error format matching the frontend.
- CDK construct per service: Lambda image, route, own tables, queue, dead-letter queue, alarms.
- Gateway: path routing (API Gateway, which can also serve WebSockets) with the existing Node server as the default target.
- Local development: a compose file that starts the services together.

Exit: an empty example service deployed through the construct and reachable through the gateway, with the Node server still serving everything else.

### Phase 2: Core service

Everything depends on identity, so it moves first.

- Session cookies, signed tokens (`gm_`, API tokens) and encrypted secrets (`setSecret`) must keep the exact same key derivation and format. If they differ, every user is signed out and stored tokens become unreadable.
- Other services verify tokens locally and cache permissions, so a Core outage does not stop people who are already signed in.
- Decide the failure policy for the permission lookup. Suggested: cached read access continues, writes fail closed.

Exit: Core serves its routes through the gateway; existing sessions and stored secrets keep working.

### Phase 3: Events

- Event bus, outbox pattern, dead-letter and replay tooling.
- Audit becomes an event consumer, so logging cannot block a request.
- Realtime events move to a dedicated streaming path.

Exit: audit entries written through events; a failed consumer does not affect the request that produced the event.

### Phase 4: Leaf services, one at a time

Order: **Insights, Documents, Knowledge, Integrations.**

For each: create its tables and copy the data, run old and new side by side, shift 10% of traffic and then 100% through the gateway, then delete the old code. Documents is where Python's document libraries pay off first.

Exit per service: contract tests green; the old module deleted; rollback tested once.

### Phase 5: Runs and Workflows (hardest)

- Runner dispatch goes through a queue.
- Runs and Workflows keep their own state.
- Streaming and reconnects get the most testing.
- The Tests module moves here.

Exit: a full session and a scheduled workflow run end to end on the new services.

### Phase 6: Resilience

- Timeouts, retries with backoff, circuit breakers, per-service concurrency limits.
- An aggregated health page, and per-module error handling in React.
- Failure test: stop each service in turn and confirm the others keep working.

Exit: a written failure matrix showing what each service's outage does and does not affect.

### Phase 7: Retire the Node server

- Remove the routes that have moved.
- Review cost and operations; update docs and runbooks.

## Frontend changes (small)

- React and Vite stay; `/api/...` paths stay the same because the gateway does the routing.
- An error boundary per module, and a "service unavailable" state in the API client for 502 and 503 responses.
- A typed client generated from OpenAPI.
- Stream event formats stay identical.
- `shared/themes` is plain JSON and does not change.

## Risks

- **Hidden coupling:** much of the code reaches into shared tables. Phase 0 will find places that need redesign, not just moving.
- **Streaming and run state:** events, reconnects and Lambda time limits are where bugs will hide.
- **Quirks in 95k lines** will not all show in the contract tests. Expect a long tail of small fixes.
- **Operations:** seven services mean seven pipelines and sets of alarms, and a harder local setup.
- **Data consistency:** work that was one transaction becomes events, so eventual consistency and duplicate delivery have to be handled.
- **Two codebases** are live during the migration, so new features either wait or are built twice.
- **SQLite mode:** local single-file mode does not map cleanly to separate services; use a compose setup or one file per service.
- **Not verified:** that Python equivalents of every Node library behave the same (the Claude Agent SDK, MCP, DOCX templating).

## Cheaper alternative

Add one Python service only where Python is stronger (document generation, data work) and leave the Node server alone. It costs a fraction of this plan, but it does not give the per-module failure isolation this plan is for.

## Open decisions

1. Seven services, or coarser (3 to 4) or finer?
2. Gateway: API Gateway (suggested, also handles WebSockets) or CloudFront?
3. Freeze new Node features after Phase 0, or build them twice during the migration?
4. Runners stay Node (suggested), or move too?
5. Why Python (team skills, AI and data libraries, other)? The answer affects the order of Phase 4.

## First pull request after approval

Phase 0 only: the route and table ownership tables and the contract-test harness.
