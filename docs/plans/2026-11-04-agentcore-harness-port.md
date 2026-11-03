# Harness on AgentCore: review of main_v3 and the port

Date: 2026-11-04
Branch: `agentcore/harness` (from `main_v3` at 833ef79)
Account / region: 366019841051 / ap-southeast-1

## 1. Summary

- `main_v3` already had most of the Phase 1 harness for the **local** engines (commit 5c6edd7): approvals bound to the exact call with expiry, spend and time limits, the config/hook guard, and the credential scrub.
- The **AgentCore** path had none of it:
  - The Claude runner (Spike A) and the Kiro runner (Spike B) allow every tool call.
  - The deployed cloud portal (`AgentPortalCloud`) sends Claude runs to the Spike A runtime, so cloud runs skip approvals and permission rules entirely.
- This branch moves the harness into the runners, using the same source files as the portal:
  - **One decision for every tool call** (`server/agent/tool-policy.ts`), used by the local engine and both runners: working folder (links followed), guard, the run's permission rules, remembered approvals, and commands too long to review.
  - **Approvals across the microVM boundary.** The runner streams an `approval-request`. The portal asks a person through its normal approval flow, then answers with a second `InvokeAgentRuntime` call on the same session, bound to the call's SHA-256 fingerprint. The microVM never holds a portal credential.
  - **Limits and stops.** The run's spend cap and time limit are recorded with stop reasons. A cancel in the portal stops the run inside the microVM.
- **Fixes found during the review** (section 3): seven bugs in main_v3, including a shell-injection risk in the runner's `git clone` and spend-cap stops being recorded as failures.
- **CDK.** Two new stacks deploy both runners without local Docker; the images build on arm64 CodeBuild. The spike stacks and the cloud stack are not touched.

## 2. Harness changes (Phase 1 PRs) → where they are now

| Harness PR | Local engine on main_v3 | AgentCore before | AgentCore after this branch |
|---|---|---|---|
| 1.1 Keep model credentials from agent shells | Done (env-scrub.ts) | Claude runner scrubs its env; Kiro runner passes everything to kiro-cli | Kiro runner also scrubs. Both runtimes' roles are narrow: Bedrock Claude only for the Claude runner, logs only for Kiro |
| 1.2 Safety switches (tokens, trigger owners) | **Missing** | n/a (portal-side) | Not in this branch; see section 5 |
| 1.3 Approval = exact call, expires, one answer wins | Done | **Every call allowed** | Approval request/answer bound to the fingerprint; expiry; answer refused for another run or another call; one answer settles it |
| 1.4 Config/hook guard, link-safe paths | Done | Claude: guard, but no link-safe folder check. Kiro: none | Shared decision in both runners; real-path folder check; clone runs with hooks off |
| 1.5 Spend cap, time limit, priced stops | Done, but the budget stop was never recorded (section 3) | Cap passed, but stop reasons lost; cost fallback priced every model as Haiku | Stop reasons (`budget`, `time_limit`, `max_turns`, `cancelled`) recorded in the portal; cost estimated with the run's model |
| 1.6 CI | Done | n/a | `npm run test:engine` added (end to end with the real engine) |
| 1.7 Progress and stop rules for loops | **Missing** | n/a (portal-side) | Not in this branch; see section 5 |

## 3. Review findings in main_v3

**Fixed in this branch**

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | The cloud portal's Claude runs go to the Spike A runtime, which allows every tool call: no approvals, no permission rules, no folder check | New runner and portal path. The cloud portal needs a config change after deploy (section 6) |
| 2 | High | Kiro on AgentCore allowed every tool call, with no guard | Guard on every permission request; untrusted runs ask a person, as the local Kiro engine does |
| 3 | High | `agent-runner` ran `git clone` through a shell built from the repo URL and branch: `https://x/$(cmd)` or a branch like `main;cmd` ran commands | `execFileSync` with arguments, hooks off, `--` before the URL; stricter URL and branch checks |
| 4 | Medium | Spend-cap stops were never recorded: the code read `stop_reason`, but the engine reports `subtype: error_max_budget_usd`. The SDK then throws "returned an error result", so the run was marked **failed** | Read the subtype; after a result, that throw just ends the run. Local engine and runner. The existing test only checked that the field existed; it now checks the value |
| 5 | Medium | Stopping a run in the portal did not stop it in the microVM; the agent kept working and spending | `cancel` control call, and the runner stops when the portal hangs up |
| 6 | Medium | Kiro's refreshed-token write-back read the credential with a SQLite query, which finds nothing in DynamoDB mode, so refreshed tokens were never saved in the cloud | Read through the credentials repository |
| 7 | Low | The sessions repositories dropped `budget_usd`, so a per-workflow budget was ignored | Mapped in SQLite and DynamoDB. No API or screen sets it yet (section 5) |
| 8 | Low | The runner's cost fallback priced every model as Haiku 4.5 | `pricing.ts` with the run's model |
| 9 | Low | `agent-runner` type check failed (`baseUrl` is rejected by TypeScript 6), hiding real errors | Removed the unused option |

**Not fixed here**

- `npm run typecheck` reports 97 errors on main_v3, the same with this branch. Examples: missing `@aws-sdk/client-sts` types, and record types without index signatures in `aws-accounts.ts` and `integrations.ts`.
- **Commands Claude Code judges read-only skip the portal.** Claude Code runs them (for example `cat`) without calling the host's permission check, so an "ask" rule for shell commands never sees them. This is engine behaviour, seen in the end-to-end test, and the same on the local engine.
- **What an agent's shell can still reach in the microVM:**
  - The runtime role's credentials (container credentials endpoint). For the Claude runner that is Bedrock Claude only.
  - In Kiro runs, the kiro-cli token database.
  - A sandbox (harness Phase 2) is the proper wall.
- **AgentCore Claude runs start with an empty folder.** That's the same as the Kiro path: the portal's working copies are not in the microVM. Private-repo checkout needs a credentials design.
- **Lambda limit.** The cloud portal runs on Lambda (15-minute maximum, `PORTAL_RUN_TIMEOUT_MS` = 14 min). A run that waits for a person longer than that is cut off by Lambda, not by the harness. Long runs need the async pattern (Step Functions or a callback).
- **Unpushed teammate work.** The CDK for `AgentPortalCloud`, and the code behind its `PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN` setting, are not in GitHub. This branch uses the same setting name; merge carefully with that work.

## 4. Design: an approval across the microVM boundary

```
Portal (Lambda or server)                     AgentCore microVM (agent-runner)
─────────────────────────                     ─────────────────────────────────
InvokeAgentRuntime(session S, mode run) ───▶  run starts; Claude Code asks canUseTool
                                              decideToolCall → "ask"
            ◀─── SSE: approval-request {requestId, tool, input, sha256}
check sha256, re-check guard/block rules
ctx.awaitInput → inbox + live card (expiry, one answer wins)
InvokeAgentRuntime(session S, mode answer,  ─▶ broker: same run? open request? same sha256?
  requestId, decision, sha256)                 → settles once; tool runs or is declined
            ◀─── SSE: answer-ack / answer-rejected
            ◀─── SSE: tool-start, tool-result, …, result {stop_reason, costUsd, tokens}
record spend, stop reason, budget
```

- Answers travel only over `InvokeAgentRuntime`, which needs the portal's IAM permission, so the microVM holds no portal token.
- The runner waits one minute longer than the portal's expiry, so the portal's expiry decides and is recorded in the portal.
- A cancel uses the same channel: `{mode: cancel, runId}`. The runner also stops if the portal hangs up.

## 5. Follow-ups

1. Point the cloud portal at the new runtime (section 6), and attach the invoke policy to its role.
2. Port harness PR 1.2 (safety switches) and 1.7 (loop progress and stop rules) into main_v3.
3. Add the per-session spend cap and time limit to the session API and screen. The columns and repository support exist now.
4. Fix main_v3's 97 type errors so CI can gate on the type check.
5. Phase 2 sandbox, for what the shell can still reach.

## 6. Deploying

```bash
cd infra
npm ci
node scripts/deploy-harness.mjs --profile <aws-profile>
```

It creates:

- `AgentPortalHarnessBuild`:
  - ECR repositories `agent-portal/agent-runner-harness` and `agent-portal/kiro-runner-harness`.
  - The arm64 CodeBuild project `agent-portal-runner-images`.
  - The runner sources as an S3 asset.
- `AgentPortalHarness`:
  - Runtimes `agentPortalClaudeHarness` and `agentPortalKiroHarness`: public network, 15-minute idle timeout, 2-hour maximum.
  - The execution roles.
  - The managed policy `agent-portal-invoke-harness-runtimes`.

Images are tagged with a hash of the sources, so an unchanged deploy does not rebuild.

Cost:

- Idle: a few cents a month for ECR storage.
- Each image build is a few minutes of arm64 CodeBuild.
- Runs: AgentCore compute only while running, plus Bedrock tokens.

To use it from the cloud portal:

1. Set `PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN` (and, for Kiro, `PORTAL_KIRO_AGENTCORE_RUNTIME_ARN`) to the `ClaudeRuntimeArn` and `KiroRuntimeArn` outputs.
2. Attach `InvokePolicyArn` to the portal's Lambda role.
3. Redeploy with this branch's server code.

To check the runtimes live: `PORTAL_LIVE_CLAUDE_RUNTIME_ARN=<ClaudeRuntimeArn> PORTAL_AGENTCORE_AWS_PROFILE=<profile> node --import tsx --test test/live/agentcore-live.test.ts`

## 7. Validation

**Live on AgentCore: not run yet.** The deploy (`node scripts/deploy-harness.mjs`) is waiting for approval. Once the runtimes exist, `test/live/agentcore-live.test.ts` runs approve, decline, guard, spend cap, cancel and a stray answer against real microVMs and Bedrock.

| Check | Result |
|---|---|
| New unit tests (tool policy, broker, payloads): `test/agentcore-harness.test.ts` | 12 passed |
| Portal relay, Claude and Kiro: `test/agentcore-portal.test.ts` | 7 passed |
| End to end, real runner server + real Claude Code engine + stand-in model API: `npm run test:engine` | 4 passed (approve, decline + guard, spend cap, cancel) in 16 s |
| Full suite (`test/*.test.ts`, Windows, Node 22.23.3) | 2,859 passed, 1 failed, 18 skipped. The failure (`user-config.test.ts`, clean-up timing) passes alone (91/91) and is in code this branch does not touch |
| Portal type check | 97 errors, identical to main_v3 |
| `agent-runner` and `kiro-runner` type check and build | Pass |
| `test:map:check` | Pass |
| CDK synth of both new stacks | Pass |
