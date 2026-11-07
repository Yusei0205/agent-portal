/**
 * Help page content: the in-portal user guide.
 *
 * Plain data so it can be searched in the browser and checked by tests (test/help-content.test.ts).
 * Text supports two inline marks: **bold** for UI labels and `code` for keys, paths and values.
 *
 * Topic shape:
 *   id        — URL slug (#/help/<id>), unique
 *   group     — one of HELP_GROUPS[].id
 *   title     — page or feature name, as the rail calls it
 *   icon      — a name from components/Icon.jsx
 *   page      — optional link to the feature: { tab, sub?, project? } (project: true needs a selected project)
 *   adminOnly — optional, shown with an "Admins" badge
 *   summary   — one or two sentences: what it is for
 *   sections  — [{ heading, items: [string] | rows: [[term, description]] , steps?: true }]
 *   tips      — optional short list of tips
 */

export const HELP_GROUPS = [
  { id: 'start',     label: 'Getting started' },
  { id: 'work',      label: 'Work' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'connect',   label: 'Connect & agents' },
  { id: 'portal',    label: 'Portal' },
  { id: 'reference', label: 'Reference' },
];

export const HELP_TOPICS = [
  {
    id: 'automations', group: 'work', title: 'Workflows', icon: 'workflow',
    page: { tab: 'automations', project: true },
    summary: 'Chain agent tasks, checks, branches and human approvals into a repeatable process, and run it on demand: from a Jira ticket to a reviewed pull request, or to test a ticket.',
    sections: [
      { heading: 'What a workflow is', items: [
        'A workflow is a map of **steps** joined by arrows: **Agent task** (an agent does the work from your instructions), **Condition** (Yes if the previous task and its checks passed, otherwise No), **Human approval** (the run waits for a person) and **End**.',
        'You build it once, **publish** it, and then **run** it as often as you like with a different request each time. Every run keeps the version it started with, even if you edit the workflow later.',
        'All the tasks of a run share one working copy of your repositories and one conversation, so a later step sees what an earlier one wrote (usually in an `artifacts/` folder).',
      ] },
      { heading: 'Before the first run', steps: true, items: [
        'Connect the repository the agent should work in (**Workspaces › Repositories**).',
        'Sign in for the engine the workflow uses (Codex, Claude Code or Kiro) under **Agent setup › Sign-ins**. A run uses the sign-in of the person who starts it.',
        'For Jira workflows, connect Jira for this project (**Connections › Tools & services**, or the **Tickets** page). The portal then reads the ticket, and its images and files up to 2 MB, itself. To let steps **write** to Jira (comments, test results), also add a Jira (Atlassian) integration with writes allowed under **Connections › Tools & services**. Jira is set up per project, so each project reads its own Jira.',
        'For workflows that deploy, give the project an AWS account (**Workspaces › AWS**) for the dev environment.',
      ] },
      { heading: 'Create a workflow', steps: true, items: [
        'Open **Workflows** in the left menu (pick a project first). The page lists the project\'s workflows; press **New workflow**.',
        'Choose a template card: **SDLC**, **Development (Jira ticket to reviewed PR)** or **Testing (verify a ticket)**. The canvas shows its steps; click a step to read its instructions. Nothing exists yet.',
        'Or choose **Describe it (generate with AI)**: write what you want in plain words (a few lines are enough, you do not need every detail) and press **Generate workflow**. The AI drafts the steps and adds the ones such a process usually needs (analysis, checks, review, an approval before anything risky). Under the draft, **What the AI assumed** lists what it decided on its own and **Please confirm** lists what you must check. Type what to change under **Change it** and press **Update the draft** as often as you like; nothing is saved until you create it, and you can edit every step afterwards.',
        'Give it a name (a free name is filled in for you; names cannot repeat in a project) and press **Create workflow**.',
        'In the editor, open **Settings** to choose the engine, the step and time limits and the repositories. Click a step on the canvas to change its name, agent, model, instructions and verification checks; **+ Agent task** and the other buttons add steps, and **Delete step** removes one. Drag to move steps and drag from one handle to another to connect them.',
        'Press **Save draft**, then **Publish version**. A workflow cannot run until it has a published version, and publishing checks that every step is connected from Start to End.',
      ] },
      { heading: 'Trigger a run', steps: true, items: [
        'Open the workflow and its **Runs** tab.',
        'Write the **run request** and press **Run published workflow**. For **Development** and **Testing**, write the Jira ticket key (for example `ABC-123`) or paste its link. For **SDLC**, describe what to build.',
        'Optional: open **Run options** to change things for this run only: the **agent** and **model** used by every agent step (otherwise each step uses its own), whether tool calls **ask first** or you **trust all tools** (no approval prompts; the agent then acts as you), and which **integrations** (MCP tools such as Jira) the agent gets. Leave them alone to follow the workflow.',
        'The run starts straight away and **continues when you close the page**. The button is off until the workflow is published and saved (a run always uses the published version), and on a deployment without durable execution you will see a notice saying so.',
        'From a script or another tool you can start a run too: `POST /api/projects/<project id>/automations/<workflow id>/runs` with `{"input": "ABC-123", "requestId": "<a new uuid>"}` and an API token that has write access (**API access**). Sending the same `requestId` again returns that run instead of starting a second one.',
        'Workflows are started by hand or by that call. They have no schedule, webhook or Jira-event trigger of their own; for those, use **Loop specs** (see Delegated sessions and loop specs).',
      ] },
      { heading: 'Follow a run', items: [
        'The **Runs** tab shows the run\'s status, the workflow drawn with each step\'s state, and a timeline with each task\'s summary. Pick an older run from **Run history**.',
        '**Open session, logs & artifacts** goes to the full session: live output, tool calls, files, and the pull request link when one was made.',
        'When a run reaches a **Human approval** step its status becomes **waiting**. Read the instructions shown, then press **Approve**. Only the person who started the run or a portal admin can approve. Tool calls inside the agent tasks still follow your normal portal permissions.',
        '**Cancel run** stops further steps and asks the active task to stop. Each agent task is limited to 12 minutes, and the workflow\'s own step, time and visit limits stop a loop that keeps going.',
      ] },
      { heading: 'The templates', rows: [
        ['SDLC', 'Input: what to build. Analyze, design, code, run tests (retry on failure), review, approve, open a pull request. Never merges or deploys.'],
        ['Development', 'Input: a Jira key. Read the ticket and attachments > design from the repository\'s patterns (reuse shared code) > code > **you approve** > deploy to dev without the pipeline > open a pull request > code review > fix review comments and repeat until approved > comment on the ticket with step-by-step QA test steps.'],
        ['Testing', 'Input: a Jira key. Read the ticket > test the fix > test edge scenarios (PASS, FAIL or NOT COVERED) > write the report > post it on the ticket, with failed or uncovered scenarios, screenshots and test files, and the frontend links to check by hand.'],
      ] },
      { heading: 'Manage workflows', items: [
        'The list shows each workflow\'s engine, steps, status (**Draft only** or **Published vN**), latest run and when it changed. **Open** edits it; **Delete** hides it (its versions and past runs are kept as history). A workflow with a run in progress cannot be deleted.',
        '**Version history** lists published versions; **Copy to draft** brings an old one back for editing. Leaving the editor with unsaved changes asks first.',
        'In instructions, `{{input}}` is the run request and `{{steps.design.output}}` is the summary of an earlier step (use the step\'s ID, shown in its settings). `{{jira.ticket}}` is the ticket named in the run request, read with the project\'s Jira connection.',
      ] },
    ],
    tips: [
      'Try a template with the **Demo** engine first to see how a run moves through the steps without using an agent.',
      'Change a template\'s instructions to match your team\'s process before the first real run: the deploy and pull request steps assume what your repository documents.',
    ],
  },
  // ── Getting started ─────────────────────────────────────────────────────────
  {
    id: 'getting-started',
    group: 'start',
    title: 'Getting started',
    icon: 'info',
    summary:
      'Agent Portal is a self-hosted place to run Claude Code and Kiro agents on your repositories, review their code, test your apps and keep the knowledge they need.',
    sections: [
      {
        heading: 'Your first ten minutes',
        steps: true,
        items: [
          'Sign in with the email and password your admin gave you, or follow your invite link.',
          'Open **Agent setup › Sign-ins** and add a Claude Code or Kiro sign-in, unless your admin has set up a portal AI provider for everyone.',
          'Pick or create a project with the project picker at the top of the rail.',
          'Add a repository under **Workspaces › Repositories** (the Git host must be connected under **Connections › Git connections**).',
          'Go to **Sessions**, press **Alt+N** and describe your goal. The agent starts working and you can follow it live.',
        ],
      },
      {
        heading: 'First-time setup (admins)',
        rows: [
          ['Deploy', 'Choose **Local PC / laptop** (SQLite) or **Server / cloud** (adds Security and Storage steps).'],
          ['Account', 'Create the first admin account.'],
          ['Provider', 'Pick the default AI engine: **Demo**, **Anthropic API**, **Amazon Bedrock** or **Kiro CLI**. Change it later in **Settings › Portal AI provider**.'],
          ['Security / Storage', 'Cloud only: AWS Secrets Manager for keys and S3 for files.'],
        ],
      },
      {
        heading: 'Projects',
        items: [
          'Everything an agent works on belongs to a project: its repositories, sessions, reviews, tests, tickets, knowledge and vault.',
          'Switch projects from the card at the top of the rail. The dialog has search, **All projects**, **New project** and **Project settings** (overview, team & members, permissions, pull requests).',
          'The rail remembers your last project, so project pages stay one click away while you browse portal pages.',
        ],
      },
    ],
  },
  {
    id: 'navigation',
    group: 'start',
    title: 'Finding your way around',
    icon: 'menu',
    summary: 'The rail on the left holds every page; the header holds search, notifications, theme and your account.',
    sections: [
      {
        heading: 'Rail sections',
        rows: [
          ['Dashboard', 'Portal-wide overview.'],
          ['Work', 'Sessions, Workflows, Workspaces, Reviews, Tests, Tickets (needs a project).'],
          ['Knowledge', 'Knowledge, Create, Vault (needs a project).'],
          ['Connect', 'Connections: Git hosts, tools & services.'],
          ['Agents', 'Agent setup: your Codex, Kiro and Claude Code sign-ins (with none, sessions fall back to the portal AI provider if the admin set one up) and your `.codex`, `.kiro` and `.claude` folders.'],
          ['Portal', 'Settings, Users (admins), API access, Feedback, Help.'],
        ],
      },
      {
        heading: 'Header',
        items: [
          '**Jump to…** (**Ctrl+K**) opens the command palette: type part of a page or action name.',
          'The **Inbox** icon shows how many items wait for you; the count refreshes every 30 seconds.',
          'The theme button cycles **Light**, **Dark** and **System**.',
          'Your initials open the account menu: your account page, colour themes, keyboard shortcuts (**?**) and **Sign out**.',
        ],
      },
      {
        heading: 'Rail size',
        items: [
          'Click **Collapse** for icon-only mode; every icon then has a tooltip.',
          'Drag the rail edge to resize it (200–320 px); double-click the edge to collapse or expand.',
          'On narrow screens the rail becomes a drawer opened with the **☰** button.',
        ],
      },
    ],
  },
  {
    id: 'dashboard',
    group: 'start',
    title: 'Dashboard',
    icon: 'layout-dashboard',
    page: { tab: 'dashboard' },
    summary: 'A portal-wide view of what your agents are doing and what they cost.',
    sections: [
      {
        heading: 'Panels',
        rows: [
          ['Active Session', 'The session running right now and its latest steps.'],
          ['Recent Sessions', 'The latest sessions across your projects; **View all** opens Projects.'],
          ['Agent Network', 'A graph of the agents that ran and how they delegated work to each other.'],
          ['Agent Performance', 'Runs, success rate, duration and usage per agent (dollars, or credits for Kiro) for the chosen period. Click a column to sort.'],
        ],
      },
    ],
    tips: ['Press **g d** from anywhere to come back to the Dashboard.'],
  },

  // ── Work ────────────────────────────────────────────────────────────────────
  {
    id: 'sessions',
    group: 'work',
    title: 'Sessions',
    icon: 'terminal',
    page: { tab: 'sessions', project: true },
    summary: 'A session is one agent working towards a goal in a project, in its own workspace with files, terminal, browser and Git.',
    sections: [
      {
        heading: 'Start a session (Alt+N)',
        rows: [
          ['Goal', 'Optional. Start with a goal or send your first message later. Settings can update or clear the goal for the next turn without changing the opening prompt.'],
          ['Engine', '**Demo** (simulated, free), **Claude Code** or **Kiro**. An engine without a sign-in shows **Not set up yet**.'],
          ['Workspace', 'A named workspace, or **Playground** to run without a Git checkout.'],
          ['Lead agent / Model', 'An agent from **Agent setup** and a model from your sign-in, or the engine defaults. **Runs as** shows which sign-in pays for it.'],
          ['Trust all tools', 'The agent may run commands and write files without asking you first.'],
          ['Max iterations', 'Hard limit on agent turns (1–100, default 10).'],
        ],
      },
      {
        heading: 'The session workspace',
        rows: [
          ['Conversation', 'Live agent output, tool calls and results. Send messages with **Ctrl+Enter**; `/` starts a slash command and `/clear` drops pending messages.'],
          ['Explorer (Ctrl+Shift+E)', 'Files of each repository, **Uploads**, and read-only **My vault** and **Team vault**. Click a file to edit; save with **Ctrl+S**.'],
          ['Source Control (Ctrl+Shift+G)', 'Diff of uncommitted changes; commit and push.'],
          ['Terminal (Ctrl+`)', 'A shell in the session workspace.'],
          ['Browser', 'Watch the browser the agent drives.'],
          ['Agents Activity', 'Sub-agents and delegated child sessions.'],
          ['Session', 'Activity timeline, attached context, and settings (goal, trust tools, max iterations).'],
          ['Status bar', 'Agent, model, tokens and usage for this turn and in total. Claude shows dollars; Kiro shows **credits**, because Kiro bills in credits.'],
        ],
      },
      {
        heading: 'Approvals, stopping and resuming',
        items: [
          'With **Trust all tools** off, an approval card appears when the agent wants to run a tool: **Approve**, **Approve all** or **Deny**. You can also answer from the **Inbox**.',
          'Click **Stop** in the session header to stop a running session.',
          'A session idle for the configured time (default 30 minutes) stops by itself. Send any message to resume it.',
          'Rename a session from its row in the list (pencil icon) or from the **⋯** menu.',
          'Out of Kiro credits, or want another provider? **⋯ › Switch engine…** moves the session to Claude Code (or back to Kiro). The conversation, repositories and files stay (in cloud sessions the old engine\'s machine saves its files first), and the next turn starts with a recap of earlier turns, including one that failed. Only the person who started the session can switch it, and not while a run is going.',
        ],
      },
      {
        heading: 'Pull requests from sessions',
        items: [
          'Sessions started from a Jira ticket open a pull request on their own when they finish and start a draft code review.',
          'Other sessions ask first: approve **Open a pull request for <repo>?** in the Inbox or on the session.',
          'Nothing is pushed if nothing changed, the portal never force-pushes, and protected branches (`main`, `master`, `develop`, `release/*` by default) are never pushed to. Change these in **Project settings › Pull requests**.',
          'Supported hosts: GitHub and AWS CodeCommit.',
        ],
      },
      {
        heading: 'Finding sessions',
        items: [
          'Press **/** to search the list; filter by **All**, **Running**, **Stopped** or **Failed**.',
          'Tick several rows to delete them together from the bulk action bar.',
        ],
      },
    ],
  },
  {
    id: 'delegation',
    group: 'work',
    title: 'Delegated sessions and loop specs',
    icon: 'agents',
    page: { tab: 'loop-specs', project: true },
    pageLabel: 'Open Loop specs',
    summary: 'Split work across child sessions, or save a goal with its checks so an agent can run it again and again.',
    sections: [
      {
        heading: 'Delegate a task',
        steps: true,
        items: [
          'In a session, open the **⋯** menu and choose **Delegate a task…**.',
          'Describe the **Task**, optionally give it a **Title** and pick a **Lead agent**.',
          'The child session runs with the same engine and workspace. When it ends, its result appears in the parent conversation.',
        ],
      },
      {
        heading: 'Limits',
        items: [
          'Admins set how many child sessions may run per parent and per user in **Settings › Sessions**. When a limit is reached the request fails with a message.',
        ],
      },
      {
        heading: 'Loop specs',
        items: [
          'A loop spec is a reusable loop session: the goal, the checks that decide when it is done, and what starts it — by hand, on a schedule, or from a webhook.',
          'Open it at `#/p/<project>/loop-specs`. A webhook spec shows its URL and secret once; copy them when shown.',
        ],
      },
    ],
  },
  {
    id: 'workspaces',
    group: 'work',
    title: 'Workspaces',
    icon: 'projects',
    page: { tab: 'workspaces', project: true },
    summary: 'What agents work on in this project: its repositories, named groups of them, and the AWS account they use.',
    sections: [
      {
        heading: 'Tabs',
        rows: [
          ['Workspaces', 'Group repositories into named workspaces. Pick one when you start a session to check them all out together.'],
          ['Repositories', 'Add the project\'s repositories from a connected Git host. A repository must be ready before sessions can use it.'],
          ['AWS', 'AWS accounts for the project. The account marked **agents use this** is given to every cloud session, so the `aws` CLI and SDKs work in the agent\'s shell.'],
        ],
      },
      {
        heading: 'Project settings',
        items: [
          'From the project picker choose **Project settings** for **Overview**, **Team & members**, **Permissions** and **Pull requests**.',
        ],
      },
    ],
  },
  {
    id: 'reviews',
    group: 'work',
    title: 'Reviews',
    icon: 'git-pull-request',
    page: { tab: 'reviews', sub: 'code', project: true },
    summary: 'AI code reviews of pull requests, full scans of whole branches, and review metrics.',
    sections: [
      {
        heading: 'Code reviews',
        steps: true,
        items: [
          'Click **New review** and pick the repository, **Base** and **Head** branches (or a PR number).',
          'Choose **Post mode**: **Draft** (you approve before anything is posted) or **Auto**, and the minimum severity.',
          'Open the review to see findings with severity, file and line. **Accept** or **Dismiss** each one.',
          'In Draft mode, post the accepted findings to the pull request when you are happy with them.',
        ],
      },
      {
        heading: 'More on reviews',
        items: [
          'The **merge gate** blocks a review when a finding at or above the admin\'s threshold is not dismissed.',
          '**Re-run** starts a fresh review of the same refs; the old one is kept.',
          'Download a report with the **Excel** and **Word** buttons on the review page.',
          'A Jira key is picked up from the branch name, e.g. `feature/PROJ-123-login`.',
        ],
      },
      {
        heading: 'Branch scans',
        steps: true,
        items: [
          'Click **New scan**, pick the repository and branch, and optionally include or exclude paths with glob patterns.',
          'Click **Estimate scan** to see files, tokens, cost and time.',
          'Set a **Token budget** and click **Confirm and start**. If it stops early, click **Resume scan**.',
        ],
      },
      {
        heading: 'Dashboard',
        items: [
          'Spend, number of reviews, pull requests and tokens for a chosen period. Toggle **Show all projects** for every project.',
          'Filters (search, who ran it, status, type, repository, dates) are kept in the URL, so you can share a filtered view.',
        ],
      },
    ],
    tips: ['Only admins and people on the full-scan allowlist can run branch scans. Pull request reviews are open to everyone.'],
  },
  {
    id: 'tests',
    group: 'work',
    title: 'Tests',
    icon: 'flask',
    page: { tab: 'tests', project: true },
    summary: 'AI-assisted end-to-end and API tests, grouped into test projects.',
    sections: [
      {
        heading: 'Tabs',
        rows: [
          ['Scripts', 'Test scripts in groups. Generate a script from a description, refine it with AI, or write it yourself.'],
          ['Test cases', 'Readable test cases. Import them from a spreadsheet.'],
          ['Runs', 'Run history with results, logs and screenshots for each step.'],
          ['Vault', 'Test data and files (logins, fixtures) that scripts refer to. Secret values are masked in results.'],
          ['Settings', 'The test project\'s name, **App URL**, optional **API base URL** and rules for the AI.'],
        ],
      },
      {
        heading: 'Running tests',
        items: [
          'Run one script or a whole group. Results update live and keep a screenshot of each step.',
        ],
      },
    ],
  },
  {
    id: 'tickets',
    group: 'work',
    title: 'Tickets',
    icon: 'ticket',
    page: { tab: 'tickets', project: true },
    summary: 'Jira tickets for this project; start an agent session from one.',
    sections: [
      {
        heading: 'How to use it',
        steps: true,
        items: [
          'Connect Jira once under **Connections › Tools & services** (API token or OAuth app).',
          'Browse, search and sort the project\'s tickets; open one to read it or jump to Jira.',
          'Click **Start session with this ticket**: the new session dialog opens with the ticket filled in.',
          'When that session changes code, it opens a pull request named after the ticket by itself.',
        ],
      },
    ],
  },

  // ── Knowledge ───────────────────────────────────────────────────────────────
  {
    id: 'knowledge',
    group: 'knowledge',
    title: 'Knowledge',
    icon: 'knowledge',
    page: { tab: 'knowledge', project: true },
    summary: 'Documents, decisions and learning material that agents in this project can draw on.',
    sections: [
      {
        heading: 'Tabs',
        rows: [
          ['Documents', 'Upload PDF, Word, Excel, PowerPoint, HTML, text, Markdown or CSV files.'],
          ['Search', 'Full-text search across documents, with matches highlighted.'],
          ['Ask', 'Ask a question in plain words and get an answer with sources. No answer? Send it to the team decisions list.'],
          ['Decisions', 'Answered team questions, kept as question and answer pairs.'],
          ['Learn', '**Overview** documents (feature guide, glossary, FAQ), **Quizzes** and **Onboarding** paths for new team members.'],
        ],
      },
    ],
  },
  {
    id: 'create',
    group: 'knowledge',
    title: 'Create',
    icon: 'sparkles',
    page: { tab: 'create', project: true },
    summary: 'Generate architecture diagrams, Word documents and slide decks from your repositories and knowledge.',
    sections: [
      {
        heading: 'Tabs',
        rows: [
          ['Diagrams', 'Architecture diagrams drawn by an agent from your repositories. View, edit, redraw and download.'],
          ['Documents', 'AI-generated Word documents from your repositories and knowledge.'],
          ['Decks', 'AI-generated PowerPoint decks from your project content.'],
        ],
      },
      {
        heading: 'Attachments',
        items: [
          'Attach up to 5 files (10 MB each) for extra context: drag and drop, browse, or paste an image.',
          'Allowed: PNG, JPG, WEBP, GIF, PDF, DOCX, XLSX, PPTX, MD, TXT, CSV, `.drawio`, `.mmd`, `.svg`.',
          'Click **Refresh** (↺) on an item to regenerate it; its earlier attachments are filled in for you.',
        ],
      },
    ],
  },
  {
    id: 'vault',
    group: 'knowledge',
    title: 'Vault',
    icon: 'archive',
    page: { tab: 'vault', project: true },
    summary: 'Files uploaded here are available to every agent run in this project.',
    sections: [
      {
        heading: 'Using the vault',
        items: [
          'Create folders, upload files, preview them, and download a file, a folder or everything as a ZIP.',
          'In a session the files appear read-only under **Team vault** in the Explorer; your personal files appear under **My vault**.',
          'Files produced by sessions and Create can be opened from the vault too.',
        ],
      },
    ],
  },

  // ── Connect & agents ────────────────────────────────────────────────────────
  {
    id: 'connections',
    group: 'connect',
    title: 'Connections',
    icon: 'plug',
    page: { tab: 'connect', sub: 'git' },
    summary: 'What the portal signs in to: Git hosts, the Kiro and Claude accounts that run agents, and the tools agents can use.',
    sections: [
      {
        heading: 'Tabs',
        rows: [
          ['Git connections', 'Saved Git credentials (GitHub, CodeCommit and others) shared across projects, used to clone and push repositories.'],
          ['Tools & services', 'Jira and Confluence, Google Workspace, and any MCP server the agent can use in a session.'],
        ],
      },
      {
        heading: 'How secrets are kept',
        items: [
          'Secrets are **write-only**: once saved, the portal shows only the last few characters and never sends them back to the browser.',
          'A secret is handed to a session only when the session starts.',
          'If you have more than one sign-in for an engine, mark one as default; the New session dialog lets you pick another.',
          'Kiro IAM Identity Center sign-ins expire: use **Refresh** or sign in again with the device code shown.',
        ],
      },
    ],
  },
  {
    id: 'agent-setup',
    group: 'connect',
    title: 'Agent setup',
    icon: 'file-cog',
    page: { tab: 'config' },
    summary: 'How your agents behave: your own `.kiro`, `.claude` and `.aws` folders, as the engines see them in every session you start.',
    sections: [
      {
        heading: 'Editing',
        items: [
          'Pick a folder tab, then a file in the files panel, and edit it. JSON files are checked before they are saved.',
          'Agents you define here appear under **Lead agent** in the New session dialog.',
          '**Agent pack** adds a ready-made team: **lead-orchestrator** (plans and hands tasks to the others), **backend-engineer** (Python, Java, Node.js / TypeScript), **frontend-engineer** (React, TypeScript, Tailwind), **infra-engineer** (AWS VPC, security groups, IaC, compute, databases, CI/CD), **security-reviewer** (code scanning, OWASP Top 10, AI and agent risks), **slide-designer** and **tech-writer** (technical docs, SOWs), each with its skills. Files you already have are kept. Admins can publish the result as the team default.',
          'Changes apply to sessions started or resumed afterwards.',
          'Import or export the whole folder as a ZIP.',
        ],
      },
      {
        heading: 'Team default vs your copy',
        items: [
          'Everyone starts from the team default. Once you edit, you have your own copy.',
          '**Reset to team default** throws your copy away.',
          'Admins can publish their copy as the new team default.',
        ],
      },
    ],
  },

  // ── Portal ──────────────────────────────────────────────────────────────────
  {
    id: 'inbox',
    group: 'portal',
    title: 'Inbox',
    icon: 'inbox',
    page: { tab: 'inbox' },
    summary: 'Approvals and notifications that are waiting for you, across all projects.',
    sections: [
      {
        heading: 'Groups',
        rows: [
          ['Approvals', 'Tool calls waiting for permission: Approve or Deny.'],
          ['Questions', 'Agent questions that need a written answer.'],
          ['Blocked sessions', 'Sessions that cannot continue.'],
          ['Pending pushes', 'Sessions asking to push their work and open a pull request.'],
          ['Review ready', 'Code reviews ready to post.'],
        ],
      },
    ],
    tips: ['Open it with the bell in the header or **g b**.'],
  },
  {
    id: 'account',
    group: 'portal',
    title: 'Your account',
    icon: 'user',
    page: { tab: 'account' },
    summary: 'Who you are signed in as, your password, and signing out other devices.',
    sections: [
      {
        heading: 'What you can do',
        items: [
          'See your name, email and role.',
          'Change your password. Your other browsers and devices are signed out when you do.',
          'Click **Sign out other devices** if you left yourself signed in somewhere.',
          'Forgot your password? Ask an admin for a reset link. Google-only accounts have no portal password.',
        ],
      },
    ],
  },
  {
    id: 'settings',
    group: 'portal',
    title: 'Settings',
    icon: 'settings',
    page: { tab: 'settings' },
    summary: 'Portal-wide policy: AI provider, tools, budget, review rules, session limits and appearance. Everyone can read it; only admins can save.',
    sections: [
      {
        heading: 'Tabs',
        rows: [
          ['Portal AI provider', 'The portal\'s own AI account, used by reviews, scans, Knowledge Ask and test generation, and as the fallback for sessions. **Test connection** before saving.'],
          ['Tools', 'Optional tool packs on the server (for example `uv`, the Kiro CLI, draw.io) with their status and an **Install** button.'],
          ['Budget', 'A monthly spending cap for the portal, in USD.'],
          ['Code review', 'Merge gate threshold, PR comment mode and the full-scan allowlist.'],
          ['Sessions', 'Idle timeout and delegated session limits.'],
          ['GitHub', 'The GitHub OAuth app used to connect GitHub accounts.'],
          ['Appearance', 'Colour themes and the template editor (admins).'],
        ],
      },
    ],
  },
  {
    id: 'users',
    group: 'portal',
    title: 'Users',
    icon: 'shield-user',
    page: { tab: 'users' },
    adminOnly: true,
    summary: 'Who can sign in, their roles, and portal-wide administration.',
    sections: [
      {
        heading: 'Tabs',
        rows: [
          ['Users', 'Create accounts, send invite and password reset links, change roles, disable accounts.'],
          ['Audit log', 'Every significant action: time, who, what, target and IP. Filter by person or action.'],
          ['API tokens', 'Every token in the portal; revoke any of them.'],
          ['Control plane', 'Running, queued and waiting sessions; **drain mode** to stop new sessions before maintenance; global, per-user and per-project session limits (`0` = no limit).'],
        ],
      },
    ],
  },
  {
    id: 'api-access',
    group: 'portal',
    title: 'API access and MCP',
    icon: 'code-2',
    page: { tab: 'api' },
    summary: 'Personal API tokens for automating the portal, and the MCP endpoint for Claude Code, Kiro and other MCP clients.',
    sections: [
      {
        heading: 'Create a token',
        steps: true,
        items: [
          'Click **New token**, give it a name, scopes, an expiry (30 days, 90 days or 1 year) and optionally one project.',
          'Copy the token straight away. **It is shown only once.**',
        ],
      },
      {
        heading: 'Scopes',
        rows: [
          ['Read', 'Always on: sessions, transcripts, reviews, test projects and runs.'],
          ['Write', 'Start, prompt, stop and delegate sessions; edit configuration.'],
          ['Review', 'Start reviews and branch scans, post PR comments.'],
          ['Merge', 'Merge pull requests.'],
          ['Tests', 'Start and cancel test runs, generate test scripts.'],
        ],
      },
      {
        heading: 'Using it',
        items: [
          'REST: call `<portal>/api/...` with `Authorization: Bearer <token>`; changes also need the header `x-requested-with: agent-portal`.',
          'MCP: copy the client snippet from the page and replace `<your-token>` with your token.',
          'Tokens act as you, up to 10 at a time, and can never manage credentials, users, tokens or settings.',
        ],
      },
    ],
  },
  {
    id: 'feedback',
    group: 'portal',
    title: 'Feedback',
    icon: 'send',
    page: { tab: 'feedback' },
    summary: 'Tell the portal admins what is broken, confusing or missing, and follow what happens to it.',
    sections: [
      {
        heading: 'Tabs',
        rows: [
          ['Send feedback', 'Choose a kind (**Something is broken**, **Idea**, **Question**, **Other**) and describe it. The page you came from is attached for you.'],
          ['Your feedback', 'Everything you sent and its status: New, Accepted, In progress, In review, Approved, Fixed or Declined.'],
          ['Inbox (admins)', 'Sort feedback, add a note and a pull request link, and hand an item to an agent session to fix.'],
        ],
      },
    ],
  },

  // ── Reference ───────────────────────────────────────────────────────────────
  {
    id: 'shortcuts',
    group: 'reference',
    title: 'Keyboard shortcuts',
    icon: 'slash',
    summary: 'Press **?** anywhere to see every shortcut. Go-to shortcuts are two keys: press **g**, then the letter.',
    sections: [
      {
        heading: 'Everywhere',
        rows: [
          ['Ctrl+K', 'Command palette'],
          ['?', 'Keyboard shortcuts'],
          ['Alt+N', 'New session'],
          ['/', 'Search the session list'],
        ],
      },
      {
        heading: 'Go to (portal)',
        rows: [
          ['g d', 'Dashboard'], ['g p', 'Projects'], ['g b', 'Inbox'], ['g n', 'Git connections'],
          ['g j', 'Tools & services'], ['g y', 'Agent sign-ins'], ['g x', 'Agent setup'],
          ['g e', 'API access'], ['g t', 'Settings'], ['g m', 'Users'],
        ],
      },
      {
        heading: 'Go to (project)',
        rows: [
          ['g s', 'Sessions'], ['g w', 'Workspaces'], ['g r', 'Reviews'], ['g h', 'Tests'],
          ['g k', 'Knowledge'], ['g c', 'Create'], ['g v', 'Vault'],
        ],
      },
      {
        heading: 'In a session',
        rows: [
          ['Ctrl+Enter', 'Send message'], ['Ctrl+S', 'Save file'],
          ['Ctrl+Shift+E', 'Explorer'], ['Ctrl+Shift+G', 'Source Control'], ['Ctrl+`', 'Terminal'],
        ],
      },
    ],
  },
  {
    id: 'troubleshooting',
    group: 'reference',
    title: 'Troubleshooting',
    icon: 'warning',
    summary: 'Common messages and what to do about them.',
    sections: [
      {
        heading: 'Problems and fixes',
        rows: [
          ['Engine "Not set up yet"', 'Add a sign-in under **Agent setup › Sign-ins**, or ask an admin to set the portal AI provider.'],
          ['Delegation limit reached', 'Wait for a child session to finish, or ask an admin to raise the limit in **Settings › Sessions**.'],
          ['Scan not allowed', 'Branch scans need an admin to add you to the full-scan allowlist. PR reviews still work.'],
          ['Browser not available for tests', 'The server has no browser for end-to-end tests; ask your admin.'],
          ['Token missing scope', 'Create a new token with the scope the call needs.'],
          ['Stale file on save', 'Someone (or the agent) changed the file; reload it, then save again.'],
          ['"No permission to push to <repo>"', 'The Git token or AWS account needs write access to the repository.'],
          ['"Could not reach the server"', 'Refresh the page. If it keeps happening, the portal server may be down.'],
        ],
      },
      {
        heading: 'Still stuck?',
        items: ['Send it through **Feedback**: admins see it and you can follow its status.'],
      },
    ],
  },
];

/** Strip the inline marks so text can be searched. */
export function plainText(s) {
  return String(s ?? '').replace(/\*\*|`/g, '');
}

/** All searchable text of a topic, lower-cased. */
export function topicText(topic) {
  const parts = [topic.title, topic.summary, ...(topic.tips || [])];
  for (const s of topic.sections || []) {
    parts.push(s.heading);
    for (const i of s.items || []) parts.push(i);
    for (const r of s.rows || []) parts.push(...r);
  }
  return plainText(parts.join(' ')).toLowerCase();
}

/**
 * Topics matching every word of the query (case-insensitive). Empty query → all topics.
 * @param {string} query
 * @param {typeof HELP_TOPICS} [topics]
 */
export function searchHelp(query, topics = HELP_TOPICS) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return topics;
  return topics.filter((t) => {
    const text = topicText(t);
    return words.every((w) => text.includes(w));
  });
}

/**
 * The hash link for a topic's page, or null.
 * @param {{ tab: string, sub?: string, project?: boolean }} page
 * @param {string} projectId — the selected project, '' when none
 */
export function pageHref(page, projectId) {
  if (!page) return null;
  const tail = [page.tab, page.sub].filter(Boolean).map(encodeURIComponent).join('/');
  if (page.project) return projectId ? `#/p/${encodeURIComponent(projectId)}/${tail}` : null;
  return `#/${tail}`;
}
