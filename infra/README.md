# infra — Spike A CDK Stack

CDK TypeScript stack for the AgentCore Runtime spike (Spike A, `main_v3` branch).

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
