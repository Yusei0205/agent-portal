/**
 * Agent Portal — AgentCore runners with the harness (approvals, rules, guard, limits).
 *
 * Two stacks, deployed by infra/scripts/deploy-harness.mjs (no local Docker needed):
 *
 *   AgentPortalHarnessBuild
 *     - ECR repositories agent-portal/agent-runner-harness and agent-portal/kiro-runner-harness
 *     - the runner sources (agent-runner/, kiro-runner/, the shared server/agent modules) as an S3 asset
 *     - an arm64 CodeBuild project that builds both images natively and pushes them
 *
 *   AgentPortalHarness
 *     - AgentCore runtimes agentPortalClaudeHarness and agentPortalKiroHarness (PUBLIC network)
 *     - execution roles: Claude may call Bedrock (Claude 4.5 global profiles) and write its logs;
 *       Kiro only writes logs (kiro-cli calls Kiro's own service). Neither can read portal data.
 *     - a managed policy that lets a portal invoke both runtimes (attach it to the portal's role)
 *
 * The spike stacks (AgentPortalSpikeA/B/C) and the cloud portal stack are not touched.
 */

import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';

export const CLAUDE_REPO = 'agent-portal/agent-runner-harness';
export const KIRO_REPO = 'agent-portal/kiro-runner-harness';
export const BUILD_PROJECT = 'agent-portal-runner-images';

/** Base image from AWS's public ECR mirror of Docker Official Images (no Docker Hub rate limits). */
const NODE_IMAGE = 'public.ecr.aws/docker/library/node:22-slim';

export interface HarnessBuildProps extends cdk.StackProps {
  /** Folder with the staged runner sources (infra/scripts/deploy-harness.mjs writes it). */
  sourceDir: string;
}

export class AgentPortalHarnessBuildStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HarnessBuildProps) {
    super(scope, id, props);

    const repos = [CLAUDE_REPO, KIRO_REPO].map((name, i) => new ecr.Repository(this, i === 0 ? 'ClaudeRunnerRepo' : 'KiroRunnerRepo', {
      repositoryName: name,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 10, description: 'Keep the last 10 images' }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    }));

    const source = new s3assets.Asset(this, 'RunnerSource', { path: props.sourceDir });

    const registry = `${this.account}.dkr.ecr.${this.region}.amazonaws.com`;
    const project = new codebuild.Project(this, 'RunnerImageBuild', {
      projectName: BUILD_PROJECT,
      description: 'Builds the Claude and Kiro AgentCore runner images (linux/arm64) and pushes them to ECR',
      source: codebuild.Source.s3({ bucket: source.bucket, path: source.s3ObjectKey }),
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: codebuild.ComputeType.LARGE,
        privileged: true, // docker build
      },
      environmentVariables: {
        REGISTRY: { value: registry },
        CLAUDE_REPO_URI: { value: repos[0].repositoryUri },
        KIRO_REPO_URI: { value: repos[1].repositoryUri },
        NODE_IMAGE: { value: NODE_IMAGE },
        IMAGE_TAG: { value: 'set-by-deploy-script' },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: ['aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $REGISTRY'],
          },
          build: {
            commands: [
              'docker build --build-arg NODE_IMAGE=$NODE_IMAGE -f agent-runner/Dockerfile -t $CLAUDE_REPO_URI:$IMAGE_TAG .',
              'docker build --build-arg NODE_IMAGE=$NODE_IMAGE -f kiro-runner/Dockerfile -t $KIRO_REPO_URI:$IMAGE_TAG .',
            ],
          },
          post_build: {
            commands: [
              'test "$CODEBUILD_BUILD_SUCCEEDING" = "1"',
              'docker push $CLAUDE_REPO_URI:$IMAGE_TAG',
              'docker push $KIRO_REPO_URI:$IMAGE_TAG',
            ],
          },
        },
      }),
      timeout: cdk.Duration.minutes(40),
    });
    for (const r of repos) r.grantPullPush(project);

    cdk.Tags.of(this).add('project', 'agent-portal');
    cdk.Tags.of(this).add('purpose', 'harness');

    new cdk.CfnOutput(this, 'BuildProject', { value: project.projectName });
    new cdk.CfnOutput(this, 'ClaudeRepoUri', { value: repos[0].repositoryUri });
    new cdk.CfnOutput(this, 'KiroRepoUri', { value: repos[1].repositoryUri });
  }
}

export interface HarnessProps extends cdk.StackProps {
  /** Image tag pushed by the build (the deploy script uses a hash of the sources). */
  imageTag: string;
}

export class AgentPortalHarnessStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HarnessProps) {
    super(scope, id, props);

    const runtimeLogs = `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`;

    const makeRole = (id: string, name: string, repoName: string, bedrock: boolean): iam.Role => {
      const role = new iam.Role(this, id, {
        roleName: name,
        assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
          conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
        }),
        description: bedrock
          ? 'AgentCore runtime for Claude runs: Bedrock Claude models, its own logs, its image. No portal data.'
          : 'AgentCore runtime for Kiro runs: its own logs and image only (kiro-cli calls Kiro, not Bedrock).',
      });
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'Logs',
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
        resources: [runtimeLogs, `${runtimeLogs}:*`],
      }));
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'EcrPull',
        actions: ['ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage', 'ecr:BatchCheckLayerAvailability'],
        resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/${repoName}`],
      }));
      role.addToPolicy(new iam.PolicyStatement({ sid: 'EcrAuth', actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
      // AgentCore Browser: the runner's browser tools start a managed browser session and drive it over the automation
      // stream (SigV4 with this role). Without this, Tests case runs report "not authorized to start a browser session".
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'AgentCoreBrowser',
        actions: [
          'bedrock-agentcore:StartBrowserSession',
          'bedrock-agentcore:GetBrowserSession',
          'bedrock-agentcore:StopBrowserSession',
          'bedrock-agentcore:ConnectBrowserAutomationStream',
          'bedrock-agentcore:ConnectBrowserLiveViewStream',
        ],
        resources: ['*'],
      }));
      if (bedrock) {
        const models = [
          'anthropic.claude-haiku-4-5-20251001-v1:0',
          'anthropic.claude-sonnet-4-5-20250929-v1:0',
          'anthropic.claude-opus-4-5-20251101-v1:0',
        ];
        role.addToPolicy(new iam.PolicyStatement({
          sid: 'BedrockClaude',
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [
            ...models.map((m) => `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.${m}`),
            ...models.map((m) => `arn:aws:bedrock:*::foundation-model/${m}`),
          ],
        }));
      }
      return role;
    };

    const claudeRole = makeRole('ClaudeRunnerRole', 'agent-portal-claude-harness-runtime', CLAUDE_REPO, true);
    const kiroRole = makeRole('KiroRunnerRole', 'agent-portal-kiro-harness-runtime', KIRO_REPO, false);

    const makeRuntime = (id: string, name: string, repoName: string, role: iam.Role, description: string) => {
      const rt = new bedrockagentcore.CfnRuntime(this, id, {
        agentRuntimeName: name,
        description,
        agentRuntimeArtifact: {
          containerConfiguration: { containerUri: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${repoName}:${props.imageTag}` },
        },
        roleArn: role.roleArn,
        networkConfiguration: { networkMode: 'PUBLIC' },
        lifecycleConfiguration: {
          // A run waiting for a person reports HealthyBusy, so idle time only counts between runs.
          idleRuntimeSessionTimeout: 900,
          // Long enough for the portal's default 60-minute run limit plus approval waits.
          maxLifetime: 7200,
        },
        environmentVariables: { AWS_DEFAULT_REGION: this.region, AWS_REGION: this.region },
      });
      // The runtime validates the image with the role, so wait for the role's policy.
      const policy = role.node.tryFindChild('DefaultPolicy')?.node.defaultChild as cdk.CfnResource | undefined;
      if (policy) rt.addResourceDependency(policy);
      return rt;
    };

    const claude = makeRuntime('ClaudeRuntime', 'agentPortalClaudeHarness', CLAUDE_REPO, claudeRole,
      'Claude Code runs with the portal harness: shared tool policy, approvals relayed to the portal, spend and time limits');
    const kiro = makeRuntime('KiroRuntime', 'agentPortalKiroHarness', KIRO_REPO, kiroRole,
      'Kiro runs with the portal harness: guard on every permission request, approvals relayed to the portal');

    // What a portal needs to start runs and send approval answers and cancels.
    const invoke = new iam.ManagedPolicy(this, 'InvokeHarnessRuntimes', {
      managedPolicyName: 'agent-portal-invoke-harness-runtimes',
      description: 'Lets the Agent Portal invoke the harness AgentCore runtimes (runs, approval answers, cancels)',
      statements: [new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [claude.attrAgentRuntimeArn, `${claude.attrAgentRuntimeArn}/*`, kiro.attrAgentRuntimeArn, `${kiro.attrAgentRuntimeArn}/*`],
      })],
    });

    cdk.Tags.of(this).add('project', 'agent-portal');
    cdk.Tags.of(this).add('purpose', 'harness');

    new cdk.CfnOutput(this, 'ClaudeRuntimeArn', { value: claude.attrAgentRuntimeArn, description: 'Set as PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN' });
    new cdk.CfnOutput(this, 'KiroRuntimeArn', { value: kiro.attrAgentRuntimeArn, description: 'Set as PORTAL_KIRO_AGENTCORE_RUNTIME_ARN' });
    new cdk.CfnOutput(this, 'InvokePolicyArn', { value: invoke.managedPolicyArn, description: 'Attach to the portal role' });
    new cdk.CfnOutput(this, 'ImageTag', { value: props.imageTag });
  }
}
