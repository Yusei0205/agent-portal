# Visual workflows

Choose a project, then **Workflows** in the Work section of the sidebar. Existing Sessions and Loop Specs remain available.

## Session goals

Settings → Goal is optional. Saving other settings leaves an unchanged goal alone. Enter new text to change the next turn’s goal, or clear it to remove the goal. An active agent turn retains the instructions it started with. The opening prompt and previous messages remain in the conversation.

## Build and run

1. Create an SDLC workflow. Choose an engine and connected repositories. Each run uses the starting user's default sign-in for that engine.
2. Select a step to edit its agent, model, instructions, verification checks, and visit limit. In **Run tests**, set the command for your project and choose its repository as the working directory. The template starts with `npm test`; adapt it for your repository.
3. Drag steps to position them and connect their handles. Ordinary steps have one Next path; conditions require one Yes and one No path. Every step must be reachable from Start and able to reach End. Retry paths are bounded by each step's visit limit, the workflow's total step limit, and its wall clock limit.
4. Save the draft, then Publish version. Publishing validates the graph. Running uses the last published version; editing a draft cannot alter a running workflow. Version history can copy an older version into the draft.
5. Enter the run request and choose Run published workflow. The execution graph and timeline show the pinned version. Open the linked session for live agent output, tool approvals, files, artifacts, terminal and PR links.

Agent instructions can use `{{input}}` and `{{steps.<step-id>.output}}`. Output mappings use the latest completed attempt's bounded text summary, including failed attempts. An unavailable mapped output fails the run instead of silently using an empty value. Use files in the shared working copy for larger artifacts. Each run has its own session, working copy and conversation; tasks within that run share them. Different engines within one run and parallel branches are not part of this version.

Verification checks execute on the existing agent runner after the task. Conditions follow Yes only when the agent turn succeeds and all required checks pass. Missing check results count as failure. An unhandled failed task stops the run; connect it to a condition to handle failure explicitly. Checks use the existing command restrictions and run environment. Each task's checks have at most 10 minutes of configured command time, and each agent turn has a 12 minute overall limit.

Approval steps wait for the run owner or a portal admin. The approval is bound to the published version, current step and visit. Tool approvals remain governed by portal permissions. The SDLC template requires human review before requesting a PR against `main_v3`; it never merges or deploys. Intermediate tasks do not generate automatic PR prompts.

Dollar budgets are supported only for providers that report USD cost. Codex subscriptions and Kiro use time and step limits. Existing portal/project/user budgets and tool policies also apply.

## Cloud operation

Deploy `AgentPortalCloud` normally. The stack creates a Step Functions **Standard** state machine named `agent-portal-workflows` and a small coordinator bridge Lambda. It configures `PORTAL_AUTOMATION_STATE_MACHINE_ARN` on the portal and grants that portal permission to start this state machine. There is no callback URL or OAuth client configuration for workflow orchestration.

Every 15 seconds the bridge invokes the portal's authenticated internal `automation-tick` job. A tick acquires a conditional lease, dispatches or polls one existing agent turn, persists a transition, and returns. Agent turns continue through the existing separate invocation/AgentCore path. Approval waits and transitions survive browser closure and Lambda replacement. Step Functions input/history contains routing IDs, not prompts, artifacts or credentials. The bridge reads the existing origin secret from Secrets Manager; it is never returned to the browser.

Definitions, immutable versions and run/attempt state live in the existing `portal-code` DynamoDB table under `AUTOMATION#<project-id>`, separately from session records. Individual records are capped at 300 KB; definitions at 140 KB. Existing session snapshots/output storage retains the working copy and full artifacts. No new DynamoDB index is required. Locally, records use SQLite and the server recovers unfinished workflows at startup.

Starts use a client-generated request ID for idempotency. Transitions use compare-and-swap revisions and expiring leases. Dispatch intent is saved before starting an agent turn. If a worker is interrupted in the uncertain dispatch window, the workflow fails with a session link rather than replaying a potentially publishing stage. Failed/missing coordinator replies are retried by Step Functions and then recorded as a failed run. Agent steps without progress fail after 14 minutes. Overall runs time out at their configured limit (maximum 24 hours, including approval waits).

Cancellation is durable: the next tick stops further transitions and writes a stop flag that the running agent invocation polls. An already completed external operation cannot be undone by cancellation. Review the linked session before starting another run after an interrupted publication step.

## Initial scope

This version provides sequential agent tasks, command verification, conditions, bounded retry paths, human approvals, PR handoff, immutable versions, execution graphs and timelines. Full logs/artifacts use the existing session view. Parallel agents, dedicated command-only nodes, automatic deployment integrations and workflow analytics are later extensions. This version builds on existing runner sessions with a 12 minute per-task cap; it does not introduce an unlimited-duration runner job protocol.

Validation covers graph invariants, repository ownership, SQLite/DynamoDB conditional writes, version pinning, duplicate starts, exact approvals, cancellation, concurrent ticks, expired runs, failed checks/retry limits, real asynchronous demo execution, the Lambda Web Adapter response protocol, and editor behavior on desktop/mobile.
