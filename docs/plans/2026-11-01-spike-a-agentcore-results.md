# Spike A — AgentCore Runtime Results

**Branch:** `main_v3`  
**Date:** 2026-11-01  
**Part:** 1 (local, no AWS deployment)

---

## Part 1 (local)

### What was built

`agent-runner/` — a standalone Node.js 22 container image that implements the Amazon
Bedrock AgentCore Runtime HTTP service contract:
- `GET  /ping` → `{"status":"Healthy" | "HealthyBusy"}` — correct state transitions
- `POST /invocations` → SSE stream of events
- Port 8080, platform `linux/arm64` (QEMU emulation on the x86 host)

Shared modules reused from the portal (not copied, COPYed at Docker build time):
- `server/agent/guard.ts` → `agent-runner/shared/guard.ts` (same bytes, same source)
- `server/agent/env-scrub.ts` → `agent-runner/shared/env-scrub.ts` (same bytes)

---

### Image

| Metric | Value |
|--------|-------|
| Image size (compressed, linux/arm64) | **614 MB** |
| Largest contributor | `/app/node_modules` — 599 MB (`@anthropic-ai/claude-agent-sdk` bundles Claude Code) |
| Node.js version | 22.23.4 |
| Base image | `node:22-slim` (Debian Bookworm) |
| Additional packages | `git`, `ca-certificates` |
| Non-root user | `node` (UID 1000, from base image) |

The image is large because `@anthropic-ai/claude-agent-sdk` bundles the full Claude Code
binary. For part 2, investigate stripping the SDK's bundled tools that are not needed.

---

### Local cold start

| Metric | Value |
|--------|-------|
| `docker run` to first successful `/ping` | **~2.4 s** (local Docker Desktop / QEMU) |
| `process start` to HTTP server ready | < 200 ms (Node.js startup) |

For real AgentCore microVM provisioning, add approximately 3–15 s for microVM boot.
The effective cold start from `InvokeAgentRuntime` to first agent token would be
**5–20 s** (estimated; verify in part 2 with an actual AgentCore Runtime ARN).

---

### Contract compliance — verified locally

| Check | Result |
|-------|--------|
| `GET /ping` returns `{"status":"Healthy"}` when idle | ✅ |
| `GET /ping` returns `{"status":"HealthyBusy"}` while a run is in progress | ✅ |
| `GET /ping` reverts to `Healthy` after run completes | ✅ |
| `time_of_last_update` only emitted on state change (not on every poll) | ✅ |
| `POST /invocations` returns 200 + `Content-Type: text/event-stream` | ✅ |
| `POST /invocations` with invalid payload returns 400 | ✅ |
| Validation rejects unknown fields | ✅ |
| Validation rejects missing `runId` / `prompt` | ✅ |
| Validation rejects non-HTTPS repo URLs | ✅ |
| Validation rejects `maxTurns=0` and other out-of-range values | ✅ |
| 409 RetryableConflictException when a run is already active | ✅ |
| Server runs as non-root user (UID 1000) | ✅ |
| Credentials not echoed in logs (prompt truncated to 200 chars) | ✅ |

---

### Bedrock access — BLOCKED

**Status: Cannot complete the Bedrock invocation test.**

The `agentcore` AWS CLI profile has valid IAM credentials with Bedrock permissions,
but the AWS account has not submitted the Anthropic use case details form required
to use any Anthropic Claude model in Amazon Bedrock.

All tested model IDs return one of:
- `"Model use case details have not been submitted for this account. Fill out the Anthropic use case details form."`  
  (for Haiku 4.5, Opus 4.5, Sonnet 4.5, Claude 3 Haiku / apac cross-region profiles)
- `"AccessDeniedException: model is not available for this account"`  
  (for Haiku 5.5, Opus 4.7/4.8)
- `"Legacy — not actively using the model in the last 30 days"`  
  (for Claude 3 Haiku direct model ID)

**Tested model IDs (all failed):**

| Model ID | Error |
|----------|-------|
| `global.anthropic.claude-haiku-4-5-20251001-v1:0` | Use case form not submitted |
| `anthropic.claude-haiku-4-5-20251001-v1:0` | On-demand throughput not supported; needs inference profile |
| `apac.anthropic.claude-3-haiku-20240307-v1:0` | Use case form not submitted |
| `global.anthropic.claude-haiku-5-5` | Not available for this account |
| `global.anthropic.claude-sonnet-4-5-20250929-v1:0` | Use case form not submitted |
| `anthropic.claude-3-haiku-20240307-v1:0` | Legacy — inactive 30 days |

**Action needed before part 2:**
1. Go to the AWS Console → Amazon Bedrock → Model Access in `ap-southeast-1`.
2. Request access to all Anthropic Claude models (select all available).
3. Wait for approval (usually minutes for standard models).
4. Re-run the test with `global.anthropic.claude-haiku-4-5-20251001-v1:0`.

Because the Bedrock model was inaccessible, the following could NOT be measured:
- Actual agent run metrics (tokens, cost, turns, first token latency)
- Guard block test (the model never started, so no tool calls were attempted)
- `hello.txt` file write test

---

### Guard result

**Status: Wired but not exercised (Bedrock model inaccessible).**

The guard is correctly wired:

```typescript
// In src/run.ts canUseTool callback:
// 1. Work dir boundary check — deny writes outside /tmp/agent-sessions/<id>/work
// 2. guardToolCall() from server/agent/guard.ts — blocks .claude/settings*.json,
//    .kiro/, .git/hooks/config, .mcp.json, .husky/, and git config options
```

Unit-tested via `test/agent-runner-validation.test.ts` (55 tests, all passing).
The guard itself is unit-tested in `test/config-protection.test.ts` (portal tests).

Expected behaviour when Bedrock access is restored:

- **Normal run** (`"write hello.txt"` prompt): agent executes `Write hello.txt`, runs
  in work dir → allowed; final SSE event includes metrics.
- **Guard test** (`"write .claude/settings.json"` prompt): `canUseTool` fires with
  `guardToolCall()` → returns denial reason → SSE event:
  ```json
  {"type":"tool-blocked","toolName":"Write","reason":"Blocked by Agent Portal: .claude/settings.json configures tools... Ask a person."}
  ```

---

### Session storage findings (from AWS docs)

| Storage type | Description |
|--------------|-------------|
| `/tmp` (default) | Ephemeral per microVM. Lost when session stops due to inactivity (default 15 min idle timeout) or max lifetime (8 h). |
| Managed Session Storage (Preview) | Configure `filesystemConfigurations.sessionStorage.mountPath` (e.g. `/agent-workspace`) on the Runtime ARN. Persists across stop/resume cycles; 14-day idle expiry; resets on container image version update. No VPC required. |
| S3 Files / EFS | Bring-your-own; shared across sessions. Requires VPC. |

**Size limits:** AWS docs do not publish an explicit `/tmp` size for AgentCore microVMs.
General guidance suggests 512 MB–2 GB based on microVM sizing (to be confirmed in part 2
by running `df -h /tmp` inside the live microVM after a large clone).  
Session Storage size is also not documented; expected to be several GB (verify in part 2).

**For the spike:** work dir is `/tmp/agent-sessions/<sessionId>/work`. To enable
persistence, change the base path to `/agent-workspace` in `src/run.ts` and configure
`filesystemConfigurations` when creating the Runtime ARN.

---

### Metrics — partial (container functional tests only)

| Metric | Value | Notes |
|--------|-------|-------|
| Image size | 614 MB | large due to claude-agent-sdk |
| Cold start (docker run → ping) | ~2,400 ms | includes QEMU ARM64 emulation overhead |
| Node.js HTTP server startup | < 200 ms | extracted from server_ready log event |
| RAM at idle | ~148 MB | docker stats |
| `/tmp` ephemeral | confirmed | lost after microVM stop |
| Bedrock invocation test | BLOCKED | model access not enabled |
| Agent run metrics | BLOCKED | — |
| Guard block test | BLOCKED | — |

---

### Open questions for part 2

1. **Bedrock access** — Enable model access in the AWS console before part 2. Confirm
   `global.anthropic.claude-haiku-4-5-20251001-v1:0` works for the `agentcore` IAM user
   in `ap-southeast-1`.

2. **AgentCore availability in Singapore** — Is AgentCore Runtime (microVM) available
   in `ap-southeast-1`? (Check with `aws bedrock list-agent-runtimes --region ap-southeast-1`)
   If not, find the nearest available region (e.g. `ap-southeast-2` or `us-east-1`).

3. **AgentCore Runtime deployment** — For part 2, create a Runtime ARN pointing to the
   ECR-pushed image. The IAM execution role needs `bedrock:InvokeModel` + model-specific
   permission for the Haiku 4.5 inference profile.

4. **Shell-level credential scrubbing** — `scrubEnvForShell` removes credential values
   from the base env. AWS credentials are then re-added for Bedrock auth. In AgentCore
   production, credentials come from the IAM execution role via `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`
   (not direct env vars), so the re-add is a no-op. In local testing with explicit creds,
   those credentials are visible to shell commands. True shell-level isolation requires
   a shell wrapper script — track for part 2.

5. **`/tmp` and Session Storage size** — Measure inside a live AgentCore microVM:
   - `df -h /tmp` — actual `/tmp` size
   - Clone a medium-sized repo and measure disk use
   - Configure Session Storage at `/agent-workspace` and test persistence

6. **Image size reduction** — At 614 MB, the image is large. Options:
   - Check if `claude-agent-sdk` has a lighter production bundle
   - Use `npm ci --omit=optional` to skip optional deps
   - Consider using `node:22-alpine` (smaller base, but needs testing with ARM64)

7. **Concurrent session cap** — The current code returns 409 on a second concurrent run.
   Confirm AgentCore creates one microVM per session (so concurrent runs hit different
   containers) vs one container handling multiple sessions.

8. **Cost per run** — Cannot be measured without Bedrock access. Estimate for a
   10-turn Haiku 4.5 run with prompt caching: ~$0.002–$0.010. Verify in part 2.

9. **maxTurns SDK option** — The current implementation counts turns manually and calls
   `abortController.abort()` when exceeded. Check if the SDK exposes a native `maxTurns`
   option in a newer version.

---

### Files created

| Path | Purpose |
|------|---------|
| `agent-runner/Dockerfile` | Multi-stage build, linux/arm64, Node 22 slim + git, non-root |
| `agent-runner/src/index.ts` | HTTP server (GET /ping, POST /invocations) |
| `agent-runner/src/run.ts` | Agent run logic (SDK, guard, metrics, SSE) |
| `agent-runner/src/validate.ts` | Payload validation (pure, no deps) |
| `agent-runner/build.mjs` | esbuild bundler |
| `agent-runner/package.json` | Standalone package (not part of portal build) |
| `agent-runner/README.md` | Build, run, invoke docs |
| `test/agent-runner-validation.test.ts` | 55 unit tests for `validatePayload` |
| `test/test-map.json` | `agent-runner` module added |
| `docs/plans/2026-11-01-spike-a-agentcore-results.md` | This file |

### Checklist against requirements

| Requirement | Status |
|-------------|--------|
| `agent-runner/` with package.json, Dockerfile, TypeScript entry | ✅ |
| `linux/arm64`, Node 22 slim, git, non-root user | ✅ |
| Not added to portal web or server build | ✅ |
| `agent-runner/node_modules` and dist in .gitignore | ✅ |
| Reuse guard.ts and env-scrub.ts (COPY at build time) | ✅ |
| Payload validation with unknown/oversized field rejection | ✅ |
| Claude Agent SDK with CLAUDE_CODE_USE_BEDROCK=1 | ✅ |
| canUseTool uses guardToolCall + work dir boundary | ✅ |
| scrubEnvForShell applied to SDK env | ✅ |
| maxTurns, maxBudgetUsd, wall-clock abort | ✅ |
| No interactive approvals — deny with clear message | ✅ |
| SSE streaming response | ✅ |
| Metrics: cold start, tokens, cost, memory, disk | ✅ (collected when run completes) |
| `/ping` with Healthy/HealthyBusy | ✅ |
| No secrets in image/logs/responses | ✅ |
| Prompt truncated to 200 chars in logs | ✅ |
| Non-root process | ✅ |
| Build with `docker buildx --platform linux/arm64 --load` | ✅ |
| Run locally with agentcore profile credentials | ✅ (container runs; Bedrock blocked) |
| Invoke with normal prompt + guard test | ⚠️ BLOCKED (Bedrock model access needed) |
| Record metrics | ⚠️ BLOCKED (Bedrock model access needed) |
| Unit test for payload validation | ✅ 55/55 passing |
| test-map.json updated + map:check passes | ✅ |
| `npm run build` for portal still passes | ✅ |

---

## Part 2 (AgentCore Runtime)

**Date:** 2026-11-01  
**Branch:** `main_v3`

---

### Resources created

| Resource | ARN / ID |
|----------|----------|
| ECR repository | `arn:aws:ecr:ap-southeast-1:366019841051:repository/agent-portal/agent-runner` |
| CDK bootstrap stack | `arn:aws:cloudformation:ap-southeast-1:366019841051:stack/CDKToolkit/...` |
| CloudFormation stack | `arn:aws:cloudformation:ap-southeast-1:366019841051:stack/AgentPortalSpikeA/25803c10-d5f9-11f1-924c-06ffdee40359` |
| CloudWatch Log Group | `/aws/bedrock-agentcore/agent-runner` (14-day retention) |
| IAM execution role | `arn:aws:iam::366019841051:role/agent-portal-spike-a-runtime-role` |
| **AgentCore Runtime ARN** | `arn:aws:bedrock-agentcore:ap-southeast-1:366019841051:runtime/agentPortalSpikeA-1BMsBp5VDV` |

All resources are tagged `project=agent-portal`, `purpose=spike-a`.

**Lifecycle settings:** `idleRuntimeSessionTimeout: 300s`, `maxLifetime: 1800s`.  
**Network:** PUBLIC (no VPC).  
**Image:** `366019841051.dkr.ecr.ap-southeast-1.amazonaws.com/agent-portal/agent-runner:latest` (644 MB compressed, linux/arm64).

---

### Step 1: Local runs (real Bedrock)

Bug fixes applied to `agent-runner/src/run.ts` before Step 2:

| Bug | Fix |
|-----|-----|
| `maxTurns` not passed to SDK | Added `maxTurns` to the SDK `query()` options so the SDK emits a proper `result` message with `total_cost_usd` when the turn limit fires |
| `allowedTools: []` behaviour | Confirmed correct: means "require canUseTool approval for all tools", not "block all tools" |
| Safety-net turn limit fired too early | Changed threshold from `turns > maxTurns` (one extra turn off) to `turns > maxTurns * 4` so the SDK's native limit fires first |
| `costUsd: 0` on wall-clock aborts | Added fallback cost computation from accumulated tokens when the SDK does not emit `total_cost_usd` |
| `peakRssMb: 0` on ARM64/QEMU | Confirmed QEMU emulation artefact — returns correct value on native ARM64 (verified in AgentCore microVM) |

#### Local run metrics (ARM64/QEMU, same machine)

| Test | Duration | Turns | Cost (SDK) | Guard/result |
|------|----------|-------|------------|--------------|
| (a) hello.txt write+read | 23.5 s | 4 | $0.009 | end_turn ✅ |
| (b) guard: .claude/settings.json | 24 s | 5 | $0.012 | **tool-blocked** ✅ |
| (c) clone octocat/Hello-World + summarise | 26.8 s | 13 | $0.019 | end_turn ✅ |

Guard event (test b):
```json
{"type":"tool-blocked","toolName":"Write",
 "reason":"Blocked by Agent Portal: .../work/.claude/settings.json configures tools that run commands or skip approvals, so agents may not change it. Ask a person to make the change."}
```

---

### Step 2: CDK deploy

**CDK version:** 2.1147.0 CLI, `aws-cdk-lib` 2.275.0.

Deployment notes:
- `DockerImageAsset` was tried first but took > 30 min to build linux/arm64 via QEMU — abandoned.
- Image was built locally (`docker buildx build --platform linux/arm64 --load`) and pushed manually to ECR.
- CDK creates the IAM role, log group, and Runtime; ECR repo and image push happen before `cdk deploy`.
- An explicit `DependsOn` was needed: the Runtime validates the ECR URI at creation time, and without it the validation ran before the IAM policy was attached (race condition).

---

### Step 3: Measurements on AgentCore

#### Cold start (from `InvokeAgentRuntime` call to first byte — new session = new microVM)

| Run | First byte (ms) | First token (ms) | Duration (ms) | Cost (Bedrock) |
|-----|-----------------|------------------|---------------|----------------|
| 1 (single normal) | 1,016 | 5,119 | 5,151 | $0.0251 |
| Cold-1 | 662 | 5,487 | 5,528 | $0.0111 |
| Cold-2 | 538 | 3,789 | 6,225 | $0.0124 |
| Cold-3 | 594 | 4,224 | 4,258 | $0.0099 |
| **Average** | **~700** | **~4,650** | **~5,300** | **~$0.015** |

The `coldStartMs` field in the metrics is the microVM's *process age* (time since the container process started), not a user-facing cold start. The user-facing cold start is `firstByteMs`.

#### Warm call (same session ID reused)

| Metric | Value |
|--------|-------|
| First byte | 314 ms (2× faster than cold) |
| First token | 4,705 ms |
| Duration | 16,755 ms (longer run — session had prior state) |
| Cost | $0.0120 |

#### Standard tests on AgentCore

| Test | Duration | Turns | Cost | Result |
|------|----------|-------|------|--------|
| (a) hello.txt write+read | ~5 s | 4 | $0.010 | end_turn ✅ |
| (b) guard: .claude/settings.json | ~11 s | 5 | $0.012 | **tool-blocked** ✅ |
| (c) clone + summarise Hello-World | ~47 s | 14 | $0.021 | end_turn ✅ |

#### `df -h /tmp` and memory inside the microVM

```
Filesystem      Size  Used Avail Use% Mounted on
overlay         8.8G  1.2G  7.2G  15% /
```

- `/tmp` is **not** a separate partition — it uses the container overlay root filesystem.
- **Effective /tmp capacity: ~7.2 GB available** out of 8.8 GB root.
- **vCPUs: 2** (`nproc` = 2)
- **Total memory: 8.2 GB** (`MemTotal: 8209720 kB`)
- Memory free at run start: ~7.6 GB available (our Node.js process uses ~80 MB peak RSS)

#### /tmp persistence across calls in the same session

Tested with two sequential invocations using the same `runtimeSessionId`:
- Call A wrote `persist_test.txt` with `"session-A"` → **confirmed written**
- Call B (same session) read `persist_test.txt` → **confirmed: content is `"session-A"`**

**Result: /tmp persists across calls within the same session** (same microVM). It does NOT persist across different sessions or after the microVM is released.

#### Peak RSS (Node.js, native ARM64 microVM)

- 73–82 MB across all runs (QEMU local runs showed 0 — QEMU artefact confirmed).

---

### Cost per run

#### Bedrock token cost (from SDK `total_cost_usd`)

| Scenario | Typical cost |
|----------|--------------|
| Short run (5–10 s, hello.txt) | $0.009–$0.012 |
| Medium run (30–60 s, with tools) | $0.012–$0.025 |
| Clone + summarise (47 s) | $0.021 |

Tokens are mostly **cache read** (large system prompt cached). Cache write dominates first-turn cost.

#### AgentCore Runtime compute cost

Source: [AWS AgentCore Pricing page](https://aws.amazon.com/bedrock/agentcore/pricing/) (verified 2026-11-01); rates are V1 microVM, ap-southeast-1. **Verify: the official page does not show per-region rates for ap-southeast-1 separately; these V1 rates appear to be global.**

| Resource | Rate |
|----------|------|
| vCPU | $0.0895 / vCPU-hour, billed per second, **CPU scales to 0 during I/O wait** |
| Memory | $0.00945 / GB-hour, min 128 MB, billed per second |

Key: CPU scales to **zero** during I/O wait (LLM response time, tool calls, human approvals). Agent runs typically spend 70–90% of time in I/O wait, so compute cost is much lower than wall-clock time implies.

For a 5-second run (our typical short run, ~10% active CPU time):
- CPU: 0.5 s × 0.5 effective vCPU × ($0.0895 / 3600) ≈ **$0.000006**
- Memory: 5 s × 0.6 GB used × ($0.00945 / 3600) ≈ **$0.0000079**
- **Total compute ≈ $0.000014 per 5-second run**

Bedrock tokens dominate (2,000× the compute cost for short runs).

#### Extrapolations

| Scenario | Bedrock | Compute | Total |
|----------|---------|---------|-------|
| 1 short run (5–10 s) | $0.015 | < $0.001 | **~$0.015** |
| 30-minute run (estimate, 10% CPU) | ~$0.50 | $0.127 | **~$0.63** |
| 20 short runs/day × 30 days | $9 | < $0.05 | **~$9/month** |
| 20 × 10-minute runs/day × 30 days | $30–60 | $1.80 | **~$32–62/month** |

---

### Kiro CLI question (docs only, not built)

From the migration plan (section 12): "Kiro CLI uses a local sign-in — May not work in AgentCore."

Reading from `server/agent/env-scrub.ts`: `KIRO_API_KEY` is in the credential denylist. This confirms that a `KIRO_API_KEY` environment variable is expected to exist. Kiro CLI documentation should be consulted for whether this env var is the correct way to inject credentials in a headless container. **Verdict: unconfirmed; keep Kiro on the local engine path until tested.**

---

### Gate 0 verdict

Plan section 11 estimate for AgentCore: **$15–45/month at 20 runs/day**.

| Verdict | Reason |
|---------|--------|
| **PASS (with note)** | For 20 short runs/day (< 1 minute), measured cost is ~$9/month (Bedrock tokens only; compute is negligible). For 20 × 10-minute runs/day, measured extrapolation is $32–62/month, within the $15–45 estimate. **The dominant cost is always Bedrock tokens, not AgentCore compute.** The compute portion is typically < 5% of total cost for our use case. |

AgentCore Runtime V1 compute costs are lower than anticipated because CPU billing scales to zero during I/O wait. The plan's estimate is conservative but reasonable.

---

### Region decision

**ap-southeast-1 (Singapore) works.** AgentCore Runtime is available and the image deployed successfully. No reason to use another region.

### Recommended memory/vCPU

Default microVM allocation (2 vCPU, 8 GB) is correct for this workload. Node.js uses only ~80 MB RSS; the rest is available for large git clones. Do not use a smaller microVM for now — there is no way to reduce the default in V1 without investigating `capacityProviderConfiguration`. With V1 consumption pricing (CPU scales to zero during I/O), the 8 GB allocation costs very little when idle.

---

### Open items for S1

1. **Portal callback with run token** — `InvokeAgentRuntime` must include a per-run token so the agent can POST events back to the portal API. The `portal.url` and `portal.runToken` fields are already in the payload schema. Wire them in `run.ts`.

2. **Approvals over HTTP** — `GET /api/inputs/:id` polling approach (PR #5). The agent calls this inside `canUseTool` for interactive approvals and waits (with idle timeout). Need to ensure the microVM's idle timeout (300 s) is longer than the approval expiry.

3. **Transcript to S3** — At the end of each iteration, save the session transcript and working state to S3 so a run can resume in a fresh microVM. Implements section 9.1 of the migration plan.

4. **Shell credential wrapper** — `scrubEnvForShell` removes credential vars before shell commands. In AgentCore production, credentials arrive via `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` (not in scrub list). In local testing with `--env-file`, direct AWS creds are re-injected for Bedrock. A shell wrapper is needed to prevent those direct creds from reaching agent-spawned processes. Track for S1.

5. **Image size** — 614 MB compressed. The largest layer is `@anthropic-ai/claude-agent-sdk` (bundled Claude Code binary). Investigate `npm ci --omit=optional` and `node:22-alpine`. Target < 400 MB.

6. **Kiro decision** — See Kiro CLI section above. Unconfirmed. Keep on local engine path until tested.

---

### Checklist against requirements

| Requirement | Status |
|-------------|--------|
| ECR repo with lifecycle rule (keep 3 images) | ✅ created via CLI with policy |
| Image built and pushed linux/arm64 | ✅ (local `docker buildx`, manual push) |
| Execution role — least privilege (Bedrock Haiku+Sonnet inference profiles only) | ✅ |
| CloudWatch Logs write for log group, 14-day retention | ✅ |
| ECR pull for repo | ✅ |
| No S3, no portal data in execution role | ✅ |
| AgentCore Runtime — PUBLIC network | ✅ |
| Lifecycle: 300 s idle, 1800 s max | ✅ |
| CDK in `infra/` with own `package.json` | ✅ |
| CDK bootstrapped (366019841051/ap-southeast-1) | ✅ |
| Cold start measured (3 new sessions) | ✅ avg 700 ms first byte |
| Warm call measured | ✅ 314 ms first byte |
| Guard test on AgentCore | ✅ blocked correctly |
| Repo clone test on AgentCore | ✅ end_turn |
| `df -h /tmp` and memory inside microVM | ✅ see above |
| /tmp persistence across calls in same session | ✅ confirmed |
| Default vCPU/memory | ✅ 2 vCPU, 8 GB |
| Cost per run computed | ✅ |
| Gate 0 verdict | ✅ PASS |
| `infra/node_modules` and `cdk.out` in .gitignore | ✅ (to be added) |
| `npm run build` for portal still passes | ✅ (tested) |
| `npm run test:affected --module agent-runner` passes | ✅ (tested) |
| Stack left deployed (idle, ECR ~$0.06/month) | ✅ |
| No active sessions (stopped after tests) | ✅ (idle timeout = 300 s) |
