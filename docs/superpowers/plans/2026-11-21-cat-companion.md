# Cat Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the still line-drawn cat with a pixel-art cat that roams along the bottom, can be dragged, reacts to live project events, and offers a Roam/Sit/Hidden menu (phase A). Phase B (a chat panel) is outlined at the end and is not part of this build.

**Architecture:** Three small pure modules in `web/src/lib/` (sprites, mood mapping and throttle, roaming brain and preferences) with node tests; a `CatSprite` component that plays a sprite sheet with CSS `steps()`; `CatMascot.jsx` is rewritten to combine them (state, roaming, drag, hover, tip and reaction bubbles, mode menu, event subscription) and is mounted in `App.jsx` with the open project id and the inbox count.

**Tech Stack:** React (web/src), plain JS modules, CSS (theme tokens), `node:test` with tsx for the pure modules, Playwright UI smoke.

**Spec:** `docs/superpowers/specs/2026-11-21-cat-companion-design.md` (read "Builder's calls").

## Global Constraints

- Web only: no server change, no network call, no new dependency (no Framer Motion).
- Roaming only when width >= 601 px, not `prefers-reduced-motion: reduce`, no text field focused, no dialog open (`[role="dialog"][aria-modal="true"]` present). Otherwise the cat sits.
- Constants (in `web/src/lib/cat-brain.js`): `WALK_SPEED_PX_S = 40`, sit 3000-8000 ms, walk 60-200 px, `REACTION_GAP_MS = 20000`, `REACTION_SHOW_MS = 8000`, drag threshold 6 px.
- Reactions only for the open project's events: `workflow.updated` `done` => celebrate, `failed` => worried, `blocked` => alert; `inbox.created` => alert. Nothing else. None while `document.hidden`. At most one per 20 s.
- Preferences in `localStorage` key `portal.cat.prefs` = `{ mode: 'roam' | 'sit' | 'hidden', x: number | null (0..1), bottom: number }`; every storage access wrapped in try/catch; works with storage unavailable.
- Theme tokens only (`--panel`, `--ink`, `--ink-2`, `--ink-3`, `--accent`, `--line`, `--raised`); light and dark. z-index 150. No coloured left stripes. No horizontal page scroll at 360-412 px. Under reduced motion no animation runs (first frame only).
- The cat's hit area is only the sprite (about 56 px; 44 px on phones); the wrapper has `pointer-events: none`.
- Tests: `node --disable-warning=ExperimentalWarning --import tsx --test <file>`; `npm run typecheck` 0 errors. Commit trailers: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01VKUCrkTguukHMdu9Rm7sub`.

## Review Focus

- A burst of 10 `workflow.updated` events: one reaction, then silence for 20 s.
- Typing in a text field while the cat is walking: it stops and sits, and does not walk over the field while you type.
- Dragging released outside the window, or a window resize after dragging: the cat is pulled back inside.
- Storage disabled or holding garbage JSON: defaults, no crash.
- Switching project or signing out: the old subscription closes (no events from the previous project).

---

### Task 1: Preferences, mood mapping and roaming brain (pure modules)

**Files:**
- Create: `web/src/lib/cat-prefs.js`, `web/src/lib/cat-mood.js`, `web/src/lib/cat-brain.js`
- Test: `test/cat-companion.test.ts`

**Interfaces (all plain JS, ES modules):**
- `cat-prefs.js`: `DEFAULT_CAT_PREFS = { mode: 'roam', x: null, bottom: 16 }`; `loadCatPrefs(storage?: Storage): { mode, x, bottom }` (validates: `mode` in the three values, `x` a finite number clamped 0..1 or null, `bottom` a finite number clamped 0..400; anything else falls back to the default for that field; storage errors or invalid JSON => defaults); `saveCatPrefs(prefs, storage?): void` (never throws).
- `cat-mood.js`: `type CatReaction = { animation: 'celebrate' | 'worried' | 'alert'; text: string; href: string | null }`; `moodForEvent(event: object, ctx: { projectId: string }): CatReaction | null`; `createReactionGate(gapMs = REACTION_GAP_MS): (nowMs: number, hidden: boolean) => boolean` (true at most once per gap, never while hidden, and an allowed call consumes the gap).
  - Copy: done "A session finished.", failed "A session failed.", blocked "A session is blocked and needs you.", inbox.created "Something needs you in the Inbox."; href `#/p/<projectId>/sessions/<workflowId>` when a workflowId is present for workflow events, `#/inbox` for inbox events and when no workflowId.
- `cat-brain.js`: exports the constants above; `roamAllowed(env: { width: number; reducedMotion: boolean; typing: boolean; dialogOpen: boolean }): boolean`; `type BrainState = { phase: 'sit' | 'walk'; x: number; targetX: number; dir: 1 | -1; until: number }`; `initialBrain(x: number, nowMs: number): BrainState` (sit, until = now + 3000); `nextBrainStep(s: BrainState, nowMs: number, rng: () => number, bounds: { min: number; max: number }): BrainState` (when phase is 'sit': choose a direction (toward the interior when within 60 px of an edge, else random), a distance 60..200 clamped to the bounds, `targetX`, `until = now + distance / WALK_SPEED_PX_S * 1000`, phase 'walk'; when 'walk': `x = targetX`, phase 'sit', `until = now + 3000 + rng() * 5000`); `clampX(x: number, bounds): number`.

- [ ] **Step 1: Write the failing tests** (`test/cat-companion.test.ts`, import the three modules with the `// @ts-expect-error` pattern used in `test/agent-orbit.test.ts`): prefs: `loadCatPrefs` with an empty storage returns defaults; with `{"mode":"hidden","x":0.4,"bottom":30}` returns them; with garbage JSON, a mode of `"dance"`, `x: 7` (clamped to 1) and `bottom: -5` (clamped to 0) returns the corrected values; a storage whose `getItem` throws returns defaults; `saveCatPrefs` with a throwing `setItem` does not throw; save then load round-trips. Mood: the four event cases return exactly the specified animation, text and href; `workflow.updated` with `running`, `paused` or no status => null; `run.event`, `pipeline.run` and `inbox.created` with a missing `itemType` still => alert for `inbox.created` (itemType is not required); an event without a `type` => null; `moodForEvent(null)` => null. Gate: first call true, a second call 5 s later false, a call 20 s after the first true, a call with `hidden: true` false and not consuming the gap. Brain: `roamAllowed` false for width 600, for `reducedMotion`, `typing`, `dialogOpen`, true for 601 with all others false; `nextBrainStep` from a sit state with a fixed rng returns a walk with `targetX` inside the bounds, a duration of distance/40 s, and the walk state returns to sit at `targetX`; at `x = bounds.min` the direction is +1, at `bounds.max` it is -1; `clampX` keeps values in the bounds and handles `min > max` (a tiny window) by returning `min`.
- [ ] **Step 2: Run it.** Expected: FAIL (modules not found).
- [ ] **Step 3: Implement the three modules** to the signatures above (no DOM access except the optional `storage` argument defaulting to `globalThis.localStorage` inside try/catch).
- [ ] **Step 4: Run the tests and `npm run typecheck`.** Expected: PASS, 0 errors.
- [ ] **Step 5: Commit** `feat(cat): preferences, mood mapping and roaming brain`.

### Task 2: Pixel sprites

**Files:**
- Create: `web/src/lib/cat-sprites.js`, `web/src/components/CatSprite.jsx`
- Test: `test/cat-sprites.test.ts`

**Interfaces:**
- `cat-sprites.js`: `export const SPRITE_SIZE = 16`; `export const PALETTE_KEYS = { o: 'outline', f: 'fur', b: 'belly', a: 'accent', e: 'eye', k: 'blush' }` (each key maps to a CSS custom property set by the component: `--cat-outline`, `--cat-fur`, `--cat-belly`, `--cat-accent`, `--cat-eye`, `--cat-blush`; `.` is transparent); `export const SPRITES: Record<'walk' | 'idle' | 'wave' | 'celebrate' | 'worried' | 'alert', { frames: string[][]; fps: number; loop: boolean }>` where each frame is 16 strings of 16 characters; frame counts: walk 4, idle 4, wave 2, celebrate 4, worried 2, alert 2; `export function sheetRects(name: SpriteName): Array<{ x: number; y: number; frame: number; key: string }>` (one entry per non-transparent pixel with `x` in 0..15, `y` in 0..15, `frame` the index, so a sheet is `frames * 16` wide); `export function frameCount(name): number`.
- `CatSprite.jsx`: `export function CatSprite({ name, flip, size })` renders a `div.cat-sprite` (fixed `size` px square, `overflow: hidden`, `transform: scaleX(-1)` when `flip`) containing one inline `<svg viewBox="0 0 {16*frames} 16" shape-rendering="crispEdges">` of `<rect>`s coloured with `fill: var(--cat-<role>)`, translated by a CSS animation `steps(frames)` over `frames / fps` seconds (`infinite` when `loop`, `forwards` otherwise); `aria-hidden="true"`.

- [ ] **Step 1: Write the failing tests:** every sprite has the required number of frames; every frame has exactly 16 rows of exactly 16 characters; only `.` and the six palette keys occur; each frame has at least 40 non-transparent pixels (it is a cat, not an empty frame); `walk` frames differ from each other (at least 3 distinct frames of 4); `sheetRects('idle').length` equals the sum of the non-transparent pixels of its frames and every rect's `frame` is below `frameCount('idle')`; the idle frames differ only slightly from frame 0 (blink = fewer eye pixels: frame 1 has fewer `e` pixels than frame 0).
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Draw the sprites** as 16x16 grids (a sitting cat seen from the side; walk cycle of four poses; wave raises one paw; celebrate is a hop with both paws up; worried has flattened ears and a sweat drop; alert is standing tall with an exclamation mark in `a`), implement `sheetRects` and `frameCount`, and the component with its CSS in `web/src/styles/mascot.css` (the keyframes use `steps()`; under `prefers-reduced-motion: reduce` no animation and the first frame shows).
- [ ] **Step 4: Run the tests, `npm run typecheck` and `npm run build:web`; render each animation's first frame once in a scratch HTML page with the real tokens (as done for the existing cat) and look at the screenshot.** Expected: PASS, build OK, the cat is recognisable in light and dark.
- [ ] **Step 5: Commit** `feat(cat): pixel sprites and sprite component`.

### Task 3: The cat companion component

**Files:**
- Modify: `web/src/components/CatMascot.jsx` (rewrite; keep the exported name `CatMascot` and `CAT_TIPS`), `web/src/styles/mascot.css`, `web/src/App.jsx` (`<CatMascot projectId={route.projectId} inboxCount={inboxCount} />`)
- Test: `test/ui/smoke.ts` cases (Task 4)

**Interfaces:**
- Consumes: Tasks 1 and 2; `subscribeProject(projectId, onEvent): () => void` from `web/src/lib/events.js`.
- Produces: `CatMascot({ projectId, inboxCount })`.

- [ ] **Step 1: Implement** (no unit test for the component; behaviour is covered by Task 4's smoke cases):
  - State: `prefs` (loaded once with `loadCatPrefs`, saved on change), `brain` (`initialBrain`), `tip`, `bubble` (`{ kind: 'tip' | 'reaction'; text; href } | null`), `menuOpen`, `reaction` animation override.
  - Position: wrapper `position: fixed; bottom: prefs.bottom px; left: 0; transform: translateX(x px)`; roaming sets `transition: transform <duration>s linear` to the brain's `targetX`; `x` default = viewport width - 80 px (the right corner) when `prefs.x` is null; clamp on `resize`.
  - Roaming loop: one `setTimeout` per brain step at `brain.until`; recompute `roamAllowed` (width, `matchMedia('(prefers-reduced-motion: reduce)')`, `document.activeElement` is an input/textarea/select/contenteditable, `document.querySelector('[role="dialog"][aria-modal="true"]')`) at each step and on `focusin`/`focusout`; when not allowed, stop at the current `x` (set the transition to none and the position to the measured current x) and show `idle`. Mode `sit` never roams; mode `hidden` renders only the 24 px paw button (`aria-label="Show the cat"`).
  - Animation shown: reaction override while active, else `walk` while the brain walks, `wave` while hovered (desktop), else `idle`; `flip` follows `dir`.
  - Drag: pointer events on the cat button with `setPointerCapture`; movement under 6 px = click (shows the next tip, as today); at or above 6 px = drag (updates `x` and `bottom`, clamps inside the window, suppresses the click, saves prefs on release, resets the brain to sit at the new x).
  - Hover label (desktop, `(hover: hover)`): a small pill "Chat with Agent ✨" above the cat while hovered and no bubble is open; decoration only in phase A (`pointer-events: none`).
  - Bubble: as today (role status, polite), plus a reaction bubble with an optional "Open" link (`href`) and ×; reaction bubbles close after `REACTION_SHOW_MS`; the tip bubble keeps its desktop auto-open after 2 s (only for widths above 600 px).
  - Reactions: `useEffect` on `projectId`: when set, `subscribeProject(projectId, (ev) => { const r = moodForEvent(ev, { projectId }); if (r && gate(Date.now(), document.hidden)) showReaction(r) })`, cleaned up on change or unmount; also when `inboxCount` rises above its previous value (not on first load) and the gate allows, show the alert reaction "Something needs you in the Inbox." (`#/inbox`). `showReaction` sets the animation override for 3 s (celebrate/worried/alert) and opens the reaction bubble.
  - Menu: a small `⋯` button on the bubble and a long-press (500 ms) on the cat open a 3-item menu (`role="menu"`: Roam, Sit, Hidden; the current mode has `aria-checked`); choosing saves prefs. Escape closes menus and bubbles.
  - Cleanup: every timer, listener and subscription released on unmount.
  - CSS: positions and bubbles with theme tokens; sparkles = six small `::before`-style spans animated outward for 900 ms (only when motion is allowed); no `border-left` stripes; phone: no roaming, 44 px cat, bubble width `calc(100vw - 44px)`.
- [ ] **Step 2: Run `npm run typecheck`, `npm run build:web`, and the existing cat smoke case** (`SMOKE_ONLY=projects` with `PLAYWRIGHT_BROWSERS_PATH=/tmp/claude-0/-home-user-agent-portal/53cde52a-a68e-55bd-84ae-8a259f9dbfcb/scratchpad/pwb npm run test:ui:fast`). Expected: build OK; the existing desktop and phone cat cases still pass (adjust them only where the old SVG's selectors changed: `data-testid="cat-mascot"`, `cat-bubble`, buttons "Show a tip" and "Close tip" must stay).
- [ ] **Step 3: Commit** `feat(cat): roaming, dragging, reactions and mode menu`.

### Task 4: Smoke tests, screenshots and guide

**Files:**
- Modify: `test/ui/smoke.ts`, `docs/user-guide.md` (a short "Cat companion" subsection under the first section on navigating the portal; link in the table of contents if the guide lists subsections), `test/test-map.json` (add `web/src/lib/cat-*.js`, `web/src/components/CatMascot.jsx`, `CatSprite.jsx`, `test/cat-*.test.ts` to a `cat` module)

- [ ] **Step 1: Write the smoke cases** (projects section, next to the existing cat cases; mock the project event stream the way other smoke cases mock `EventSource` or `page.route` for `/api/projects/:id/events`; if the harness cannot feed server-sent events, expose the component's reaction entry point through a `window.__catReact(event)` hook that exists only when `localStorage['portal.cat.debug'] === '1'`, and use it): a `workflow.updated` with status `failed` shows a bubble "A session failed." with an Open link to the session; a second event 1 s later shows no new bubble; the bubble closes with ×; choosing Sit in the menu stops roaming and survives a reload (prefs); choosing Hidden shows only the paw button, which brings the cat back; dragging the cat 200 px left moves it and a reload keeps the position; typing in a text field makes the cat stop (its position stays unchanged over 3 s while the field is focused); at 390 px the cat does not move for 4 s and the page has no horizontal scroll; with `prefers-reduced-motion: reduce` emulated the cat does not move.
- [ ] **Step 2: Run them** (`npm run build:web`, then `SMOKE_ONLY=projects ... npm run test:ui:fast` with the Playwright path above) and take screenshots (desktop dark, desktop light, phone) of: idle, walking, hover label, the three reactions with their bubbles; look at them. Expected: all cases pass; the cat is clearly a cat at 56 px; bubbles do not overflow.
- [ ] **Step 3: Write the guide subsection and the test-map module;** run `npm run test:map:check` (0 errors) and `npm run typecheck`.
- [ ] **Step 4: Commit** `feat(cat): smoke tests, guide and test map`.

---

## Phase B outline (NOT part of this build; needs the user's go-ahead and answers to the spec's open questions)

- **Task B1: shortcuts panel.** Clicking the cat (or the "Chat with Agent" label) opens a floating panel (role dialog, non-modal, closes with Escape) with a greeting and buttons: Start a session (opens the existing New session dialog), Check what needs me (Inbox), Open Auto-fix, Open Pipelines, Search knowledge. A pure `catActions(route)` function decides which buttons show for the current page and project. Tests: unit test for `catActions`; smoke for opening, keyboard use and closing.
- **Task B2: assistant.** Server: an assistant endpoint and its session model, tool permissions (read-only first), budget cap and audit; client: a chat view in the panel with streaming. Not planned in detail: it starts with its own design once the open questions in the spec are answered.
