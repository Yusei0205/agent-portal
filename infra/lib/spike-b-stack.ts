/**
 * AgentPortalSpikeB — CDK Stack
 *
 * Resources created:
 *   - Import of existing ECR repository agent-portal/kiro-runner
 *     (created and image-pushed via CLI before this deploy)
 *   - IAM execution role for the AgentCore Runtime (least privilege: logs + ECR only;
 *     kiro-cli calls Kiro's service, not Bedrock, so no bedrock:InvokeModel needed)
 *   - CloudWatch Log Group (/aws/bedrock-agentcore/kiro-runner, 14-day retention)
 *   - AgentCore Runtime (PUBLIC network, 5-min idle timeout, 30-min max lifetime)
 *
 * Image build: the linux/arm64 image is built locally and pushed to ECR via
 *   the commands in infra/README.md before running `cdk deploy AgentPortalSpikeB`.
 *   CDK references the ECR image URI directly (no DockerImageAsset build during deploy).
 *
 * To destroy:
 *   npx cdk destroy AgentPortalSpikeB --profile agentcore
 */

import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';

/** ECR repo name — must exist and have the image pushed before `cdk deploy`. */
const ECR_REPO_NAME = 'agent-portal/kiro-runner';
/** Image tag to use in the AgentCore Runtime. */
const IMAGE_TAG = 'br-202611039';

export class AgentPortalSpikeBStack extends cdk.Stack {
  public readonly runtimeArn: string;
  public readonly logGroupName: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── ECR Repository (imported — created and image pushed via CLI) ──────────
    const repo = ecr.Repository.fromRepositoryName(this, 'KiroRunnerRepo', ECR_REPO_NAME);
    const imageUri = `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${ECR_REPO_NAME}:${IMAGE_TAG}`;

    // ── CloudWatch Log Group ──────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'KiroRunnerLogGroup', {
      logGroupName: '/aws/bedrock-agentcore/kiro-runner',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.logGroupName = logGroup.logGroupName;

    // ── Execution Role ─────────────────────────────────────────────────────────
    // Least privilege: kiro-cli calls Kiro's own service (not Bedrock), so we do
    // NOT grant bedrock:InvokeModel.  Only CloudWatch Logs write + ECR pull.
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: 'agent-portal-spike-b-runtime-role',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for AgentCore Runtime spike-b (kiro-runner). Logs + ECR only.',
    });

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

    // ECR: pull the kiro-runner image
    // AgentCore Browser: the runner's browser MCP starts a managed browser session on demand and drives it over the
    // automation WebSocket (SigV4 with this role). Resource * until the exact browser ARNs are confirmed.
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

    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcrPullKiroRunner',
      effect: iam.Effect.ALLOW,
      actions: [
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:BatchCheckLayerAvailability',
      ],
      resources: [repo.repositoryArn],
    }));

    // GetAuthorizationToken requires * — global API action
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcrGetAuthToken',
      effect: iam.Effect.ALLOW,
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    // ── AgentCore Runtime ─────────────────────────────────────────────────────
    // Same lifecycle settings as Spike A: 5-min idle, 30-min max.
    // PUBLIC network: kiro-cli needs outbound HTTPS to Kiro's service endpoints.
    const runtime = new bedrockagentcore.CfnRuntime(this, 'KiroRunnerRuntime', {
      agentRuntimeName: 'agentPortalSpikeB',
      description: 'Spike B: kiro-runner container running kiro-cli headless via AgentCore',
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
    cdk.Tags.of(this).add('purpose', 'spike-b');

    // Explicit dependency: Runtime must wait for all IAM policies to be attached.
    const inlinePolicy = executionRole.node.findChild('DefaultPolicy');
    if (inlinePolicy) {
      const cfnPolicy = inlinePolicy.node.defaultChild as cdk.CfnResource;
      runtime.addDependsOn(cfnPolicy);
    }

    this.runtimeArn = runtime.attrAgentRuntimeArn;

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'RuntimeArn', {
      exportName: 'spike-b-runtime-arn',
      value: runtime.attrAgentRuntimeArn,
      description: 'AgentCore Runtime ARN for kiro-runner',
    });

    new cdk.CfnOutput(this, 'EcrRepoUri', {
      exportName: 'spike-b-ecr-repo-uri',
      value: imageUri,
      description: 'ECR image URI used by the Runtime',
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      exportName: 'spike-b-log-group',
      value: logGroup.logGroupName,
      description: 'CloudWatch Log Group for kiro-runner',
    });

    new cdk.CfnOutput(this, 'ExecutionRoleArn', {
      exportName: 'spike-b-execution-role-arn',
      value: executionRole.roleArn,
      description: 'IAM execution role ARN',
    });
  }
}
