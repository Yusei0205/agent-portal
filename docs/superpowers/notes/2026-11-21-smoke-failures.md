# UI smoke failures on main_v3 (2026-11-21)

Scope: `test/ui/smoke.ts`, branch `claude/agent-portal-cdqxa9` at 1cf2719. The failures predate the Kyuubit rebrand
(identical at 9c57fab). Method: run the suite, capture the exact case names and messages, find the root cause of each,
then decide with evidence whether the test is stale (the product changed on purpose) or the product regressed.

## Results

| Run | Passed | Failed |
|---|---|---|
| Before, full suite (`npm run test:ui:fast`) | 194 | 14 (all distinct cases below, plus 1 more that did not fail in this run: composer pinned) |
| Before, `SMOKE_ONLY=shell,sessions,projects` | see per-case list | rail x3, Bulk-select hint (when run without section 49), 390 px x2 (composer intermittent) |
| After, full suite, run 1 | 208 | 0 |
| After, full suite, run 2 | 208 | 0 |
| After, `SMOKE_ONLY=shell,sessions,projects` | 81 | 0 (see end of file) |

`npm run typecheck` clean, `npm run test:map:check` 0 errors (66 warnings, unchanged), `npm run build:web` clean.

The first full run also showed failures that are not in the original list but are real: Users page, Settings > Code
review (two cases), Codex device sign-in, and four dashboard Agent network cases. The "stale test vs product bug"
verdicts below cover all of them.

## Per failure

### 1. Rail sections / no Inbox in rail: STALE TEST
- Cause: `7b42d8b` (2026-11-18) added `{ tab: 'inbox', label: 'Inbox', badge: true }` to the unlabelled top rail section.
  The test still said "Inbox NOT in rail (moved to top bar)".
- Evidence: the change is deliberate and pinned by a unit test, `test/web-command-center.test.ts:50`
  (`getByRole('link', { name: 'Inbox (4 unread)' })` has href `#/inbox`). `docs/user-guide.md` still says Inbox is a
  top-bar icon, which is true as well (both exist), but its rail table is older (see "Docs" below).
- Fix: assert exactly one Inbox link in the rail with href `#/inbox`. Commit "Smoke: rail tests follow the collapsible
  secondary sections and the Inbox rail item".

### 2. Connections rail item links to /connect/code-hosts, and 7. Nav Connections link: STALE TEST
- Cause: same commit made Project tools, Connect, Agents and Portal collapsible disclosures (`secondary: true`;
  `<ul hidden>` unless the current route is inside the section). The tests waited for the links without opening the section.
- Evidence: `Rail.jsx` `NavSection` (`disclosure = section.secondary && !collapsed`), CSS `.rail-section-toggle`.
- Fix: `expandRailSection()` helper clicks the heading toggle and waits for `aria-expanded="true"`; the Connections test
  also checks the toggle collapses the section again. Same commit as 1. (The expanded state is sticky across tests in the
  same tab, so the test must not assert "starts collapsed".)

### 3. Collapsed rail link count (21, limit 14): REAL (small) REGRESSION, product fixed
- Cause: the test's count was a proxy for "fits at 1280x800 without scroll". `layout.css` explicitly tunes the collapsed
  rail "so all icons fit at 800 px" (28 px hit targets). `7b42d8b` grew the rail to 21 links (admin) and in icon-only mode
  every link is shown (no disclosure), so `.rail-nav-wrap` overflowed: scrollHeight 656 > clientHeight 620.
- Evidence: measured in the browser; links are 28 px high, 21 x 28 = 588, the rest was dividers and gaps.
- Fix (product): collapsed spacing in `web/src/styles/layout.css` only: hide the first section's divider, divider margin
  1 px, no extra section gap, rail gap 2 px. Hit targets stay 28 px. Test now asserts all links are visible (>= 19) and
  `scrollHeight <= clientHeight` instead of a link-count window. Commit "Collapsed rail: fit all 21 links at 1280x800
  without scrolling".

### 4. 'ide-editor-area hidden at 390 px': STALE TEST
- Cause: `7b42d8b` added `session-studio.css`: `.session-studio .session-work-pane { display:flex !important }` and, in
  `@container (max-width: 760px)`, `.ide-main-row { flex-direction: column }` with the work pane (`.ide-editor-area
  .session-work-pane`) stacked above the conversation (`width:100%; min-height:160px`). That overrides the old
  `sessions.css` rule that hid the editor on phones (that rule is now dead).
- Evidence: the stacked layout is explicit and has its own mobile rules (`.session-work-pane .ide-resize-handle-x`,
  header span hiding); the work pane now also hosts the Execution and Review modes, so hiding it would hide them.
- Fix: assert the new behaviour: the pane renders, stays inside the viewport, does not overlap the conversation, and the
  conversation is still on screen. Commit "Smoke: at 390 px the session work pane is stacked above the chat, not hidden".
- Not changed: the dead `.ide-workspace .ide-editor-area { display:none !important }` block and its comment in
  `sessions.css` (cosmetic, out of scope).

### 5. 'Composer pinned at 390 px' (intermittent): REAL BUG, product fixed
- Cause (found by dumping the layout tree in the failing state, which was stable, not transient): the empty
  conversation placeholder `.ws-placeholder` (`flex:1`, `padding:40px 20px`) has an intrinsic minimum height of 161 px. In
  the phone-stacked agent panel (232 px) the 36 px header + 161 px placeholder + 120 px composer = 317 px, so the
  composer ended at y=876 (viewport 844), clipped by `.ide-body { overflow:hidden }`. It only happens for a session with
  no messages, so whether the test failed depended on what earlier tests had written to the demo session (test order,
  `SMOKE_ONLY`). A real user opening a new session on a phone gets the same thing.
- Not a timing race: 25 reloads with a per-frame sampler showed the same bad value from the first frame to 2.6 s.
- Fix (product): `.session-studio .ide-agent-panel .ws-placeholder { min-height:0; overflow-y:auto }` in
  `session-studio.css`; the sampler then reported 0 bad frames in 25 reloads. Test: no fixed sleeps (waits for the composer
  to be visible, then `document.fonts.ready` and two animation frames), plus a new assertion that the composer is not
  clipped by `.ide-body`. Commit "Session chat: an empty conversation no longer pushes the composer out of view on phones".

### 6. 'Explorer panel': STALE TEST
- Cause: on a window wider than 1050 px a session opens with Files already showing (`useState(... ? 'explorer' : null)`
  in `IdeWorkspace.jsx`, since `5a8f536`/`7b42d8b`), and the activity button toggles. The test clicked it and so closed the sidebar.
- Fix: close first if `aria-pressed="true"`, then open; wait on `aria-pressed` and the `aside[aria-label="Explorer"]`
  instead of a 600 ms sleep. Commit "Smoke: the Explorer activity button is a toggle".

### 8. 'Bulk-select hint': TEST ORDER RACE (not product)
- Cause: the test before it (section 48) ends on the POST that starts a session; the app then navigates into the new
  session, possibly after the next test's `goto`, which takes over the page (observed URL was the new session, list
  collapsed, so `.sessions-list-panel` never became visible). Section 49 already contained a comment and a 1.5 s sleep
  for exactly this, so the failure only showed when 49 was not in the run (`SMOKE_ONLY=shell,sessions,projects`).
- Fix: section 48 waits for the session URL (`waitForURL`), and the sleep in 49 is removed. Commit "Smoke: wait for the new
  session to open instead of racing the next test".

### Additional failures found in the full run

- **Users page; Settings > Code review (threshold + rate card, negative rate); "Settings page is accessible" banner;
  PR comment mode**: TEST LEAK. "Pipelines tab: a member sees the settings read-only" mocks `/api/auth/state` as non-admin
  and reloads; the shell keeps that user after the mocks are removed, so later tests that need an admin (they only ran
  after the Setup section) failed. Reproduced with `SMOKE_ONLY=setup,permissions,settings`. Fix: reload after unrouting
  and wait for the admin-only Users link. Commit "Smoke: the member-state Pipelines test restores the admin user when
  it ends".
- **Pipelines "saving settings reloads the list"** (surfaced after the fix above; about 1 run in 4): the mock failed every
  settings GET after the first, but the panel can load twice. Fix: switch the failure on right before the click it
  tests. Commit "Smoke: the Pipelines status-refresh failure is switched on by the click, not by a GET count". The double
  load itself is a minor inefficiency, not investigated.
- **Codex device sign-in**: TEST BUG. A hash-only `goto` to the route the previous test is on keeps the mounted
  component, which has already loaded the real `/api/codex/status`; the mock is never used (the page showed "Codex CLI
  was not found on the portal host"). The next test already hops through `/projects` for this reason. Fix: do the same.
  Commit "Smoke: Codex sign-in test leaves the page first so its route mocks are used".
- **Dashboard Agent network x4** (node click, Enter key, single card, no zoom toolbar): STALE TEST. The network now sits in
  `<details class="db-network-disclosure">`, closed by default; `test/web-dashboard-insights.test.ts` asserts it is
  hidden until the summary is clicked ("available on demand"). Fix: `openNetwork()` asserts it starts collapsed, opens
  it, waits for a card. Commit "Smoke: Agent network lives in an on-demand disclosure on the dashboard".
  The last of the four then hit 404s from its own mocked recent session `sess-smoke-1`; allow exactly as many bare
  404 console lines as there are 404s for that fake id. Commit "Smoke: the dashboard JS-error check ignores the 404s
  its own mocked session causes".

## Docs

`docs/user-guide.md` (Rail section, around line 50) still describes four sections (Work, Connect, Quality, Account) and
"nothing expands or collapses". It is stale against the current rail (Portal, Work, Project tools, Knowledge, Connect,
Agents, Portal admin; the secondary ones collapse). Not changed here; it needs its own pass.
