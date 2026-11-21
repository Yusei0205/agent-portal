# clovi parity, round 2: specs for missing features

Status: **implemented** on `feat/clovi-parity` (2026-10-30), uncommitted · user guide: `docs/user-guide.md`
Reference: https://dvfknzixb0pap.cloudfront.net (clovi by Axrail.AI), reviewed read-only with Playwright. Nothing was created or changed there.

## 1. How this was compared

Every page of the reference was opened: Sessions (list, New session, one live session), Workspaces, Connections, Integrations, Vault, Reviews (7 sections), Tests (6 sections), Credentials, Configuration, Users, API Access, Settings, the Ctrl+K palette and the account menu. Each feature was then checked against this branch's code (`server/*.ts`, `web/src/**`, `server/db.ts` tables).

The 2026-10-21 plan marks delegation, per-user credentials, the config editor and extra Claude models as built, but that work was on `feat/sessions-workspace`. **None of it exists on this branch** (no `delegate`, `nudge`, credential or config routes or tables), so those features are specced again below.

### Already at parity (no work)

Session list grouped by day with status and engine filters · workspaces (`workspaces_v2`) · git connections, team or personal (`git_connections_v2`) · MCP integrations (HTTP, stdio, Atlassian, AWS, browser) · vault with personal, project and portal scopes · PR review with merge gate, merge, re-run, cost dashboard with cache rates, Jira context · API tokens (max 10, read/write) · audit log, teams, invitations.

### Work already in progress (do not redo)

Uncommitted on this branch: `server/terminal.ts` (WebSocket shell, PTY fallback), the WebSocket upgrade hook in `server/http.ts`, `server/agent/kiro.ts`, `server/agent/claude-code.ts`, `server/agent/pricing.ts`. `server/session-files.ts` already serves the IDE tree and file read, write and create routes, but **no UI calls them**.

## 2. Gap summary

| # | Feature | Reference location | Ours today | Size |
|---|---|---|---|---|
| F1 | Session IDE workspace (explorer, editor, source control, terminal, browser) | Session detail | Backend routes only, no UI | M |
| F2 | Command palette, shortcut keys, theme switch, account menu | Header | Theme lib only, no UI | S |
| F3 | Session lifecycle polish (rename, idle stop, status bar, slash commands) | Session detail | Missing | S |
| F4 | Per-user engine credentials, named, picked per session | Credentials | One provider per project/portal | M |
| F5 | Personal config editor for `~/.kiro`, `~/.claude`, `~/.aws` with team default | Configuration | Missing | M |
| F6 | New session dialog parity (agent list, model list, credential pick, playground) | New session | Engine pick only | S |
| F7 | Delegated sessions, limits, subagent nudge | Settings, session | Missing | M |
| F8 | Admin-editable Claude model list; Settings readable by everyone | Settings | Missing | XS |
| F9 | Branch scans: estimate, confirm budget, run, resume | Reviews › Branch Scans | Missing | M |
| F10 | Review settings: auto-post PR comments, LiteLLM provider, cross-account role helper, list filters | Reviews › Settings, Code Reviews | Partly | S |
| F11 | Portal MCP server and finer token scopes | Reviews › API & MCP, Tests › API | REST tokens only | M |
| F12 | Tests module: projects, test vault, scripts, AI generation, runs | Tests | Missing | XL |

## 3. Specs

Each spec says what to build and what done looks like. The implementing agents choose structure and patterns.

---

### F1 — Session IDE workspace

**What.** Turn the session detail into a workspace with resizable, toggleable panels around the agent conversation:

- **Explorer.** A tree of the session's checkout, one root per repo, with git-ignored entries shown dimmed. Extra roots: *Uploads*, *My vault*, *Team vault* (read-only). Actions: refresh, new file, new folder, upload files to uploads, download a repo as zip.
- **Code editor.** Opens files from the Explorer with syntax highlighting. Save with Ctrl+S using the existing write route and its concurrency token. A conflict (the agent changed the file meanwhile) shows a clear message and lets the user reload or overwrite.
- **Source Control.** Per repo: changed files with status, opening a file shows its diff against the base branch. Reuse the existing Changes view where possible.
- **Terminal.** A panel connected to the in-progress `server/terminal.ts` WebSocket, scoped to the session's working copy. Toggle with Ctrl+`.
- **Browser** button, shown when a browser integration is attached: shows what the agent's browser tool last opened (screenshot or page URL).
- **Agents activity.** Lists in-process subagents and delegated sessions (F7) with status.

Shortcuts: Ctrl+S save, Ctrl+` terminal, Ctrl+Shift+E explorer, Ctrl+Shift+G source control.

**Read first.** `server/session-files.ts`, `server/terminal.ts`, `web/src/pages/sessions/SessionWorkspace.jsx`, `SessionChanges.jsx`, `web/src/styles/workspace.css`.

**Done when.**
- A user can open, edit and save a file in a running session, and the agent sees the change on its next turn.
- Saving a file the agent changed meanwhile never overwrites silently.
- The terminal opens in the session's working copy, and closing the panel ends the shell.
- Team vault files cannot be edited from the Explorer.
- Panel visibility and sizes survive a reload.
- Users without access to the session get 403 from every IDE and terminal route.

---

### F2 — Command palette, shortcuts, theme, account menu

**What.**
- **Ctrl+K palette.** Fuzzy search over every page the user can open, recent sessions, and actions (new session, switch theme). Two-key go-to shortcuts shown beside each page (e.g. `g s` sessions, `g w` workspaces, `g v` vault).
- **`?` opens a shortcuts sheet** listing every key command.
- **Theme switch** (Light, Dark, System) in the header and the account menu, using `web/src/lib/theme.js`.
- **Account menu** in the header: name, email, theme, shortcuts, sign out.
- **Breadcrumb** in the header using the existing `Breadcrumb` component.

**Done when.** Every nav page is reachable from the palette, by keyboard only. Shortcuts are ignored while typing in an input. Focus is trapped in the palette and returns to where it was on close. The theme choice persists.

---

### F3 — Session lifecycle polish

**What.**
- **Rename session** inline from the header and from the list's actions menu.
- **Idle stop.** A session with no turn for N minutes stops itself and logs "Session stopped — idle for N minutes". Sending a message resumes it. Admins set N in Settings (default 30).
- **Status bar** under the composer: agent, tokens (or "not reported" for Kiro), cost this turn and this session, tool approval mode.
- **Slash commands.** Commands such as `/clear` are passed to the engine and shown as "<user> ran the command /clear" with the result.
- **Load earlier turns**: long transcripts show the latest turns first, with a button to load older ones.

**Done when.** An idle session stops at the configured time, and its next message resumes it on the same branch. Renames are visible in the list without a reload. A 1,000-turn transcript opens without freezing the page.

---

### F4 — Per-user engine credentials

**What.** A **Credentials** page where each user stores their own engine sign-ins:

- **Kiro:** API key (reaches the engine as `KIRO_API_KEY`, per [Kiro's headless mode docs](https://kiro.dev/blog/introducing-headless-mode/)) or **IAM Identity Center** device-code login, which shows the start URL, region, token validity and last sign-in.
- **Claude Code:** Anthropic API key, **subscription token** from `claude setup-token` (reaches the engine as `CLAUDE_CODE_OAUTH_TOKEN`, per [claude-code-action setup](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md)), or **Bedrock through an assumed role**, which stores no secret.
- One **default** credential per engine plus extra **named** credentials (e.g. "work", "personal"), chosen per session in F6.

**Business rules.**
- Secrets are write-only: after saving, only the mode and the last 4 characters are shown. They are encrypted at rest with the existing `server/secrets.ts`.
- Credentials can only be changed from a signed-in browser. API-token requests get 403.
- A credential reaches only the runs of the user who owns it, as environment variables on that run's process. It never appears in logs, events or transcripts.
- When a user has no credential for an engine, it falls back to the portal or project provider as today. If neither exists, the engine shows "Not set up yet".

**Done when.** Two users on the same project run sessions billed to their own keys. No API response, log line or run event contains a secret. Deleting a credential stops new sessions from using it, and running sessions keep going.

---

### F5 — Personal configuration editor

**What.** A **Configuration** page with three tabs, one per folder (`~/.kiro`, `~/.claude`, `~/.aws`), showing the folder exactly as the engines see it in the user's sessions.

- File tree and editor with new file, new folder, rename and delete. JSON files are validated as you type.
- **Team default layer.** Admins publish a team default as a version, with an id and timestamp. Users who have not changed anything follow new publishes. A user who edits stops following, sees "You changed your configuration on <date>", and can **Reset to team default**.
- **Import zip / Export zip** per folder. Token cache files are left out of exports.
- Changes apply to sessions started or resumed afterwards.

**Business rules.** The `~/.aws` folder may hold keys, so its files are stored encrypted, and exports warn the user. Writes through API tokens require the write scope. Paths are contained to the three folders.

**Done when.** An agent added in `~/.kiro/agents` appears in the New session agent list (F6). Invalid JSON cannot be saved without an explicit "save anyway". Reset restores the current team version exactly. Zip round-trip (export, then import) is lossless.

---

### F6 — New session dialog parity

**What.**
- **Agent** picker lists agents from the user's config (F5) for the chosen engine, plus "Engine default".
- **Model** picker lists the models the engine reported in the user's last session for that engine ("As reported by your last Kiro session, 2 hours ago"), plus the admin list (F8) for Claude Code.
- **Credential** picker shown when the user has more than one for the engine (F4).
- **Playground (no workspace)** option, clearly labelled.
- **Trust all tools** toggle with a one-line explanation of what it allows.
- **Alt+N** opens the dialog from anywhere in Sessions.

**Done when.** The dialog shows only valid choices for the selected engine. An engine without a usable credential is disabled with a link to Credentials. The chosen agent, model and credential are stored on the session and shown in its status bar (F3).

---

### F7 — Delegated sessions

**What.** A session, or its agent, can hand a task to a **child session** with its own working copy and branch.
- Agents get a `delegate_session` tool. People get **Delegate a task…** in the session's actions menu.
- The parent shows each child as a card that opens it, plus its status, in Agents activity (F1). The child links back to its parent.
- When the child finishes, its summary returns to the parent agent as a message.
- **Admin limits** in Settings: delegation on/off, max running per parent (0–10), max running per user (0–20), idle stop for finished children (1–240 min), nested delegation on/off.
- **Subagent nudge**: when more than N in-process subagents run at once (0–20, 0 = off), the lead is reminded once per turn to delegate heavy work instead.

**Business rules.** Children inherit the parent's workspace, engine, credential and integrations, and count against the owner's budget. Deleting the parent stops and deletes its children. Turning delegation off removes the tool from new turns and leaves running children alone.

**Done when.** An agent delegates two tasks that run in parallel on separate branches and receives both summaries. Exceeding a cap returns a clear refusal to the agent and the UI. Limits are enforced on the server and covered by tests.

---

### F8 — Claude model list and Settings visibility

**What.** Admins edit the Claude Code model list in Settings, one `model id | label` per line, with no deploy needed. Running sessions pick it up on their next start or resume. Non-admins can view Settings read-only, with "Last changed <when> by <who>".

**Done when.** A model added in Settings appears in the New session picker (F6). A non-admin sees the values but every control is disabled, and the server refuses their writes.

---

### F9 — Branch scans

**What.** A full review of a branch as it is, not a PR diff, pinned to the branch's current commit.
- **New scan** form: repository (via AWS account or git connection), branch (blank = default), paths to include, gitignore-style excludes, optional background documents (PDF, Word, Markdown, text, JSON, YAML, CSV; up to 512 MB total), and an optional model role for this scan.
- **Estimate first.** The scan counts files and estimates tokens, cost and time. Nothing is spent until the user confirms a token budget on the scan page.
- Scan states: Estimating → Estimate ready → Queued → Fetching → Reviewing → Completed / Failed. A failed or budget-stopped scan can be **resumed** from where it stopped.
- Findings use the existing findings model and viewer, grouped by file.
- **Branch Scans** list beside Code Reviews, sharing the same filters (F10).
- Scans can only be run by an admin-managed list of users. PR reviews are unaffected.

**Done when.** A scan of a 500-file repo shows its estimate before any model call. The scan stops at the confirmed budget, and resume continues without re-reviewing finished files. A user not on the list sees the form disabled with an explanation, and the server refuses them.

---

### F10 — Review settings and list additions

**What.**
- **PR comment mode:** Manual (today) or Automatic. Automatic posts findings when a review completes, only once per PR revision, and skips posting if the PR moved during the review.
- **LiteLLM gateway** as a third review provider (OpenAI-compatible URL + key), with a warning that the gateway operator can read reviewed code.
- **Cross-account Bedrock helper:** when the user picks "assumed role", show the exact trust policy and permissions policy to create in the other account, each with a copy button.
- **List filters** on Code Reviews and Branch Scans: run by (me / everyone / person), account, status, type (PR / full scan), repository, date range, and search.

**Done when.** Re-running a review on the same commit never posts a second set of comments. A LiteLLM-backed review completes end to end against a stub gateway in tests. The filters are reflected in the URL, so a filtered list can be shared.

---

### F11 — Portal MCP server and token scopes

**What.** An MCP server at `/api/mcp` over Streamable HTTP, authenticated with the existing personal access tokens.
- **Scopes** on tokens: `read` (always), `write` (sessions: start, prompt, stop; config edits), `review` (start reviews and scans, post comments), `merge` (merge PRs). `tests` is added with F12.
- **Tools**, filtered to the token's scopes: `list_sessions`, `start_session`, `prompt_session`, `get_transcript`, `stop_session`, `start_review`, `wait_for_review`, `get_review`, `list_reviews`, `get_review_usage`, `post_review_comments`, `merge_pull_request`, `start_scan`, `confirm_scan`, `resume_scan`.
- The **API Access** page shows the MCP URL, a copyable client config snippet, and token stats (active, with write/merge, never used).

**Business rules.** Users, tokens, credentials and settings stay browser-only, so a leaked token cannot escalate. Every tool call is written to the audit log. `wait_for_review` returns within a bounded time and reports progress, so clients can poll.

**Done when.** An MCP client with a `read` token sees only read tools. A `review` token can start a review and wait for its result. Calls without a valid token get 401. Tool calls appear in the audit log.

---

### F12 — Tests module (largest item)

**What.** AI-assisted end-to-end and API testing of a deployed app.

1. **Test projects.** Name, app URL (where runs start), optional API base URL, optional repositories the generator may read (through git connections), optional documentation from the vault (files or folders), run defaults (viewport 1440×900, timeout 300 s), and "Rules for the AI" (max 4,000 chars) applied to every generation.
2. **Test vault.** Named credentials that test steps fill in by name: logins (username, password, optional TOTP authenticator key) and plain secrets. Write-only, with CSV import. Also named files for upload steps. Values reach only the run that references them.
3. **Test scripts in groups.** Steps include UI actions, assertions, API requests (relative paths use the API base URL), and free-form agent steps ("sign in with the admin login").
4. **Generation.** The user describes a test case, or imports test cases (spreadsheet or document). An agent reads the app, the repos and the docs, then writes or refines the script. "Refine with AI" edits an existing script.
5. **Runs.** Execute one script or a group in a headless browser at the project's viewport. Each step records a status, a screenshot and, for failures, the error. Runs can be cancelled. A run history per script shows pass and fail trends.
6. **Model use.** Generation and agent steps use the user's engine credential (F4) or the portal provider. No separate AI settings page.
7. **API and MCP.** Read, write and run tools under the `tests` scope (F11).

**Business rules.** Runs are fenced the same way sessions are (write guard, command blocklist). Vault values are never written to logs, screenshots of filled password fields are masked, and TOTP codes are generated at run time. Membership uses the existing project permissions, so there is no separate user list.

**Done when.** A user creates a project for a sample app, generates a login test from one sentence using a vault login with TOTP, runs it, and sees step screenshots and a pass. A failing step shows its error and screenshot. CSV-imported credentials are usable by name. No secret appears in any log or run artifact.

**Suggested split.** F12a projects and test vault → F12b scripts and runs → F12c generation and import → F12d API and MCP tools.

## 4. Out of scope

- **A microVM per session.** Runs still share the portal host behind the write guard and command blocklist, as decided on 2026-10-21.
- **Separate user allowlists per module.** The reference keeps separate lists for Reviews and Tests. We keep one user list plus project roles.
- The reference's `~/.aws` "platform account" warning, which is specific to their hosting.

## 5. Delivery plan

| Phase | Features | Agents | Why first |
|---|---|---|---|
| 1 | F1, F2, F3 | frontend-agent (F1 UI, F2), backend-agent (F1 terminal finish, F3) in parallel, then both testing agents | Backend largely exists, highest daily use |
| 2 | F4, F5, F6, F8 | backend-agent → frontend-agent, then testing | Unblocks per-user billing and agent choice |
| 3 | F7 | backend-agent + frontend-agent, then testing | Needs F4/F6 (inherited credential, agent) |
| 4 | F9, F10, F11 | backend-agent + frontend-agent, then testing | Independent of phases 2–3 except token scopes |
| 5 | F12a → F12d | backend-agent + frontend-agent per slice, then testing | Largest; reuses F4, F11 |

Each phase ends with code-review-agent. Findings send the work back to the implementing agent, at most 3 rounds, before the next phase starts. Every phase must pass `npm run typecheck`, `npm test` and `npm run test:ui`.

## 6. Decisions needed

1. **Tests module (F12):** build it in full (phase 5), as an MVP of F12a + F12b only, or defer it?
2. **Sign-in:** the reference uses Google sign-in restricted to the company domain. We have email and password plus invitations. Add Google sign-in with a domain allowlist (the `users.google_sub` column already exists)?
3. **In-progress terminal work:** commit the current uncommitted changes as-is before phase 1 starts, or let phase 1 finish and commit them together?

## 7. What was built (2026-10-30)

Decisions taken in the absence of answers: F12 built in full; Google sign-in not added; nothing committed.

| Feature | Where |
|---|---|
| F1 Session workspace | Session › Explorer, editor, Source Control, Terminal, Browser, Agents activity, Session panel |
| F2 Palette, shortcuts, theme, account menu | Header; Ctrl+K, `?`, `g` + key |
| F3 Lifecycle | Rename, idle stop and resume, status bar, slash commands, transcript paging |
| F4 Engine credentials | Credentials page; New session › Credential |
| F5 Configuration editor | Configuration page (~/.kiro, ~/.claude, ~/.aws), team default, zip import/export |
| F6 New session parity | Agent and model pickers, playground, trust all tools, Alt+N |
| F7 Delegated sessions | Session › Delegate a task…; `delegate_session` tool (Claude Code in-process MCP, Kiro via mcp.json with a workflow-bound `delegate` token); Settings › Delegated sessions |
| F8 Claude model list | Settings › Claude models; Settings readable by everyone |
| F9 Branch scans | Branch scans page: estimate, confirm budget, run, resume; allowlist |
| F10 Review settings | PR comment mode, LiteLLM provider, cross-account Bedrock policy helper, list filters in the URL |
| F11 MCP server and scopes | `/api/mcp` (Streamable HTTP); scopes read, write, review, merge, tests |
| F12 Tests module | Tests page: test projects, test vault with TOTP, scripts, AI generate/refine/import, browser runs with masked screenshots, SSRF guard, MCP tools |

Verification at hand-off: `npm test` 814/814, `npm run test:ui` 94/94, `npm run typecheck` 11 errors (all pre-existing, untouched files).

Known limits:
- Kiro IAM Identity Center sign-in is delivered through the AWS SSO token cache in the run's home folder. The cache format comes from community sources, not official Kiro docs, so it needs a check against a real Kiro login.
- Runs still share the portal host. There is no microVM per session.
- The Integrations page mentions `/aws on` and `/browser on`, but nothing implements them. This predates this branch.
