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
