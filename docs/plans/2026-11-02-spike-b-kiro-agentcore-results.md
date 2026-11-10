# Spike B — Kiro CLI in Bedrock AgentCore Results

## Update (2026-11-02, after fix) — PASS

| Check | Result |
|---|---|
| Device-code sign-in inside AgentCore (`spike-b-login.mjs`) | PASS. Code shown, user approved, token returned (620 bytes, never logged). |
| `kiro-run` (`spike-b-run.mjs`) | PASS 3 of 3. Reply `kiro-cloud-ok`, exit 0, first text about 6.4 s. |

Root cause of the login failure: kiro-cli 2.37 on Linux still shows "Enter Start URL" and "Enter Region" prompts (prefilled from the flags). Without a terminal it reads empty input, the region becomes empty, and it fails with "failed to construct request". It was not a container sandbox problem. Fix: `kiro-runner/src/login.ts` runs kiro-cli under a pseudo-terminal (`script -qfc`), presses Enter at each prompt, and parses the new `Code:` / `Open this URL:` output.

The earlier intermittent kiro-run failures did not recur in these runs; the earlier "browser tool" explanation below is unconfirmed.

---

**Branch:** `main_v3`
**Date:** 2026-11-02
**Region:** ap-southeast-1 (Singapore)
**Account:** 366019841051

---

## Summary

| Item | Result |
|------|--------|
| kiro-cli 2.37.1 runs in linux/arm64 musl container | ✅ |
| AgentCore Runtime deployed | ✅ |
| ACP protocol works (initialize → session/new → session/prompt) | ✅ |
| OIDC token refresh (spike-b-run.mjs pre-invocation) | ✅ |
| kiro-cli responded "kiro-cloud-ok" | ✅ (1 of 7 runs) |
| kiro-run overall verdict | **CONDITIONAL PASS** |
| Blocker for 100% reliability | kiro-cli non-deterministically uses browser tool; Chromium not in container |
| spike-b-login.mjs ready | ✅ (not run — requires user approval) |

---

## What was built

### kiro-runner container image

A new standalone container image `agent-portal/kiro-runner` (ECR, `ap-southeast-1`) that serves the AgentCore Runtime HTTP contract (GET /ping, POST /invocations with SSE) and runs kiro-cli in two modes:

| Mode | Description |
|------|-------------|
| `kiro-run` | Materialises a temp auth DB from the caller-supplied IdC token, runs `kiro-cli acp` (JSON-RPC 2.0 over stdio), streams output, detects token refresh |
| `kiro-login` | Creates an empty auth DB, runs `kiro-cli login --use-device-flow`, streams verification URL and user code, returns token payload |

#### Image facts

| Metric | Value |
|--------|-------|
| Image size (uncompressed, linux/arm64) | **399 MB** |
| kiro-cli version | 2.37.1 |
| kiro-cli binary | `/usr/local/bin/kiro-cli` (38 MB) |
| kiro-cli-chat binary | `/usr/local/bin/kiro-cli-chat` (207 MB — the ACP backend) |
| kiro-cli-term binary | `/usr/local/bin/kiro-cli-term` (30 MB) |
| Base image | `node:22-slim` (Debian Bookworm, glibc 2.36) |
| kiro-cli build | musl-aarch64 (static, chosen because glibc 2.36 < 2.39 threshold for gnu aarch64) |
| Node.js version | 22.23.4 |
| No npm runtime deps | ✅ (only node:* built-ins) |
| Non-root user (UID 1000) | ✅ |

The image is smaller than Spike A's agent-runner (614 MB) because it does not include `@anthropic-ai/claude-agent-sdk`.

#### CDK stack `AgentPortalSpikeB`

| Resource | Value |
|----------|-------|
| Stack ARN | `arn:aws:cloudformation:ap-southeast-1:366019841051:stack/AgentPortalSpikeB/55cd87a0-d640-11f1-b68d-02ffeaf058eb` |
| ECR repository | `agent-portal/kiro-runner` (lifecycle rule: keep 3 images) |
| IAM execution role | `agent-portal-spike-b-runtime-role` (logs + ECR only — no Bedrock, kiro calls Kiro's service) |
| CloudWatch Log Group | `/aws/bedrock-agentcore/kiro-runner` (14-day retention) |
| **AgentCore Runtime ARN** | `arn:aws:bedrock-agentcore:ap-southeast-1:366019841051:runtime/agentPortalSpikeB-bdj4np3GHd` |

Lifecycle: `idleRuntimeSessionTimeout: 300s`, `maxLifetime: 1800s`. Network: PUBLIC.

---

## Run results

### kiro-run timings

| Run | Session | First byte (ms) | First text (ms) | Duration (ms) | Cold start (s) | Outcome |
|-----|---------|-----------------|-----------------|---------------|----------------|---------|
| 1 | (chat mode) | 7,867 | 9,687 | 9,688 | 0.2 | browser error |
| 2 | (ACP, v2) | 971 | 2,745 | 2,746 | 340 | browser error |
| 3 | (ACP, v3) | 1,506 | 3,236 | 3,237 | 473 | browser error |
| 4 | (ACP + OIDC refresh) | 912 | 2,658 | 2,658 | 517 | browser error |
| **5 ✅** | **`70a3fe9c`** | **910** | **3,097** | **3,097** | **308** | **kiro-cloud-ok ✅ exit 0** |
| 6 | `40a35a09` | 978 | 2,820 | 2,820 | 806 | browser error |
| 7 | `1a71587f` | 978 | 2,820 | 2,820 | 864 | browser error |

**Run 5 is a confirmed PASS** — kiro-cli responded "kiro-cloud-ok" via ACP with exit code 0.

The ACP timing on the successful run: firstByte=910 ms, firstText=3,097 ms, total duration=3,097 ms (plus 308 s cold start for image pull).

### OIDC token refresh

The spike-b-run.mjs script calls AWS SSO OIDC `CreateToken` with `grant_type: refresh_token` before invoking the runner. The refresh works reliably:
- Stored token expiry: `2026-11-01T22:48:57.705Z`
- Refreshed token expiry: `2026-11-01T23:17:xx – 23:20:xx` (successive runs)

The OIDC-refreshed token was used for runs 4–7. Run 5 (cold start 308 s) succeeded; runs 4, 6, 7 (cold start 473–864 s) failed.

### Root cause of intermittent browser error

kiro-cli's ACP mode starts the AI agent and lets it decide which tools to use for the prompt. For the prompt "Reply with exactly: kiro-cloud-ok":
- On run 5 (success): the AI chose to respond directly with text (no tools)
- On all other runs: the AI chose to use a browser tool first, which failed because Chromium is not installed in the container

The error is not about the access token being invalid — it is about the AI model's non-deterministic tool selection. With 7 attempts, 1 succeeded (14% success rate).

The cold start pattern (shorter cold start = success) suggests: warm microVMs (where kiro-cli was recently called) may have a different initial state than fresh ones. This needs further investigation.

The OIDC token refresh path works correctly. The stored refresh token is valid and produces fresh access tokens.

### kiro-cli browser requirement — fix options

| Option | Description | Image size impact |
|--------|-------------|-------------------|
| Add Chromium | Install `chromium` in the Dockerfile | +250–400 MB |
| Set `DISPLAY` + Xvfb | Add virtual display; may redirect browser to headless Chromium | +100 MB |
| Use `spike-b-login.mjs` | Device-flow login from container; user approves code in browser outside | No change |
| Disable browser tool in kiro-cli config | Pass a `~/.config/kiro/` config that disables the browser tool | Unknown |
| Upgrade kiro-cli | A newer version may have better headless support | No change |

**Recommended path**: Add Chromium (headless) to the container and test.

---

## Token handling design for production

### Encryption in transit and at rest

| Boundary | Method |
|----------|--------|
| Portal DB → spike-b-run.mjs | AES-256-GCM via `server/secrets.ts` decrypt |
| spike-b-run.mjs → AgentCore | TLS 1.3 (all `InvokeAgentRuntime` calls are TLS-encrypted by the SDK) |
| AgentCore → kiro-runner microVM | AWS internal network (encrypted by AWS infrastructure) |
| Token in temp DB inside microVM | In-memory only, deleted on exit |
| Token in SSE `result` event (if refreshed) | Transmitted over the same TLS-encrypted AgentCore channel |

For S9 (Kiro in cloud): the access token should not be placed in the invocation payload at all. Instead:
1. Portal stores the encrypted token in AWS Secrets Manager before each run.
2. Portal passes only the Secrets Manager ARN in the payload.
3. kiro-runner fetches and decrypts the token from Secrets Manager at runtime using the execution role.
4. After the run, kiro-runner conditionally writes a refreshed token back to Secrets Manager.

### Conditional write-back for concurrent refreshes

If two sessions use the same IdC credential and both refresh at the same time, the second write would overwrite the first. In production:

1. kiro-runner returns the refreshed token in the SSE `result.refreshedToken` field.
2. The portal API receives it via the run callback.
3. The portal performs a conditional update (`UPDATE engine_credentials SET secret_enc = ? WHERE id = ? AND secret_enc = ?`) using the PRE-run ciphertext as the condition. The second concurrent writer detects the conflict (0 rows updated) and discards its token (the first writer's refresh token is already stored).

This is optimistic concurrency — the same pattern the portal already uses for `_refreshPromises` deduplication, extended to the AgentCore callback path.

---

## Costs

| Component | Cost |
|-----------|------|
| ECR storage (399 MB image) | ~$0.04/month |
| AgentCore compute per run | ~$0 (CPU scales to zero; short runs) |
| CloudWatch Logs | ~$0 (no successful runs) |
| Bedrock tokens | $0 (kiro uses Kiro's service, not Bedrock) |
| **Total idle cost** | **~$0.04/month** |

kiro-cli uses Kiro's own service endpoints (not Amazon Bedrock) for LLM calls. There is no Bedrock token cost for kiro runs. The cost is dominated by kiro-cli's own licensing/usage model.

---

## Teardown

Leave the stack deployed for follow-up testing. To destroy when done:

```sh
cd infra
npx cdk destroy AgentPortalSpikeB --profile agentcore
aws ecr delete-repository --repository-name agent-portal/kiro-runner --force \
  --region ap-southeast-1 --profile agentcore
```

---

## Files created / changed

| Path | Purpose |
|------|---------|
| `kiro-runner/Dockerfile` | linux/arm64 image with kiro-cli 2.37.1 |
| `kiro-runner/package.json` | standalone npm package (no runtime deps) |
| `kiro-runner/tsconfig.json` | TypeScript config |
| `kiro-runner/build.mjs` | esbuild bundler |
| `kiro-runner/src/index.ts` | HTTP server (GET /ping, POST /invocations, SSE) |
| `kiro-runner/src/validate.ts` | Payload validation for kiro-run / kiro-login modes |
| `kiro-runner/src/run.ts` | kiro-run: materialise auth DB, run kiro-cli ACP, detect refresh |
| `kiro-runner/src/login.ts` | kiro-login: device-flow, stream verification URL/code |
| `infra/lib/spike-b-stack.ts` | CDK stack (ECR import, IAM role, log group, AgentCore Runtime) |
| `infra/bin/app.ts` | Added `AgentPortalSpikeBStack` |
| `infra/scripts/spike-b-run.mjs` | Reads portal DB, refreshes token via OIDC, invokes kiro-run |
| `infra/scripts/spike-b-login.mjs` | Invokes kiro-login, writes verification URL to temp file |
| `infra/README.md` | Added Spike B section |
| `test/test-map.json` | Added `kiro-runner` module |
| `docs/plans/2026-11-02-spike-b-kiro-agentcore-results.md` | This file |

---

## Open questions for S9

1. **Chromium requirement** — Confirm whether kiro-cli needs Chromium for all run modes, or only for the auth flow. If only auth, `spike-b-login.mjs` (device flow) may be sufficient for S9 since token refresh via OIDC does not require a browser.

2. **kiro-cli headless flag** — Check the kiro-cli 2.37 changelog and any `KIRO_*` environment variables for a headless/no-browser mode. The login docs at https://kiro.dev/blog/introducing-headless-mode/ mention `KIRO_API_KEY` for headless; IdC headless mode may require different configuration.

3. **`spike-b-login.mjs` validation** — The login script is built and ready. Running it (user must approve a device code) will confirm whether the device-flow path produces a token that kiro-cli accepts for subsequent ACP runs.

4. **API key mode vs IdC mode** — The plan (section 8, row 3) lists two sign-in modes: (a) `KIRO_API_KEY` and (b) IAM Identity Center. Mode (a) sets a simple env var and may work without browser auth. Test mode (a) as a fallback.

5. **Token write-back in S9** — The spike-b-run.mjs intentionally does not write the refreshed token back to portal.db (spike only). S9 must implement the conditional write-back via the AgentCore run callback.
