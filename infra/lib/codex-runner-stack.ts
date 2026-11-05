import * as cdk from 'aws-cdk-lib';
import * as assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';

export interface CodexRunnerProps extends cdk.StackProps { repoRoot: string }
/** Opt-in stack: publishing/deploying builds the dedicated native arm64 runner image. */
export class AgentPortalCodexRunnerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CodexRunnerProps) {
    super(scope, id, props);
    const image = new assets.DockerImageAsset(this, 'CodexRunnerImage', {
      directory: props.repoRoot, file: 'codex-runner/Dockerfile', platform: assets.Platform.LINUX_ARM64,
    });
    const role = new iam.Role(this, 'CodexRuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }),
      description: 'Codex: image pull and runtime logs only; no portal data-store, secret-store, S3, or Bedrock permissions',
    });
    image.repository.grantPull(role);
    role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`] }));
    const runtime = new agentcore.CfnRuntime(this, 'CodexRuntime', {
      agentRuntimeName: 'agentPortalCodexRunner', description: 'Codex with short-lived ChatGPT OAuth, portal approvals, durable thread snapshots, and isolated repositories',
      agentRuntimeArtifact: { containerConfiguration: { containerUri: image.imageUri } }, roleArn: role.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' }, lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 7200 },
      environmentVariables: { AWS_REGION: this.region, AWS_DEFAULT_REGION: this.region },
    });
    const policy = role.node.tryFindChild('DefaultPolicy')?.node.defaultChild as cdk.CfnResource | undefined;
    if (policy) runtime.addResourceDependency(policy);
    cdk.Tags.of(this).add('project', 'agent-portal');
    new cdk.CfnOutput(this, 'CodexRuntimeArn', { value: runtime.attrAgentRuntimeArn, description: 'Set PORTAL_CODEX_AGENTCORE_RUNTIME_ARN on the portal' });
    new cdk.CfnOutput(this, 'CodexImageUri', { value: image.imageUri });
  }
}
