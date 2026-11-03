/**
 * AgentPortalSpikeA — CDK Stack
 *
 * Resources created:
 *   - Import of existing ECR repository agent-portal/agent-runner
 *     (created and image-pushed via CLI before this deploy)
 *   - IAM execution role for the AgentCore Runtime (least privilege: Bedrock + logs + ECR)
 *   - CloudWatch Log Group (/aws/bedrock-agentcore/agent-runner, 14-day retention)
 *   - AgentCore Runtime (PUBLIC network, 5-min idle timeout, 30-min max lifetime)
 *
 * Image build: the linux/arm64 image is built locally and pushed to ECR via
 *   infra/scripts/push-image.ps1  before running `cdk deploy`.
 *   CDK references the ECR image URI directly (no DockerImageAsset build during deploy).
 *
 * To destroy:
 *   npx cdk destroy --profile agentcore
 */

import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';

/** ECR repo name — must exist and have the image pushed before `cdk deploy`. */
const ECR_REPO_NAME = 'agent-portal/agent-runner';
/** Image tag to use in the AgentCore Runtime. */
const IMAGE_TAG = 'br-202611037';

export class AgentPortalSpikeAStack extends cdk.Stack {
  public readonly runtimeArn: string;
  public readonly logGroupName: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── ECR Repository (imported — created and image pushed via CLI) ──────────
    // The repo is created outside CDK to avoid build-time ordering issues.
    // Lifecycle rule (keep 3 images) is applied by infra/scripts/push-image.ps1.
    const repo = ecr.Repository.fromRepositoryName(this, 'AgentRunnerRepo', ECR_REPO_NAME);

    const imageUri = `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${ECR_REPO_NAME}:${IMAGE_TAG}`;

    // ── CloudWatch Log Group ──────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'AgentRunnerLogGroup', {
      logGroupName: '/aws/bedrock-agentcore/agent-runner',
      retention: logs.RetentionDays.TWO_WEEKS,   // 14 days
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.logGroupName = logGroup.logGroupName;

    // ── Execution Role ─────────────────────────────────────────────────────────
    // Least privilege: Bedrock InvokeModel on Haiku 4.5 + Sonnet 4.5 profiles only,
    // CloudWatch Logs write for its own log group, ECR pull for our repo.
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: 'agent-portal-spike-a-runtime-role',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for AgentCore Runtime spike-a. Bedrock + Logs + ECR only',
    });

    // AgentCore Browser: the runner starts a managed browser session on demand and drives it over the
    // automation WebSocket (SigV4 with this role). Resource is * because the AWS-managed browser
    // (aws.browser.v1) lives under an AWS-owned ARN; tighten once the exact ARNs are confirmed.
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreBrowser',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:StartBrowserSession',
        'bedrock-agentcore:GetBrowserSession',
        'bedrock-agentcore:StopBrowserSession',
        'bedrock-agentcore:ConnectBrowserAutomationStream',
        'bedrock-agentcore:ConnectBrowserLiveViewStream',
      ],
      resources: ['*'],
    }));

    // Bedrock: InvokeModel on both global inference profiles + underlying model ARNs.
    // The global inference profile routes to one or more regional model endpoints.
    // Both the inference profile ARN and the foundation-model ARNs are needed so
    // the router can call the model in whatever region it selects.
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvokeHaiku45AndSonnet45',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        // Global inference profiles (account-scoped)
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0`,
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0`,
        // Foundation-model ARNs in any region (cross-region routing uses these)
        // arn:aws:bedrock:<region>::foundation-model/<model-id>
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
      ],
    }));

    // CloudWatch Logs: write to our log group
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogsWrite',
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStreams',
      ],
      resources: [
        logGroup.logGroupArn,
        `${logGroup.logGroupArn}:*`,
      ],
    }));

    // AgentCore writes each runtime's logs and metrics to its default log group; without this the runtime
    // runs but nothing shows up in CloudWatch or the AgentCore observability view.
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreDefaultLogs',
      effect: iam.Effect.ALLOW,
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
      ],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreMetrics',
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
    }));

    // ECR: pull the agent-runner image
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcrPullAgentRunner',
      effect: iam.Effect.ALLOW,
      actions: [
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:BatchCheckLayerAvailability',
      ],
      resources: [repo.repositoryArn],
    }));

    // GetAuthorizationToken requires * — it's a global API action
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcrGetAuthToken',
      effect: iam.Effect.ALLOW,
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    // ── AgentCore Runtime ─────────────────────────────────────────────────────
    // Using CfnRuntime (L1 construct) from aws-cdk-lib/aws-bedrockagentcore.
    // Network mode PUBLIC: no VPC needed for the spike.
    // Lifecycle: 5-minute idle timeout, 30-minute max lifetime.
    const runtime = new bedrockagentcore.CfnRuntime(this, 'AgentPortalRuntime', {
      agentRuntimeName: 'agentPortalSpikeA',
      description: 'Spike A: agent-runner container running Claude Code via AgentCore',
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: imageUri,
        },
      },
      roleArn: executionRole.roleArn,
      networkConfiguration: {
        networkMode: 'PUBLIC',
      },
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: 300,   // 5 minutes idle → microVM released
        maxLifetime: 1800,                 // 30 minutes absolute max
      },
      // Persistent per-session folder (preview): repositories and files survive after the microVM is released, as long as
      // later calls use the same runtime session id (see server/agent/agentcore-session.ts). 1 GB, kept 14 days idle,
      // reset when a new runtime version is deployed. The runners fall back to temporary disk if it is not mounted.
      filesystemConfigurations: [{ sessionStorage: { mountPath: '/mnt/workspace' } }],
      environmentVariables: {
        AWS_DEFAULT_REGION: this.region,
        AWS_REGION: this.region,
      },
    });

    // Tags (stack-level; propagated to all resources)
    cdk.Tags.of(this).add('project', 'agent-portal');
    cdk.Tags.of(this).add('purpose', 'spike-a');

    // Explicit dependency: Runtime must wait for all IAM policies to be attached.
    // Without this, AgentCore tries to validate the ECR URI before the role has
    // permissions and fails with an "Access denied" validation error.
    const inlinePolicy = executionRole.node.findChild('DefaultPolicy');
    if (inlinePolicy) {
      const cfnPolicy = inlinePolicy.node.defaultChild as cdk.CfnResource;
      runtime.addDependsOn(cfnPolicy);  // CfnRuntime is already L1; use addDependsOn directly
    }

    this.runtimeArn = runtime.attrAgentRuntimeArn;

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'RuntimeArn', {
      exportName: 'spike-a-runtime-arn',
      value: runtime.attrAgentRuntimeArn,
      description: 'AgentCore Runtime ARN',
    });

    new cdk.CfnOutput(this, 'EcrRepoUri', {
      exportName: 'spike-a-ecr-repo-uri',
      value: imageUri,
      description: 'ECR image URI used by the Runtime',
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      exportName: 'spike-a-log-group',
      value: logGroup.logGroupName,
      description: 'CloudWatch Log Group for agent-runner',
    });

    new cdk.CfnOutput(this, 'ExecutionRoleArn', {
      exportName: 'spike-a-execution-role-arn',
      value: executionRole.roleArn,
      description: 'IAM execution role ARN',
    });
  }
}
