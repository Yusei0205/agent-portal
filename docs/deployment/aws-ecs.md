# Deploying Agent Portal on AWS ECS Fargate

This guide walks through running the Agent Portal as a containerised service on AWS ECS Fargate
with an Application Load Balancer, EFS for persistent storage, and Secrets Manager for secrets.

---

## 1. Architecture overview

```
Internet
   │  HTTPS (443)
   ▼
┌──────────────────────────────────────────┐
│  Application Load Balancer               │
│  - HTTPS listener (ACM certificate)      │
│  - Sticky sessions (lb_cookie, 86400 s)  │
└─────────────────────┬────────────────────┘
                      │  HTTP (8787)
                      ▼
┌─────────────────────────────────────────────────────┐
│  ECS Fargate Task                                   │
│                                                     │
│  ┌─────────────────────────┐  ┌──────────────────┐  │
│  │  portal container       │  │  browser sidecar │  │
│  │  (image: ecr/portal)    │  │  (optional)      │  │
│  │  PORT=8787              │  │  localhost:3000  │  │
│  └──────────┬──────────────┘  └──────────────────┘  │
│             │ EFS mount (/data)                      │
└─────────────┼───────────────────────────────────────┘
              │
    ┌─────────▼──────────┐    ┌───────────────────────┐
    │  Amazon EFS        │    │  AWS Secrets Manager  │
    │  portal.db,        │    │  PORTAL_SECRET_KEY    │
    │  vault, projects…  │    │  KIRO_API_KEY (opt)   │
    └────────────────────┘    └───────────────────────┘
```

**Key design decisions:**
- The portal runs a single Node.js process with a built-in SQLite database — scale-out is not
  supported. Run exactly **one task** per service.
- EFS provides durable, persistent storage that survives task replacements and upgrades.
- ALB sticky sessions ensure every browser request hits the same task (required for SSE and
  session cookies).
- Secrets Manager injects the secret key at task start so it never lives on disk.

---

## 2. Prerequisites

Before you start:

- **AWS CLI** ≥ 2.x, configured with an account that has admin-level permissions for the
  initial setup.
- **Docker** — for building and pushing the container image.
- **ECR repository** — create one if you don't have one:
  ```bash
  aws ecr create-repository --repository-name agent-portal --region us-east-1
  ```
- **EFS filesystem** — create and note the filesystem ID:
  ```bash
  aws efs create-file-system \
    --performance-mode generalPurpose \
    --encrypted \
    --tags Key=Name,Value=agent-portal-data \
    --region us-east-1
  ```
  Also create a mount target in each subnet where Fargate tasks will run.
- **Secrets Manager secret** for `PORTAL_SECRET_KEY`:
  ```bash
  # Generate a key
  KEY=$(openssl rand -hex 32)
  aws secretsmanager create-secret \
    --name agent-portal/secret-key \
    --secret-string "$KEY" \
    --region us-east-1
  ```
  Note the secret ARN — you'll need it in the task definition.

---

## 3. IAM task role

Create a task role with the minimum required permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SecretsManager",
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:*:*:secret:agent-portal/*"
    },
    {
      "Sid": "BedrockInvoke",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "*"
    },
    {
      "Sid": "S3Storage",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:HeadObject",
                 "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::YOUR_BUCKET_NAME",
        "arn:aws:s3:::YOUR_BUCKET_NAME/*"
      ]
    }
  ]
}
```

Remove the `S3Storage` statement if you are using EFS for storage (the default).

Create the role:

```bash
# 1. Create the role with the ECS trust policy
aws iam create-role \
  --role-name AgentPortalTaskRole \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Principal":{"Service":"ecs-tasks.amazonaws.com"},
      "Action":"sts:AssumeRole"
    }]
  }'

# 2. Attach the inline policy above
aws iam put-role-policy \
  --role-name AgentPortalTaskRole \
  --policy-name AgentPortalPolicy \
  --policy-document file://task-role-policy.json
```

You also need a **task execution role** (for ECS to pull images and write logs):

```bash
aws iam attach-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
```

---

## 4. ECS task definition

Replace the placeholder values (`YOUR_*`) before registering.

```json
{
  "family": "agent-portal",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "2048",
  "memory": "3072",
  "taskRoleArn": "arn:aws:iam::YOUR_ACCOUNT_ID:role/AgentPortalTaskRole",
  "executionRoleArn": "arn:aws:iam::YOUR_ACCOUNT_ID:role/ecsTaskExecutionRole",
  "volumes": [
    {
      "name": "portal-data",
      "efsVolumeConfiguration": {
        "fileSystemId": "YOUR_EFS_FILESYSTEM_ID",
        "rootDirectory": "/",
        "transitEncryption": "ENABLED"
      }
    }
  ],
  "containerDefinitions": [
    {
      "name": "portal",
      "image": "YOUR_ACCOUNT_ID.dkr.ecr.YOUR_REGION.amazonaws.com/agent-portal:latest",
      "essential": true,
      "portMappings": [
        { "containerPort": 8787, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "DATA_DIR",        "value": "/data" },
        { "name": "PORT",            "value": "8787" },
        { "name": "HOST",            "value": "0.0.0.0" },
        { "name": "DEPLOY_TARGET",   "value": "cloud" },
        { "name": "TRUST_PROXY",     "value": "1" },
        { "name": "NODE_ENV",        "value": "production" }
      ],
      "secrets": [
        {
          "name": "SECRET_KEY_ARN",
          "valueFrom": "arn:aws:secretsmanager:YOUR_REGION:YOUR_ACCOUNT_ID:secret:agent-portal/secret-key"
        }
      ],
      "mountPoints": [
        {
          "sourceVolume": "portal-data",
          "containerPath": "/data",
          "readOnly": false
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/agent-portal",
          "awslogs-region": "YOUR_REGION",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -sf http://localhost:8787/api/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ]
}
```

Register the task definition:

```bash
aws ecs register-task-definition \
  --cli-input-json file://task-definition.json \
  --region YOUR_REGION
```

---

## 5. ALB sticky sessions

The portal uses a single SQLite database and in-memory state, so **all requests from one browser
session must reach the same task**. Enable sticky sessions on the ALB target group:

```bash
aws elbv2 modify-target-group-attributes \
  --target-group-arn YOUR_TARGET_GROUP_ARN \
  --attributes \
    Key=stickiness.enabled,Value=true \
    Key=stickiness.type,Value=lb_cookie \
    Key=stickiness.lb_cookie.duration_seconds,Value=86400
```

Set the health check path to `/api/health` and the success codes to `200`.

---

## 6. First deployment

### Push image to ECR

```bash
# Authenticate
aws ecr get-login-password --region YOUR_REGION | \
  docker login --username AWS --password-stdin \
  YOUR_ACCOUNT_ID.dkr.ecr.YOUR_REGION.amazonaws.com

# Build and push
docker build -t agent-portal .
docker tag agent-portal:latest \
  YOUR_ACCOUNT_ID.dkr.ecr.YOUR_REGION.amazonaws.com/agent-portal:latest
docker push \
  YOUR_ACCOUNT_ID.dkr.ecr.YOUR_REGION.amazonaws.com/agent-portal:latest
```

### Create ECS cluster and service

```bash
# Create cluster (if needed)
aws ecs create-cluster --cluster-name agent-portal --region YOUR_REGION

# Create the service (1 task, single-AZ placement recommended for SQLite)
aws ecs create-service \
  --cluster agent-portal \
  --service-name portal \
  --task-definition agent-portal \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[YOUR_SUBNET_ID],
    securityGroups=[YOUR_SG_ID],
    assignPublicIp=DISABLED
  }" \
  --load-balancers "targetGroupArn=YOUR_TARGET_GROUP_ARN,containerName=portal,containerPort=8787" \
  --region YOUR_REGION
```

### Verify health check

```bash
# Watch service events
aws ecs describe-services \
  --cluster agent-portal \
  --services portal \
  --query 'services[0].events[:5]' \
  --region YOUR_REGION

# Tail logs
aws logs tail /ecs/agent-portal --follow --region YOUR_REGION
```

The portal is ready when the ALB health check at `/api/health` returns `200`. Open the ALB DNS
name (or your custom domain) to complete the admin setup.

---

## 7. Kiro API key

If you use the Kiro engine, store `KIRO_API_KEY` in Secrets Manager and inject it into the task:

```bash
aws secretsmanager create-secret \
  --name agent-portal/kiro-api-key \
  --secret-string "YOUR_KIRO_API_KEY" \
  --region YOUR_REGION
```

Add to the `secrets` array in the task definition:

```json
{
  "name": "KIRO_API_KEY",
  "valueFrom": "arn:aws:secretsmanager:YOUR_REGION:YOUR_ACCOUNT_ID:secret:agent-portal/kiro-api-key"
}
```

Add `secretsmanager:GetSecretValue` for this ARN to the task role.

---

## 8. Browser MCP sidecar (optional)

To enable the web browser tool for agent runs, add the browser container as a second container
in the same task. The portal reaches it via `localhost` (awsvpc network mode shares the network
namespace within a task).

Add to `containerDefinitions` in the task definition:

```json
{
  "name": "browser-mcp",
  "image": "YOUR_ACCOUNT_ID.dkr.ecr.YOUR_REGION.amazonaws.com/browser-mcp:latest",
  "essential": false,
  "portMappings": [
    { "containerPort": 3000, "protocol": "tcp" }
  ]
}
```

And add this environment variable to the `portal` container:

```json
{ "name": "PORTAL_BROWSER_MCP_URL", "value": "http://localhost:3000" }
```

---

## 9. Backup

Use AWS Backup to take daily EFS snapshots:

```bash
# Create a backup plan
aws backup create-backup-plan --backup-plan '{
  "BackupPlanName": "agent-portal-daily",
  "Rules": [{
    "RuleName": "daily-30-day-retention",
    "TargetBackupVaultName": "Default",
    "ScheduleExpression": "cron(0 5 * * ? *)",
    "Lifecycle": { "DeleteAfterDays": 30 }
  }]
}' --region YOUR_REGION

# Assign the EFS filesystem to the plan
aws backup create-backup-selection \
  --backup-plan-id YOUR_PLAN_ID \
  --backup-selection '{
    "SelectionName": "portal-efs",
    "IamRoleArn": "arn:aws:iam::YOUR_ACCOUNT_ID:role/AWSBackupDefaultServiceRole",
    "Resources": ["arn:aws:elasticfilesystem:YOUR_REGION:YOUR_ACCOUNT_ID:file-system/YOUR_EFS_ID"]
  }' --region YOUR_REGION
```

The SQLite WAL is flushed on graceful shutdown; for a consistent snapshot you can stop the ECS
task before the backup window or use the built-in portal backup endpoint before taking the
snapshot.

---

## 10. Upgrade

```bash
# 1. Build and push the new image
docker build -t agent-portal .
docker tag agent-portal:latest \
  YOUR_ACCOUNT_ID.dkr.ecr.YOUR_REGION.amazonaws.com/agent-portal:latest
docker push \
  YOUR_ACCOUNT_ID.dkr.ecr.YOUR_REGION.amazonaws.com/agent-portal:latest

# 2. Force a new deployment (ECS pulls the new image and replaces the task)
aws ecs update-service \
  --cluster agent-portal \
  --service portal \
  --force-new-deployment \
  --region YOUR_REGION
```

ECS will start the new task, wait for it to pass the health check, then stop the old task.
The brief overlap is safe because only one task runs at a time with the `desiredCount: 1` setup.

Schema migrations are applied automatically on start. If a migration fails, the task will exit
and the old task continues to serve traffic until you resolve the issue.

---

## 11. Troubleshooting

### Secret not found

```
[config] Failed to load secret from Secrets Manager: AccessDeniedException
```

The task role is missing `secretsmanager:GetSecretValue` for the secret ARN.
Check the task role policy and the secret's resource-based policy.

### EFS mount timeout

The task stops immediately or hangs at startup. Check:
1. The EFS mount target exists in the same VPC/subnet as the Fargate task.
2. The task's security group allows outbound NFS traffic (TCP port 2049) to the EFS security group.
3. The EFS security group allows inbound NFS (TCP 2049) from the task's security group.

```bash
# Check mount target state
aws efs describe-mount-targets \
  --file-system-id YOUR_EFS_ID \
  --region YOUR_REGION
```

### Port already in use

If you run two tasks accidentally (desiredCount > 1 on one host), they will share the EFS mount
but write to the same SQLite file, causing corruption. Keep `desiredCount: 1` at all times.

### Out of memory

The task definition sets 3 GB. If agent runs are killed by the OOM killer, raise `memory` to
`4096` in the task definition and re-deploy.

### Health check failing after deploy

The portal takes up to 30 seconds to start on first launch (database migration + secret key
resolution). The `startPeriod: 60` in the health check definition gives it time. If it still
fails, check CloudWatch logs:

```bash
aws logs tail /ecs/agent-portal --follow --region YOUR_REGION
```
