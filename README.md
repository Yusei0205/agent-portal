# Agent Portal

A self-hosted web portal for running Claude agents on your projects. Built on the official
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript).

- **Projects** keep their own documents, repositories, agents, skills, runs and members.
- **Knowledge**: upload FSD, TSD, specs and notes (Word, PDF, Excel, PowerPoint, Markdown, HTML).
  They are converted to Markdown, indexed, searchable, and answerable with cited sources.
- **Asking when unsure**: agents ask clarifying questions instead of guessing. Answers go to a
  decisions log that every agent reads first, so nobody is asked twice.
- **Agent runs**: a live tree of the main agent and its subagents, with every tool call,
  approvals for edits and commands, cost per agent, follow-ups, and push to a new branch.
- **Code review** of two branches or a GitHub pull request, with findings next to the changed
  lines, a cheap Haiku pass and an optional Sonnet deep look, and posting back to GitHub.
- **Agents and skills**: seven role templates (business analyst, solution architect, backend and
  frontend developer, QA engineer, reviewer, technical writer), your own agents and skills, a
  shared library, a one-click test run, **import from any `.claude` folder or zip**, and
  **draft a new agent or skill from a plain-language description**.
- **Learn**: documentation in a plain-language version and an engineering version, glossaries,
  FAQs, quizzes checked against their sources, onboarding paths and team progress.
- **Demo mode**: a simulated agent so every feature works without an API key.

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

1. **Project**: create “Refund service”. Under *Project and team*, add a colleague
   (create their account first in *Settings › Users*).
2. **Knowledge**: drop in an FSD and a TSD. Open a document, try the search box, then *Ask*
   something the documents answer and something they don’t. Send the second one to the team
   and answer it under *Open questions*. It appears in the *Decisions log*.
3. **Agents and skills**: add the *Business analyst*, *QA engineer* and *Technical writer* roles.
   Open an agent, change its instructions, and press *Run test*.
   - **Import**: click *Import* on the Agents or Skills tab, choose a `.zip`, a folder from your
     computer, or (admins) a server path. Preview shows conflicts, invalid items and missing skills;
     choose Overwrite / Skip / Rename per item, then confirm.
   - **Describe**: click *Describe…* on the Agents or Skills tab, type a plain-language description
     and optionally toggle "Based on project documents", then review and save the AI-drafted form.
4. **Repositories**: connect a GitHub, CodeCommit or other Git repository. Wait for *Ready*.
5. **Single run**: start “Design and build the refund approval flow” as a *Single run* (a session with
   one iteration) on that repository with *Ask before changes*. Answer the agent’s questions,
   approve the file write, click the subagents, open *Changes*, and *Push changes* to a new branch.
   Start the same task again: it uses the recorded decision and doesn’t ask.
   - **Tools**: the “Tools for this session” row lets you enable the web browser, AWS
     integration, or Kiro engine per run. Packs not yet installed show a hint to install
     them under *Settings › Tools*.
   - **Jira ticket selector**: if the project has Jira connected and mapped (under *Project and
     team › Jira*), the *Free task* composer shows an optional *Jira ticket* field. Search or
     type a key (e.g. `PAY-123`), select a ticket, and the agent receives its full details as
     context. The instruction becomes optional when a ticket is selected. Branch name, commit
     message and draft pull-request title all include the ticket key automatically.
   - **From a ticket**: on the *Tickets* page, open any ticket and click *Start coding run* to
     open the composer with that ticket pre-selected.
6. **Code review**: review a feature branch against `main` with *Deep look* on. Accept or
   dismiss findings. For a GitHub pull request, use *Post to GitHub*.
7. **Learn**: write a *System overview*, switch between *For everyone* and *For engineers*,
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
