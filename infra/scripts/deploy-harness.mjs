#!/usr/bin/env node
/**
 * Deploy the harness AgentCore runners without local Docker:
 *   1. Stage the runner sources (agent-runner/, kiro-runner/, the shared server modules).
 *   2. Deploy AgentPortalHarnessBuild (ECR repositories, arm64 CodeBuild project, sources in S3).
 *   3. Build and push both images in CodeBuild, tagged with a hash of the sources
 *      (skipped when both images with that tag are already in ECR).
 *   4. Deploy AgentPortalHarness (the two AgentCore runtimes on that tag).
 *
 * Usage (from infra/):  node scripts/deploy-harness.mjs --profile <aws-profile>
 * Needs: AWS CLI v2, Node 22. Uses the CDK CLI version pinned below through npx.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CDK = 'aws-cdk@2.1147.0';
const REGION = 'ap-southeast-1';
const PROJECT = 'agent-portal-runner-images';
const REPOS = ['agent-portal/agent-runner-harness', 'agent-portal/kiro-runner-harness'];

const infra = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(infra, '..');
const stage = path.join(infra, '.harness-src');
const args = process.argv.slice(2);
const profileIdx = args.indexOf('--profile');
const profile = profileIdx >= 0 ? args[profileIdx + 1] : process.env.AWS_PROFILE;
const profileArgs = profile ? ['--profile', profile] : [];
const isWin = process.platform === 'win32';

const log = (m) => console.log(`\n▶ ${m}`);
function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: infra, shell: isWin, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (${r.status})`);
}
function aws(cmdArgs) {
  return JSON.parse(execFileSync('aws', [...cmdArgs, '--region', REGION, '--output', 'json', ...profileArgs], { encoding: 'utf8', shell: isWin }) || 'null');
}

// ── 1. Stage sources ──────────────────────────────────────────────────────────
log('Staging runner sources');
fs.rmSync(stage, { recursive: true, force: true });
const skip = new Set(['node_modules', 'dist', 'shared']);
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}
copyDir(path.join(root, 'agent-runner'), path.join(stage, 'agent-runner'));
copyDir(path.join(root, 'kiro-runner'), path.join(stage, 'kiro-runner'));
for (const f of ['agent/guard.ts', 'agent/env-scrub.ts', 'agent/tool-policy.ts', 'agent/pricing.ts', 'agent/agentcore-approvals.ts', 'real-path.ts',
  // The runners' own pure modules (files, repositories, snapshots, MCP proxies, checks).
  'agent/runner-files.ts', 'agent/runner-inspect.ts', 'agent/runner-repos.ts', 'agent/runner-snapshot.ts', 'agent/runner-terminal.ts', 'agent/runner-terminal-auth.ts', 'agent/runner-mcp.ts', 'agent/runner-checks.ts', 'agent/runner-finalize.ts', 'agent/runner-finalize-run.ts', 'agent/runner-memory.ts', 'agent/runner-graph.ts']) {
  const to = path.join(stage, 'server', f);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, 'server', f), to);
}

// Image tag: a hash of everything staged (same sources → same tag → no rebuild).
const hash = crypto.createHash('sha256');
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else hash.update(path.relative(stage, p).split(path.sep).join('/')).update(fs.readFileSync(p));
  }
})(stage);
const tag = `h-${hash.digest('hex').slice(0, 16)}`;
console.log(`image tag ${tag}`);

const cdkArgs = ['-y', CDK, 'deploy', '--require-approval', 'never', '-c', 'harness=1', '-c', `harnessImageTag=${tag}`, '-c', `publicUrl=${process.env.PUBLIC_URL || 'https://d1tah6dqw2fe9f.cloudfront.net'}`, ...profileArgs];

// ── 2. Build stack ────────────────────────────────────────────────────────────
log('Deploying AgentPortalHarnessBuild (ECR, CodeBuild, sources)');
run('npx', [...cdkArgs, 'AgentPortalHarnessBuild']);

// ── 3. Images ─────────────────────────────────────────────────────────────────
const have = REPOS.every((repo) => {
  try {
    aws(['ecr', 'describe-images', '--repository-name', repo, '--image-ids', `imageTag=${tag}`]);
    return true;
  } catch {
    return false;
  }
});
if (have) {
  log(`Images ${tag} already in ECR; skipping the build`);
} else {
  log('Building both images in CodeBuild (linux/arm64)');
  const started = aws(['codebuild', 'start-build', '--project-name', PROJECT, '--environment-variables-override', `name=IMAGE_TAG,value=${tag},type=PLAINTEXT`]);
  const id = started.build.id;
  console.log(`build ${id}`);
  let status = 'IN_PROGRESS';
  let phase = '';
  while (status === 'IN_PROGRESS') {
    await new Promise((r) => setTimeout(r, 20_000));
    const b = aws(['codebuild', 'batch-get-builds', '--ids', id]).builds[0];
    status = b.buildStatus;
    if (b.currentPhase !== phase) console.log(`  ${b.currentPhase}`);
    phase = b.currentPhase;
  }
  if (status !== 'SUCCEEDED') {
    throw new Error(`CodeBuild ${id} ended ${status}. Logs: CloudWatch group /aws/codebuild/${PROJECT}`);
  }
}

// ── 4. Runtimes ───────────────────────────────────────────────────────────────
log('Deploying AgentPortalHarness (AgentCore runtimes)');
run('npx', [...cdkArgs, 'AgentPortalHarness', '--outputs-file', path.join(infra, 'cdk.out', 'harness-outputs.json')]);
console.log(fs.readFileSync(path.join(infra, 'cdk.out', 'harness-outputs.json'), 'utf8'));
