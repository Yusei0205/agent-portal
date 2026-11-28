# Improvements drawn from axrail.ai CloudCode — draft

Status: **implemented** on `feat/sessions-workspace` (2026-10-21), except isolated compute per session (P3 #14) · reference reviewed read-only

CloudCode is a team platform where each session is Kiro CLI or Claude Code running in its own cloud
container over a private checkout of a workspace's repositories. Below is what it has, how it compares
with Agent Portal today, and what is worth taking. Our strengths it lacks are listed at the end, so we
keep them.

## 1. What CloudCode has (by page)

| Page | What it does |
|---|---|
| **Sessions** | List + detail. *New session* (Alt+N): pick a **workspace** (or a "playground" with no repos), an **engine** (Kiro or Claude Code), an **agent** (from your `.kiro/agents`, 22 found), a **model**, and **Trust all tools** (agent runs commands and edits without asking). Each session gets an **isolated microVM**, its own checkout on a fresh `clc/…` branch, and **keeps running when the tab is closed**. |
| **Workspaces** | Named, reusable **sets of repositories**, each with its connection, repo and **base branch**; repos are checked out side by side. Up to 10 **integrations** attached per workspace. Edits affect new sessions only. |
| **Connections** | CodeCommit accounts and Bitbucket workspaces. **Team** (shared) vs **Only you** (personal). Shows region/account, masked key, **Used by N workspaces**, **Last tested** with the identity it signed in as, a **Test** button. |
| **Integrations** | MCP tools for sessions, **read-only unless writes are allowed**, secrets reach sessions only as short-lived credentials. Presets: **Jira & Confluence** (Atlassian Rovo MCP; sign in with Atlassian / API token / service account), **Google Drive/Docs/Sheets/Slides**, **AWS read-only** (CloudWatch Logs, DynamoDB, Lambda, CloudFormation via an assumed role), **Web browser** (Bedrock AgentCore Browser: open pages, screenshots), **Custom MCP** (HTTP or stdio). |
| **Vault** | Files uploaded once, available in every session at `~/vault`. **My vault** and **Team vault**; folders, upload folder, download all, 512 MiB per file. |
| **Credentials** | **Per-user** engine credentials. Kiro: API key or **IAM Identity Center** login. Claude Code: Anthropic API key, **Pro/Max subscription token** (`claude setup-token`), or **Bedrock via an assumed role** (no secret stored). Several **named credentials** per engine, chosen per session. Write-only, last 4 chars shown, browser-only changes. |
| **Configuration** | In-browser **file editor** for your own `~/.kiro`, `~/.claude` and `~/.aws` (agents, steering, skills, hooks, `mcp.json`), with a **team default** layer, JSON validated while typing, **Import/Export zip**. Applies to sessions started or resumed afterwards. |
| **Users** | Allowlist of Google accounts (company domain only); who added whom, last sign-in; anyone listed can add/remove. |
| **API Access** | **Personal access tokens** (max 10, expiry 30/90/365 days, **read** or **read+write** scope) for a REST API to list/start/prompt/stop sessions and read transcripts. Users, tokens and credentials stay browser-only, so a leaked token cannot escalate. |
| **Settings** | Admin limits for **delegated sessions**: an agent (or a person) can hand a task to a **separate session with its own machine, checkout and branch** (`delegate_session` tool). Caps: max running per parent (0–10), per user (0–20), idle stop minutes, **nested delegation** on/off. **Built-in subagent nudge**: above N in-machine subagents the agent is reminded once per turn to delegate heavy work instead. **Claude model list** editable without a deploy (Bedrock ids). |

## 2. Comparison with Agent Portal

| Area | Agent Portal today | CloudCode | Gap |
|---|---|---|---|
| Isolation | Runs share the portal host; writes fenced to `work/<run>/` by the guard | microVM per session | Large (infra) |
| Engine choice | Provider set per project / Settings | Per session (Kiro or Claude Code) | Medium |
| Agent per session | *Lead agent* on sessions | Agent picker (from `.kiro/agents`) | Small — we have it |
| Approvals | Sessions fully autonomous; single runs have 3 modes | One "Trust all tools" toggle | We are richer |
| Repo sets | Pick repos per session (multi-repo just added) | Saved **workspaces** | Small |
| Repo credentials | Repositories page, per project | Team vs personal **connections**, test, used-by | Small–medium |
| Tools for agents | Jira (portal-side), AWS accounts, Knowledge search | **MCP integrations** (Jira/Confluence, Drive, AWS RO, browser, custom) | Medium–large |
| Shared files | Knowledge (converted, indexed) + per-session context | **Vault** mounted in every session | Small |
| Credentials | Admin Settings / project AWS; one per provider | **Per-user**, several named, Claude **subscription token** | Medium |
| Agent config | *Agents and skills* builder, import | Raw editor for `.kiro/.claude/.aws` + team default + zip | Small |
| Automation | None | **PAT + REST API** | Medium |
| Delegation | In-process subagents (Claude SDK; Kiro subagents just added) | + **Delegated sessions** on their own machine/branch, with caps | Medium |
| Restart | Server restart pauses sessions | Sessions survive (containers) | Medium |

## 3. Recommended improvements (prioritised)

**P1 — high value, fits our architecture**

1. **Engine per session.** Let *New session* choose Claude Code or Kiro (and the credential) instead of
   only the project connection. Our runner already has both providers; this is mostly a field on
   `workflows`/`runs` and the dialog. Effort: S–M.
2. **Delegated sessions.** Give agents a `delegate_session` tool (and a *Delegate a task…* button) that
   starts a child **session** on its own working copy and branch, linked to the parent, shown as a child
   bubble that opens the child session. Admin caps: running per parent / per user, idle stop, nested on/off.
   Complements in-process subagents for heavy, parallel work. Effort: M.
3. **Subagent nudge.** When more than N in-process subagents run at once, remind the lead once per turn to
   delegate heavy work to sessions instead. Cheap once (2) exists. Effort: S.
4. **Integrations as MCP tools, read-only by default.** Start with *Custom MCP* (HTTP/stdio) and
   **AWS read-only via an assumed role** (we already have AWS accounts), then Confluence. Attach per project
   or session; short-lived credentials only. Effort: M per preset.
5. **Sessions survive a server restart.** Today they pause ("The server restarted. Resume to go on").
   Auto-resume sessions that were running, with a once-per-restart guard. Effort: S.

**P2 — useful polish**

6. **Saved repository sets ("workspaces")** on top of multi-repo: name a set of repos + base branches and
   pick it in *New session*. Effort: S.
7. **Connection health:** *Test* button, last tested + signed-in identity, *used by N*; **personal vs team**
   connections. Effort: S–M.
8. **Per-user engine credentials**, several named ones, including the **Claude Pro/Max subscription token**
   and **Bedrock via assumed role**; write-only, last 4 shown. Effort: M.
9. **Vault:** personal + team files mounted read-only into every run (distinct from Knowledge, which is
   converted and indexed). Can reuse the session-context storage. Effort: S–M.
10. **Raw config editor** for the project's `.claude/` (and `.kiro/`) with JSON validation, team default
    layer, zip import/export, next to the existing *Agents and skills* builder. Effort: S–M.
11. **Model list editable in Settings** without a deploy (Bedrock ids + labels) — extends *Model versions*. Effort: S.
12. **Keyboard shortcut** Alt+N for *New*; a short **welcome panel** explaining sessions. Effort: XS.

**P3 — bigger bets**

13. **Personal access tokens + REST API** (read / read-write scopes, expiry, max 10; users, tokens and
    credentials stay browser-only). Lets CI or scripts start sessions. Effort: M.
14. **Isolated compute per session** (container or microVM per run) instead of shared host + path guard.
    Strongest security gain, biggest change (infra, image, credential injection). Effort: L.
15. **Playground sessions** (no repos, scratch folder) — we already allow "no repository"; label it. Effort: XS.

## 4. Keep — where Agent Portal is ahead

- **Knowledge**: converted, indexed, cited answers, decisions log, open questions.
- **Learn**: documentation for two audiences, quizzes, onboarding paths.
- **Code review** with findings beside the diff and posting to GitHub.
- **Live agent canvas**, iteration strip, autonomous **sessions with goals, budgets and iteration caps**, Jira ticket per session re-read every iteration.
- **Approval modes** finer than a single "trust all" switch, and the write-folder guard.
- **Context attachments** per session, **Insights** and cost/credit tracking.

## 5. Suggested next step

Pick from P1. The cheapest high-value pair is **(1) engine per session** and **(5) survive restarts**; the
most requested capability (agents working in parallel) is **(2) delegated sessions + (3) nudge**.

## 6. What was built

| Item | Where |
|---|---|
| Repository connections (team / personal, test, used-by, browse repos) | Connections page; Repositories › Connect › From a connection |
| Workspaces (repo sets + base branches + integrations) | Project › Workspaces; New session › Workspace |
| Integrations as MCP tools, read-only by default | Integrations page; workspaces, New session › More options |
| Configuration editor for .claude / .kiro | Project › Configuration |
| Personal access tokens + REST API | API access page |
| Engine per session (Claude Code or Kiro) | New session › Engine |
| Sessions carry on after a restart | Settings › Agent defaults |
| Vault (personal + team, copied into each run) | Vault page |
| Delegated sessions + limits + subagent advice | Session › Delegate a task; Settings › Delegated sessions |
| Extra Claude models without a deploy | Settings › Extra Claude models |

Not built: isolated compute per session (a container or microVM per run). Runs still share the portal host,
fenced by the write guard, approvals and the command blocklist.
