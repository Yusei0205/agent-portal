# infra — CDK Stacks

CDK TypeScript stacks for `main_v3` spikes.

| Stack | Purpose |
|---|---|
| `AgentPortalSpikeA` | AgentCore Runtime (agent-runner container) |
| `AgentPortalSpikeC` | AppSync Events live-update channels proof |

## What it creates

- ECR repository `agent-portal/agent-runner` (lifecycle rule: keep 3 images)
- IAM execution role `agent-portal-spike-a-runtime-role` (Bedrock InvokeModel + logs + ECR)
- CloudWatch Log Group `/aws/bedrock-agentcore/agent-runner` (14-day retention)
- AgentCore Runtime `agentPortalSpikeA-1BMsBp5VDV` (PUBLIC network, 5-min idle, 30-min max)

## Runtime ARN

```
arn:aws:bedrock-agentcore:ap-southeast-1:366019841051:runtime/agentPortalSpikeA-1BMsBp5VDV
```

## Deploy

Prerequisites:
- AWS CLI profile `agentcore` configured
- Docker Desktop running with linux/arm64 emulation (QEMU)
- CDK CLI 2.1147.0+ (`npm install -g aws-cdk@latest`)

```sh
# From repo root: build and push image to ECR
$loginPwd = aws ecr get-login-password --region ap-southeast-1 --profile agentcore
$loginPwd | docker login --username AWS --password-stdin 366019841051.dkr.ecr.ap-southeast-1.amazonaws.com
docker buildx build --platform linux/arm64 --load -f agent-runner/Dockerfile -t agent-runner:local .
docker tag agent-runner:local 366019841051.dkr.ecr.ap-southeast-1.amazonaws.com/agent-portal/agent-runner:latest
docker push 366019841051.dkr.ecr.ap-southeast-1.amazonaws.com/agent-portal/agent-runner:latest

# Deploy the CDK stack
cd infra
npm install
cdk deploy --profile agentcore --require-approval never
```

## Invoke

```sh
# Single normal run
node scripts/invoke.mjs

# 3 cold-start runs (new sessions)
node scripts/invoke.mjs --cold

# Guard test
node scripts/invoke.mjs --guard

# Warm call (reuse session)
node scripts/invoke.mjs --warm <session-id>

# Repo clone + summarise
node scripts/invoke.mjs --repo

# Diagnostic (df -h, memory, vCPU)
node scripts/invoke.mjs --diag
```

## Destroy

The stack costs nothing when idle (no running sessions). ECR storage is ~$0.06/month for a 614 MB image.

To tear everything down:

```sh
cd infra
npx cdk destroy --profile agentcore
```

Then delete the ECR repo (CDK does not manage it since it was created via CLI):

```sh
aws ecr delete-repository --repository-name agent-portal/agent-runner \
  --force --region ap-southeast-1 --profile agentcore
```

## Cost

With idle stack (no invocations): ~$0.06/month (ECR storage).  
Per short run (5–10 s): ~$0.009–$0.025 (Bedrock tokens; compute is negligible).  
20 runs/day of 10-minute sessions: ~$32–62/month (Bedrock tokens dominate).

See `docs/plans/2026-11-01-spike-a-agentcore-results.md` for full measurements.

---

# Spike C — AppSync Events

Live-update channel proof: AppSync Events with IAM publish + Lambda authorizer for browser subscribe.

## What it creates

- AppSync Events API `agent-portal-spike-c`
- Lambda authorizer `agent-portal-spike-c-authorizer` (token scope → channel access)
- Channel namespaces: `run`, `project`, `global` (with IAM publish + Lambda subscribe auth)
- IAM log role and CloudWatch Log Group `/aws/appsync/spike-c` (3-day retention)

## API endpoints (deployed)

| Endpoint | URL |
|---|---|
| HTTP (publish) | `https://am5pzyt7cjffdgzpq6jyuvli5e.appsync-api.ap-southeast-1.amazonaws.com` |
| WebSocket (subscribe) | `wss://am5pzyt7cjffdgzpq6jyuvli5e.appsync-realtime-api.ap-southeast-1.amazonaws.com/event/realtime` |

## Deploy Spike C

Prerequisites: CDK bootstrapped (done), profile `agentcore` configured.

```sh
# From repo root
cd infra
npm install
npm run build
npx cdk deploy AgentPortalSpikeC --profile agentcore --require-approval never
```

Then generate config and run tests:

```sh
# Write scripts/spike-c-config.json from CDK outputs
node scripts/spike-c-setup.mjs

# Terminal 1: subscribe (listen for events, cross-project deny test, latency stats)
node scripts/spike-c-subscribe.mjs --duration 90

# Terminal 2: publish (500-event burst, large-payload test, cost estimate)
node scripts/spike-c-publish.mjs

# Quick smoke check (single event, IAM auth test)
node scripts/spike-c-publish.mjs --verify
```

## Key results

- **Cross-project subscribe denied** ✅
- **p50 latency: 74 ms, p95: 165 ms** (same region)
- **Batch limit: 5 events per HTTP request** (AppSync enforced)
- **Reconnect: 107 ms** — no missed events replayed (pure pub/sub)
- **Spike cost: < $0.002** — production estimate ~$0.13/month at 20 runs/day

See `docs/plans/2026-11-02-spike-c-appsync-events-results.md` for full measurements.

## Destroy Spike C

```sh
cd infra
npx cdk destroy AgentPortalSpikeC --profile agentcore
# No ECR repo was created for Spike C — nothing else to delete.
```

The stack costs ~$0/month when idle (no connections, no invocations).
