# Claude on AgentCore: several agents and several sessions

Goal: a Claude run on Bedrock AgentCore can split its task, as the prompt calls for:
- **several agents in one run**: the project's own agents (`.claude/agents/*.md`) go to the microVM, and Claude hands work to them with the Agent tool;
- **several sessions**: Claude starts child sessions with `delegate_session`. Each child is a portal session of its own (its own run, so its own microVM), and its result is posted back to the parent session.

Branch: `feat/agentcore-multi-agent`, stacked on `fix/model-pricing` (PR #15), which is stacked on `fix/cancelled-run-spend` (PR #14). The PR goes to `fix/model-pricing`.

## Done (first commit on the branch)

| Area | Change |
|---|---|
| `server/agent/agent-defs.ts` (new) | Reads agent files (front matter: name, description, tools, disallowedTools, model, maxTurns; body = prompt). Later folders win on a name clash. Limits: 50 agents, 50,000-character prompt, 200 KB file. |
| `server/agent/claude-agentcore.ts` | Sends `agents` (owner's config in the run home, then the project's `.claude/agents/`), and `delegation: { via: 'portal' }` when Settings › Delegation is on, the session has an owner, and it is not a child (unless nesting is allowed). Starts each run with a recap of earlier turns (every AgentCore run is a new engine session). Relays subagent events; a subagent's text is shown under its name and is not the run's answer. |
| `server/agent/agentcore-bridge.ts` | `DelegationRelay`: checks the request's fingerprint, re-checks block rules for `mcp__portal__delegate_session`, calls `createChildSession`, and answers the microVM with the child's ID and title (or why none was started). |
| `agent-runner/src/validate.ts` | Accepts `agents` (validated field by field) and `delegation`. |
| `agent-runner/src/run.ts` | Passes `agents` to the SDK. Maps the haiku/sonnet/opus aliases to the global Bedrock profiles the runtime role allows (`ANTHROPIC_DEFAULT_*_MODEL`). Streams `subagent-started` / `-finished` / `-failed` from the SDK's `task_started` / `task_notification` (task_type `local_agent`). Tags subagent text and tool calls with `agent`. Prices a subagent's replies at its own model. Adds the in-process MCP server `portal` with `delegate_session` (waits on the broker for the portal's answer, 2 minutes). |
| `agent-runner/package.json`, `build.mjs` | `zod` 4.6.7 is a direct dependency and stays external. |
| `server/session-lifecycle.ts` | Agents list: one row per subagent run, with its task; events replayed oldest first (they were read newest first, so a finished subagent showed as running). |
| UI | Live view: a subagent's text under "Agent › name"; a row when a subagent starts or ends. Agents panel refreshes on subagent events and shows each one's task. |
| Tests | `test/agent-defs.test.ts`, `test/agentcore-multi-agent.test.ts` (a real child session is started and its result reaches the parent), new cases in `test/agent-runner-validation.test.ts`. Portal and runner type checks pass; 102 tests in the touched areas pass. |

## Still to do

### 1. Finish the code
1. `agent-runner/src/run.ts`: create the MCP server with `alwaysLoad: true`, so Claude Code never hides `delegate_session` behind tool search.
2. `server/agent/agentcore-bridge.ts`: mention delegation in the header comment.
3. `test/test-map.json`: add the two new test files to their modules; `npm run test:map:check` must pass.

### 2. End-to-end test with the real runner and the real Claude Code engine
File: `test/engine/agentcore-runner-engine.test.ts` (run with `npm run test:engine`; it uses `test/mock-anthropic-api.ts`, no API key).
1. Start a second runner process as a second microVM. The invoker sends the parent run's session (its id starts with the parent's runId) to runner A and every other session to runner B.
2. **Subagent test.** Write `file-writer.md` into `{dataDir}/projects/<slug>/.claude/agents/`. Script: `Agent` (subagent_type `file-writer`) → `Bash` inside the subagent (an "ask" rule) → the subagent's text → the main agent's text. Check:
   - the agent's prompt reaches the model (a request's `system`);
   - the person was asked about the subagent's command, and it ran (marker file);
   - `subagent-started` and `subagent-finished` arrived;
   - the run's answer is the main agent's text only;
   - tool calls inside the subagent carry `agent`. If the SDK's `agentID` is not the `task_id`, change the mapping in `run.ts` (or drop the tag) rather than the test.
   - Read the first request's `tools` to confirm the tool is named `Agent` (older engines: `Task`).
3. **Child session test.** Insert a user, give the parent workflow `created_by`, set `PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN` so the child also runs through the AgentCore path, and restore it afterwards. Script: `mcp__portal__delegate_session` → text → text. Check:
   - `mcp__portal__delegate_session` is in the request's `tools`;
   - the child workflow exists with `parent_id`;
   - the child's run went to runner B (another session);
   - a `child-result` event with status `done` reached the parent;
   - the parent's tool result contains `childWorkflowId`.

### 3. Full validation
- `npm run typecheck`, then `node build.mjs` and `npx tsc --noEmit` in `agent-runner/`.
- `npm test` (all), `npm run test:engine`, `npm run test:map:check`, `npm run build`.
- Compare any failure with `main_v3`. A known flake is the `user-config` "materialises kiro config" timing test.

### 4. Commit, push, PR
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Open the PR to `fix/model-pricing`: "feat(agentcore): several agents and child sessions for Claude runs on AgentCore". The body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Say in the body:
  - merging rebuilds the runner image and updates the runtime;
  - child sessions on AgentCore start in an empty work folder, the same as every AgentCore run today; only the result text comes back to the parent.
- Do not merge.

### 5. After merge (needs AWS; not in the cloud session)
1. Merge in order: #14, then #15, then this PR. The deploy workflow then updates the runtimes. `aws-prod` has no reviewers.
2. Extend `test/live/agentcore-live.test.ts` and run it against the deployed runtime (Haiku 4.5, about $0.10):
   - a run hands work to a project agent;
   - a run starts a child session that runs in its own microVM and reports back.
3. To use it from a portal, set `PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN` to the harness runtime. The cloud portal still uses Spike A.

## Known limits (not in this change)
- The local engine's `delegate_session` passes a hand-made schema object instead of zod. Check whether it works there; fix it in its own PR if not.
- The engine sends one assistant message per content block, and usage on those is not final. Token totals may overcount, which affects estimates only.
