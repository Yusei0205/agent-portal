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
- **Feedback**: anyone signed in can send feedback and follow its status. Admins sort it in an
  inbox and can send an item to an agent that works on the portal's own code (see below).
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
`TRUST_PROXY=1`. Do not expose port 8787 directly. On EC2 or ECS, give the server a role with
the permissions in [`docs/aws-iam-policy.json`](docs/aws-iam-policy.json) and choose “Server’s
own AWS identity” in Settings, so no AWS keys are stored at all.

The policy lets the server call Claude models, list the models and inference profiles in the
account, and use CodeCommit. The list permissions (`bedrock:ListFoundationModels`,
`bedrock:ListInferenceProfiles`) only work with `"Resource": "*"`. Without them,
**Test connection** fails with `not authorized to perform: bedrock:ListFoundationModels`. To add
the policy to an existing role:

```bash
aws iam put-role-policy --role-name YOUR_ROLE_NAME --policy-name AgentPortalAccess --policy-document file://docs/aws-iam-policy.json
```

If the role is created by CloudFormation or CDK, add the same statements there instead, so the
next deploy keeps them. If you keep secrets in SSM Parameter Store, also allow
`ssm:GetParameter` and `ssm:PutParameter` on `arn:aws:ssm:*:*:parameter/agent-portal/*`.

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

## Generate a skill from company documentation

Under **Agents and skills › Skills**, choose **Generate from document**. Select a document
already uploaded to Knowledge, or upload a company coding guide, review process, or other
practice document. Generation uses the configured model provider and requires project editor
access. Documents must finish processing and contain at most 60,000 characters of extracted
text; upload a focused excerpt for longer guides.

Review the generated name, usage description, and Markdown instructions against the linked
source sections. Edit the draft, preview it, then choose **Approve and save skill**. Generation
does not activate a skill. Saving creates a new enabled skill in the project's existing skill
library, commits it to project history, and makes it selectable in an agent's Skills settings.
Existing skill names cannot be overwritten through this approval step.

Drafts are held in the current page; leaving or discarding removes them. The generation run
is recorded in run history. In Demo mode, the draft contains labeled source excerpts for
review; a real provider extracts the documented practices into instructions. Review remains
necessary because generated instructions may misinterpret or repeat content from the source.

## Improving the portal from user feedback

The portal can work on its own code, with an admin approving every change:

1. Create a project for the portal itself (for example "Agent Portal") and connect this
   repository under its **Repositories**. For GitHub, set a token (in *Settings* or on the
   repository) that can push, open and merge pull requests.
2. Users send feedback from **Feedback** in the left menu. The page they came from is filled in.
3. Admins open **Feedback › Inbox**, add a note for the agent if needed, and press
   **Start agent run**. The run always asks before changes, because the feedback text comes from
   users; the prompt quotes that text as a description of the problem, not as instructions.
4. When the agent finishes, the portal pushes its work to a `feedback/…` branch, opens a pull
   request (GitHub) and starts a code review. The feedback moves to **In review**.
5. The admin decides in the feedback's **Review the changes** panel:
   - **Approve and merge**: merges the pull request (squash). Other Git hosts are marked
     *Approved*, and you merge the branch yourself. Serious review findings, or a review that is
     still running, need an extra confirmation.
   - **Send back to the agent**: the same run continues with your comments and the open review
     findings, then the branch and pull request are updated and reviewed again.
   - **Reject changes**: closes the pull request and marks the feedback *Declined*.

The person who sent the feedback follows its status, and the pull request link, under
**Your feedback**.

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
