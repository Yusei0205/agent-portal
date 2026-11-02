# Path B (full serverless) — status and next steps

Date: 2026-11-03
Branch: `pathb-serverless` (worktree `../agent-portal-pathb`)
Account / region: 366019841051 / ap-southeast-1
Budget target: under $10/month for the prototype

## 1. Decisions so far

| Topic | Decision | Why |
|---|---|---|
| Hosting | Path B (full serverless) first, no container | Pay per use; Lightsail/EC2/Fargate cost money while idle |
| Compute | Lambda + Lambda Web Adapter, response streaming | Scales to zero; current Node server runs mostly unchanged |
| Database | DynamoDB on-demand, behind repositories (`USE_DYNAMODB=true`) | About $0 idle, no VPC, no cold resume |
| Web | S3 + CloudFront | Free tier covers prototype traffic |
| Search | DynamoDB keyword index (`portal-search`) | OpenSearch minimum cost is far above budget |
| Agents | AgentCore runtimes (Kiro done; Claude runner exists from Spike A) | Isolation per run |
| Live updates | AppSync Events (Spike C passed) | About $0.13/month at prototype use |
| Speed over polish | Known bugs go to `2026-11-03-pathb-bug-backlog.md` | User request: build fast, fix later |

Rejected: App Runner (closed to new customers 2026-04-30), ECS Express/Fargate (ALB + task always on, about $25/month), Lightsail (billed while stopped), EC2 start/stop (manual, about $1–3/month but still a server), OpenSearch Serverless.

## 2. Commits on `pathb-serverless`

| Commit | Content |
|---|---|
| 6481dea (main_v3) | Sessions repository + transcript changes |
| 1b85846 | Sessions hardening (conditional transitions, transcript, idle index, event retry) |
| fedb9a5 | Delegation, inbox, budget repositories |
| c12ab7b | Dashboard and insights via stats repository |
| d17c8eb | Knowledge, vault, output-files repositories + backlog |
| 4f2ea58 | Reviews/scans/repos/workspaces, credentials/integrations/themes/user-config/agentcore-login, create-module/learn/testing repositories |

Tests at 4f2ea58: all 40 backend modules pass in SQLite mode; DynamoDB contract tests pass against DynamoDB Local (run directly, see backlog item 26).

## 3. What works in DynamoDB mode

Works: sign-in, projects/members/teams, API tokens, permissions, audit, settings, sessions and runs, Kiro via AgentCore, approvals, delegation, inbox, budget, dashboard, insights, knowledge search, vault list, output files, repos, workspaces, git connections, reviews (core CRUD), scans (core), credentials, AWS accounts, integrations, themes, user config.

Not yet in DynamoDB mode (callers still use SQLite directly; repositories exist):
- Testing module, learn, diagrams, generated docs, presentations, doc templates, most of ai-attachments.
- Review list filters, review merge/rerun/post, scan background jobs, review lifecycle hook.
- MCP server (`server/mcp-server.ts`).

Details: `docs/plans/2026-11-03-pathb-bug-backlog.md`.

## 4. Other cloud blockers (not database)

| Area | Today | Needed |
|---|---|---|
| Files (`data/`, uploads, vault bytes, working copies) | Local disk | S3 via `server/storage/` (S3 backend exists, few users) |
| Timers (`setInterval`, idle stop, cleanup) | In process | EventBridge Scheduler calling an internal endpoint |
| Live updates (SSE, project event bus) | One process | AppSync Events (Spike C), polling fallback |
| In-memory maps (approvals waiters, run controllers) | One process | DB rows / conditional updates |
| Claude runs | Local child process | AgentCore runtime (Spike A image), like Kiro |
| Terminal, browser-live, pandoc/draw.io | Local binaries | AgentCore command shell / Browser, jobs Lambda |
| Auth | Email + password | Google sign-in with email allow-list (decision 2.a) before public use |
| Spike C tokens | Unsigned | Signed JWTs |

## 5. Next steps (in order)

1. **Deploy a first cloud version (core features).**
   - CDK: DynamoDB tables (on-demand), Lambda container image with Lambda Web Adapter, Function URL, S3 bucket for `web/dist`, CloudFront (`/*` → S3, `/api/*` → Lambda URL with OAC).
   - Env: `USE_DYNAMODB=true`, table names, `PORTAL_KIRO_AGENTCORE_RUNTIME_ARN`, secret key from SSM.
   - Add a $10 budget alert next to the existing $50 one.
2. **Files to S3** so uploads, vault and knowledge files survive Lambda restarts.
3. **Google sign-in + allow-list** before sharing the URL.
4. **Timers to EventBridge Scheduler.**
5. **Live updates via AppSync Events** (sign the tokens).
6. **Claude runner on AgentCore**, same path as Kiro.
7. **Finish caller conversion** for the modules in section 3, then the MCP server.
8. **Fix backlog items** (priority: knowledge search cleanup bugs, review lifecycle hook, testing module).

## 6. How to resume

- Work in `c:\Users\tanch\Desktop\Project\Individual\agent-portal-pathb` (branch `pathb-serverless`). Another session uses the main folder.
- Build: `npm run build`. Tests: `npm run test:affected -- --backend-only` (split by `--module`, max 10 min each).
- DynamoDB tests: `docker run -d --rm --name ddb -p 8000:8000 amazon/dynamodb-local`, set `DYNAMODB_ENDPOINT=http://localhost:8000` and `REQUIRE_DYNAMODB=1`, run the `test/*-repo.test.ts` files directly with `node --import tsx --test`, then stop the container.
- Rules learned: section 9 of `2026-11-02-full-cloud-portal-plan.md`. Repository how-to: `2026-11-02-repository-pattern.md`.
- AWS profile `agentcore`; rotate the access key from `cytan_accessKeys.csv` before any CI setup.
