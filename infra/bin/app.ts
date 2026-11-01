#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AgentPortalSpikeAStack } from '../lib/spike-a-stack';

const app = new cdk.App();

new AgentPortalSpikeAStack(app, 'AgentPortalSpikeA', {
  env: {
    account: '366019841051',
    region: 'ap-southeast-1',
  },
  description: 'Spike A: AgentCore Runtime for agent-portal (project=agent-portal, purpose=spike-a)',
  stackName: 'AgentPortalSpikeA',
});
