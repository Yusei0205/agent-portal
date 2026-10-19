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
  shared library, and a one-click test run.
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

```bash
docker build -t agent-portal .
docker run -d -p 8787:8787 -v portal-data:/data \
  -e PORTAL_SECRET_KEY=$(openssl rand -hex 32) agent-portal
```

Keep the same `PORTAL_SECRET_KEY` across restarts.

### On a server

Run it behind HTTPS (Caddy is the least work: `reverse_proxy 127.0.0.1:8787`), and set
`TRUST_PROXY=1`. Do not expose port 8787 directly. On EC2, give the instance a role with
Bedrock invoke and CodeCommit access and choose “Server’s own AWS identity” in Settings, so no
AWS keys are stored at all.

## How to test it (about 15 minutes, Demo mode)

1. **Project**: create “Refund service”. Under *Project and team*, add a colleague
   (create their account first in *Settings › Users*).
2. **Knowledge**: drop in an FSD and a TSD. Open a document, try the search box, then *Ask*
   something the documents answer and something they don’t. Send the second one to the team
   and answer it under *Open questions*. It appears in the *Decisions log*.
3. **Agents and skills**: add the *Business analyst*, *QA engineer* and *Technical writer* roles.
   Open an agent, change its instructions, and press *Run test*.
4. **Repositories**: connect a GitHub, CodeCommit or other Git repository. Wait for *Ready*.
5. **Agent runs**: start “Design and build the refund approval flow” on that repository with
   *Ask before changes*. Answer the agent’s questions, approve the file write, click the
   subagents in the tree, open *Files and changes*, and *Push changes* to a new branch.
   Start the same task again: it uses the recorded decision and doesn’t ask.
6. **Code review**: review a feature branch against `main` with *Deep look* on. Accept or
   dismiss findings. For a GitHub pull request, use *Post to GitHub*.
7. **Learn**: write a *System overview*, switch between *For everyone* and *For engineers*,
   publish it, make a quiz from it, publish and take the quiz, then create an onboarding path.
   Re-upload a source document with a change and see the document flagged as out of date.
8. **Settings**: set a monthly budget; switch to a real provider and repeat step 5.

## Automated tests

```bash
npm test          # unit, end-to-end API, and real-SDK wiring tests (Demo mode, fake SDK)
npm run test:ui   # browser walkthrough of every page (needs: npx playwright install chromium)
```

## Where things live

```
data/
  portal.db                 users, runs, events, search index, settings
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
