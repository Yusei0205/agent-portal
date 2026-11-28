# Nine lives ring: the dashboard core in Kyuubit's pixel style

Date: 2026-11-21. Status: approved by the owner (picked option 3 from the sample sheet), built.

## Intent

The dashboard and session Execution view show an "AI core": a 3D blue wireframe sphere that does not match the Kyuubit pixel cat and
clover logo. The owner chose the **nine lives ring**: a small pixel four-leaf clover inside a ring of nine pixel "lives".

## Approaches (from the sample sheet)

1. Pixel clover medallion. 2. 3D clover (same engine). 3. **Nine lives ring (chosen).** Builder's call: it replaces the sphere in every
appearance template (the clover is the brand, like the logo), coloured from each template's tokens.

## Design

- `AiCore` keeps its name and props (`state`, `size`, `animated`, `className`) and gains `active` (number of running agents, optional).
  It draws an inline SVG with crisp pixels: nine 1.8-unit squares on a circle (radius 10 in a 24-unit box) and the 11x11 pixel clover
  from the sample in the middle (four leaves, gold centre plus).
- States (pure helper `lifeDots(state, active)` in `web/src/lib/nine-lives.js` returns nine of `off | on | bad | walk`):
  - idle: all dim; one "walk" life brightens in turn around the ring (slow).
  - running: `min(active, 9)` lives lit and pulsing; without `active` (session view) 3 lit; the ring turns slowly.
  - success: all nine lit.
  - failed: one life red (index 2), the top-left leaf and the centre red.
- Colours: leaves `--accent`, lit lives `color-mix(--accent, white)`-style brighter accent, dim lives accent at low opacity, centre
  `--warn` (gold), failure `--danger`. No hard-coded colours.
- Motion: CSS only; none when `animated` is false or the person asks for reduced motion (first frame). The 3D scene
  (`web/src/components/ai-core-scene.js`) is removed; `three` stays (used elsewhere).
- Accessibility: `role="img"`, label "AI core: idle" / "AI core: 3 agents running" / "AI core: the last run succeeded" / "AI core: a run failed".
- Dashboard passes `active={summary.runningSessions}`; the session view keeps passing only `state`.
