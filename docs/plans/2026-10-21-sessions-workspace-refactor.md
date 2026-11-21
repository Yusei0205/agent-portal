# Sessions workspace refactor — implementation plan

Status: **implemented** on branch `feat/sessions-workspace` (phases 0–5) · 2026-10-21

## 1. Goal

Make **Sessions** the one place to start, watch and steer agent work in a project:

1. **Remove the "Agent runs" page** as a separate destination. Sessions already wrap runs
   (one run per iteration), so the second page is duplication.
2. **Run a prompt and monitor it per project**: one screen that lists every session in the
   project, shows which ones are working or need you, and shows what changed.
3. **Let people attach context** for the agents: knowledge documents, uploaded files, notes,
   Jira tickets, results of earlier runs. Context can be added at creation and later.
4. **Show spawned agents as bubbles/nodes**: a live canvas of the main agent and its
   subagents; click a bubble to see exactly what that agent is doing.
5. Do it **phase by phase**, each phase shippable and tested.

## 2. What exists today (findings)

| Area | Where | Notes |
|---|---|---|
| Nav | `web/src/App.jsx:53` `PROJECT_NAV` | Has both `sessions` and `runs`; the pending-approval count badge sits on `runs` (`App.jsx:215`). |
| Sessions UI | `web/src/pages/Sessions.jsx` (451 lines) | List of cards → detail page. Detail stacks everything vertically: facts, Jira, `LiveGraph`, composer, history, goal. History is oldest-last but rendered reversed. |
| Runs UI | `web/src/pages/Runs.jsx` (1208 lines) | List + free composer + `RunView` (tree, timeline, result, changes, push, follow-up). **Sessions imports `Timeline`, `useRunStream`, `JiraTicketPicker` from it**, so it can't just be deleted. |
| Graph | `web/src/components/AgentGraph.jsx` | Nested `<ul>` of cards, not a node canvas. Data comes from `lib/tree.js` `buildTree(events)` — already gives main → subagent tree with status, items, tokens, cost. Reusable as-is. |
| Session engine | `server/workflows.ts` | `drive()` loop: one `startRun()` per iteration with `resumeOf` the previous run, `acceptEdits` + `autoApprove`. Pause/resume/stop/messages routes. |
| Worktree | `server/agent/runner.ts:264-270` | A resumed run **reuses the previous run's worktree**, so `/api/runs/<last_run_id>/changes` is already the cumulative diff of the whole session. |
| Prompt | `server/guardrails.ts:97` `composeIterationPrompt` | Has goal, Jira (fenced as untrusted), rules, progress, instructions, check. No "context" section. |
| Who links to `#/…/runs/<id>` | `InputCard.jsx:18`, `Builder.jsx:424` (agent test), `Tickets.jsx:408` (analyze) and `:571` (`runs/new?jiraKey=`), `Review.jsx:270`, `Insights.jsx:816`, `Sessions.jsx` ×3, `test/ui/ui-smoke.ts:126` | These are runs **not owned by a session** (tests, analyses, reviews). They still need a viewer. |
| Uploads | `server/http.ts:25` raw body buffer; `server/knowledge.ts:131` `uploadDocument` + `convert.ts` | Reusable for context files (Word/PDF/Excel → Markdown). |
| Demo | `server/agent/demo.ts` | Spawns subagents (`parent_tool_use_id`) and supports `[demo-iterations: N]`, `[demo-block]`, `[demo-stuck]` — enough to test the canvas and session states without a key. |

## 3. Target UX

### 3.1 Navigation

```
Knowledge · Learn · Tickets · ▶ Sessions (3)  · Code review · Repositories · Agents and skills · Insights · Project and team
                                 └ badge = pending approvals/questions + blocked sessions
```

- "Agent runs" removed from the rail.
- Old links keep working:
  - `#/p/<pid>/runs/<runId>` → if the run belongs to a session (`meta.workflowId`) go to
    `sessions/<wid>?run=<runId>`; otherwise open the **run viewer** at `sessions/run/<runId>`.
  - `#/p/<pid>/runs/new?jiraKey=…` → `sessions/new?jiraKey=…` (new-session dialog pre-filled).
- One-off runs (agent tests, ticket analyses, code-review runs) show up in the Sessions list
  under an **"Other runs"** filter, read-only, opened in the run viewer.

### 3.2 Sessions page = master–detail workspace

```
┌─ Sessions ─────────────────┬───────────────────────────────────────────────────────────────┐
│ [+ New session]  [search]  │  RLP-2683 Fix refund limit          ● Running  [Pause] [Stop] │
│ ▸ Needs you (1)            │  iter 3/8 ▓▓▓░░░░░  $1.20 / $5 ▓▓░░░  ⎇ agent/rlp-2683 → main │
│   ● RLP-2701 …  approve ⏎  │  [Live] [Changes 12] [History] [Context 4] [Settings]         │
│ ▸ Running (2)              │ ┌──────────────── canvas ───────────────┐┌── Inspector ──────┐ │
│   ● RLP-2683 … ◉◉◯ 3 agents│ │          (Main)◉                      ││ backend-agent     │ │
│   ● Docs for api …         │ │        ╱    │     ╲                   ││ working · 14 tools│ │
│ ▸ Ready for review (4)     │ │   (BE)◉  (FE)◯   (QA)✓                ││ Brief from main…  │ │
│ ▸ Other (6)                │ │     │                                 ││ ▸ Read src/…      │ │
│ ─ Other runs (tests…) ─    │ │   (test)◉                             ││ ▸ Edit refund.ts  │ │
│                            │ └─ iter: ①✓ ②✓ ③● ───────── [fit][⤢]──┘│ ▸ Bash npm test ⟳ │ │
│                            │ ┌ Tell the agents… [📎 context] [Send ⌘⏎]───────────────────┐ │
└────────────────────────────┴───────────────────────────────────────────────────────────────┘
```

- **Left list**, grouped by state: *Needs you* (blocked or pending input) → *Running* →
  *Ready for review* → *Other*. Each row: status dot, title, one-line "now doing", mini
  bubble count of active agents, time. Search + "mine only" filter. Collapses to a drawer
  under 900px.
- **Header**: title, status pill, one primary action (Pause/Resume), Stop, progress bars for
  iterations and budget (USD or Kiro credits), branch chip `work_branch → base`, Jira chip,
  lead-agent chip.
- **Tabs** (URL-synced `?tab=`):
  - **Live** (default): pending approvals/questions banner (reuse `InputCard`) → agent canvas
    + inspector → **iteration strip** (one chip per iteration/run; click to replay that
    run's graph; the live one is pinned).
  - **Changes**: cumulative diff of the session's worktree (`/api/runs/<last_run_id>/changes`,
    reuse `DiffView`), file list, download, **Push / open PR** (move `PushDialog`, pre-filled
    with `work_branch` and base branch).
  - **History**: newest first; human instructions, iteration summaries, check results,
    status changes; each iteration links to its run in the canvas, not to a separate page.
  - **Context**: what the agents were given (see §5), add/remove.
  - **Settings**: today's `SessionForm` in edit mode, inline instead of a modal.
- **Composer docked at the bottom** of the detail pane, always visible: text area,
  📎 *Add context*, ⌘/Ctrl+Enter to send. Label switches between "Queue for next step" and
  "Send and continue" as today.

### 3.3 New session dialog — simpler, progressive

Step 1 (always visible): **Goal** (or Jira ticket), **Context** chips (+ add), **Repository** and
**base branch**.
"More options" (collapsed): template (*Build/fix* · *Quick task = 1 iteration* · *Document a
repository* — replaces the Runs "Document a repository" composer), lead agent, model, budget,
max iterations. Defaults stay as now (sonnet, $5 / 20 credits, 8 iterations).

## 4. Agent canvas (bubbles / nodes)

New `web/src/components/AgentCanvas.jsx` + `web/src/lib/graphLayout.js`, **no new dependency**
(SVG edges + HTML bubbles; React Flow would add ~150 KB for little gain here).

- **Input**: the existing `buildTree(events)` result. No server change needed.
- **Layout** (`graphLayout.js`, pure function, unit-tested): top-down tidy tree —
  `y = depth × rowGap`, `x` from subtree leaf counts so parallel subagents sit side by side.
  Memoised on `(node ids, child order)` so status changes don't re-layout.
- **Bubble**: circle with role initials, hue from `hueFor(label)`; status ring —
  running = pulsing ring, waiting = amber, done = check, failed = red, stopped = grey.
  Label + one-line *now doing* (reuse `nowLine()` from `AgentGraph.jsx`), tool count and
  cost in a small caption. New bubbles animate in when the main agent calls `Agent`/`Task`.
- **Edges**: SVG cubic curves parent → child; animated dashed stroke while the child runs.
- **Interaction**: click/Enter selects → inspector shows that node's `Timeline` (reused) with
  the brief, tool calls (expandable input/result), report back. Toggle **Follow live**
  (auto-select the most recently active node). Pan (drag), zoom (wheel/pinch), *Fit*,
  *Expand* (full-screen). Completed subtrees can collapse.
- **Accessibility**: bubbles are buttons with `aria-label="backend-agent, working, 14 tools"`;
  arrow keys move parent/child/sibling; `prefers-reduced-motion` disables pulse/dash
  animations; the current nested list (`AgentGraph`) stays as a "List view" toggle and is the
  default under 600px wide.
- **Performance**: `useRunStream` currently does `setState` per SSE event; batch events per
  animation frame (`requestAnimationFrame` queue) so a burst of tool events renders once.
- **Theming**: styles in `styles.css` with HUD overrides in `hud.css` (glow rings, scanline
  edges) to match the existing look switch.

## 5. Context for the agents

### Kinds
| Kind | Stored as | Given to the agent as |
|---|---|---|
| Knowledge document | reference to `documents.id` | path under `docs/md/…` + title; agent reads it |
| Uploaded file | `projects/<slug>/work/sessions/<wid>/context/<file>`; Office/PDF converted to `.md` via `convert.ts` | path to the `.md` (and original) |
| Note | text (≤ 8,000 chars per note) | inlined |
| URL / snippet | text | inlined, fenced |
| Earlier run / session result | reference to `runs.id` / `workflows.id` | its result/summary inlined (trimmed) |
| Jira ticket | already `workflows.jira_key` | unchanged (re-read each iteration) |

### Backend
- **DB migration** (`server/db.ts`, append to migrations list):
  ```sql
  CREATE TABLE IF NOT EXISTS workflow_context (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,            -- doc | file | note | url | run | session
    ref TEXT NOT NULL DEFAULT '',  -- document id, run id, relative file path
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '', -- note text / snippet
    size INTEGER NOT NULL DEFAULT 0,
    event_id INTEGER,              -- set when attached to an instruction message
    created_by TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workflow_context_wf ON workflow_context(workflow_id);
  ```
- **Routes** (`server/workflows.ts`, editor role, project checked via `requireProject`):
  - `GET    /api/workflows/:id/context`
  - `POST   /api/workflows/:id/context` — `{ kind, ref?, title?, body? }`
  - `POST   /api/workflows/:id/context/upload?name=…` — raw body, same size/type limits as
    knowledge uploads
  - `DELETE /api/workflows/:id/context/:cid`
  - `POST /api/projects/:pid/workflows` and `POST /api/workflows/:id/messages` accept
    `context: [...]` so context can be added in the same request.
- **Prompt** (`guardrails.ts` `composeIterationPrompt`): new `context` input rendered as
  `## Context provided by the team` — files/docs as a path list with "Read these before
  planning", notes/snippets/results inlined inside an untrusted-content fence (same wording as
  the Jira fence). Total inline budget ~20k chars; overflow is written to a file and referenced.
  Context attached with a message is flagged "new since last iteration".
- **Safety**: file names sanitised (`safeName`), path kept inside the session context folder,
  type allowlist and size cap reused from knowledge uploads; deleted with the session;
  context folder is readable by the agent but outside its write dir.

### UI
- `ContextPicker` popover used in both the new-session dialog and the docked composer:
  tabs *Documents* (search project knowledge), *Upload* (drop zone), *Note*, *Earlier work*
  (pick a run/session). Chips show attached items; × removes.
- **Context** tab lists everything with who added it and when.

## 6. Project monitoring

- List endpoint returns live fields so the list needs no per-session stream:
  `pending_inputs` (pending `inputs` on `last_run_id`), `last_run_status`, `context_count`,
  `now` (last tool/text line, cached on the workflow row when `run.updated` fires — cheap,
  set in `runner.ts` alongside `notifyProject`).
- List refreshes on the existing project stream events `workflow.updated`, `run.updated`,
  `input.created`, `input.resolved` (debounced, as `AgentActivity` does).
- Rail badge on Sessions = pending inputs + blocked sessions.
- Optional (phase 5): browser notification and tab-title counter when a session becomes
  *Needs you* or *Ready for review*.

## 7. File-by-file change list

### Frontend
| File | Change |
|---|---|
| `web/src/pages/Runs.jsx` | **Deleted** at the end of phase 1, after extraction below. |
| `web/src/lib/useRunStream.js` | **New** — `useRunStream` moved out of Runs, plus rAF batching. |
| `web/src/components/run/Timeline.jsx` | **New** — `Timeline`, `TimelineItem`. |
| `web/src/components/run/Changes.jsx` | **New** — `Changes`, `FileModal`, `isBinaryPath`. |
| `web/src/components/run/PushDialog.jsx` | **New** — moved. |
| `web/src/components/run/RunViewer.jsx` | **New** — trimmed `RunView` for one-off runs (canvas + inspector + Result/Changes/Request tabs, follow-up, push). |
| `web/src/components/JiraTicketPicker.jsx` | **New** — moved from Runs. |
| `web/src/components/AgentCanvas.jsx`, `web/src/lib/graphLayout.js` | **New** — §4. |
| `web/src/components/ContextPicker.jsx` | **New** — §5. |
| `web/src/pages/sessions/SessionsPage.jsx` | **New** — master–detail shell, routing (`sessions`, `sessions/new`, `sessions/<wid>`, `sessions/run/<runId>`). |
| `web/src/pages/sessions/SessionList.jsx` | **New** — grouped list, filters, "Other runs". |
| `web/src/pages/sessions/SessionWorkspace.jsx` | **New** — header, tabs, docked composer. |
| `web/src/pages/sessions/{LiveTab,ChangesTab,HistoryTab,ContextTab,SettingsTab,IterationStrip,NewSessionDialog}.jsx` | **New** — split of today's `Sessions.jsx`. |
| `web/src/pages/Sessions.jsx` | Re-exports `SessionsPage` (keeps `App.jsx` import stable) or removed. |
| `web/src/components/AgentGraph.jsx` | Kept as the list view / small-screen fallback. |
| `web/src/App.jsx` | Remove `runs` from `PROJECT_NAV`; badge on `sessions`; `case 'runs'` → redirect helper. |
| `web/src/lib/router.js` | Add query (`?tab=`, `?run=`) helpers if missing. |
| `InputCard.jsx`, `Builder.jsx`, `Tickets.jsx`, `Review.jsx`, `Insights.jsx` | Links → `sessions/run/<id>` (or redirect helper `runHref(projectId, run)`). Tickets "Start coding run" → opens new-session dialog. |
| `web/src/styles.css`, `web/src/hud.css` | Workspace grid, canvas, bubbles, docked composer, responsive rules. |

### Backend
| File | Change |
|---|---|
| `server/db.ts` | Migration: `workflow_context`; `workflows.now_line TEXT DEFAULT ''`. |
| `server/workflows.ts` | Context routes; `context` on create/message; list view adds `pending_inputs`, `last_run_status`, `context_count`, `now_line`; template `quick` → `max_iterations = 1`, `document` → document goal via `composeDocumentPrompt`. |
| `server/guardrails.ts` | `composeIterationPrompt({ …, context })` section + fence. |
| `server/runs.ts` | `GET /api/runs/:id` returns `workflow_id` (from `meta.workflowId`) for redirects. Free-task `POST /api/projects/:pid/runs` stays (Tickets/Builder/Review use internal routes) but the UI no longer calls it directly. |
| `server/agent/runner.ts` | On assistant/tool events of a session run, update the workflow's `now_line` (throttled, ≤ 1/s). |

### Tests
| File | Change |
|---|---|
| `test/workflows.test.ts` | Context CRUD, upload limits, path traversal rejected, context reaches prompt (demo agent echoes), `quick` template stops after 1 iteration, list live fields. |
| `test/graph-layout.test.ts` | **New** — layout: single node, siblings don't overlap, deep chains, stable positions on status change. |
| `test/ui/ui-smoke.ts` | Replace the "Agent runs" step: create session in Demo mode with `[demo-iterations: 2]`, see bubbles appear, click a subagent bubble → inspector shows its brief, open Changes tab, add a note as context; old `#/…/runs/<id>` URL redirects. |

## 8. Phases

| # | Phase | Deliverable | Done when |
|---|---|---|---|
| 0 | **Extract** | Move shared pieces out of `Runs.jsx` (§7 "New — moved"). No visible change. | `npm run typecheck`, `npm test`, `npm run test:ui` pass unchanged. |
| 1 | **IA cut-over** | Remove Agent runs nav; run viewer at `sessions/run/<id>`; redirects; all links updated; badge moved; "Other runs" filter. | Every old link lands somewhere sensible; ui-smoke updated and green. |
| 2 | **Workspace** | Master–detail list, header with progress bars, tabs (Live/Changes/History/Settings), docked composer, Changes tab with push/PR, simpler new-session dialog with templates. | Session can be created, watched, instructed, pushed without leaving the page. |
| 3 | **Agent canvas** | `AgentCanvas` + inspector + iteration strip + follow-live + rAF batching; list view fallback. | Demo run shows bubbles appearing live; keyboard + reduced-motion checked; layout tests pass. |
| 4 | **Context** | Migration, routes, prompt section, `ContextPicker`, Context tab, attach-with-message. | Tests in `workflows.test.ts` pass; demo prompt shows the context section. |
| 5 | **Monitoring polish** | Live list fields (`now_line`, pending inputs), notifications, mobile drawer, empty states, HUD styling pass. | Manual check at 1440 / 1024 / 400 px in both looks. |

Each phase is one commit (or PR) on a feature branch; phases 0–1 can land together.

## 9. Risks

- **Approvals inside sessions**: sessions run `acceptEdits` + `autoApprove`, so the
  "Needs you" group mostly comes from *blocked* status, not tool approvals. Adding an
  "Ask before commands" mode is possible (the drive loop already `await`s `started.done`,
  so a waiting run just pauses the loop) but is out of scope unless wanted.
- **Re-render cost** with many events: mitigated by rAF batching and memoised layout.
- **Old chat runs** (free-task runs with follow-ups) remain viewable read-only in "Other
  runs"; "Continue this conversation" stays available in the run viewer.
- **Uncommitted local changes**: the repo currently has ~40 modified files and untracked
  Kiro work (`git status`). Commit or stash before starting phase 0 so the refactor diff
  stays reviewable.

## 10. Decisions needed before starting

1. One-off runs (agent tests, ticket analyses, review runs): keep as read-only **"Other runs"**
   inside Sessions *(recommended)*, or convert them into one-iteration sessions?
2. Add an **"Ask before commands"** approval mode to sessions now, or keep sessions fully
   autonomous *(recommended for now)*?
3. Canvas: **dependency-free SVG** *(recommended)* or React Flow?
4. Order: run phases 0→5 in sequence *(recommended)*, or start with the canvas (phase 3)
   for a quick visible win?
