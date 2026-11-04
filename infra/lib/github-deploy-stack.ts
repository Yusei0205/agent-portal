/**
 * AgentPortalGithubDeploy — lets GitHub Actions deploy the harness runners without stored keys.
 *
 * Deployed once by an account admin:
 *   cd infra && npx -y aws-cdk@2.1147.0 deploy AgentPortalGithubDeploy -c github=1 --profile <admin-profile>
 *
 * Creates:
 *   - the GitHub OIDC identity provider (token.actions.githubusercontent.com)
 *   - role agent-portal-github-deploy, which only a workflow job of this repository running in
 *     the GitHub environment "aws-prod" can assume (.github/workflows/deploy-agentcore.yml)
 *
 * The repository is public, so trust is pinned to the exact repo and environment. Pull requests
 * from forks never receive an OIDC token for it. In the repository settings, an admin should give
 * the "aws-prod" environment required reviewers and limit it to the main_v3 branch.
 *
 * What the role may do:
 *   - assume the CDK bootstrap roles (deploy, publish assets, look up), which is how `cdk deploy` works;
 *   - start and read the runner image build, and check which images exist.
 * Nothing else: no direct access to data, secrets or the portal's own stack.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { BUILD_PROJECT, CLAUDE_REPO, KIRO_REPO } from './harness-stack';

export interface GithubDeployProps extends cdk.StackProps {
  /** owner/name of the repository allowed to deploy. */
  repository: string;
  /** GitHub environment the deploy job runs in. */
  environment: string;
}

export const GITHUB_DEPLOY_ROLE = 'agent-portal-github-deploy';

export class AgentPortalGithubDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GithubDeployProps) {
    super(scope, id, props);

    const provider = new iam.OidcProviderNative(this, 'GithubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const role = new iam.Role(this, 'DeployRole', {
      roleName: GITHUB_DEPLOY_ROLE,
      description: `GitHub Actions deploy of the Agent Portal harness runners (${props.repository}, environment ${props.environment})`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${props.repository}:environment:${props.environment}`,
        },
      }),
    });

    // `cdk deploy` works by assuming the bootstrap roles (qualifier hnb659fds).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'CdkBootstrapRoles',
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`],
    }));
    // infra/scripts/deploy-harness.mjs: build the runner images and check what is already pushed.
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'RunnerImageBuild',
      actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: [`arn:aws:codebuild:${this.region}:${this.account}:project/${BUILD_PROJECT}`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'RunnerImageLookup',
      actions: ['ecr:DescribeImages'],
      resources: [CLAUDE_REPO, KIRO_REPO].map((r) => `arn:aws:ecr:${this.region}:${this.account}:repository/${r}`),
    }));

    cdk.Tags.of(this).add('project', 'agent-portal');
    cdk.Tags.of(this).add('purpose', 'harness');

    new cdk.CfnOutput(this, 'DeployRoleArn', { value: role.roleArn, description: 'Used by .github/workflows/deploy-agentcore.yml' });
  }
}
