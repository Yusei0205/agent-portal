# Agent Portal

A self-hosted web portal for running AI coding agents on your projects, to speed up delivery, QA and
code review. It runs agents through the official
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript) (Anthropic API or Amazon
Bedrock) or through Kiro CLI, and has a simulated Demo mode. The full list of what it does is in
[docs/requirements-spec.md](docs/requirements-spec.md).

- **Projects** hold documents, repositories, agents, skills, sessions and members. **Setup** is one
  page per project: a readiness checklist plus tabs for connection and provider, repositories,
  agents and skills, team and members, Jira, configuration files and budget.
  The project menu is Sessions, Workspaces, Code review, Knowledge, Create, Vault, Insights, Setup
  and the Portal group, plus Tickets once the project has Jira connected.
- **Create** is one page with tabs for Diagrams, Documents (generated Word and Markdown), Decks
  (PowerPoint) and this project's Templates. The portal-wide default templates stay in Settings.
- **Sessions** are the core feature. A session is a saved goal that the portal drives through
  repeated agent runs until it is done, blocked or hits a limit (budget, iterations, stagnation).
  A single run is a session with one iteration. Each session has a live agent tree, every tool
  call with its cost, changes and diffs, follow-up messages, an optional plan-first approval,
  delegation to child sessions, slash commands, and push to a new branch or a pull request.
- **Loop specs** are reusable session recipes: a trigger (manual, cron, interval, webhook, GitHub
  event, Jira event), a goal template, rules, a verification pipeline (shell checks and an
  advisory judge), stop rules, memory between iterations and escalation. Seeded: investigate and
  fix a ticket, feature from a Jira ticket, bug fix, nightly test fixer, dependency update and
  **Keep docs current**. That last one runs when a pull request is merged into the default branch
  and every night: it refreshes stale architecture diagrams, then stale generated documents,
  writes them into a work branch (`docs/diagrams/*.mmd`, `docs/generated/*.md`) and proposes one
  pull request (you allow the push by default). Nothing stale means no session and no pull request.
  A spec names its actions in `trigger_config.action` or, for several, `trigger_config.actions`.
  **Review new pull requests** reviews a GitHub pull request when it is opened, reopened, gets
  new commits or is marked ready for review (not drafts, not the portal's own `docs/keep-current-*`
  branches). Point a repository webhook (Pull requests events) at the spec's URL, with its secret.
  It keeps the findings and puts "Review ready: approve to post" in the Inbox (draft mode, the
  default), or posts straight away (`postMode: auto`). Only findings at or above the lowest
  severity (default medium) are posted, as inline comments plus one summary, never twice for the
  same file, line and text on a pull request, at most 20 per pull request, with secret values
  scrubbed. CodeCommit pull requests are reviewed by hand (*Run now* with the number) and get one
  summary comment.
- **Inbox** is one list across projects of everything that needs a person: approvals, questions,
  pending pushes and blocked sessions, with a live count and answers right in the list.
- **Workspaces** are named sets of repositories (and integrations) that a session can use as a
  group.
- **Vault** holds files you upload once (documents, templates, test data). Every run gets a copy.
  It has a personal, a team-wide and a per-project scope on one page.
- **Integrations and connections**: Git connections (GitHub, Bitbucket, CodeCommit, other Git
  servers), AWS accounts (keys, profiles, SSO), MCP integrations, Jira, and API tokens.
- **Insights**: cost, tokens, latency, failures and agent activity, for one project or all of
  them, plus loop metrics and spend per user.
- **Knowledge**: upload FSD, TSD, specs and notes (Word, PDF, Excel, PowerPoint, Markdown, HTML).
  They are converted to Markdown, indexed, searchable and answerable with cited sources. When the
  documents do not answer, the question goes to the project's team questions and the answer lands
  in a decisions log that every agent reads first.
- **Learn** (a tab of Knowledge): generated documentation in a plain-language and an engineering version, glossaries,
  FAQs, quizzes checked against their sources, onboarding paths and team progress. Documents are
  flagged when their sources change.
- **Architecture diagrams**: an agent session draws Mermaid system-context, component and
  data-flow diagrams from a project's repositories. Each redraw is a new, validated version kept
  in the project's git repository (`docs/diagrams/`); a diagram is flagged stale when a repository
  moves on and can be refreshed on demand or by a loop spec. Export as PNG (needs the optional
  headless browser) or raw Mermaid.
- **Code review** of two branches or a GitHub pull request: findings next to the changed lines,
  a cheap Haiku pass with a rule-based scan, an optional Sonnet deep look, and posting back to
  GitHub. Reviews started by the *Review new pull requests* loop spec are marked "From PR #n
  (auto)"; the ones in draft mode have an *Approve and post* button.
- **Claude Code and Kiro engines**: each engine has its own agents and skills (`.claude` and
  `.kiro` in the project). Claude agents come from role templates, a shared library, import from
  a folder or zip, or a plain-language description. A Kiro session never silently falls back to
  Claude Code.
- **Documents and decks**: agents can write Word, Excel, CSV and PowerPoint files, and the
  "Document a repository" mode writes cited documentation. Upload a Word or PowerPoint template
  once (per project, with a portal-wide default) and generated files follow it. The documentation
  generator writes an overview, architecture, API, runbook or user guide from chosen repositories,
  knowledge, decisions and stored diagrams as Markdown plus Word, checks its source citations,
  keeps versions and flags a document stale when a source changes. The presentation generator
  turns a topic, document, session result or architecture diagram into a deck with speaker notes,
  diagrams and a slide preview. Diagrams and previews use an optional headless browser.
  The New and Regenerate dialogs and the Refresh actions have an *Agent and tools* choice: a lead
  agent and a switch that lets the agent use tools freely. Diagram, document and presentation requests accept an optional `leadAgent` and `trustAllTools`
  (the session launcher's options; always-blocked commands stay blocked), remembered on the item
  and reused by refresh and regenerate.
- **Administration**: users and invitations, an audit log, and a control plane (concurrency caps,
  queueing, graceful drain, approval deadlines). Teams, SCIM provisioning, Google sign-in setup
  and outbound webhooks are built but parked: turn on **Settings › Advanced** to show them in
  the Admin panel.

Everything runs in one Node.js process with a built-in SQLite database. No other services.

## Requirements

- Node.js **22.13 or newer** (uses the built-in `node:sqlite`)
- Git
- For AWS CodeCommit over `https://`: the AWS CLI. For `codecommit::` addresses: `pip install git-remote-codecommit`.
- Optional: `pandoc`, only for `.odt`, `.rtf` and `.epub` uploads.

## Run it

```bash
npm install
cp .env.example .env          # then set PORTAL_SECRET_KEY (openssl rand -hex 32)
npm run build
npm start                     # http://127.0.0.1:8787
```

Open the address, create the admin account, then create a project. The portal starts in
**Demo mode**. Switch to a real provider under **Settings › Model provider**:

- **Anthropic API**: paste an API key from the Claude Console.
- **Amazon Bedrock**: set the region and how the server signs in to AWS (instance role, named
  profile, access keys, a Bedrock API key, or **AWS SSO / IAM Identity Center**). Enable the
  Claude models in the Bedrock console first. If your account needs exact model IDs or
  inference profiles, set them under **Settings › Model versions**.

Press **Test connection** after switching.

### Docker

The recommended way to run the portal in Docker is with the included `compose.yml`.

#### First run

```bash
cp .env.example .env          # set PORTAL_SECRET_KEY (openssl rand -hex 32)
docker compose up -d
```

Open http://127.0.0.1:8787, create the admin account, then create a project.

> **Port binding:** `compose.yml` binds to `127.0.0.1:8787` only. The port is not
> reachable from other machines. Put Caddy or nginx in front before exposing it.

#### Creating the admin account on first start

If you set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` before `docker compose up`, the
portal creates the admin account automatically on start (no setup page needed).

> **Security note:** `ADMIN_PASSWORD` remains in the container environment and is visible
> via `docker inspect`. Remove it from `.env` (or unset it) after the first start and
> restart the container: `docker compose up -d`. The admin account is not re-created on
> subsequent starts so removing the variable is safe.

#### Tool packs (off by default)

Three optional packs extend what agents can do. They are **off by default** so a basic
`docker compose up` works without them.

| Pack | What it enables | How to turn it on |
|------|-----------------|-------------------|
| **uv / uvx** | AWS integration in agent runs, custom uvx-based MCP servers | Admin: click **Install** under **Settings › Tools** |
| **Kiro CLI** | Kiro engine for agent runs | Admin: click **Install** under **Settings › Tools**, then log in (see below) |
| **Browser MCP** | Web browser integration in agent runs | Start with `docker compose --profile browser up -d` |

**Installing uv or kiro-cli:** open **Settings › Tools** (admin only). Each pack row shows
its status, what it enables, and an Install button with a live log stream.

**Browser isolation:** each agent run gets its own isolated browser context. Users and
sessions never share cookies, history, or storage. Up to three browser sessions run at the
same time (configurable in `compose.yml`). The browser container is never accessible from
outside the compose network.

**Slash commands in a session:**
- `/tools` — show the status of all three tool packs.
- `/browser on` / `/browser off` — enable or disable the web browser for the current session.
- `/aws on` / `/aws off` — enable or disable the AWS integration for the current session.

#### Kiro login

After installing kiro-cli under Settings › Tools, log in from the host:

```bash
docker compose exec portal kiro-cli login --use-device-flow
```

Open the URL shown, approve, and the session is saved on the data volume.

#### AWS credentials (named profiles and SSO)

To use AWS named profiles or host SSO credentials, start the stack with both compose files:

```bash
docker compose -f compose.yml -f compose.aws.yml up -d
```

`compose.aws.yml` mounts your host's `~/.aws` directory read-only into the container so the
portal can use profiles and ambient credentials. See the comments in `compose.aws.yml` for the
writable-mount variant needed when the portal initiates `aws sso login` itself.

See [docs/container-provider-checklist.md](docs/container-provider-checklist.md) for
step-by-step verification of every provider (Anthropic, Bedrock, CodeCommit, GitHub, Kiro).

#### Pre-flight check

```bash
docker compose run --rm portal node dist/preflight.mjs
```

Prints one line per dependency (`ok`, `missing`, or `optional-off`). Required items cause a
non-zero exit.

#### Backup

**Linux / macOS:**
```bash
docker run --rm \
  -v portal-data:/data:ro \
  -v "$(pwd)":/backup \
  busybox \
  tar -czf /backup/portal-backup-$(date +%F).tar.gz -C /data .
```

**Windows (PowerShell):**
```powershell
docker run --rm `
  -v portal-data:/data:ro `
  -v "${PWD}:/backup" `
  busybox `
  tar -czf /backup/portal-backup.tar.gz -C /data .
```

#### Upgrade

```bash
docker compose build --pull          # rebuild with latest base image
docker compose up -d                 # restart; data volume is untouched
```

Later changes to the database are applied automatically on start. The schema was rebuilt from a
clean baseline (one execution model: a single run is a session with one iteration), so a data
volume made by an earlier build is refused with a clear message instead of being upgraded: move
`portal.db` aside to start with an empty database.

#### Troubleshooting

**Port already in use:**
```
Error response from daemon: Ports are not available: exposing port TCP 127.0.0.1:8787
```
Another process is using 8787. Change the port in `.env` (`PORT=8788`) and in
`compose.yml` (`"127.0.0.1:8788:8787"`), then `docker compose up -d`.

**Memory limit:**
The portal container is capped at 3 GB in `compose.yml`. If agent runs are killed by
the OOM killer, raise the limit (`deploy.resources.limits.memory: 4g`).

**CRLF in `.env` on Windows:**
If you edit `.env` with Windows Notepad or some editors, it may save `\r\n` line endings.
Docker and Node handle this, but secret values with a trailing `\r` will fail validation.
Save `.env` with LF line endings (most editors have a setting for this), or run:
```
(Get-Content .env) | Set-Content -NoNewline .env
```

### On a server

Run it behind HTTPS (Caddy is the least work: `reverse_proxy 127.0.0.1:8787`), and set
`TRUST_PROXY=1` in `.env`. Do not expose port 8787 directly. On EC2, give the instance a
role with Bedrock invoke and CodeCommit access and choose "Server's own AWS identity" in
Settings, so no AWS keys are stored at all.
## How to test it (about 15 minutes, Demo mode)

1. **Project**: create “Refund service”. Under *Setup › Team & members*, add a colleague
   (create their account first in *Settings › Users*).
2. **Knowledge**: drop in an FSD and a TSD. Open a document, try the search box, then *Ask*
   something the documents answer and something they don’t. Send the second one to the team
   and answer it under *Team questions*. It appears in the *Decisions log*.
3. **Agents and skills** (*Setup › Agents & skills*): add the *Business analyst*, *QA engineer* and *Technical writer* roles.
   Open an agent, change its instructions, and press *Run test*.
   - **Import**: click *Import* on the Agents or Skills tab, choose a `.zip`, a folder from your
     computer, or (admins) a server path. Preview shows conflicts, invalid items and missing skills;
     choose Overwrite / Skip / Rename per item, then confirm.
   - **Describe**: click *Describe…* on the Agents or Skills tab, type a plain-language description
     and optionally toggle "Based on project documents", then review and save the AI-drafted form.
4. **Repositories** (*Setup › Repositories*): connect a GitHub, CodeCommit or other Git repository. Wait for *Ready*.
5. **Single run**: start “Design and build the refund approval flow” as a *Single run* (a session with
   one iteration) on that repository with *Ask before changes*. Answer the agent’s questions,
   approve the file write, click the subagents, open *Changes*, and *Push changes* to a new branch.
   Start the same task again: it uses the recorded decision and doesn’t ask.
   - **Tools**: the “Tools for this session” row lets you enable the web browser, AWS
     integration, or Kiro engine per run. Packs not yet installed show a hint to install
     them under *Settings › Tools*.
   - **Jira ticket selector**: if the project has Jira connected and mapped (under *Setup ›
     Jira*), the *Free task* composer shows an optional *Jira ticket* field. Search or
     type a key (e.g. `PAY-123`), select a ticket, and the agent receives its full details as
     context. The instruction becomes optional when a ticket is selected. Branch name, commit
     message and draft pull-request title all include the ticket key automatically.
   - **From a ticket**: on the *Tickets* page, open any ticket and click *Start coding run* to
     open the composer with that ticket pre-selected.
6. **Code review**: review a feature branch against `main` with *Deep look* on. Accept or
   dismiss findings. For a GitHub pull request, use *Post to GitHub*. To try the automatic review,
   add the built-in spec *Review new pull requests* (Sessions › Loop specs), then *Run now* with a
   pull request number; the result waits in the Inbox until you approve it.
7. **Learn** (*Knowledge › Learn*): write a *System overview*, switch between *For everyone* and *For engineers*,
   publish it, make a quiz from it, publish and take the quiz, then create an onboarding path.
   Re-upload a source document with a change and see the document flagged as out of date.
8. **Settings**: set a monthly budget; switch to a real provider and repeat step 5.

## Automated tests

```bash
npm test               # unit, end-to-end API, and real-SDK wiring tests (Demo mode, fake SDK)
npm run test:ui        # browser walkthrough of every page (needs: npx playwright install chromium)
npm run test:container # end-to-end container smoke test (needs Docker)
```

## Where things live

```
data/
  portal.db                 users, sessions, agent runs, events, search index, settings
  master.key                only if PORTAL_SECRET_KEY is not set
  claude-home/              Claude Code config and session transcripts for agent runs
  library/                  shared agents and skills
  projects/<slug>/          one git repository per project
    CLAUDE.md               generated from the project details; every agent reads it first
    .claude/agents/         role and custom agents
    .claude/skills/         skills (project-docs is built in)
    docs/md/                uploaded documents as Markdown
    docs/decisions.md       answers to agent questions
    docs/generated/         approved learning documents
    docs/diagrams/          architecture diagrams (Mermaid source, one file per diagram)
    repos/<name>/           reference clones (read-only for agents)
    work/<run id>/          each run's own folder or git worktree
```

Every change to agents, skills, documents and decisions is committed to the project’s git
repository, so you can see who changed what and restore older versions.

## Costs

The portal itself costs nothing to run beyond the machine. Model use is billed by Anthropic or
AWS per token. Defaults keep it low: Haiku for questions, quizzes, checks and first-pass
reviews; Sonnet for agent runs and documentation; Opus only when you pick it. Each run shows
its cost (or, in Demo mode, what it would cost), and *Settings › Budget* stops new runs at a
monthly cap.

## Security notes

- Passwords are hashed with scrypt; sessions are HttpOnly cookies; API calls require a
  same-origin header.
- API keys and tokens are encrypted with AES-256-GCM (or kept in AWS SSM Parameter Store) and
  never sent back to the browser.
- **AWS SSO**: the IAM Identity Center access token is stored encrypted in the portal database
  and never sent to the browser. The browser only receives a one-time user code. Temporary
  AWS_ACCESS_KEY_ID / SECRET / SESSION_TOKEN credentials are fetched per-request, cached in
  memory, and passed to agents the same way as other AWS auth methods.
- Agent runs get a cleaned environment (no portal secrets), may only write inside their own
  `work/<run id>/` folder, and need approval for edits and shell commands unless a run is
  started with *Auto-accept edits*. Commands still ask.
- Agents run as the portal’s operating-system user. For untrusted repositories, run the
  portal in its own container or VM (the Dockerfile does this).
