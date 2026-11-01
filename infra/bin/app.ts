#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AgentPortalSpikeAStack } from '../lib/spike-a-stack';
import { AgentPortalSpikeBStack } from '../lib/spike-b-stack';
import { AgentPortalSpikeCStack } from '../lib/spike-c-stack';

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
