# Claude on AgentCore: several agents and several sessions

Goal: a Claude run on Bedrock AgentCore can split its task, as the prompt calls for:
- **several agents in one run**: the project's own agents (`.claude/agents/*.md`) go to the microVM, and Claude hands work to them with the Agent tool;
- **several sessions**: Claude starts child sessions with `delegate_session`. Each child is a portal session of its own (its own run, so its own microVM), and its result is posted back to the parent session.

Branch: `feat/agentcore-multi-agent`, stacked on `fix/model-pricing` (PR #15), which is stacked on `fix/cancelled-run-spend` (PR #14). The PR goes to `fix/model-pricing`.

## Done

### First commit (7ee5f5e)

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

### Later commits: finished, tested end to end, validated

| Area | Change |
|---|---|
| `agent-runner/src/run.ts` | The `portal` MCP server is created with `alwaysLoad: true`, so `delegate_session` is in the prompt from the first turn and is never deferred behind tool search. |
| `server/agent/agentcore-bridge.ts` | The header comment covers delegation: `DelegationRelay`'s four steps, and where the child's result goes. |
| `server/delegation.ts`, `server/agent/runner.ts` | A child's result now reaches its parent. `deliverChildResult` takes the child run's result (the agent's answer, or why the run failed), cut at 8,000 characters, and puts it in the `child-result` event's body (the parent's next input) and `summary` (shown in the live view). Before, it read a `summary` the workflow record does not have, so the parent got only "finished with status: done". Shared by every engine. |
| `test/test-map.json` | `test/agent-defs.test.ts` and `test/agentcore-multi-agent.test.ts` are in `kiro` (with `server/agent/agent-defs.ts`, next to `claude-agentcore.ts`); `agentcore-multi-agent` is also in `delegation`. |
| `test/mock-anthropic-api.ts` | A script step may be a function of the request it answers (to use the tool name the engine offers, or to reply by who asks). |
| `test/engine/agentcore-runner-engine.test.ts` | Two runner processes stand in for two microVMs: A takes the sessions of the runs a test starts, B every other session. Each runner gets a microVM's environment (none of the host's Claude Code or Anthropic variables) and has tool search on. Three new tests: a project agent the main agent waits for; a project agent in the background; a child session started with `delegate_session`, whose answer reaches the parent. |
| `test/delegation.test.ts` | The child's result is in the `child-result` event; a long result is cut and says so. |

### What the end-to-end tests showed (Agent SDK 0.3.303)
- `canUseTool`'s `agentID` is the subagent's `task_id`, so the `agent` tag on a subagent's tool calls is right. The mapping in `run.ts` is unchanged.
- Agents run in the background by default. The main agent's turn can end first (a first `result`); the engine tells it with a task notification when the agent ends, and it answers (a second `result`). The runner reads to the end, and `total_cost_usd` is cumulative, so the spend recorded is the whole run's.
- An agent the main agent waits for (`run_in_background: false`) does not stream its last text: its report comes back as the tool result and as the `summary` of `subagent-finished`, which the live view shows under its name. A background agent's text is streamed with `agent`.
- The engine starts an agent without calling `canUseTool`, so the hand-off shows as `subagent-started`, not as a tool call. Every tool the agent then uses goes through the run's rules.
- With tool search on and no `alwaysLoad`, the first request offers `ToolSearch` but not `delegate_session`, and the child-session test fails. With `alwaysLoad: true` it passes.
- The child session ran on runner B and its `child-result` reached the parent with status `done`, but without the child's answer. That product bug was on `main_v3` too; it is fixed above.
- The existing test "a person approves a shell command…" failed in a Claude Code cloud session, on `main_v3` too: the runner inherited the session's own Claude Code variables, so the engine sent the session's login instead of the test key. Fixed in the test (the microVM environment above).

### Validation (Node 22.23.4)

| Check | Result |
|---|---|
| `npm ci` (root and `agent-runner/`) | OK |
| `npm run typecheck` | 0 errors |
| `agent-runner`: `node build.mjs`, `npx tsc --noEmit` | OK, 0 errors |
| `npm run test:engine` | 7 of 7 pass (4 existing, 3 new), in each of the last 3 runs |
| `npm test` | 2,923 tests: 2,896 pass, 3 fail, 6 cancelled, 18 skipped. Every failure and cancellation is in `test/browser-live.test.ts`, which fails the same way on `main_v3`: the image has no Chromium headless shell for the project's Playwright version. |
| AgentCore, delegation and agent tests (`agent-defs`, `agentcore-multi-agent`, `agent-runner-validation`, `agentcore-harness`, `agentcore-portal`, `kiro-agentcore`, `delegation`, `security-fixes`) | 170 of 170 pass |
| `npm run test:map:check` | passes |
| `npm run build` | OK |

## Still to do

### After merge (needs AWS; not in the cloud session)
1. Merge in order: #14, then #15, then this PR. The deploy workflow then updates the runtimes. `aws-prod` has no reviewers.
2. Extend `test/live/agentcore-live.test.ts` and run it against the deployed runtime (Haiku 4.5, about $0.10):
   - a run hands work to a project agent;
   - a run starts a child session that runs in its own microVM and reports back.
3. To use it from a portal, set `PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN` to the harness runtime. The cloud portal still uses Spike A.

## Known limits (not in this change)
- The local engine's `delegate_session` passes a hand-made schema object instead of zod. Check whether it works there; fix it in its own PR if not.
- The engine sends one assistant message per content block, and usage on those is not final. Token totals may overcount, which affects estimates only.
- A portal rule that blocks the Agent tool is not applied on AgentCore: the engine starts agents without asking `canUseTool`. The local engine is the same engine, so most likely the same there (not tested). The rules still apply to every tool the agent uses.
- The deploy workflow's `verify` job names its portal AgentCore tests one by one, and the two new ones are not in that list. `ci.yml` runs them through the test map.
