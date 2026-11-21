# Kyuubit — User Guide

Kyuubit ("Lucky agents. Nine lives.") is the name of this portal, with a pixel cat and a four-leaf clover as its logo. A custom template can show its own name and logo instead.

## Table of contents

1. [Getting started](#1-getting-started)
2. [Sessions](#2-sessions)
3. [Delegated sessions](#3-delegated-sessions)
4. [Workspaces, Connections, Integrations, Vault](#4-workspaces-connections-integrations-vault)
5. [Credentials](#5-credentials)
6. [Configuration](#6-configuration)
7. [Reviews](#7-reviews)
8. [Tests](#8-tests)
9. [API access and MCP](#9-api-access-and-mcp)
10. [Knowledge, Create, Insights, Inbox, Learn](#10-knowledge-create-insights-inbox-learn)
11. [Users](#11-users)
12. [Keyboard shortcuts](#12-keyboard-shortcuts)
13. [Troubleshooting](#13-troubleshooting)
14. [Auto-fix](#14-auto-fix)
15. [Pipelines](#15-pipelines)

---

## 1. Getting started

### First-time setup wizard

The setup wizard runs once, before any user signs in. It has up to six steps depending on your deployment type.

| Step | Description |
|------|-------------|
| **Deploy** | Choose **Local PC / laptop** (4-step wizard, SQLite database) or **Server / cloud** (6-step wizard, adds Security and Storage steps). |
| **Account** | Create the first admin account: name, email, and password. |
| **Provider** | Pick the default AI engine. Options: **Demo** (no API key, simulated runs), **Anthropic API** (API key), **Amazon Bedrock** (region and auth method), or **Kiro CLI** (requires the CLI to be installed first). |
| **Security** | (Cloud only) Configure AWS Secrets Manager for storing keys. |
| **Storage** | (Cloud only) Configure S3 for file storage. |
| **Confirm** | Review and submit. |

You can change the provider later under **Settings › Portal AI provider**.

### Signing in

Enter your email and password on the sign-in screen. If you do not have an account, ask your admin to create one or send you an invite link.

### Navigating the portal

The portal has three main areas.

**Rail (left side)**
The rail is the navigation sidebar. Some sections are always open; the ones marked "collapsible" show only their heading until you click it (a section also opens by itself when you are on one of its pages, and stays open afterwards):

| Section | Pages |
|---------|-------|
| *(top, no heading)* | Dashboard, Inbox (with unread count), Usage |
| **Work** | Sessions, Workflows, Workspaces, Reviews |
| **Project tools** (collapsible) | Tests, Tickets, Mail |
| **Knowledge** | Knowledge, Create, Vault |
| **Connect** (collapsible) | Connections |
| **Agents** (collapsible) | Agent setup |
| **Portal** (collapsible) | Settings, Users and AgentCore (admin only), API access, Feedback, Help |

Work, Project tools and Knowledge items need a project to be selected. Inbox is also available as the bell icon in the top bar.

**Project picker**
Below the brand mark is a compact card showing the current project name (or "Choose a project"). Clicking it opens a **Switch project** dialog with a search field, your project list, an **All projects** link, a **New project** link, and — when a project is selected — a **Project settings** link. Project settings opens the project overview, repositories, team, and permissions pages. Use **↑ / ↓** to navigate, **Enter** to select, **Esc** to close. The rail remembers the last chosen project so project items stay linked even when you browse global pages (Credentials, Settings…).

**Collapse and resize**
Click **Collapse** at the bottom of the rail to switch to icon-only mode (56 px). Drag the resize handle on the rail's right edge to set the expanded width (200–320 px); double-click it to toggle collapse. Both settings persist across sessions. Keyboard on the focused resize handle: **← →** resize by 8 px, **Home / End** jump to minimum or maximum.

When the rail is **collapsed** to icon-only mode:
- Every icon has a tooltip that appears on hover or keyboard focus.
- Section headings become thin dividers and every page is shown (nothing is collapsed).
- The project picker becomes an avatar button showing the project's initials.

**Mobile**
On screens narrower than 768 px the rail becomes an off-canvas drawer, opened with the **☰ Menu** button in the top bar. Press **Esc**, click the backdrop, or navigate to a page to close the drawer.

**Header (top)**
The header shows a breadcrumb for the current page. On the right:
- **Jump to…** (Ctrl+K) opens the command palette. Type any part of a page name or action name to filter.
- An **Inbox** icon links to your notifications. A numeric badge shows the unread count and updates every 30 seconds.
- A theme toggle button cycles through **Light**, **Dark**, and **System**.
- Your initials open the **account menu**, which shows your name and email, colour theme controls, a shortcut to the keyboard shortcuts sheet (**?**), and **Sign out**.

### The cat companion

A small pixel cat (a calico: white with orange and brown patches, a gold collar and a small green four-leaf clover charm) lives at the bottom of the screen. It is a helper, never a requirement: nothing in the portal depends on it.

- **Roaming.** On screens wider than 600 px the cat sits for a few seconds, walks a short way along the bottom, and repeats. It stops where it is while you type in a field or while a dialog is open, and it does not move at all if your system asks for reduced motion. On phones it stays in the corner.
- **Hover and click.** Pointing at the cat makes it wave and shows a "Chat with Agent" label. Clicking the cat opens a small shortcut panel (see below). A tip bubble pops up by itself shortly after the page loads on wide screens; **×** closes it, and **Esc** closes any bubble, menu or the panel. To see another tip, right-click (or press and hold) the cat and choose **Show a tip**.
- **Shortcut panel.** The cat greets you and offers buttons for what exists on the current page: **Start a session**, **What needs me?** (the Inbox), **Auto-fix**, **Pipelines** and **Search knowledge** inside a project, and the Inbox and your projects elsewhere. You can also type a page or action, such as "inbox", "settings" or "auto-fix", and press Enter to go there. Anything else you type, three characters or more, is a question for the assistant (see below). The panel does not block the page behind it: **Esc** or **×** closes it and puts the keyboard focus back on the cat. On a phone it is a sheet across the bottom of the screen. The **Allow cat to roam** box switches between Roam and Sit.
- **Asking the cat.** Ask a question such as "why did my last session fail" or "how do I connect GitHub" and the cat answers in the panel, with link buttons to the right pages (for example **Inbox** or **Pipelines**). It answers from this guide, what the portal knows about the open project (its knowledge and the project notes its owners approved in project memory), and a live summary of that project (sessions, pipelines, items that need you). It uses your own Agent sign-in, so connect one under Agent sign-ins first; without one the cat tells you so and shows an **Agent sign-ins** button. It is read-only: it can explain and point, never start, change or delete anything. Replies are plain text. You can send up to 8 questions a minute and 100 a day; past that the cat asks you to wait. Nothing is stored on the server: the conversation is kept in this browser, one per project (and one for pages outside a project), so it is still there after you close the panel or reload; a conversation you have not opened for 14 days is dropped. The bin button at the top of the panel (**Clear chat**) empties the current project's conversation. Another browser or device starts with an empty one. Short page or action names (up to three words, such as "inbox" or "new session") still just take you there, without asking the assistant. Longer or question-like text, such as "why did my last session fail", goes to the assistant.
- **Working.** While a session in the open project is running, the cat sits at a tiny laptop and types, and it stays where it is. It follows the live updates the page receives, so a session that was already running before you opened the page shows up once it next changes.
- **Drag.** Drag the cat anywhere on the screen. It remembers the spot in this browser and stays inside the window when you resize it.
- **Reactions.** For the project you have open, the cat reacts when a session finishes (it hops), fails (it looks worried) or is blocked, and when something new needs you in the Inbox (it looks alert). The bubble has an **Open** link to the session or the Inbox and closes by itself after 8 seconds. It reacts at most once every 20 seconds and not while the browser tab is in the background.
- **Mode.** Click **⋯** on a bubble, or right-click (or press and hold) the cat, to choose **Roam**, **Sit** or **Hidden**. Hidden leaves a small paw button in the bottom-right corner that brings the cat back. The choice is stored in this browser only.

### Projects and switching projects

The **Projects** page lists all projects you have access to. Switch projects at any time using the project picker in the rail, or press **g p** to go to the Projects page.

---

## 2. Sessions

### New session dialog (Alt+N)

Click **New session** in the sessions list header or press **Alt+N** to open the dialog.

| Field | Description |
|-------|-------------|
| **Goal** | Describe the outcome you want. Required. Maximum 8000 characters. |
| **Engine** | **Demo** (no cost, simulated), **Claude Code** (Anthropic Claude via Claude Code SDK), or **Kiro** (Kiro CLI). An engine is greyed out with a "Not set up yet" link if you have no credential for it and the portal provider does not cover it. |
| **Workspace** | Select a named workspace or **Playground (no workspace)**. Playground sessions run without a git checkout. Appears when at least one workspace or ready repository exists for the project. |
| **Lead agent** | Choose a named agent from your configuration, or leave as **Engine default**. Not shown for Demo. |
| **Model** | Choose a model returned by the portal for the selected engine and credential, or leave as **Engine default**. Shown for both Kiro and Claude Code. The model list comes from your credential (sign-in); for subscription tokens, the list is fixed. While models are loading, a spinner appears. If the engine returns an error, the error is shown as a hint with a **Refresh** button; **Engine default** remains selectable. A **Runs as: {label}** line below the dropdown shows which sign-in the session will use (your credential, or the portal AI provider). |
| **Credential** | Shown only when you have more than one credential for the selected engine. |
| **Trust all tools** | When checked, the agent may run shell commands and write files without asking first. Hidden for Demo. |
| **Max iterations** | Hard limit on agent iterations. Range 1–100. Default 10. |

Click **Start session**. The portal creates the session and navigates to it.

### Session list

The session list (left panel of the Sessions page) shows all sessions for the current project.

- Sessions are grouped by **Active** (running or pending), then by day (**Today**, **Yesterday**, dated groups).
- Use the search box or press **/** to focus it. Filter by **All**, **Running**, **Stopped**, or **Failed** status. An engine filter appears when both Kiro and Claude sessions exist.
- Hover over a session row to reveal a rename button.
- Select multiple sessions with the checkboxes that appear on hover, then use the bulk action bar to delete them.

### Session workspace

Clicking a session opens the IDE-style workspace. It has the following areas.

**Header**
Shows the session title, an engine badge, a **Stop** button (when the session is running), and a **⋯** menu with **Rename session** and **Delegate a task…** options.

**Activity bar**
A vertical bar of icon buttons on the left edge. Each button toggles a sidebar panel:

| Button | Panel |
|--------|-------|
| Explorer (Ctrl+Shift+E) | File tree |
| Source Control (Ctrl+Shift+G) | Git diff and commit |
| Browser | In-session browser view |
| Agents Activity | Sub-agents and child sessions |
| Session | Activity log, context items, settings |
| Terminal (Ctrl+`) | Integrated terminal |

**Explorer panel**
Shows root sections for each repo in the session's workspace, an **Uploads** section (drag-and-drop or upload button), **My vault** (read-only, your personal vault files), and **Team vault** (read-only, project and portal vault files). You can create files and folders, rename and delete items in the workspace sections. You can download any section as a zip.

**Editor panel**
Click any file in the Explorer to open it in the editor. Save with **Ctrl+S**.

If you try to save a file that another user or the agent has changed since you opened it, you will see a stale-file conflict notice. You must reload the file before saving.

**Agent conversation panel**
Shows the live output stream: agent text, tool calls (expandable), tool results, and completion events. A running cost pill appears in the corner when cost data is available.

Scroll up to read earlier output. If there are more turns than the initial page, a **↑ Load earlier turns** button appears at the top.

Use the composer bar at the bottom to send messages. Press **Ctrl+Enter** to send. Any message starting with `/` is treated as a command and forwarded to the engine on the next turn. `/clear` is handled by the portal itself — it drops any pending messages so the next turn starts fresh.

**Source Control panel**
Shows a diff of uncommitted changes in the session workspace. Use this to commit and push.

**Agents Activity panel**
Lists sub-agents and delegated child sessions. Each entry shows a status dot, name, source (delegated or internal), and a link to open the child session.

**Session panel**
Three tabs: **Activity** (timeline of session events), **Context** (attached context items), **Settings** (edit the goal, trust-tools toggle, and max iterations for the session — takes effect on the next iteration).

**Status bar**
Shows the current agent, model, token counts for this turn and session total, cost for this turn and total, and the tool approval mode (Trust all tools or Ask before tool use).

### Conversation features

**Messages**: Type in the composer and press Ctrl+Enter. When the session is idle-stopped, sending a message resumes it.

**Slash commands**: Any message starting with `/` is treated as a command and forwarded to the engine. `/clear` is handled by the portal and drops pending messages so the next turn starts fresh. The hint appears when you start typing `/`.

**Load earlier turns**: Use the **↑ Load earlier turns** button at the top of the conversation panel to page back through previous turns.

**Approvals**: When the agent needs permission to run a tool and trust-tools is off, an approval card appears in the conversation. Click **Approve**, **Approve all** (approves this and all similar requests for the rest of the run), or **Deny**. You can also handle approvals from the **Inbox** page without opening the session.

### Rename

Hover over a session row in the list and click the pencil icon, or use the **⋯** menu in the workspace header and select **Rename session**.

### Stop

Click the **Stop** button in the workspace header while the session is running.

### Pull requests from sessions

When a session changes code in a project repository, the portal can push the work to a new branch, open a pull request and start a code review of it.

- **Sessions linked to a Jira ticket** open the pull request by themselves when a run ends. The branch is `portal/<TICKET>-<short-title>`, the title is `<TICKET>: <ticket summary>`, and a draft review starts with the branch, PR number and Jira key already filled in. Nothing is posted to the pull request until you approve the review.
- **Sessions without a ticket** ask first. An item "Open a pull request for <repo>?" appears in the Inbox and on the session; nothing is pushed until you approve it.
- **No changes, no pull request.** A session that did not change the repository pushes nothing.
- The **Pull request** card on the session shows each step (asked, pushed, opened, review started) with links. If a step fails, or you declined or the question expired, the card has a **Create pull request** or **Try again** button.
- Supported: **GitHub** and **AWS CodeCommit**. On other hosts the branch is pushed and the card says no pull request was opened.
- The token or AWS account behind the repository needs write access: a GitHub token with repository write access, or CodeCommit `GitPush` and `CreatePullRequest`. Without it the card says "No permission to push to <repo>".

**Settings** (project **Setup › Pull requests**, editors only): the switch *Open a pull request when a session fixes code* (on by default), and the list *Branches that are never pushed to* (default `main`, `master`, `develop`, `release/*`; the repository's default branch is always protected too). The portal never pushes to a listed branch and never force-pushes.

**New code review** lists the repository's branches in the Base and Head fields (from the host, refreshed on request). You can still type a branch or ref that is not listed.

### Idle stop and resuming

A session that has had no activity for the portal-configured idle timeout (default 30 minutes) is automatically stopped. A banner appears in the composer bar: "Session stopped — idle for N minutes. Send a message to resume." Send any message to resume it. You can also dismiss the banner without sending a message.

---

## 3. Delegated sessions

From the **⋯** menu in a session header, choose **Delegate a task…**. This opens a dialog.

| Field | Description |
|-------|-------------|
| **Task** | Describe what the child session should accomplish. Required. |
| **Title** | Short name for the child session. Optional. |
| **Lead agent** | Choose a named agent from your config, or inherit from the parent session. Shown when agents are available. |

The dialog shows the current delegation limits (max running child sessions per parent, max per user) set by the admin. If delegation is disabled by the admin, the dialog shows an error and the **Delegate task** button is disabled.

The child session runs with the same engine and workspace as the parent. When it finishes, a **child-result** event appears in the parent session's conversation, showing the child's title, final status, and summary. Open the child session by clicking **Open session** in the Agents Activity panel.

A parent session that has used all of its allowed iterations is not resumed by child results arriving after that point.

**Limits**: The admin controls the maximum number of concurrently running child sessions per parent and per user. If a limit is reached, the delegate request fails with an error message.

---

## 4. Workspaces, Connections, Integrations, Vault

### Project setup (Repositories, Team, Permissions)

Open **Project settings** from the project picker or navigate to `#/p/:id/setup`. The setup page has four tabs: **Overview**, **Repositories**, **Team & members**, and **Permissions**.

#### Repositories tab

The Repositories tab lists every git repository attached to the project and lets you add more.

**Adding repositories — Browse connection**

Click **Add repositories** to open the dialog. The **Browse connection** tab lets you select repos from an existing Git connection:

1. **Choose a connection** from the dropdown. If no connections are configured, follow the link to **Connections → Git**.
2. **Search** the repo list with the search box (debounced — waits 350 ms after you stop typing).
3. For **Bitbucket** connections a **workspace filter** dropdown appears when multiple workspaces are available.
4. **Select repositories** using the checkboxes. Repos already in the project show an **Added** badge and cannot be selected again. Use **Select all** to check every available repo on the current page.
5. Click **Add N repositories** to add the selection. The portal calls the bulk endpoint and shows a summary: how many were added, skipped (already present), and any errors.

After adding, the repo list in the dialog updates so newly added repos show the **Added** badge.

**Adding repositories — Add by URL**

Switch to the **Add by URL** tab to add a single repository by its HTTPS URL. Provide a display name, the full URL, and the provider type, then click **Add repository**.

**Repository status badges**

| Badge | Meaning |
|-------|---------|
| `new` | Added, not yet cloned |
| `cloning` | Clone or sync in progress |
| `ready` | Cloned and available for sessions |
| `error` | Last clone or sync failed — hover the card for the error message |

Click **Sync** on any repo to trigger a fresh clone/pull. Click **Branches** to expand the list of remote branches.

### Repositories

**Repositories** (rail › Work › Workspaces › **Repositories** tab, project-scoped; `#/p/:id/workspaces/repositories`) is where you add, sync, or remove git repositories for the current project. The old address `#/p/:id/setup/repositories` still opens it.

When a project has no repositories:
- The **Workspaces** page shows a note with a direct link to add repositories.
- The **New session** dialog shows a note with a direct link to add repositories.
- Workspace creation still works (you can create workspaces before adding repos) but the repo picker in the workspace modal shows a hint until repos are available.

You can also reach the Repositories tab by clicking **Project settings** in the project picker and choosing the **Repositories** tab.

### Workspaces

**Workspaces** (under a project) are named groups of repositories. When you start a session, you can pick a workspace to give the agent access to one or more repos. Create, edit, and delete workspaces from the **Workspaces** page. Each workspace lists how many repos it includes and when it was created.

### Connections

**Connections** (`#/connections`) is a portal-scoped page with two tabs.

| Tab | URL | Description |
|-----|-----|-------------|
| **Git** | `#/connections/git` | Saved Git credentials for GitHub, AWS CodeCommit, Bitbucket Cloud, and generic Git hosts. Available to all projects. |
| **AWS accounts** | `#/connections/aws` | Manage the AWS accounts of the currently selected project. The page shows which project is selected and lists its accounts. If no project is selected, use the project picker in the rail to choose one first. |

Old URLs redirect automatically: `#/aws` → `#/connections/aws`; `#/connections` (bare) → `#/connections/git`.

#### Git connections

Each row shows the provider, scope (personal or shared), the account the connection is signed in as (populated after clicking **Test**), and the creation date.

Click **New connection** to open the two-step dialog.

**Step 1 — Choose provider:** Pick from the provider cards.

| Provider | Authentication options |
|----------|----------------------|
| **GitHub** | **Sign in with GitHub** (OAuth device flow — requires a GitHub OAuth App configured in Settings → GitHub) or **Personal access token** (classic token with `repo` and `read:user` scopes). |
| **AWS CodeCommit** | Region + credential source: **Portal AWS account** (references an account from the AWS accounts tab), **Access key ID + secret**, or **Portal AWS SSO identity** (uses the portal's Bedrock SSO session). |
| **Bitbucket Cloud** | Atlassian email + API token (create at `id.atlassian.com → Security → API tokens`). App passwords are not supported. Optional workspace filter. |
| **Other Git** | Token (preferred) or username + password for any HTTPS git host. |

**Scope** — Personal connections are only visible to you. Shared connections (admin-only) are available to all portal users.

**Test** — Click **Test** on any row to verify credentials. On success, the **Account** column updates with the login name or email returned by the provider.

**Edit** — Opens the credential update dialog for the same provider.

**Delete** — A confirmation prompt appears inline. Confirm with **Yes, delete** or dismiss with **Cancel**.

#### GitHub OAuth App (Settings → GitHub)

To enable the GitHub device-code flow, an admin must configure a GitHub OAuth App:

1. Create an OAuth App at **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Enable **Device Flow** in the app's settings.
3. Copy the **Client ID** (not the secret) and paste it into **Settings → GitHub → GitHub OAuth App Client ID**.

Once configured, the **Sign in with GitHub** option becomes available in the New Connection dialog. A device-code box appears with a URL and a one-time code — open the link, enter the code, and the portal creates the connection automatically.

### Integrations

**Integrations** (rail › Connect › Connections › **Tools & services** tab, `#/connect/tools`) shows the current project's integrations, or the portal-wide list when no project is selected. The old `#/integrations` address still opens it.

- **HTTP integrations**: an MCP server reachable at a URL (`https://...`).
- **Stdio integrations**: an MCP server launched by command (e.g. `npx my-mcp-server`).

Notes for specific integration types: AWS integration is configured via **Connections › AWS accounts**. Browser integration requires the Browser MCP tool pack. draw.io integration requires the Icon diagrams tool pack installed under **Settings › Tools**. The Integrations page mentions `/aws on` and `/browser on`; the portal does not act on these commands, so a session receives them as ordinary text.

### Vault

**Vault** (under a project) holds files that are available to every agent run in the project. Three tabs:

| Tab | Scope |
|-----|-------|
| **Project** | Shared across all sessions in this project. |
| **Personal** | Only your own sessions. |
| **Portal-wide** | All sessions in the portal. |

Upload files from the **Upload file** button. Download individual files or all files as a ZIP. Delete files with the trash button.

---

## 5. Credentials

**Agent sign-ins** (rail › Agents › Agent setup, `#/config/sign-ins`; formerly Credentials, and the old `#/credentials` address still opens it) stores your own sign-ins for Kiro and Claude Code. Your sessions use these first; without one they fall back to the portal AI provider (configured in **Settings › Portal AI provider**). Secrets are write-only: after saving, only the last four characters are shown.

### Kiro credentials

| Mode | Description |
|------|-------------|
| **API key** | Your Kiro API key from kiro.dev. |
| **IAM Identity Center** | Sign in with your AWS SSO portal. Provide the Start URL and select the AWS region from the dropdown. A device-code challenge opens — visit the URL shown, enter the code, and wait for the portal to confirm. |

### Refreshing and re-signing in to Kiro IAM Identity Center

Kiro IAM Identity Center tokens expire periodically. The portal stores a refresh token and renews the access token automatically before starting sessions when it can, so you usually do not need to act. When automatic renewal is possible, a **Refresh** button appears on the credential card.

| Action | When it appears | What it does |
|--------|-----------------|--------------|
| **Refresh** | When `canRefresh` is true (a valid refresh token is stored) | Silently renews the access token. Shows a toast on success. On failure, highlights **Sign in again**. |
| **Sign in again** | Always, for IAM Identity Center credentials | Starts a new device-code sign-in flow. The credential keeps its name, id, and default flag — no need to remove and re-add it. Displays the same code box used when the credential was first created. |

**Status labels on the card:**

| Label | Meaning |
|-------|---------|
| Expires in _Xh_ / _Xm_ | Token is valid; time remaining shown |
| Expiring soon | Token expires within 5 minutes |
| Token expired | Token has expired; use **Refresh** or **Sign in again** |
| Sign-in needed | Stored tokens cannot be used; **Sign in again** is required (shown with primary button styling) |
| Waiting for sign-in | A device-code sign-in flow is in progress |

The portal attempts to auto-renew Kiro IAM Identity Center sign-ins before each session and before listing models when a refresh token is stored. If auto-renewal fails, the session does not start and asks you to click **Sign in again**; it never silently switches to another account.

### Claude Code credentials

| Mode | Description |
|------|-------------|
| **API key** | Your Anthropic API key. |
| **Subscription token** | A token from running `claude setup-token` in the Claude Code CLI. |
| **Amazon Bedrock (role)** | Assumes an IAM role. Provide the role ARN, Bedrock region, and optionally an external ID. No secret is stored. |

### Default vs named credentials

You can have multiple credentials for the same engine. Mark one as **Default** with the **Set default** button. When you start a session, the default is pre-selected. The credential picker appears in the New Session dialog only when you have more than one credential for the selected engine.

### What "write-only" means

After saving a credential, the full secret is not retrievable through the portal. Only the last four characters of the secret are displayed for verification. To replace a secret, add a new credential or remove and re-add the existing one.

### Fallback to the portal provider

If you start a session with an engine but have no matching credential, the portal falls back to the server-wide provider configured in **Settings › Portal AI provider**. The portal AI provider is the portal's own AI account, used by code reviews, branch scans, Knowledge Ask and test generation. If the portal provider does not cover that engine either, the engine card is shown as unavailable in the New Session dialog.

---

## 6. Configuration

**Configuration** (rail › Agents › Agent setup) lets you manage your personal `~/.kiro`, `~/.claude`, and `~/.aws` folders — exactly as the engines and their tools see them in every session you start. Changes apply to sessions started or resumed afterwards. Sign-ins belong in **Agent sign-ins**, not here.

The page header shows **Import Zip** and **Export Zip** buttons on the right for the currently active folder.

### Three tabs

| Tab | Folder | Contents |
|-----|--------|----------|
| **Kiro (~/.kiro)** | `~/.kiro` | Agents, skills, steering files, hooks, and settings (including `settings/mcp.json` for MCP servers). |
| **Claude Code (~/.claude)** | `~/.claude` | `CLAUDE.md`, `settings.json`, agents, skills, commands, and hooks that Claude Code loads. |
| **AWS (~/.aws)** | `~/.aws` | AWS `config` and `credentials` files used by engines and tools that need AWS access. |

A one-line description of the selected tab appears next to the tabs.

The `~/.aws` tab carries a warning: keys stored here are plaintext in zip exports — handle with care. For engine sign-ins, **Agent sign-ins** or the project's **Workspaces › AWS** tab is the safer place.

### Files panel and editor

Each tab shows a two-pane layout:

- **Left — Files panel**: a file tree rooted at the folder (e.g. `.kiro`), with **New File** and **New Folder** buttons at the top. Click a file to open it in the editor.
- **Right — Editor**: displays the selected file with syntax highlighting. JSON files are validated as you type. An unsaved-changes indicator (orange dot) appears next to the filename when there are pending edits. Press **Ctrl+S** or click **Save** to save. The editor empty state shows a **New File** shortcut.

### Starter file structure

When a `~/.kiro` or `~/.claude` folder is empty, a **Add starter files** button appears in the Files panel. Clicking it creates a ready-to-use folder layout with example agents, skills, steering or commands, hooks, and settings files. You can edit or delete any of the created files afterwards.

**Kiro starter layout:**
- `agents/example-agent.json` — example agent (name, description, prompt, tools, allowedTools)
- `skills/README.md` — skills folder
- `steering/project.md` — always-on context file loaded at session start
- `hooks/README.md` — hooks folder
- `settings/mcp.json` — MCP server registry (starts empty: `{"mcpServers":{}}`)

**Claude Code starter layout:**
- `CLAUDE.md` — project-level instructions loaded at session start
- `settings.json` — Claude Code settings
- `agents/example-subagent.md` — example subagent (YAML front matter: name, description, tools; then system prompt)
- `skills/example/SKILL.md` — example skill (YAML front matter: name, description)
- `commands/README.md` — custom slash commands folder
- `hooks/README.md` — hooks folder

### Team default vs your own copy

When an admin has published a team default, a **Team default** card appears above the file tree. The badge shows either **Following team default** (your files match the published version) or **Your own configuration** (you have made local changes).

While following the team default, files are read-only in the editor. Any file you edit automatically forks you off the team default and switches the badge to **Your own configuration**.

The card shows the current team version ID and how long ago it was published.

### Reset to team default

Click **Reset to Team Default** in the Team default card to discard your changes and return to the published team version. A confirmation dialog appears first.

### Agent picker in New Session dialog

The **Lead agent** dropdown in the New Session dialog reads agents from your configuration:

- **Kiro**: `~/.kiro/agents/*.json` files (uses the `name` and `description` fields).
- **Claude Code**: `~/.claude/agents/*.md` files (uses the first `#` heading as the name).

After adding starter agents, they appear in the picker immediately on the next dialog open.

### What reaches sessions

Every session receives a copy of your entire `~/.kiro`, `~/.claude`, and `~/.aws` folders (or the team default versions if you are following them). This includes agents, skills, steering files, hooks, commands, and settings — the full folder tree is materialised into the session's home directory before the engine starts.

### JSON validation

The editor validates `.json` and `.jsonc` files as you type and shows inline errors in the footer. If you try to save a file with invalid JSON, you are offered a **Save anyway** option.

### Import and export zip

Use **Import Zip** to upload a zip archive that replaces the current folder's contents entirely. Use **Export Zip** to download the current folder as a zip. Useful for backup, transfer, or seeding a team default.

### Admin: publish as team default

Admins see a **Publish as team default** button in the Team default card. Clicking it publishes the admin's current copy of that folder as the new team version. Portal users who are following the team default receive the update the next time they visit the Configuration page.

---

## 7. Reviews

**Reviews** (under a project, at `/p/:pid/reviews`) has three tabs: **Code reviews**, **Branch scans**, and **Dashboard**. Old URLs redirect automatically: `/p/:pid/review` → `/p/:pid/reviews/code`; `/p/:pid/branchscans` → `/p/:pid/reviews/branch-scans`; `/reviews` (old portal-level route) → the last-used project's dashboard, or to the Projects page if no project was previously selected.

### Code reviews

**Code reviews** runs AI-powered pull request reviews.

1. Click **+ New review**.
2. Fill in the form:

| Field | Description |
|-------|-------------|
| **Repository** | Pick from the project's repos. |
| **Base branch / ref** | The branch you are merging into (e.g. `main`). Required. |
| **Head branch / ref** | The branch containing the changes. Required unless you supply a PR number. |
| **PR number** | Optional. Enables posting comments back to the PR. |
| **Jira ticket key** | Optional. Auto-detected from the branch name (e.g. `feature/PROJ-123-my-feature`) when left blank. |
| **Post mode** | **Draft** — you approve before findings are posted. **Auto** — findings post automatically when the review completes. |
| **Min severity** | Only findings at this severity or above are included. |

3. Click **Create Review**. The review appears in the list with a status badge.

### Findings

Click **View findings** on a review row to expand the findings panel inline, or click **Open** to go to the full review detail page.

Each finding shows:
- A severity badge (Critical, High, Medium, Low, Info) and file/line reference.
- A title and description.
- A confidence percentage where available.
- **✓ Accept**, **✕ Dismiss**, or **Reset** buttons.

Dismissed findings are dimmed and excluded from the merge gate count.

### Merge gate

The admin sets a merge threshold in **Settings › Code review**. If any non-dismissed finding exceeds the threshold severity, the review is considered blocked.

### Posting to the PR

In **Draft** post mode, admins see a **Post to GitHub** button on the findings panel once the review is done. This posts all accepted (non-dismissed) findings as PR comments. In **Auto** post mode, findings post automatically on completion.

The **PR comment mode** setting (manual or automatic) controls the portal-wide default. Admins change it in **Settings › Code review**.

### Re-run and export

On the review detail page, click **Re-run** to start a fresh review against the same refs. The portal creates a new review and navigates to it; the original review is preserved and linked as the parent.

Download a report directly from the review detail page using the **Excel** and **Word** buttons (top-right action bar). These call `GET /api/projects/:id/reviews/:rid/export/xlsx` and `.../export/docx` respectively. The same endpoints are available via the REST API for programmatic access.

### Dashboard

The **Dashboard** tab opens within the project's Reviews page. By default it shows recent reviews for the current project only. Toggle **Show all projects** to see reviews from every project in the portal. The four summary tiles (estimated spend, total reviews, pull requests, tokens) always reflect portal-wide totals, regardless of the toggle. A period selector at the top right lets you choose Today, 7 days, 30 days, or 90 days.

### Filters

Both the project reviews list and the dashboard support filters: search by branch or ref, filter by who ran the review, by status (Pending, Running, Done, Failed), by type (PR review or Full scan), by repository, and by date range. Filters are reflected in the URL so you can share a filtered view.

### Branch scans

**Branch scans** is the Branch scans tab on the Reviews page. It runs a full-branch code review that inspects every file on a branch, not just a diff.

#### Who can run branch scans

Admins can always run scans. Non-admins must be on the **scan allowlist** set by an admin in **Settings › Code review › Full-scan allowlist**. If you are not on the list, the **New scan** button is disabled with the message "Full scans are limited to a list of people. Ask an administrator to add you. Pull request reviews are not affected."

#### Estimate → confirm budget → run → resume

1. Click **New scan**.
2. Fill in the form:

| Field | Description |
|-------|-------------|
| **Repository** | Required. |
| **Branch** | Leave blank to scan the default branch. |
| **Include paths** | One glob pattern per line (e.g. `src/**/*.ts`). Leave blank to include all files. |
| **Exclude paths** | One gitignore-style pattern per line. |
| **Model role** | Custom instruction prepended to the model's system prompt. Optional. |

3. Click **Estimate scan**. The scan enters the **Estimating** state and then shows an **Estimate** card with the number of files, estimated tokens, cost, and time.
4. Review the estimate. Set a **Token budget** (the scan stops when the budget is reached). Click **Confirm and start**.
5. The scan progresses through: **Queued → Fetching → Reviewing → Completed** (or **Failed**). A progress stepper and two progress bars (files and token budget) are shown while reviewing.
6. If the scan stops before completion (budget reached or failure), click **Resume scan** to continue from where it left off.

#### Findings

Findings appear grouped by file once the scan starts reviewing. Filter by severity. Accept or dismiss individual findings. Findings are backed by the same review system as PR reviews.

#### Filters

The scan list supports the same filters as code review: search, run-by, status, repository, and date range.

---

## 8. Tests

**Tests** (under a project) is the AI-assisted end-to-end and API testing module. A headless browser is required to run browser-based tests; if one is unavailable, a yellow banner appears at the top of the page: "Browser not available. A headless browser is required to run tests." along with the reason.

### Test projects

The top level of Tests is a list of test projects. Each test project has its own vault, groups, scripts, and run history. Create a test project with **New test project**.

### Test vault

Each test project has a separate vault for test credentials. Credentials are write-only: values can only be replaced, not read back.

Two kinds of credential:

| Kind | Fields |
|------|--------|
| **Login** | Name, username, password, and optionally an authenticator key (TOTP secret). |
| **Secret** | Name and a single secret value. |

Import multiple credentials at once from the **Import CSV** button. The CSV must have the columns `name, kind, username, password, totp, value`. One row per credential.

**Files**: Upload binary files to the test vault for use in upload steps.

### Groups and scripts

Scripts are organised into named groups. Create a group with **New group**. Add scripts to a group with **+ Script**.

A script is a sequence of steps. Each step has a kind and kind-specific fields.

| Step kind | Description |
|-----------|-------------|
| **Go to URL** | Navigate to a path relative to the app URL. |
| **Click** | Click an element identified by a locator. |
| **Fill input** | Type a value into an input. Supports vault references. |
| **Select option** | Select an option in a `<select>` element. |
| **Press key** | Press a keyboard key (e.g. Enter, Tab, Escape). |
| **Upload file** | Upload a file from the test vault using a locator. |
| **Assert visible** | Assert an element is visible. |
| **Assert text** | Assert an element contains specific visible text. |
| **Assert URL** | Assert the current URL matches a pattern. |
| **Wait** | Pause for a given number of milliseconds. |
| **API request** | Make an HTTP request and assert the response status. |
| **Agent instruction** | Give a free-text instruction to the AI agent to execute. |

**Locator modes** (for step kinds that target elements):

| Mode | Identifies element by |
|------|-----------------------|
| Role + name | ARIA role and accessible name |
| Label | Associated label text |
| Text | Visible text content |
| Test ID | `data-testid` attribute value |
| CSS selector | CSS selector |

### Vault and file references

In a **Fill input** step value, use `{{vault.name.username}}`, `{{vault.name.password}}`, or `{{vault.name.totp}}` to insert login credential fields. Use `{{vault.name.value}}` for secrets. Use `{{file.name}}` in **Upload file** steps to reference a file from the test vault. The insert drop-downs in the step editor populate these references automatically.

### Generate and refine with AI

Click **Generate with AI** (available at the group/script list level or inside the script editor) to open the Generate dialog. Type a description of the test scenario — this is required. You can also attach requirement documents, screenshots or architecture diagrams; the AI will use them as source material when generating steps.

**Generation runs in the background.** After you click **Generate**, the dialog closes immediately and the server runs the job asynchronously. A progress indicator appears near the Scripts toolbar ("Generating — *your description*" with a spinner) for every active job. You can start multiple generations while one is already running. When a job finishes, the scripts list refreshes automatically and a toast notification confirms how many scripts were generated. If generation fails, the indicator turns into an error row that stays visible until you dismiss it. Active jobs are picked up automatically when you reload the page or navigate away and back.

**Attaching files to Generate with AI**

In the Generate dialog, use the attachment area to add up to 5 files. Documents and diagrams (PDF, DOCX, XLSX, PPTX, MD, TXT, CSV, .drawio, .mmd, .svg) may be up to 20 MB each; images (PNG, JPG, WEBP, GIF) may be up to 10 MB each. You can:
- Click the drop zone to browse files.
- Drag and drop files onto the drop zone.
- Paste a screenshot or image directly from the clipboard (useful for UI screenshots or architecture diagrams).

Each file uploads immediately. A spinner shows while uploading. The **Generate** button is disabled until all uploads complete. Remove a file before generating by clicking the × button next to it.

Click **Refine with AI** inside the script editor to describe a change to the existing steps. A dialog opens where you type your instruction (required) and optionally attach supporting files. Click **Refine** to start the refinement. Like generation, refinement runs in the background — the dialog closes immediately and a status bar below the editor toolbar shows "Refining…" until the refined steps are ready.

### Import test cases

Click **Import test cases** from the scripts tab toolbar. Paste a CSV with `name` and `description` columns, one row per test case. An AI session generates steps for each test case. Any row-level errors are shown inline.

### Running scripts and groups

Click **Run** next to any script to run it individually. Click **Run group** next to a group header to run all scripts in the group in sequence. A run starts immediately and its status appears in the **Runs** tab.

### Run results and screenshots

Open the **Runs** tab in a test project to see all runs. Filter by status (Queued, Running, Passed, Failed, Cancelled, Error). Click a run to open its detail view.

The detail view shows each step with its status, duration, and any error message. Steps that capture screenshots show a thumbnail that expands on click.

Cancel a running run with the **Cancel run** button.

### What is masked

All credential values stored in the test vault are write-only. They appear in test steps as references (e.g. `{{vault.admin.password}}`) and are substituted at run time. They are never shown in the portal UI, logs, or transcripts.

Screenshots taken during a run mask any password input field and any field that was filled using a vault reference. The actual values are resolved only at run time and are never stored in screenshots or step records.

### Network restrictions

Browser-based tests run through the portal server. The available network is determined by the server's network configuration. If the test app is not reachable from the server, test runs will fail at the navigation step.

Requests to cloud-metadata endpoints (e.g. `169.254.169.254`) and all link-local addresses are always blocked, and every redirect hop is checked against the same rules. An admin setting controls whether private and loopback addresses (e.g. `10.0.0.0/8`, `127.0.0.1`) are accessible from test runs; the default is to allow them.

---

## 9. API access and MCP

**API access** (rail › Portal) manages personal access tokens and shows the MCP connection details.

### Creating tokens

1. Click **New token**.
2. Fill in **Name**, **Scopes**, **Expiry**, and optionally restrict to a single project.
3. Click **Create token**.
4. Copy the token immediately. **It is shown only once.**

You can have up to 10 active tokens. The token statistics panel shows active token count, how many have write scope, how many have merge scope, and how many have never been used.

### Scopes

| Scope | What it allows |
|-------|----------------|
| **Read** (always on) | List sessions, get transcripts, list and get reviews, list test projects and scripts, get test runs. |
| **Write** | Start, prompt, stop, and delegate sessions; edit configuration. |
| **Review** | Start and re-run code reviews, start, confirm and resume branch scans, post PR comments. |
| **Merge** | Merge pull requests via the portal. |
| **Tests** | Start and cancel test runs, generate test scripts. |

Tokens cannot manage credentials, users, other tokens, or portal settings, and cannot use the terminal.

Expiry options: 30 days, 90 days (default), or 1 year.

### Browser-only actions

Some actions require a browser session (e.g. managing credentials and the initial setup wizard). Calling these via API returns a 403 error. All other API endpoints work with a personal access token.

### REST API base

All API requests go to `<portal-origin>/api`. All mutating requests require the `x-requested-with: agent-portal` header in addition to the `Authorization: Bearer <token>` header.

### Connecting an MCP client

The **API access** page shows an **MCP endpoint** URL and a **Client configuration snippet**. Copy the snippet, replace `<your-token>` with a personal access token, and paste it into your MCP client configuration (e.g. Claude Code, Kiro).

The MCP endpoint uses the transport shown on the page (typically `http-streaming` or `streamable-http`).

### Tool list by scope

The page lists all available MCP tools grouped by the scope required to call them.

| Scope | Tools |
|-------|-------|
| Read | `list_sessions`, `get_transcript`, `list_reviews`, `get_review`, `get_review_usage`, `list_test_projects`, `list_test_scripts`, `get_test_run` |
| Write | `start_session`, `prompt_session`, `stop_session`, `delegate_session` |
| Review | `start_review`, `wait_for_review`, `post_review_comments`, `start_scan`, `confirm_scan`, `resume_scan` |
| Merge | `merge_pull_request` |
| Tests | `start_test_run`, `cancel_test_run`, `generate_test_script` |

---

## 10. Knowledge, Create, Insights, Inbox, Learn

### Knowledge

**Knowledge** (under a project) stores documents and lets you query them.

| Tab | Description |
|-----|-------------|
| **Documents** | Upload PDF, Word, Excel, PowerPoint, HTML, text, Markdown, or CSV files. Status shows processing or ready. |
| **Search** | Full-text search across uploaded documents. Matching words are highlighted. |
| **Ask** | Ask a natural-language question. The portal returns an answer with source snippets. If no answer is found, you can send the question to the team decisions list. |
| **Decisions** | Lists answered team questions: question + answer pairs. |
| **Learn** | See the **Learn** section below. |

### Create

**Create** (under a project) generates diagrams, documents, and slide decks.

| Tab | Description |
|-----|-------------|
| **Diagrams** | Generate and edit Mermaid and other diagrams. |
| **Documents** | Generate written documents using AI. |
| **Decks** | Generate presentation slide decks. |

#### Attaching files to Create actions

When creating or refreshing a diagram, document, or presentation, you can attach up to 5 files (10 MB each) to provide the AI with additional context — for example architecture diagrams, requirement documents, existing content, or reference images.

**Allowed file types:** PNG, JPG, WEBP, GIF, PDF, DOCX, XLSX, PPTX, MD, TXT, CSV, .drawio, .mmd, .svg.

Attach files by dragging and dropping onto the drop zone in the creation form, clicking the drop zone to browse, or pasting an image from the clipboard. Each file uploads immediately with a spinner. The **Create** button remains disabled until all uploads complete.

**Refresh with attachments:** Click the **Refresh** (↺) button next to an existing diagram, document, or presentation to open a Refresh dialog. Any attachments previously used are pre-filled — you can keep them, remove them, or add new ones before confirming the refresh.

### Insights

**Insights** is now part of the **Dashboard** (rail, top group); the old `#/insights` and `#/p/:id/insights` addresses open the Dashboard, with that project selected. It shows usage metrics with a period selector: **Today**, **7 days**, or **30 days**.

Metrics shown: total cost, total runs, failure rate, average run duration. Charts: daily cost line chart, runs by status pie chart, cost by project bar chart (portal-wide only). Admins also see a cost-by-user table.

### Inbox

**Inbox** (rail, top group, and the top bar icon) shows all items that require a person to act on, across all projects. A numeric badge on the Inbox icon in the top bar updates every 30 seconds. Navigate to Inbox by clicking the icon or pressing **g b**.

| Group | Description | Action |
|-------|-------------|--------|
| **Approvals** | Tool calls waiting for permission. | Approve or Deny. |
| **Questions** | Agent questions requiring a text answer. | Type and submit an answer. |
| **Blocked sessions** | Sessions that cannot continue. | Dismiss. |
| **Pending pushes** | Sessions waiting for a manual git push. | Dismiss. |
| **Review ready** | Code reviews that have completed and are ready to post. | Dismiss. |

You can also handle approvals directly in the session workspace, in the agent conversation panel.

### Learn

**Learn** is a tab within **Knowledge** (under a project). It has three sub-tabs:

| Sub-tab | Description |
|---------|-------------|
| **Overview** | Create and manage learning documents (overview, feature guide, glossary, FAQ). Publish or unpublish documents. |
| **Quizzes** | Take published quizzes linked to learning documents. Quizzes show your score and correct answers. |
| **Onboarding** | Structured onboarding paths for the project. Shows steps and progress percentage. |

---

## 11. Users

**Users** (`#/users`) is visible only to admin users. It has four tabs. Old link `/admin` redirects to `/users` automatically.

### User management

Manage portal users: create accounts, send invite links, disable accounts.

### Audit log

Searchable log of every significant action in the portal. Columns: time, actor, action code, target, and IP address. Filter by actor ID or action string. Paginated at 50 entries per page.

### API tokens

Shows your own tokens and, in the admin view, all tokens across all users. You can revoke any token from the admin view.

### Control plane

Three metrics at the top: running sessions, queued sessions, and sessions awaiting approval.

**Drain mode**: When active, no new sessions will start. Existing sessions continue. Use this before maintenance. Toggle with **Start drain** / **Stop drain**.

**Concurrency limits**: Global max sessions, per-user max sessions, and per-project max sessions. Set to 0 for no limit. These apply to new session starts.

---

### Settings

**Settings** (Portal group) is visible to all users. Non-admins see a read-only banner and cannot save changes. The banner shows when settings were last changed and by whom.

#### Portal AI provider tab

This is the portal's own AI account, used by code reviews, branch scans, Knowledge Ask and test generation. It is also the fallback for sessions when a user has no sign-in under Credentials.

Choose the portal's default AI engine and configure its credentials. Providers: Demo, Anthropic API, Amazon Bedrock, Kiro CLI. A **Test connection** button verifies the configuration before saving.

Model version overrides let you specify exact model IDs or Bedrock inference profile ARNs for the Sonnet, Haiku, and Opus aliases.

**Amazon Bedrock — AWS SSO / IAM Identity Center**

Select **AWS SSO / IAM Identity Center** as the sign-in method to authenticate via your organization's AWS IAM Identity Center. Enter the SSO start URL (e.g. `https://d-xxxx.awsapps.com/start`) and select the Identity Center's AWS region from the dropdown (which may differ from the Bedrock region). Click **Sign in with AWS SSO** to start a device-code flow: open the link shown, enter the user code, and wait for the portal to confirm. After sign-in, choose the AWS account and IAM role to use, then click **Save**. A signed-in status row shows the current session and an expiry time; click **Sign out** to revoke it. The session is shared across all portal runs.

For the **Named AWS profile** option, SSO-backed profiles also work — run `aws sso login --profile <name>` on the server before saving.

**Kiro CLI panel**

The Kiro CLI panel shows whether the CLI is installed on the server and the current sign-in status (not installed, not signed in, or signed in with AWS Builder ID / IAM Identity Center including the email address). Click **Sign in** to start a device-code flow; choose **AWS Builder ID** (free personal account) or **IAM Identity Center** (organization SSO — provide start URL and select the region from the dropdown). The CLI session is portal-wide: all Kiro runs on this server share the same identity. Individual users can still use their own Kiro credential from **Agent sign-ins** to override it. An optional **Kiro API key** field is available as an alternative to the CLI sign-in.

#### Tools tab

Manage installed tool packs (MCP extensions) available to agent sessions.

#### Permissions tab

Configure portal-wide shell-command permission rules.

#### Budget tab

Set a portal-wide monthly spend cap in USD. New runs are blocked once the cap is reached. Demo and Kiro CLI runs do not count toward the cap. Leave blank for no limit.

#### Code review tab

| Setting | Description |
|---------|-------------|
| **PR comment mode** | **Manual** — you click "Post to GitHub" on the review page. **Automatic** — findings post immediately when a review completes. |
| **LiteLLM gateway** | Optional OpenAI-compatible gateway URL, model, and API key for code review. Note: the gateway operator can read code being reviewed. |
| **Cross-account Bedrock** | When the portal runs in one AWS account and Bedrock is in another, use the policy helper to generate the IAM trust policy and permissions policy for the cross-account role. |
| **Merge threshold** | The worst severity that is still allowed to merge. Options: No gate, High or lower (default), Medium or lower, Low or lower, Info only, Zero findings. |
| **Token rate card** | USD per 1 million tokens for input, output, cache write, and cache read. Used for cost estimates. |
| **Full-scan allowlist** | Check which non-admin users are allowed to start branch scans. |

#### Sessions tab

| Setting | Range | Description |
|---------|-------|-------------|
| **Idle timeout** | 5–240 minutes | Sessions with no activity are automatically stopped after this interval. Sending a message resumes them. |
| **Enable terminal** | On/Off | When off, no new terminal connections are accepted. Existing connections are not disrupted. |

#### Delegated sessions tab

| Setting | Range | Description |
|---------|-------|-------------|
| **Enable delegation** | On/Off | Turns the **Delegate a task…** button and the delegate tool on or off for new agent turns. Running child sessions are not affected. |
| **Max running child sessions per parent** | 0–10 (0 = unlimited) | How many child sessions a single parent session can have running at once. |
| **Max running delegated sessions per user** | 0–20 (0 = unlimited) | How many delegated sessions one user can have running at once across all their parent sessions. |
| **Idle stop for finished children** | 1–240 minutes | How long after a child session finishes before it is cleaned up. |
| **Allow nested delegation** | On/Off | Whether child sessions may themselves delegate to grandchild sessions. |
| **Subagent nudge threshold** | 0–20 (0 = off) | When this many in-process sub-agents are running simultaneously, the lead agent is reminded once per turn to delegate heavy work. |

#### Appearance tab (admin only)

Control the portal's look and feel. Changes apply to **all users** immediately — no page reload required.

**Template list** shows all built-in and custom templates as preview cards with colour swatches, font sample, and template name. The active template is marked with a green **Active** badge.

| Action | Description |
|--------|-------------|
| **Activate** | Apply this template to the entire portal instantly. The active template cannot be deactivated; only replaced by activating another. |
| **Duplicate** | Create a custom copy of any template. Custom copies can be edited and deleted. |
| **Export** | Download the template as a JSON file. |
| **Import** | Upload a previously exported or hand-crafted JSON template. The template is added to the list but not activated automatically. |
| **Delete** | Remove a custom (non-built-in) template that is not currently active. |

#### Template editor

Click **Edit** on any custom template (or **Duplicate** on a built-in template to create a copy, then **Edit**) to open the inline editor. The rest of the portal remains unchanged while you work — only the **live preview pane** reflects your draft.

**Fields in the editor:**

| Section | Fields |
|---------|--------|
| **Brand** | Product name (shown in rail and login), tagline, and SVG logo (≤ 20 KB — upload and preview before saving; the server sanitises the SVG before storing it). |
| **Fonts** | Display font (headings), body font, and monospace font. Select from the dropdown which shows bundled fonts (loaded immediately) vs. system-fallback fonts. |
| **Radius** | Three sliders — Small, Medium, Large — controlling border-radius from 0 to 24 px. |
| **Effects** | Checkboxes for Glow, Dot grid background, and Gradient accent buttons. A Motion dropdown (Full / Reduced / None). |
| **Colour tokens per mode** | Grouped as **Surfaces**, **Text**, **Accent**, **Status**, and **Effects**. Each token has a colour picker and a hex/rgba text input. Switch between light and dark modes using the mode tabs. |

**Contrast warnings** — four contrast ratio badges are shown above the colour token groups. Each badge is **green (✓)** if the ratio meets WCAG AA (4.5:1) and **amber (⚠)** if it does not:
- ink on panel
- ink-2 on panel
- accent-ink on accent
- link on panel

**Live validation** — as you type, the editor sends the draft to `POST /api/admin/themes/validate`. Any validation errors appear inline next to the offending field within a second.

**Live preview pane** — the right half of the editor shows a scoped preview that applies the draft CSS variables to a container (not to `:root`). The preview shows, in each mode side by side: a nav item, primary/default/danger buttons, a card with a link, a KPI stat card, status pills, an input, a table row, and a stepper. The rest of the app is unaffected until you save.

**Save actions:**

| Button | Effect |
|--------|--------|
| **Save** | Persists the template to the server; does not activate it. |
| **Save and activate** | Saves and immediately activates the template for all users. |
| **Cancel** | Discards all draft changes and returns to the template list. |

**Template structure** (for advanced users or API use): a template JSON has an `id`, `name`, `version`, `brand` (productName, tagline, logoSvg, faviconSvg), `modes` with `dark` and/or `light` token maps, `fonts` (display, body, mono), `effects` (glow, gridBackground, gradientAccents, motion), and `radius` (sm, md, lg).

Built-in templates (every one shows the Kyuubit name and logo; a template you make yourself can carry its own):
- **Kyuubit** — the default: deep green-black with clover-green and gold accents in dark, warm cream with clover green in light, rounded cards and a soft glow, matching the logo. A portal that still had Aethrix Night active when it was updated to this release is switched to Kyuubit once; pick Aethrix Night again at any time and it stays.
- **Aethrix Night** — deep-space navy with violet and cyan accents, Space Grotesk + Inter fonts, faint grid background, gradient primary buttons. Has both dark and light modes.
- **Classic Teal** — the original quiet workbench, teal accents, system fonts. Has both dark and light modes.

The user's own **Light / Dark / System** choice (in the account menu top right) is independent of the template and is saved per browser. If the active template has only one mode, the Light/Dark toggle is hidden.

---

## 12. Keyboard shortcuts

Press **?** anywhere (outside a text field) to open the shortcuts sheet. All shortcuts are suppressed while typing in an input, textarea, select, or any content-editable element.

### Global

| Keys | Action |
|------|--------|
| Ctrl K | Open command palette |
| ? | Show keyboard shortcuts sheet |

### Sessions

| Keys | Action |
|------|--------|
| Alt N | New session |

### Workspace (inside a session)

| Keys | Action |
|------|--------|
| Ctrl S | Save file |
| Ctrl ` | Toggle terminal |
| Ctrl Shift E | Toggle explorer |
| Ctrl Shift G | Toggle source control |

### Navigation — project context (requires a project to be selected)

| Keys | Destination |
|------|-------------|
| g s | Sessions |
| g w | Workspaces |
| g r | Reviews |
| g k | Knowledge |
| g v | Vault |
| g l | Insights |
| g c | Create |
| g i | Integrations |
| g h | Tests |

### Navigation — portal (always available)

| Keys | Destination |
|------|-------------|
| g p | Projects |
| g b | Inbox |
| g n | Connections |
| g j | Integrations (portal) |
| g e | API access |
| g m | Users (admin only) |
| g t | Settings |
| g y | Credentials |
| g x | Configuration |

**Two-key navigation**: press **g**, then the second key within 1.5 seconds.

---

## 13. Troubleshooting

### Engine not set up

**Symptom**: In the New Session dialog, an engine card is greyed out with the message "Not set up yet — Set up a credential."

**Cause**: You have no credential for that engine and the portal's server-wide provider does not cover it.

**Fix**: Click the "Set up a credential" link to go to **Agent sign-ins** and add one, or ask your admin to configure the portal provider in **Settings › Portal AI provider**.

---

### Delegation limit reached

**Symptom**: After clicking **Delegate task**, you see an error such as "Max running child sessions per parent" or "Max running delegated sessions per user".

**Cause**: You have hit the admin-configured delegation limit.

**Fix**: Wait for an existing child session to finish, or ask your admin to raise the limits in **Settings › Delegated sessions**.

---

### Scan not allowed

**Symptom**: The **New scan** button is disabled on the Branch scans page, with the message "Full scans are limited to a list of people. Ask an administrator to add you."

**Cause**: You are not on the scan allowlist. PR reviews are not affected.

**Fix**: Ask an admin to add you to the allowlist in **Settings › Code review › Full-scan allowlist**.

---

### Browser not available for tests

**Symptom**: A yellow banner appears at the top of the Tests page: "Browser not available. A headless browser is required to run tests." followed by a reason.

**Cause**: The portal server does not have a headless browser available, or the browser tool pack is not installed.

**Fix**: Ask your admin to install the browser tool pack under **Settings › Tools**, or check the server configuration.

---

### Token missing scope

**Symptom**: An API call returns a 403 error mentioning an insufficient scope.

**Cause**: The personal access token used for the request does not have the scope required for that operation.

**Fix**: In **API access**, create a new token with the required scope, or ask an admin to confirm which scopes are needed. The **Tool list by scope** table on the API access page shows which tools need which scope.

---

### Stale file on save

**Symptom**: When saving a file in the session workspace, an error tells you the file has been modified since you opened it.

**Cause**: The agent or another user changed the file while you had it open.

**Fix**: Reload the file from the Explorer (click it again) to see the current version, make your changes on top, then save again.

---

### "Could not reach the server. Please refresh."

**Symptom**: This message appears on the splash screen instead of the sign-in form.

**Cause**: The portal server is unreachable or not responding.

**Fix**: Check that the portal server is running. Refresh the page once the server is available.

---

### "Sign in failed"

**Symptom**: The sign-in form shows this error after submitting.

**Cause**: Wrong email or password, or the account is disabled.

**Fix**: Double-check your credentials. If you have forgotten your password, ask an admin to reset it.

---

## 14. Auto-fix

### What it is

Auto-fix finds problems on its own and asks an agent to fix them, with a person in control of what ships. Three sources create **findings**: a failed GitHub Actions run, a code-review finding (opt-in) and a failed portal session. For each finding the portal starts a fix session on a branch named `autofix/<kind>-<id>`, the server (not the agent) re-checks the result, and the outcome is a draft pull request or an Inbox question. Nothing is merged by Auto-fix.

Safety model: Auto-fix is off until a project admin turns it on; checks, protected paths, size limits, attempt and cost limits are enforced by the server and not by the agent's prompt; and by default **a person approves every push** in the Inbox (see "Unattended push: security prerequisites").

### Turn it on

1. Open the project, **Setup > Auto-fix**. Only a project owner or admin can change the policy.
2. Set the **verify command** (for example `npm test`). Auto-fix refuses to leave `off` without one. The fix session must make it pass, and the portal runs it as the check after each iteration.
3. Choose the **classes** (kinds of finding to fix): `lint`, `tests`, `types`, `build` are on by default. The kind of a CI finding comes from the failed **workflow's name** (words such as lint, type, build or test), so a workflow named just "CI" has kind `other`, which is suppressed until you add `other` to the classes (or name the workflows after what they check). `review` (review findings) and `session` (failed sessions) are optional and off by default. Anything not listed is suppressed and not fixed.
4. Choose the **mode**: `propose` (the diff waits for your approval in the Inbox, nothing is pushed until you approve) or `draft_pr` (opens a draft PR when the checks pass; see below for what "unattended" means here).
5. Choose the **engine** and the **run-as user**: the unattended sessions run as that user, who must still be a project editor or owner (a non-member admin is refused). It is set to you when you first enable.
6. Optionally edit branches, protected paths and limits, then save. The form shows the server's error if a value is refused.
7. Set up the GitHub webhook (next section). Without it, CI failures are not seen.

Start with `propose`. Break a test on a branch, watch the finding appear, approve the Inbox item, look at the draft PR, and only then consider `draft_pr`.

### GitHub webhook

In the GitHub repository: **Settings > Webhooks > Add webhook**.

- **Payload URL**: `<portal>/api/hooks/autofix/<projectId>`
- **Content type**: `application/json`
- **Secret**: on the Auto-fix tab press **Rotate secret**. The secret is shown once; copy it into GitHub. Rotating again invalidates the old one.
- **Events**: select individual events: **Workflow runs** and **Pull requests**.

Requests with a missing or wrong signature are rejected. Only GitHub repositories are supported.

### Finding lifecycle

| Status | Meaning |
|---|---|
| New | Seen, waiting to be checked against the policy (also while a limit or cooldown holds it back) |
| Triaged | Allowed by the policy, about to get a fix session |
| Fixing | A fix session is running, or its change is waiting for an Inbox approval |
| PR open | A draft PR (or an approved push) exists; CI on the fix branch is being watched |
| Resolved | CI on the fix branch went green, or the PR was merged |
| Dismissed | A person dismissed it, or the fix PR was closed without merging (a cooldown applies) |
| Suppressed | The policy does not allow it (class off, branch not eligible, mode off) |
| Needs a person | Auto-fix gave up or cannot continue; see the reason on the finding |

Repeats of the same failure (same repository, branch family and error) increase the occurrence count and never start a second run. A person can **Dismiss**, mark a kind **Never fix** (removes it from the classes) or **Retry** a finding that is new, suppressed or needs a person.

### Inbox items

- **Auto-fix PR ready**: the fix passed the server's checks and a person must approve the push. The item shows the changed paths. Approving pushes the branch and opens the draft PR with the `autofix` label.
- **Auto-fix needs a human**: Auto-fix stopped and says why (cannot reproduce, a guardrail refused the change, attempts used up, and so on).

By default every push is approved by a person, in both modes. An approval given after the finding has left the fixing state (the session was cancelled, the finding went to a person, the policy was turned off) pushes nothing: the item says so, and the finding can be retried on the Auto-fix tab. A session started by Auto-fix, an earlier session of a retried finding or a session delegated from one never uses the ordinary push, and its **Create PR** button answers 409.

### Guardrails

- **Protected paths**: globs agents may never change. Supported syntax is `*`, `**` and `?` only; braces and brackets are refused. Matching is case-insensitive and path segments with control characters are refused. Always protected: `.github/workflows/**`, `infra/**`, `**/.env*`, `**/*.pem`, `package-lock.json` and the lockfile in sub-folders. The defaults cannot be removed.
- **Size caps**: 10 changed files and 300 changed lines by default. Exceeding them does not refuse the fix: in `draft_pr` mode it downgrades to asking a person in the Inbox. Only a protected-path hit blocks the push.
- **Attempts and cooldown**: 2 attempts per finding by default; the cooldown (60 minutes by default) applies after a failed session or push and after a dismissed PR, not between red-CI retries.
- **Open-PR cap**: at most 3 open auto-fix PRs per project by default.
- **Cost caps**: $2 per finding and $10 per day by default.
- **Kill switch**: **Pause** on the Auto-fix tab stops new fix sessions for the project; an admin can pause the whole portal (`POST /api/autofix/pause`).
- Fix sessions: the built-in fixer specs allow at most 12 sessions an hour, portal-wide, and one auto-fix session runs at a time across all projects; other findings wait.

### Retry on red CI

When CI on the fix branch fails, the portal starts one retry session per red CI result on the same branch, which sees the previous diff and the new failure. There is no cooldown between retries. This repeats up to the attempt cap, then the finding goes to a person. A green run resolves the finding; a PR closed without merging dismisses it and applies the cooldown.

### Review findings and failed sessions

Review findings are opt-in. Put `review` in the classes and add the pull request's branch pattern under extra branches. The fix session clones the repository and works against the default branch first, then starts from the reviewed commit; the fix is a **stacked PR** whose base is the reviewed branch, not the default branch. A failed portal session is recorded as a finding too (kind `session`), but with the default classes it is suppressed. Add `session` to the classes to have failed sessions sent to a person; a failed session is never retried automatically.

### Unattended push: security prerequisites

The default is human approval for every push. Setting `AUTOFIX_ALLOW_UNATTENDED_PUSH=1` on the portal server lets `draft_pr` mode push and open the PR without asking. Set it only when **all** of these are true:

1. The runner images (agent-runner, kiro-runner, codex-runner) are rebuilt and redeployed with the hardened finalize code. Until then old runners reject the new request fields and Auto-fix pushes nothing. Runs of auto-fix sessions carry a new `checkedReport` field: an old runner rejects them (fails closed), while ordinary sessions are unaffected and keep their usual end-of-run change report.
2. The credentialed git commands run where the agent cannot read them: as a separate user or outside the microVM, or after all agent processes are killed. Today the agent and the runner share a user and a microVM, so a process the agent leaves behind can read the push token from `/proc`.
3. A repository ruleset restricts pushes to `.github/workflows/**`, `infra/**` and tags, or the token lacks the `workflows` scope. Push-triggered workflows run with secrets at push time.
4. You accept the residual risk: some server-side checks (the GitHub compare after the push) run after the push.
5. Know what is still open (see `docs/superpowers/notes/2026-11-17-autofix-open-items.md`): the `/proc` exposure above is structural; the ordinary session push still has a pre-existing token leak through an agent-set `pushurl`, and other git calls in the runner (`runner-repos.ts`, `runner-files.ts`, `runner-inspect.ts`, `runner.ts`) run with the token in the agent's repository. Do not enable unattended push until you accept these.

### Known limits

- Review findings have no category, so their kind is always `review`.
- The change report is computed against the default branch, so a large stacked fix may ask a person or be blocked.
- A fix whose base branch changed a protected file since the fork is refused with "rebase on the base branch".
- GitHub only. CodeCommit and other hosts end in "needs a person".
- DynamoDB mode: the built-in specs are not seeded, so Auto-fix does nothing there.
- The changed paths are shown on the Inbox item; they are not stored on the finding.
- A run that is lost (not failed) does not raise a finding.

---

*Final report*

Sections written (all 13 requested): Getting started, Sessions, Delegated sessions, Workspaces/Git connections/Integrations/AWS accounts/Vault, Credentials, Configuration, Code review, Branch scans (folded into section 7), Tests, API access and MCP, Knowledge/Create/Insights/Inbox/Learn, Admin, Keyboard shortcuts, Troubleshooting.

Items left out because they could not be confirmed in the code: the full list of MCP tool names (they are fetched at runtime from `/api/mcp/info` and vary by deployment); exact invite-link flow (Auth.jsx only shows the hint "Ask your admin to create an account or send you an invite link" — no invite page was found); Connections/Integrations/AwsAccounts pages are described briefly as their full form content was not read in detail; the Tests page screenshot feature is partially implemented (state variable exists but rendering was not confirmed in full).

---

## 15. Pipelines

The **Setup > Pipelines** tab shows the state of a project's GitHub Actions workflow runs, and alerts the project when a deploy fails. Every project member can read it; only a project owner or admin can change its settings.

### What it shows

For each GitHub repository of the project, the latest run of every workflow on every alerting branch: a status (Queued, Running, Succeeded, Failed, Timed out, Cancelled, Skipped or Other), the workflow, the branch, the short commit, who started it, when and how long it took, and a **View run** link to GitHub. **History** lists the earlier runs of that workflow and branch. **Show all branches** also lists the other branches (by default only the repository's default branch and your alert branches). The list updates by itself when GitHub reports a run. On a phone each run is a card and the page never scrolls sideways.

### Which runs are deploys

A workflow is a deploy workflow when its name contains "deploy" (any case). To use other names, list the exact workflow names under **Deploy workflows** in the tab's settings; the list then replaces the rule. Alerts apply to the repository's default branch; add more branches under **Alert branches**.

### Alerts and recovery

When a deploy workflow ends `failure` or `timed_out` on an alert branch, the project gets an Inbox item labelled **Deploy failed** (workflow, repository@branch, commit, who started it and a **View run** link). There is one open alert per repository, workflow and branch: further failures refresh it with the latest run and a failure count. The first later success (or a successful re-run of the failed run) closes the alert automatically; no one has to dismiss it.

### Slack and Teams

Optionally post the same alerts, and a "recovered" message, to a chat channel. Paste the channel's webhook URL into **Slack or Teams channel** and press **Save URL**; press **Send test message** to check it. The URL is stored as a secret and is never shown again: the tab shows only its host and last 4 characters. A failed post is shown next to the setting.

- **Slack**: in a Slack app, turn on **Incoming Webhooks**, add a webhook to the channel and paste its `https://hooks.slack.com/...` URL.
- **Teams**: in the channel create a **Workflows** flow from the template **Post to a channel when a webhook request is received** and paste the flow's URL (an `https://...webhook.office.com/...` or `https://...logic.azure.com/...` address).

Only those hosts are accepted, over https.

### Set-up

Pipelines uses the same GitHub webhook as Auto-fix (see "GitHub webhook" in section 14): payload URL `<portal>/api/hooks/autofix/<projectId>` with the **Workflow runs** event enabled. Until the first run arrives the tab says so and repeats these steps. Only runs received after the webhook is set up are shown; there is no polling and no refresh button.
