/**
 * buildAttention (Dashboard "Needs attention"): a pipeline Inbox item reads "Deploy failed" with the run's title, not
 * "Blocked" / "Session".
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

type Row = { key: string; tone: string; label: string; title: string; href: string };
let tempDir: string;
let buildAttention: (input: { inbox?: unknown[]; idleClosing?: unknown[]; recentSessions?: unknown[]; nowMs?: number }) => Row[];

before(async () => {
  tempDir = await mkdtemp(path.resolve('.dashboard-attention-test-'));
  const outfile = path.join(tempDir, 'DashboardInsights.mjs');
  await build({ entryPoints: ['web/src/components/DashboardInsights.jsx'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic' });
  ({ buildAttention } = await import(pathToFileURL(outfile).href));
});
after(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true }); });

describe('buildAttention', () => {
  it('labels a pipeline item "Deploy failed" and uses its title', () => {
    const rows = buildAttention({
      inbox: [{
        id: 'i1', type: 'blocked', project_id: 'p1', project_name: 'Alpha', workflow_id: null,
        payload: { kind: 'pipeline', title: 'Deploy portal on acme/widgets@main', workflow: 'Deploy portal', repo: 'acme/widgets', branch: 'main' },
      }],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, 'Deploy failed');
    assert.equal(rows[0].title, 'Deploy portal on acme/widgets@main');
    assert.equal(rows[0].tone, 'danger');
  });

  it('a pipeline item without a stored title builds one from workflow, repository and branch', () => {
    const rows = buildAttention({ inbox: [{ id: 'i4', type: 'blocked', project_id: 'p1', payload: { kind: 'pipeline', workflow: 'Deploy', repo: 'acme/app', branch: 'main' } }] });
    assert.equal(rows[0].title, 'Deploy on acme/app@main');
  });

  it('other blocked items keep their labels', () => {
    const rows = buildAttention({
      inbox: [
        { id: 'i2', type: 'blocked', project_id: 'p1', workflow_id: 'w1', workflow_goal: 'Fix it', payload: {} },
        { id: 'i3', type: 'blocked', project_id: 'p1', workflow_id: 'w2', workflow_goal: 'Cut', payload: { kind: 'turn-interrupted' } },
      ],
    });
    assert.deepEqual(rows.map((r) => r.label), ['Blocked', 'Turn cut off']);
  });
});
