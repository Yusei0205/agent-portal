/**
 * Spike C — setup script
 *
 * Reads the AgentPortalSpikeC CloudFormation stack outputs and writes
 * scripts/spike-c-config.json for use by the publisher and subscriber scripts.
 *
 * Usage:
 *   node scripts/spike-c-setup.mjs
 *
 * Prerequisites:
 *   - `cdk deploy AgentPortalSpikeC --profile agentcore` has completed
 *   - AWS profile 'agentcore' configured
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

console.log('Reading AgentPortalSpikeC stack outputs...');

let outputs;
try {
  const raw = run(
    'aws cloudformation describe-stacks --stack-name AgentPortalSpikeC --region ap-southeast-1 --profile agentcore',
  );
  const json = JSON.parse(raw);
  const stack = json.Stacks?.[0];
  if (!stack) throw new Error('Stack not found');
  outputs = Object.fromEntries(
    (stack.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]),
  );
} catch (err) {
  console.error(`Failed to describe stack: ${err.message}`);
  console.error('Make sure `cdk deploy AgentPortalSpikeC --profile agentcore` has completed.');
  process.exit(1);
}

const httpDomain = outputs.HttpDomain;
const realtimeDomain = outputs.RealtimeDomain;
const apiId = outputs.ApiId;

if (!httpDomain || !realtimeDomain) {
  console.error('Missing expected outputs. Available outputs:');
  console.error(JSON.stringify(outputs, null, 2));
  process.exit(1);
}

// Use a fixed test run/project ID for the spike
const runId = 'run-spike-test-001';
const projectId = 'project-spike-a';

const config = {
  apiId,
  httpDomain,
  realtimeDomain,
  region: 'ap-southeast-1',
  runId,
  projectId,
};

const configPath = join(__dir, 'spike-c-config.json');
writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

console.log('✅ spike-c-config.json written:');
console.log(JSON.stringify(config, null, 2));
console.log('\nNext steps:');
console.log('  1. In terminal 1: node scripts/spike-c-subscribe.mjs');
console.log('  2. In terminal 2: node scripts/spike-c-publish.mjs');
