# agent-runner

Minimal Amazon Bedrock AgentCore Runtime container image.

Implements the AgentCore HTTP service contract:
- `POST /invocations` — runs one Claude Code agent turn, streams SSE events
- `GET /ping` — returns `{"status":"Healthy"}` (or `"HealthyBusy"` during a run)
- Port **8080**, platform **linux/arm64**

Guard and env-scrub wiring comes from the portal's own `server/agent/guard.ts` and
`server/agent/env-scrub.ts` — same source file, copied at Docker build time.

---

## Build

Build from the **repo root** (so Docker can COPY the shared portal modules):

```sh
docker buildx build --platform linux/arm64 --load \
  -f agent-runner/Dockerfile \
  -t agent-runner:local \
  .
```

Emulation is fine on an x86 host (QEMU via Docker Desktop). The first build takes
a few minutes; subsequent builds use the layer cache.

---

## Run locally with real Bedrock

> Requires an AWS CLI profile named `agentcore` with Bedrock access in
> `ap-southeast-1`. Credentials are passed at run time only — never baked into
> the image.

```sh
# Export credentials from the agentcore profile into a temp file
$TmpCreds = "$env:TEMP\agentcore-creds.env"
aws configure export-credentials --profile agentcore --format env-no-export > $TmpCreds

# Run the container (arm64 emulation on x86)
docker run --rm -d \
  --name agent-runner-test \
  --platform linux/arm64 \
  -p 8080:8080 \
  --env-file "$TmpCreds" \
  -e AWS_DEFAULT_REGION=ap-southeast-1 \
  -e AWS_REGION=ap-southeast-1 \
  agent-runner:local

# Wait for the server to be ready
Start-Sleep -Seconds 3

# Clean up the temp credential file immediately
Remove-Item "$TmpCreds"
```

The credential file is deleted right after `docker run` — credentials are not
written inside the repo and are not echoed to stdout.

---

## Invoke

### Normal run

```sh
$body = '{"runId":"test-01","prompt":"List the files in the work dir, write hello.txt containing \"hi\", then read it back."}'
Invoke-RestMethod -Method Post -Uri http://localhost:8080/invocations `
  -ContentType 'application/json' `
  -Body $body | ConvertTo-Json -Depth 5
```

Or with curl (Git Bash / WSL):

```sh
curl -s -X POST http://localhost:8080/invocations \
  -H 'Content-Type: application/json' \
  -d '{"runId":"test-01","prompt":"List the files in the work dir, write hello.txt containing \"hi\", then read it back."}' \
  --no-buffer
```

### Guard test (must be blocked)

```sh
curl -s -X POST http://localhost:8080/invocations \
  -H 'Content-Type: application/json' \
  -d '{"runId":"guard-test","prompt":"Write the text {\"blocked\":true} to .claude/settings.json"}' \
  --no-buffer
```

Expect a `tool-blocked` event with the guard reason.

### Health check

```sh
curl http://localhost:8080/ping
# {"status":"Healthy"}
```

---

## Stop and remove

```sh
docker stop agent-runner-test
docker rm agent-runner-test
```

---

## Invocation payload schema

```json
{
  "runId":        "(required) string — unique run identifier",
  "prompt":       "(required) string — agent goal, max 100,000 characters",
  "model":        "(optional) Bedrock model ID; default us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "maxTurns":     "(optional) integer 1–200; default 10",
  "maxBudgetUsd": "(optional) number 0–100; default 0.50",
  "maxMinutes":   "(optional) number 0–480; default 10",
  "repo": {
    "url":    "(required) public HTTPS clone URL",
    "branch": "(optional) branch name"
  },
  "portal": {
    "url":      "(required) portal callback URL (part 2)",
    "runToken": "(required) per-run auth token (part 2)"
  },
  "policy":     "(optional) { trusted, rules[] }: the run's permission rules, applied to every tool call",
  "approvals":  "(optional) { via: 'portal', expiryMinutes }: calls that need a person are streamed as approval-request",
  "agents": {
    "<name>": "(optional) the project's subagents: { description, prompt, tools?, disallowedTools?, model?, maxTurns? }"
  },
  "agent":      "(optional) the session's lead agent: one of agents, run as the main conversation",
  "delegation": "(optional) { via: 'portal' }: offers the delegate_session tool (child sessions)"
}
```

Unknown top-level fields are rejected with HTTP 400.

### Several agents, several sessions

- **Subagents.** `agents` goes to the Agent SDK's `agents` option, so Claude can hand work to a
  project agent with the Agent tool. At most 50 agents are accepted; agent names are 1 to 64
  letters, digits, `.`, `_` or `-`.
  - A subagent's tool calls go through the same permission check as the main agent's.
  - Its `model` may be `haiku`, `sonnet`, `opus` or `inherit`. On Bedrock these aliases map to
    the global profiles the runtime role allows (`ANTHROPIC_DEFAULT_*_MODEL`).
- **Lead agent.** `agent` runs one of `agents` as the main conversation (the Agent SDK's `agent`
  option): its prompt, tools and model. It hands work to the other agents with the Agent tool.
- **Child sessions.** With `delegation`, Claude gets `mcp__portal__delegate_session` (task, title,
  and, when the run has `agents`, `agent`: which of them runs the child session as its lead agent):
  1. A call is streamed as a `delegate-request`.
  2. The portal starts a child session, which is its own run, so on AgentCore its own microVM.
     The child's lead agent is the named one, or else the parent's.
  3. The portal answers with a mode `answer` invocation. The answer is bound to the call's
     fingerprint, like an approval.
  4. When the child finishes, the portal posts its result to the parent session.

---

## SSE event format

The response is `Content-Type: text/event-stream`. Each line is:

```
data: <json object>\n\n
```

Event types:

| `type`          | Fields                                         |
|-----------------|------------------------------------------------|
| `status`        | `text`                                         |
| `assistant-text`| `text`, `tokens.{input,output,cacheWrite,cacheRead}`, `agent` (a subagent's text) |
| `tool-call`     | `name`, `input` (truncated to 200 chars)       |
| `tool-start`    | `toolName`, `toolInput`, `agent` (a subagent's call): the call was allowed |
| `tool-result`   | `name`, `output` (truncated to 500 chars)      |
| `tool-blocked`  | `toolName`, `toolInput`, `reason`, `agent`     |
| `approval-request` | `requestId`, `toolName`, `input`, `inputHash`, `expiresAt`: a person must answer |
| `delegate-request` | `requestId`, `input.{task,title,agent}`, `inputHash`: the portal starts a child session and answers |
| `subagent-started` | `id`, `name`, `description`, `background`, `depth`, `parentId`/`parentName` (nested) |
| `subagent-finished` / `subagent-failed` | `id`, `name`, `status`, `summary`, `tokens`, `toolUses`, `durationMs` |
| `result`        | `runId`, `stop_reason`, `metrics`              |
| `error`         | `message`                                      |

The final `result` event includes the full metrics object:

```json
{
  "coldStartMs": 1240,
  "startToFirstTokenMs": 3200,
  "durationMs": 18500,
  "turns": 3,
  "inputTokens": 4200,
  "outputTokens": 380,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0,
  "costUsd": 0.0031,
  "peakRssMb": 142,
  "workDirDiskMb": 1
}
```

The same metrics are written as a structured JSON line to stdout (CloudWatch).

---

## Session storage notes

- **`/tmp` is ephemeral** — persists only for the microVM lifetime (one session start
  to session stop). If the microVM is terminated for inactivity (default idle timeout:
  15 minutes) or reaches the max lifetime (8 hours), the work dir is gone.
- **Managed Session Storage (Preview)** — configure `filesystemConfigurations` with
  `sessionStorage.mountPath = /agent-workspace` on the Runtime ARN.  Files at that
  path survive stop/resume cycles (14-day idle expiry; no VPC required).  To use it,
  change the `workDir` base in `src/run.ts` from `/tmp` to `/agent-workspace`.
- **Size**: `/tmp` is typically 512 MB–2 GB in an AgentCore microVM (not officially
  documented; measured value pending part 2 test).  Session Storage size limit is also
  not published; likely in the GB range.
- **Open question for part 2**: confirm `/tmp` size and session storage size limit in
  `ap-southeast-1` by running a large clone and checking `df -h`.

---

## Security notes

- **No secrets in the image** — credentials are injected at run time via `--env-file`.
- **Non-root user** — runs as uid 1000.
- **Prompt truncated** in logs — first 200 characters only.
- **guardToolCall** blocks writes to `.claude/settings*.json`, `.kiro/`, `.git/hooks`,
  `.mcp.json`, `.husky/`, and git config options that run external programs.
- **Work dir boundary** — write tools outside `/tmp/agent-sessions/<session>/work` are
  blocked by `canUseTool`.
- **scrubEnvForShell** removes `*_KEY`, `*_TOKEN`, `*_SECRET` vars from the SDK env.
  In AgentCore production the execution role uses `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`
  (not in the denylist), so the credential chain works.  In local testing, explicit
  `AWS_*` creds are re-injected for Bedrock auth; true shell-level isolation without
  them requires a shell wrapper — open question for part 2.

---

## Local development (outside Docker)

The `shared/` directory is populated by the Dockerfile COPY at build time.
For local TypeScript compilation/typecheck outside Docker:

```sh
# From repo root
cp server/agent/guard.ts agent-runner/shared/guard.ts
cp server/agent/env-scrub.ts agent-runner/shared/env-scrub.ts
cd agent-runner
npm install
npm run typecheck
```

Note: the `shared/` copies are gitignored — always use the originals in `server/agent/`.
