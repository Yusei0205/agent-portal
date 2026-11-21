# Kyuubit Brand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the portal to Kyuubit with the pixel-cat logo across every template, add the clover-green Kyuubit template as the default, and restyle the mascot to match the owner's cat.

**Architecture:** Brand lives in each theme JSON (`shared/themes/*.json` → `brand`); the web reads `tmpl.brand` with code fallbacks. A new built-in template is registered like the others; a one-time idempotent startup step switches an untouched default. The mascot is the painter in `web/src/lib/cat-sprites.js` coloured by CSS custom properties in `web/src/styles/mascot.css`.

**Tech Stack:** JSON themes, React web, TypeScript server, node:test, Playwright smoke.

**Spec:** `docs/superpowers/specs/2026-11-21-kyuubit-brand-design.md`

## Global Constraints

- Name `Kyuubit`; tagline `Lucky agents. Nine lives.`; logo SVG exactly the content of `docs/superpowers/assets/kyuubit-logo.svg` (use it verbatim for `brand.logoSvg` and as the basis of `web/favicon.svg`).
- Server identity strings (git identity, PR/auto-fix footers, MFA issuer, MCP client name, guard messages) unchanged.
- Other templates keep colours and fonts; only `brand` changes.
- Default template id `kyuubit`; marker setting `theme.kyuubit_default_applied`; the switch only happens when the active template is `aethrix-night` and the marker is absent; it sets the marker either way so it runs once.
- No new dependency; theme tokens in UI CSS; reduced motion respected; phone width without horizontal scroll.
- Tests: `node --disable-warning=ExperimentalWarning --import tsx --test <file>`; `npm run typecheck` 0 errors; `npm run test:map:check` 0 errors; `npm run build`. Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01VKUCrkTguukHMdu9Rm7sub`.

## Review Focus

- An owner who picked another template before this release (active ≠ `aethrix-night`) keeps it; one who later picks `aethrix-night` again is not switched back on the next start.
- A custom template with its own brand still shows that brand.
- The logo renders crisp at 16, 24 and 32 px in dark and light.
- Existing tests asserting "Agent Portal" in the UI or `aethrix-night` as the default are updated to the new truth, not deleted.
- The mascot keeps all animations, frame counts, the blink and working states, and the existing smoke cases pass.

---

### Task 1: Brand, Kyuubit template, default and favicon

**Files:**
- Create: `shared/themes/kyuubit.json`
- Modify: every `shared/themes/*.json` (`brand` only), `web/src/lib/templates/index.js`, `server/themes.ts` (built-ins, `DEFAULT_THEME_ID`, the one-time switch, or put the switch where startup steps run: find how `theme.active` is seeded in `server/db.ts` ~1735-1748 and the settings repository), `server/db.ts` seed default, `web/src/lib/theme.js` and `web/theme-init.js` fallbacks, `scripts/build.mjs` bundled themes (add kyuubit, keep aethrix), `web/src/pages/settings/Appearance.jsx` `BUILTIN_IDS` (add `kyuubit`, also `graphite` if it is a built-in missing there), `web/favicon.svg`, `web/index.html` title, the `Agent Portal` fallbacks in `web/src/components/Rail.jsx`, `web/src/App.jsx`, `web/src/pages/Auth.jsx`, `web/src/pages/setup/SetupWizard.jsx`, `web/src/pages/setup/DeployTarget.jsx`, `web/src/lib/help-content.js`, `server/assistant/prompt.ts` (the system prompt's portal name)
- Test: `test/themes.test.ts` (update), new `test/kyuubit-brand.test.ts`

- [ ] **Step 1: Write the failing tests** (`test/kyuubit-brand.test.ts`): every file in `shared/themes/*.json` has `brand.productName === 'Kyuubit'`, the tagline, and `brand.logoSvg` equal to the trimmed content of `docs/superpowers/assets/kyuubit-logo.svg`; `kyuubit.json` passes the server's theme validator (use the same validator `test/themes.test.ts` uses) for both modes; its dark and light `ink` on `canvas` and `accent-ink` on `accent` have contrast ratio ≥ 4.5 (small helper in the test); a fresh server's `GET /api/theme` returns template id `kyuubit`; startup switch: with `theme.active` = `"aethrix-night"` and no marker, after the step the active id is `kyuubit` and the marker is set; with `theme.active` = `"nebula"` it stays `nebula` and the marker is set; with the marker set and `theme.active` = `"aethrix-night"` it stays `aethrix-night`. Update `test/themes.test.ts` default assertions from `aethrix-night` to `kyuubit` (built-in protection tests for aethrix-night stay).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the template, brand updates (a small one-off script is fine but commit only the resulting JSON), registration, defaults, the idempotent switch, favicon (same pixel head as the logo), the web fallbacks and the assistant prompt name. Update any other test that asserts the UI product name `Agent Portal` or the default id (grep `test/` for both) to the new values; leave tests about server identity strings untouched.
- [ ] **Step 4: Run** the new and updated tests, `test/assistant-*.test.ts`, `npm run typecheck`, `npm run test:map:check` (map the new test), `npm run build`. Expected: all pass, 0 errors.
- [ ] **Step 5: Commit** `feat(brand): Kyuubit name, logo and clover template`.

### Task 2: Mascot matches the owner's cat, with a clover charm

**Files:**
- Modify: `web/src/lib/cat-sprites.js` (painter patches and tag), `web/src/styles/mascot.css` (palette custom properties, clover sparkles), `test/cat-sprites.test.ts`

**Interfaces:** `SPRITES`, `frameCount`, `sheetRects`, `PALETTE_KEYS` keep their names and shapes; new palette key `l` = clover (green), the gold centre keeps key `g`.

- [ ] **Step 1: Update the tests first:** the calico test now expects brown (`n`) on the left half (x ≤ 7) and orange (`p`) on the right half (x ≥ 8) of the head rows, a cream blaze (`f`) in the centre columns of the face, at least 3 clover pixels (`l`) in a plus shape under the collar with a gold (`g`) centre in every frame that shows the body; all existing frame-count, blink, working, walk-cycle and sheetRects tests keep passing.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the pattern (match the reference described in the spec: halves split brown/orange, cream blaze, cream/grey belly, pink ears/cheeks/nose, gold collar, orange tail) and the clover charm in the painter; add `--cat-clover` light/dark values in `mascot.css` (`#3FAE6E` dark, `#2F8F5B` light) and change the celebrate sparkles to small clover shapes (CSS only, reduced motion respected).
- [ ] **Step 4: Run** `test/cat-sprites.test.ts`, `test/cat-*.test.ts`, `npm run build:web`, and `SMOKE_ONLY=projects npm run test:ui:fast` with `PLAYWRIGHT_BROWSERS_PATH=/tmp/claude-0/-home-user-agent-portal/53cde52a-a68e-55bd-84ae-8a259f9dbfcb/scratchpad/pwb`. Screenshot the cat (idle, walk, celebrate, working) in dark and light into `/tmp/claude-0/-home-user-agent-portal/53cde52a-a68e-55bd-84ae-8a259f9dbfcb/scratchpad/kyuubit/` and compare with the reference `/tmp/claude-0/-home-user-agent-portal/53cde52a-a68e-55bd-84ae-8a259f9dbfcb/images/1.png`. Expected: pass; reads as the same cat.
- [ ] **Step 5: Commit** `feat(cat): calico pattern of the owner's cat with a clover charm`.

### Task 3: Login illustration, docs and screenshots

**Files:**
- Modify: `web/src/pages/Auth.jsx` (decorative cat-with-clover pixel illustration above the form, built from `SPRITES.idle` frame 0 plus a pixel clover; `aria-hidden`; hidden when the viewport height is under 640 px), its stylesheet, `docs/user-guide.md` (portal name, the Kyuubit template in Appearance, the cat's clover), `README.md` title line if it names the portal, `test/ui/smoke.ts` (login shows Kyuubit and the illustration; the header brand says Kyuubit; existing cases pass)

- [ ] **Step 1: Write the smoke cases**, then **Step 2: run** to see them fail.
- [ ] **Step 3: Implement** the illustration and docs.
- [ ] **Step 4: Run** `npm run build:web`, the smoke subset `SMOKE_ONLY=projects,setup` (whichever sections cover login/header), `npm run typecheck`, `npm run test:map:check`; take screenshots (login dark/light, desktop and phone; Sessions with the header logo and mascot in the Kyuubit template dark and light; one other template, e.g. Nebula, showing the Kyuubit brand) into the scratchpad `kyuubit/` folder and look at them.
- [ ] **Step 5: Commit** `feat(brand): login illustration, guide and smoke tests`.
