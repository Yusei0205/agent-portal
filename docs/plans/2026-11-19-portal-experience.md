# Portal experience improvement plan

Status: first delivery implemented; broader phases below remain planned. Deployment status is tracked in GitHub Actions.

First delivery: Dashboard Mission Control selects recent/active sessions and opens a collaboration, activity and deliverables inspector. It uses existing permission-filtered APIs, bounded recent events, project subscriptions and a 10-second refresh fallback. Includes agent selection, output previews, workspace/review links, stale-resource warnings and mobile/reduced-motion behavior.

Reference: [AI Agent Portal Design](https://chatgpt.com/share/6afd9718-b1bc-83ec-a120-c7cc5660c572), read in Opera on 2026-11-19. The reference proposes a mission-control workspace for developers and non-technical users, live agent collaboration, workflow orchestration, and Simple/Developer experiences. Its interactive NEXUS prototype explicitly uses simulated, in-memory data. Adopt its interaction concepts with the portal's real records and permissions; the proposed names are navigation labels, not a rebranding decision.

## Product direction

Make the core journey clear: define an outcome, select project context, run agents, handle decisions, inspect deliverables, and verify the result. Preserve the working Code/Run/Review workspace and existing routes. Deliver the visual identity through consistent hierarchy, restrained accents, readable technical detail, and animations tied to actual execution events.

## Existing foundation and improvements

| Reference concept | Current portal foundation | Improvement |
| --- | --- | --- |
| Command Center | Dashboard, attention strip, KPI drilldowns, active session, run trends | Prioritized work queue, cross-session activity, selected-session collaboration graph, clear freshness |
| Agent Workforce | Agent setup, session agent views, graph/orbit/detail components | Project-level directory linking configured agents to actual runtime activity, skills and permissions |
| Workflow Studio | Automations already uses React Flow with agent, condition and approval nodes, templates and execution graphs | Integrated editor/run inspector, consistent node states, validation feedback, contextual step actions |
| Missions | Sessions, workflow runs, tickets, Inbox and outputs | Outcome-oriented list/detail view aggregating these records without duplicating execution ownership |
| Knowledge Hub | Knowledge, repositories/workspaces, Create and Vault | Show which context is selected, where it came from, its version and its use in the current task |
| Observability | Usage, execution timelines, reviews and tests | Connected trace/quality/cost views with links to the exact run and supporting evidence |
| Simple/Developer views | Focus mode and Code/Run/Review already exist | Persistent experience preference with progressive disclosure across navigation, launch and inspection |
| Polished motion | Motion, hover glow, artifact reveal and mode transitions | Shared interaction rules and purposeful status transitions across pages |

## Phase 1: Consistency and two experience levels — P0

1. Consolidate layout primitives: PageHeader, filter toolbar, metric card, status badge, empty state, inspector drawer and composer controls. Define spacing, control heights, type scale, focus and layer tokens. Scope theme overrides so each theme keeps the same geometry. Verify empty, long-title, error and multiline states.
2. Add a persistent Simple/Developer preference. Simple emphasizes objective, progress, approvals and outputs; Developer exposes branch/files, execution trace, tools, terminal and verification. Both use the same underlying task and permissions. Keep technical details reachable and preserve unsent drafts when switching.
3. Reduce primary navigation to Command Center, Missions, Workforce, Workflows, Knowledge and Observability. Put project setup, connections and administration in secondary groups. Retain route aliases, project scope, active states and existing shortcuts. Validate naming with actual tasks before removing familiar labels such as Sessions.
4. Extend Ctrl+K beyond page navigation: new mission/session, resume session, find recent artifact, jump to approval, and open a known file. Entity search requires permission-filtered server search or explicitly limited recent records; do not present loaded-page search as global search.

Acceptance: shared control geometry at desktop and mobile widths, visible keyboard focus, no lost drafts on experience changes, no broken bookmarks, and equivalent approval visibility in both experiences.

Primary areas: App.jsx, Rail.jsx, PageHeader.jsx, CommandPalette.jsx, theme tokens, sessions.css and session-studio.css. Prefer moving shared styles into owned primitives over appending more conflicting overrides.

## Phase 2: Command Center and live collaboration — P0

1. Order the dashboard around decisions required, active work and recently delivered results. Keep operational metrics secondary and drillable. Provide useful first-run actions when there is no activity.
2. Add a live collaboration graph for one selected session/workflow. Reuse AgentGraph/AgentOrbit and useSessionAgents where their contracts fit. Render only known parent-child or workflow relationships; animate handoffs only when a recorded event establishes them.
3. Clicking an agent opens an inspector showing current status, assigned objective, recent recorded tools, changed files, outputs and pending decisions. Existing transcript/tool records provide the trace; do not imply access to hidden model reasoning.
4. Add a bounded activity feed with links to source records, event timestamps and connection/freshness labels. Reuse project subscriptions and existing stream/polling fallbacks. Cross-project aggregation needs a scoped read endpoint if existing APIs cannot supply it efficiently.

Acceptance: states reflect real events, disconnected data is visibly stale, empty data never appears as a fabricated agent network, graph and list support keyboard interaction, and updates do not steal focus or restart animation on every refresh.

Primary areas: Dashboard.jsx, DashboardInsights.jsx, DashboardDetails.jsx, session AgentGraph/AgentDetail/useSessionAgents, lib/events.js. Backend additions depend on a scoped event/aggregation contract audit.

## Phase 3: Missions and artifact review — P0

1. Introduce a task list with board/list views and filters for project, owner, status and attention. Start as a read model over sessions and workflow runs; define whether a mission is a session or a parent of several runs before creating a new persistent entity.
2. Build an outcome-oriented detail view: objective, context, assigned agents, execution milestones, decisions, artifacts and verification evidence. Link into the existing Code/Run/Review workspace for technical inspection.
3. Unify approval presentation between Inbox, task detail and Session. Display requested action, affected resource, reason and available evidence. Preserve server authorization and approval state handling; avoid separate frontend-only approval state.
4. Give artifacts a consistent inspector with preview, version, producing run, timestamps and download. Distinguish generated output from a code change and from an approved or deployed result. Add version comparison only where the underlying version/content records support it.
5. Add outcome templates using existing workflow templates and launch defaults: investigate a bug, implement from a ticket, generate API tests, review changes, create technical documentation.

Acceptance: one canonical task status, direct links between task/run/artifact/review, approval resolution stays consistent across open views, and a successful agent turn is never labeled deployed or verified without supporting evidence.

Primary areas: SessionsShell/SessionList, SessionCommandBar, Inbox, Automations, ArtifactCard/CreationPreview and RunOutputsCard. Schema and aggregation work follow the mission-model decision.

## Phase 4: Workflow Studio and Workforce — P1

1. Improve the existing React Flow studio rather than replace it: node palette, template picker, step inspector, graph validation and readable errors.
2. Connect saved workflow versions to execution overlays. Selecting a running/failed/approval step opens the relevant recorded tools, checks, output and decision. Clearly distinguish editing a future version from inspecting an active run.
3. Audit backend capabilities before adding parallel branches, retry policies and checkpoint controls. The current UI has conditions and bounded retry paths; a canvas edge must not imply unsupported scheduler behavior.
4. Add a Workforce directory assembled from configured agents and runtime records. Distinguish configured, available, running and blocked. Show effective engine/model, skills, tools and permissions only when known and permitted.
5. Provide a context inspector for repositories, selected knowledge and configured agent instructions. Explain provenance and scope. Do not expose credentials or assume an unobservable internal model memory.

Acceptance: invalid graphs cannot start, active execution is tied to its saved version, unsupported controls are absent, and changing an agent configuration explains when the change takes effect.

## Phase 5: Observability and replay — P1/P2

1. Link run duration, token usage/cost, retries, tool failures, checks and output to the same run identifiers. Preserve distinctions between credits, tokens and provider-reported monetary costs.
2. Add evaluation comparisons only against explicit datasets, criteria and recorded evaluation runs. Show missing evidence and incomplete outcomes.
3. Implement read-only execution replay first: a scrubber over persisted events with agent/node/file selection. Label timestamps and gaps. Replay must not execute tools.
4. Consider resume/rerun from checkpoints only after verifying persisted snapshots, idempotency, side effects and approval boundaries. This is separate backend work.
5. Defer a skills marketplace, multi-agent debate and a full SDLC relationship graph until the core flow is coherent. Start with curated installed skills and existing code/review/test links.

## Interaction and motion contract

- Pointer glow applies to interactive summary surfaces; editors, dense logs, terminals and tables stay visually quiet.
- Running nodes may pulse; completed nodes settle; failed/blocked nodes use a distinct state and text. Color alone never carries meaning.
- New artifacts reveal once; navigation restores scroll/filter/selection; a selected inspector remains stable during live updates.
- Prefer short transitions (approximately 150–250 ms), no continuous celebration or forced camera movement. Honor reduced motion, touch devices and the existing animation controls.
- Keep charts, graphs and previews lazy loaded and bound event lists. Establish measured performance baselines before setting regression budgets.

## Delivery and validation

Deliver one vertical slice first: Command Center → selected active session → agent inspector → artifact/review. Then expand to Missions and the two experience levels. Avoid a simultaneous route, data-model and theme rewrite.

Validate with real and fixture-backed running, paused, blocked, failed, complete, empty and disconnected states. Cover keyboard navigation, focus return, mobile composer geometry, multiple theme modes, stale event handling, draft persistence and permission filtering. Use existing browser regression tests for dashboard interactions and the Session workspace, and extend them around the delivered flows.

Track time/clicks to find an approval, identify a failed step, resume work and inspect a deliverable. Measure layout shifts, input responsiveness and live-update behavior. Backend orchestration capabilities and entity search scope require an API audit before their implementation estimates are finalized.
