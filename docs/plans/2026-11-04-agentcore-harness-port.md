# Harness on AgentCore: review of main_v3 and the port

Date: 2026-11-04
Branch: `agentcore/harness` (from `main_v3` at 833ef79), merged in PR #12; deploy and live results added on `agentcore/deploy-live`
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
| 10 | Medium | `@aws-sdk/client-sts` was imported but never installed, so "Test connection" for an AWS account with access keys always failed | Added at 3.1152.0 |
| 11 | Medium | CI could not pass: 97 type errors stopped the first job, and the DynamoDB Local health check (`curl -f` on a URL that answers 400) never reported healthy | Type-only fixes (97 → 0); health check removed, and the wait step accepts any HTTP answer |

**Not fixed here**

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
4. Phase 2 sandbox, for what the shell can still reach.
5. Record the spend of a cancelled AgentCore run. After sending the cancel, the portal could keep reading the stream for a few seconds to receive the runner's final `result` (section 7, "Seen live").
6. A repository admin protects the `aws-prod` environment with required reviewers and limits it to `main_v3`. Today it has neither, so any push to `main_v3` that touches the runners deploys straight away.

## 6. Deploying

### Through GitHub Actions (`.github/workflows/deploy-agentcore.yml`)

| Job | When | What |
|---|---|---|
| `verify` | Pull requests that touch the runners; before every deploy | Runner builds and type checks; runner and AgentCore tests; end-to-end run with the real Claude Code engine (stand-in model API); infra type check |
| `deploy` | Pushes to `main_v3` that touch the runners, or started by hand on `main_v3` | Signs in to AWS through GitHub OIDC (no stored keys) and runs `infra/scripts/deploy-harness.mjs` |

**Trust.** Only this repository's jobs in the GitHub environment `aws-prod` can assume the deploy role `agent-portal-github-deploy`. Pull requests, including those from forks, never get AWS access.

**What the role may do:**
- Assume CDK's own bootstrap roles.
- Start and read the runner image build.
- Check which runner images exist.

**One-time setup:**
1. **Done on 2026-11-04.** The role was deployed to account 366019841051 (ap-southeast-1), stack `AgentPortalGithubDeploy`:
   ```bash
   cd infra
   npx -y aws-cdk@2.1147.0 deploy AgentPortalGithubDeploy -c github=1 --profile <admin-profile>
   ```
   It created the GitHub OIDC provider and `arn:aws:iam::366019841051:role/agent-portal-github-deploy`.

   **Trust is pinned to GitHub's immutable subject.** The repository uses GitHub's immutable OIDC subjects, so its tokens name the owner and repository by numeric ID: `repo:Yusei0205@52206369/agent-portal@1426275824:environment:aws-prod`. A renamed or re-created repository cannot reuse these IDs.
   - The first version of the role expected the name-only form `repo:Yusei0205/agent-portal:environment:aws-prod`, so AWS refused GitHub's sign-in. CloudTrail showed the subject GitHub actually sent.
   - `infra/bin/app.ts` now sets `subjectPrefix`. GitHub reports the value as `sub_claim_prefix` at `GET /repos/Yusei0205/agent-portal/actions/oidc/customization/sub`.

   Checked with IAM's policy simulator:
   - **Allowed:** the four CDK bootstrap roles (deploy, file publishing, image publishing, lookup); starting and reading builds of `agent-portal-runner-images`; listing images in the two runner repositories.
   - **Refused:** assuming any other role (such as the runtime roles); reading secrets; starting any other CodeBuild project.
2. A repository admin opens Settings › Environments, creates `aws-prod`, and:
   - adds required reviewers, so every deploy waits for an approval;
   - limits the environment to the `main_v3` branch.

   If no one creates it first, GitHub creates `aws-prod` on the first deploy run with no protection, so that run deploys without an approval.
3. Optional: set the repository variable `AWS_DEPLOY_ROLE_ARN`. Without it, the workflow uses `arn:aws:iam::366019841051:role/agent-portal-github-deploy`.

### By hand

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

### Deployed (2026-11-04)

The deploy ran from GitHub Actions on `main_v3` at 54a7a7f, the merge of PR #12. It took three attempts:

1. The first attempt ran before the deploy role existed.
2. The second was refused because of the subject form (section 6).
3. The third deployed everything in 5 minutes ([run 41813191293](https://github.com/Yusei0205/agent-portal/actions/runs/41813191293)).

| Output | Value |
|---|---|
| Image tag (both runners) | `h-bbc925ebded24d49` (Claude runner 645 MB, Kiro runner 361 MB, compressed) |
| `ClaudeRuntimeArn` | `arn:aws:bedrock-agentcore:ap-southeast-1:366019841051:runtime/agentPortalClaudeHarness-BW7D1pFqIl` |
| `KiroRuntimeArn` | `arn:aws:bedrock-agentcore:ap-southeast-1:366019841051:runtime/agentPortalKiroHarness-cb9yhJCYyX` |
| `InvokePolicyArn` | `arn:aws:iam::366019841051:policy/agent-portal-invoke-harness-runtimes` |

The cloud portal (`AgentPortalCloud`) still points at the Spike A runtime until someone sets these ARNs on it (section 6).

### Live on AgentCore: 6 passed

`test/live/agentcore-live.test.ts` ran against the deployed Claude runtime, with real microVMs and Bedrock Claude Haiku 4.5, from Windows on 2026-11-04. All six tests took 26 s and cost about $0.05.

| Test | What happened | Portal record |
|---|---|---|
| Approve | The runner asked about `echo live-ok > live.txt && cat live.txt`; the portal said allow; the command ran | $0.0238, stop: normal end |
| Decline | The runner asked about `touch declined.txt`; the portal said deny; the command did not run, and the agent was told "The user declined" | $0.0089 |
| Guard | Writing `.claude/settings.json` was refused inside the microVM ("Blocked by Agent Portal"); nobody was asked | $0.0108 |
| Spend cap | With a $0.001 cap, the engine stopped after its first reply | "spend cap reached ($0.001)" |
| Cancel | Aborting in the portal stopped a 240-second command. The runtime's log shows the run ended with `stop_reason: cancelled` 6 s after it started | $0, no tokens (see below) |
| Stray answer | An answer for a run that isn't waiting was refused | `answer-rejected`, 404 |

**Seen live:** a cancelled run is recorded at $0 with no tokens, although the model had already answered once before the stop. The runner does send a final `result` with an estimated cost. But on abort, `server/agent/claude-agentcore.ts` closes the stream and throws at once, so it never reads that result. It is a small undercount and a follow-up (section 5).

**Not live-tested:** the Kiro runtime. It needs a Kiro sign-in; the relay and guard are covered by `test/agentcore-portal.test.ts` and `test/kiro-agentcore.test.ts`.

### CI on Linux

On `main_v3` after the merge, CI passed: type check, backend tests and DynamoDB contract tests. The deploy workflow's `verify` job also passed, including `npm run test:engine`, which runs the real runner and Claude Code engine.

### Local (Windows 11, Node 22.23.3)

| Check | Result |
|---|---|
| New unit tests (tool policy, broker, payloads): `test/agentcore-harness.test.ts` | 12 passed |
| Portal relay, Claude and Kiro: `test/agentcore-portal.test.ts` | 7 passed |
| End to end, real runner server + real Claude Code engine + stand-in model API: `npm run test:engine` | 4 passed (approve, decline + guard, spend cap, cancel) in 16 s |
| Full suite (`test/*.test.ts`, Windows, Node 22.23.3) | 2,860 passed, 0 failed, 18 skipped |
| Portal type check | 0 errors (main_v3 had 97) |
| Build | Pass |
| `agent-runner` and `kiro-runner` type check and build | Pass |
| `test:map:check` | Pass |
| CDK synth of both new stacks | Pass |
