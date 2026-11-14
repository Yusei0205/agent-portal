/**
 * Which deploys a push starts: the runner workflow's path list matches the files that go into the runner images, the Codex image is
 * rebuilt only for the files it is made of, and the portal deploy keeps the long-job runtime and builds natively.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error pure JavaScript CI helper has no declaration file
import { RUNNER_PATHS, CODEX_PATHS, matches, anyMatch, scopeFor, changedFiles, codexBundleFiles } from '../scripts/deploy-scope.mjs';
// @ts-expect-error pure JavaScript deploy helper has no declaration file
import { HARNESS_SERVER_FILES } from '../infra/scripts/harness-sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

/** The `paths:` list under an event of a workflow file (`push` or `pull_request`). */
function workflowPaths(file: string, event: string): string[] {
  const lines = read(file).split('\n');
  const at = lines.findIndex((l) => l === `  ${event}:`);
  assert.ok(at >= 0, `${file} has ${event}`);
  const out: string[] = [];
  let inPaths = false;
  for (const line of lines.slice(at + 1)) {
    if (/^  \S/.test(line) || /^\S/.test(line)) break; // the next event, or the next top-level key
    if (/^    paths:/.test(line)) { inPaths = true; continue; }
    if (inPaths) { const m = /^      - (.+)$/.exec(line); if (m) out.push(m[1].replace(/^'|'$/g, '')); else if (line.trim()) inPaths = false; }
  }
  return out;
}

describe('runner deploy scope', () => {
  it('deploy-agentcore.yml starts on exactly the files in RUNNER_PATHS, for pushes and pull requests', () => {
    for (const event of ['push', 'pull_request']) {
      assert.deepEqual([...workflowPaths('.github/workflows/deploy-agentcore.yml', event)].sort(), [...RUNNER_PATHS].sort(), event);
    }
  });

  it('every portal module staged into the runner images starts a runner deploy, and exists', () => {
    for (const f of HARNESS_SERVER_FILES) {
      assert.ok(fs.existsSync(path.join(root, 'server', f)), `server/${f} exists`);
      assert.ok(anyMatch([`server/${f}`], RUNNER_PATHS), `server/${f} starts a runner deploy`);
    }
  });

  it('matches a folder pattern by prefix and a file pattern exactly', () => {
    assert.equal(matches('kiro-runner/src/run.ts', 'kiro-runner/**'), true);
    assert.equal(matches('kiro-runner-extra/x.ts', 'kiro-runner/**'), false);
    assert.equal(matches('package.json', 'package.json'), true);
    assert.equal(matches('docs/package.json', 'package.json'), false);
  });
});

describe('Codex image scope', () => {
  it('reads the files the Codex bundle is made of', async () => {
    const files = await codexBundleFiles();
    assert.ok(files.has('codex-runner/src/index.ts'));
    assert.ok(files.has('server/agent/runner-files.ts'), 'a shared module it imports');
    assert.ok([...files].every((f) => !f.includes('node_modules')));
    assert.equal(files.has('web/src/pages/CodeMap.jsx'), false);
  });

  it('decides from the changed files', async () => {
    const codex = await codexBundleFiles();
    const of = (...files: string[]) => scopeFor(files, codex);
    assert.deepEqual(of('web/src/pages/CodeMap.jsx', 'docs/x.md', 'test/zip-attachments.test.ts'), { runners: false, codex: false });
    assert.deepEqual(of('codex-runner/src/index.ts'), { runners: false, codex: true });
    assert.deepEqual(of('codex-runner/Dockerfile'), { runners: false, codex: true });
    assert.deepEqual(of('package-lock.json'), { runners: false, codex: true });
    assert.deepEqual(of('kiro-runner/src/run.ts'), { runners: true, codex: false });
    assert.deepEqual(of('server/agent/runner-files.ts'), { runners: true, codex: true });
    assert.deepEqual(of('server/agent/codex-session.ts'), { runners: false, codex: true });
    assert.ok(CODEX_PATHS.includes('infra/lib/codex-runner-stack.ts'));
  });

  it('says nothing is known when git cannot give the changed files', () => {
    assert.equal(changedFiles(undefined, 'abc'), null);
    assert.equal(changedFiles('0000000000000000000000000000000000000000', 'abc'), null);
    assert.equal(changedFiles('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'cafebabecafebabecafebabecafebabecafebabe'), null);
  });
});

describe('portal deploy workflow', () => {
  const wf = read('.github/workflows/deploy-portal.yml');

  it('keeps the long-job runtime on every deploy', () => {
    assert.match(wf, /-c "jobRuntime=\$JOB_RUNTIME"/);
    assert.match(wf, /-c "jobRuntimeAgentRuns=\$JOB_RUNTIME_AGENT_RUNS"/);
    assert.match(wf, /JOB_RUNTIME: \$\{\{ vars\.JOB_RUNTIME \|\| 'true' \}\}/);
  });

  it('builds on a native arm64 runner, without emulation', () => {
    assert.match(wf, /deploy:[\s\S]*?runs-on: ubuntu-24\.04-arm/);
    assert.doesNotMatch(wf, /qemu/i);
  });

  it('deploys only after CI passed, and after the runner deploy of the same commit when runners changed', () => {
    const order = ['scripts/deploy-scope.mjs', 'Wait for CI on this commit', 'Wait for the runner deploy', 'Sign in to AWS', 'Deploy AgentPortalCloud'].map((s) => wf.indexOf(s));
    assert.ok(order.every((i) => i > 0), 'all steps exist');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
    assert.match(wf, /CI_WORKFLOW: deploy-agentcore\.yml/);
    assert.match(wf, /steps\.scope\.outputs\.runners == 'true'/);
  });

  it('deploys the Codex runner only when its image changed, and otherwise reads the running one', () => {
    assert.match(wf, /if: steps\.scope\.outputs\.codex == 'true'/);
    assert.match(wf, /describe-stacks --stack-name AgentPortalCodexRunner/);
  });

  it('builds the portal Lambda for arm64 like the other images', () => {
    const stack = read('infra/lib/portal-stack.ts');
    assert.match(stack, /architecture: lambda\.Architecture\.ARM_64/);
    assert.doesNotMatch(stack, /LINUX_AMD64/);
  });
});
