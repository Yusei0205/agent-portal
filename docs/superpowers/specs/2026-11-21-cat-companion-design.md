# Cat companion: a pixel cat that roams, reacts and (later) answers

Date: 2026-11-21. Status: phase A and B1 built (cat v2); B2 built (answers only, read-only assistant, see 2026-11-21-cat-assistant-design.md); actions that change things stay open.

## Intent

The portal's mascot (today a still, line-drawn cat that shows a tip bubble) should feel like a small living assistant: it walks along the
bottom of the screen, sits and blinks, reacts when work finishes, fails or needs a person, and can be dragged out of the way. The idea
comes from a shared ChatGPT mockup (the screenshot the user sent): a pixel-art cat, "Chat with Agent" on hover, a chat panel on click,
and reactions to agents completing tasks or workflows failing. Success: the portal feels more alive and the cat tells people about
things that need them, without ever being in the way.

## Phases

- **Phase A (built now):** the pixel cat, roaming, drag, hover label, tip bubble kept, mood reactions to live events, a three-way mode
  menu, tests, user guide note.
- **Phase B:** the chat panel the mockup shows. **B1 (built, cat v2): a panel of shortcuts, no live chat.** B2: a real assistant, built
  (answers only); its decisions are answered in 2026-11-21-cat-assistant-design.md.
- **Cat v2 (built with B1):** a calico look (white fur, orange and brown patches, pink ears and cheeks, collar with a gold tag; colours are
  CSS custom properties with light and dark values), a "working" animation (cat at a laptop, 4 frames) while the open project has a
  running session (tracked from `workflow.updated` events only; roaming pauses, reactions still win), and the B1 panel below.

## Goals (phase A)

- **Look:** pixel art, drawn in code (character grids rendered as crisp SVG, coloured from theme tokens); animations are sprite
  sheets stepped with CSS `steps()`: walk (4 frames), idle sit with blink and tail (4), wave on hover (2), celebrate (4), worried (2),
  alert (2). No image files, no animation library.
- **Roaming:** along the bottom edge: sits 3-8 s, walks 60-200 px at 40 px/s in a random direction (turning at the edges), repeats. It only
  roams on screens at least 601 px wide, when the system does not ask for reduced motion, when no text field has focus (it walks back to
  rest where it is and sits while you type) and while no dialog is open. Otherwise it sits.
- **Drag:** pointer drag anywhere on screen (a movement of 6 px or more is a drag, less is a click); the position is remembered in the browser
  (`portal.cat.prefs`: mode, x as a fraction of the width, distance from the bottom). It stays inside the window after a resize.
- **Hover (desktop):** the cat waves and a small label "Chat with Agent ✨" appears. In phase A the label was decoration (clicking showed a tip); since B1 clicking opens the shortcut panel.
- **Reactions (current project only):** the cat subscribes to the open project's live event stream and the portal's inbox count:
  - `workflow.updated` with status `done`: celebrate (hop and sparkles), bubble "A session finished." with a link to the session.
  - status `failed`: worried, bubble "A session failed." with a link.
  - status `blocked`, or `inbox.created`: alert, bubble "Something needs you." with a link to the session or the Inbox.
  - Deploy failures arrive as `inbox.created` (type `blocked`), so they alert too. Nothing else triggers a reaction.
  - Quiet rules: at most one reaction per 20 s; none while the browser tab is hidden; a reaction bubble closes by itself after 8 s or on ×;
    the cat never reacts to events of other projects.
- **Control:** a small menu on the bubble (and on long-press of the cat on a phone) with three modes: Roam (default), Sit, Hidden. Hidden
  leaves a 24 px paw button in the corner to bring the cat back. The mode is remembered in the browser.
- **Phones:** the cat never roams; it sits in the corner; the tip bubble opens only on tap (already built); reactions still show their
  bubble.
- **Accessibility:** the cat is a button with a label; bubbles are polite live regions; reduced motion shows the first frame only; the
  keyboard can focus the cat and the menu; the cat is never the only way to reach anything.

## Non-goals (phase A)

- No chat, no network calls, no server changes; no new dependency (no Framer Motion).
- No reaction to other projects, to deploy success, or to plain `running`/`paused` changes.
- The cat does not run to the header's Inbox icon (the mockup's "runs toward the notification"): it celebrates or points in place. Revisit
  after the first version.
- No per-user setting stored on the server (browser-only, like the theme tweaks).

## Anti-goals

- Covering controls: the cat must not sit over the session message box or buttons it walks across and then stay there; it yields (sits)
  while a text field has focus, can always be dragged away, and its hit area is only the sprite (about 56 px).
- Noise: a cat that reacts to every event, bounces constantly, or cannot be turned off.
- Distraction at work: no sound, no flashing, no animation under reduced motion.

## Constraints

- Web only (`web/src`), no new package. Theme tokens only, light and dark. The look works at phone width and does not create horizontal
  scroll. z-index stays below dialogs and the command palette (150).
- Pure logic lives in plain JS modules under `web/src/lib/` with node tests (the repo's existing pattern, e.g. `agent-orbit.js`).
- Live events: `subscribeProject(projectId, onEvent)` from `web/src/lib/events.js`; the inbox count is already loaded by `App.jsx`
  (`inboxCount`, polled every 30 s).

## Approaches

1. **Code-drawn pixel sprites, CSS `steps()` sheets, small pure state machine (chosen).** No assets, theme-aware, testable, no dependency.
2. Sprite-sheet PNG files. Rejected: need an artist, do not follow themes, licensing.
3. Framer Motion or a canvas engine, as the mockup's conversation suggested. Rejected: a dependency and bundle weight for walking in a line;
   CSS transitions are enough.

## Phase B outline

- **B1 shortcuts panel (built):** clicking the cat (not dragging) opens a non-modal floating card (role dialog, no aria-modal; Escape or the
  close button closes it; focus moves to its input and returns to the cat; on a phone a full-width bottom sheet). Greeting "Meow! I'm
  your portal assistant. What would you like to do?", quick-action chips from the pure `catActions(route)` (Start a session, What needs
  me? = Inbox, Auto-fix, Pipelines, Search knowledge; outside a project only the Inbox and Projects), an input whose text is matched
  (`matchCatInput`) against those actions and the command palette's page names and navigates, otherwise the reply "I can't answer
  questions yet, but I can take you to: ...". An "Allow cat to roam" checkbox is bound to the existing mode pref; footer "Shortcuts only
  for now". The tip bubble stays for tips (menu item "Show a tip"); the hover label now names a real action. No model calls, no server
  changes, no new dependency. "Start a session" opens the Sessions page and presses Alt+N for the person (the page owns that dialog).
  Reactions that arrive while the panel is open are said inside it instead of a bubble.
- **B2 assistant:** built (answers only): a read-only chat in the panel, uses the user's own sign-in, nothing stored on the server.

## Open questions (for B2): answered

Answered by 2026-11-21-cat-assistant-design.md (B2 built, answers only). Kept below for the record.

- What may the assistant do: answer questions about the portal and the project only, or start sessions and change things?
- Which engine and budget pays for it (per user monthly cap?), and is it available to every member or only owners?
- Does it run as a normal session in a project (visible in the session list, with approvals), or as a separate lightweight chat?
- Where does its knowledge come from: the project's knowledge search and the user guide only, or live portal data?

## Builder's calls (check these)

- Mode menu and "Hidden" paw instead of a setting in a settings page (no dependency on other screens).
- Reactions use only the current project's stream; no new server-side per-user stream.
- Pixel grids are 16x16 with a 6-colour palette from theme tokens (outline, fur, belly, accent, eye, blush).
- Roaming speed 40 px/s and the 20 s reaction gap are tunable constants in one file.
