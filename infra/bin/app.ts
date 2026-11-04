#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AgentPortalSpikeAStack } from '../lib/spike-a-stack';
import { AgentPortalSpikeBStack } from '../lib/spike-b-stack';
import { AgentPortalSpikeCStack } from '../lib/spike-c-stack';
import { AgentPortalCloudStack } from '../lib/portal-stack';
import { AgentPortalHarnessBuildStack, AgentPortalHarnessStack } from '../lib/harness-stack';
import { AgentPortalGithubDeployStack } from '../lib/github-deploy-stack';
import * as path from 'node:path';

const app = new cdk.App();

new AgentPortalSpikeAStack(app, 'AgentPortalSpikeA', {
  env: {
    account: '366019841051',
    region: 'ap-southeast-1',
  },
  description: 'Spike A: AgentCore Runtime for agent-portal (project=agent-portal, purpose=spike-a)',
  stackName: 'AgentPortalSpikeA',
});

new AgentPortalSpikeBStack(app, 'AgentPortalSpikeB', {
  env: {
    account: '366019841051',
    region: 'ap-southeast-1',
  },
  description: 'Spike B: Kiro CLI headless in AgentCore Runtime (project=agent-portal, purpose=spike-b)',
  stackName: 'AgentPortalSpikeB',
});

new AgentPortalSpikeCStack(app, 'AgentPortalSpikeC', {
  env: {
    account: '366019841051',
    region: 'ap-southeast-1',
  },
  description: 'Spike C: AppSync Events live-update channel proof for agent-portal (project=agent-portal, purpose=spike-c)',
  stackName: 'AgentPortalSpikeC',
});

// Path B core stack. Required context: -c budgetEmail=you@example.com ; optional: -c kiroRuntimeArn=arn:aws:bedrock-agentcore:...
const budgetEmail = app.node.tryGetContext('budgetEmail');
if (budgetEmail) {
  new AgentPortalCloudStack(app, 'AgentPortalCloud', {
    env: { account: '366019841051', region: 'ap-southeast-1' },
    description: 'Agent Portal Path B: Lambda + DynamoDB + S3/CloudFront (project=agent-portal)',
    stackName: 'AgentPortalCloud',
    repoRoot: path.resolve(__dirname, '..', '..'),
    kiroRuntimeArn: app.node.tryGetContext('kiroRuntimeArn'),
    budgetEmail,
    storageBucket: app.node.tryGetContext('storageBucket'),
    claudeRuntimeArn: app.node.tryGetContext('claudeRuntimeArn'),
    agentcoreBrowser: String(app.node.tryGetContext('agentcoreBrowser')) === 'true',
    publicUrl: app.node.tryGetContext('publicUrl'),
    googleAllowed: app.node.tryGetContext('googleAllowed'),
  });
}

// Harness runners (infra/scripts/deploy-harness.mjs passes -c harness=1 and the image tag).
// Only built on request, so the spike stacks deploy without the staged runner sources.
if (app.node.tryGetContext('harness')) {
  const env = { account: '366019841051', region: 'ap-southeast-1' };
  new AgentPortalHarnessBuildStack(app, 'AgentPortalHarnessBuild', {
    env,
    stackName: 'AgentPortalHarnessBuild',
    description: 'Agent Portal: ECR and arm64 CodeBuild for the harness runner images (project=agent-portal, purpose=harness)',
    sourceDir: path.join(__dirname, '..', '.harness-src'),
  });
  new AgentPortalHarnessStack(app, 'AgentPortalHarness', {
    env,
    stackName: 'AgentPortalHarness',
    description: 'Agent Portal: Claude and Kiro AgentCore runtimes with approvals, rules, guard and limits (project=agent-portal, purpose=harness)',
    imageTag: String(app.node.tryGetContext('harnessImageTag') ?? 'unset'),
  });
}

// GitHub Actions deploy role (one-time, by an account admin): -c github=1
if (app.node.tryGetContext('github')) {
  new AgentPortalGithubDeployStack(app, 'AgentPortalGithubDeploy', {
    env: { account: '366019841051', region: 'ap-southeast-1' },
    stackName: 'AgentPortalGithubDeploy',
    description: 'Agent Portal: GitHub OIDC role that deploys the harness runners (project=agent-portal, purpose=harness)',
    repository: 'Yusei0205/agent-portal',
    environment: 'aws-prod',
  });
}
